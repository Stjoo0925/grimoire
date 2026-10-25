/**
 * 핀포인트 벤치 — 같은 질문을 세 방식으로 풀게 해 "누가 더 빨리 정확한 위치를 대나"를 잰다.
 *
 *   grimoire  Grimoire MCP만 (내장 도구 끔)
 *   history   git 명령만 (log/show/grep) — 과거 히스토리를 직접 도는 방식
 *   explore   Read/Grep/Glob만 — 프로젝트 파일을 직접 순회하는 방식
 *
 *   npm run bench -- --questions bench/questions.local.json
 *   npm run bench -- --questions … --modes grimoire --only conflict,ratelimit --repeat 2
 *
 * 질문 파일: { "root": "~/work-dir", "questions": [{ id, type, q, expect: ["정답 sha 또는 파일명 일부", …] }] }
 * 정답은 expect의 모든 문자열이 답에 들어 있으면 맞은 것으로 본다(대소문자 무시).
 *
 * grimoire 모드는 root 아래 레포를 임시 DB에 새로 인덱싱해서 쓴다 — 실제 ~/.grimoire는 건드리지 않는다.
 * 결과는 bench/results/<시각>.json에 남긴다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { tempDir } from "../tests/helpers";
import { runClaude, type AgentRun } from "./claude";

type Mode = "grimoire" | "history" | "explore";
const MODES: Mode[] = ["grimoire", "history", "explore"];

interface Question {
  id: string;
  type: string;
  q: string;
  expect: string[];
}

interface Row {
  question: string;
  type: string;
  mode: Mode;
  attempt: number;
  ok: boolean;
  run: AgentRun;
}

const SUFFIX = " 답에는 근거(파일 경로나 커밋 sha)를 꼭 밝혀줘.";

function expandHome(value: string): string {
  return value.replace(/^~(?=$|\/)/, os.homedir());
}

function modeOptions(mode: Mode, root: string, grimoireConfig: string, emptyConfig: string, neutralCwd: string) {
  switch (mode) {
    case "grimoire":
      return { cwd: neutralCwd, mcpConfig: grimoireConfig, tools: "", allowedTools: ["mcp__grimoire"] };
    case "history":
      return {
        cwd: root,
        mcpConfig: emptyConfig,
        tools: "Bash",
        allowedTools: [
          "Bash(git log:*)",
          "Bash(git show:*)",
          "Bash(git grep:*)",
          "Bash(git -C * log *)",
          "Bash(git -C * show *)",
          "Bash(git -C * grep *)",
          "Bash(ls:*)",
        ],
      };
    case "explore":
      return { cwd: root, mcpConfig: emptyConfig, tools: "Read,Grep,Glob", allowedTools: ["Read", "Grep", "Glob"] };
  }
}

function summarize(rows: Row[]) {
  const byMode = new Map<Mode, Row[]>();
  for (const row of rows) byMode.set(row.mode, [...(byMode.get(row.mode) ?? []), row]);
  return [...byMode.entries()].map(([mode, list]) => {
    const sum = (pick: (row: Row) => number) => list.reduce((acc, row) => acc + pick(row), 0);
    return {
      mode,
      correct: list.filter((row) => row.ok).length,
      total: list.length,
      seconds: +(sum((row) => row.run.ms) / 1000).toFixed(1),
      turns: +(sum((row) => row.run.turns ?? 0) / list.length).toFixed(1),
      cost: +sum((row) => row.run.costUsd ?? 0).toFixed(3),
      cacheWrite: sum((row) => row.run.usage?.cacheWrite ?? 0),
      cacheRead: sum((row) => row.run.usage?.cacheRead ?? 0),
    };
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      questions: { type: "string" },
      modes: { type: "string" },
      only: { type: "string" },
      repeat: { type: "string" },
      model: { type: "string" },
      label: { type: "string" },
    },
  });
  if (!values.questions) throw new Error("--questions <파일>이 필요합니다");
  const spec = JSON.parse(fs.readFileSync(values.questions, "utf8")) as { root: string; questions: Question[] };
  const root = path.resolve(expandHome(spec.root));
  const only = values.only?.split(",").map((item) => item.trim());
  const questions = spec.questions.filter((question) => !only || only.includes(question.id));
  const modes = (values.modes?.split(",") as Mode[] | undefined) ?? MODES;
  const repeat = Math.max(1, Number.parseInt(values.repeat ?? "1", 10) || 1);

  // BENCH_CLI로 고정해 둔 빌드를 가리킬 수 있다 — 벤치 도중 dist가 다시 빌드돼도 측정 대상이 바뀌지 않게
  const cli = process.env.BENCH_CLI ? path.resolve(process.env.BENCH_CLI) : path.resolve(__dirname, "..", "..", "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error(`${cli}가 없습니다 — npm run build를 먼저 하세요`);

  // grimoire용 임시 DB — root 아래 레포를 새로 인덱싱
  const data = tempDir("grimoire-bench-data-");
  const neutralCwd = tempDir("grimoire-bench-cwd-");
  const env = { GRIMOIRE_HOME: data, GRIMOIRE_SYNC_ON_START: "0", GRIMOIRE_UPDATE_CHECK: "0", OLLAMA_HOST: process.env.BENCH_OLLAMA_HOST ?? "http://127.0.0.1:9" };
  if (modes.includes("grimoire")) {
    const started = Date.now();
    execFileSync(process.execPath, [cli, "scan", root], { env: { ...process.env, ...env }, stdio: "ignore" });
    process.stdout.write(`인덱싱 ${((Date.now() - started) / 1000).toFixed(1)}s (${root})\n`);
  }
  const grimoireConfig = path.join(neutralCwd, "..", `grimoire-bench-${process.pid}.json`);
  fs.writeFileSync(grimoireConfig, JSON.stringify({ mcpServers: { grimoire: { command: process.execPath, args: [cli, "mcp"], env } } }));
  const emptyConfig = path.join(neutralCwd, "..", `grimoire-bench-empty-${process.pid}.json`);
  fs.writeFileSync(emptyConfig, JSON.stringify({ mcpServers: {} }));

  const rows: Row[] = [];
  for (const question of questions) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      for (const mode of modes) {
        process.stdout.write(`… ${question.id} / ${mode}${repeat > 1 ? ` #${attempt}` : ""}\n`);
        const run = await runClaude({
          prompt: question.q + SUFFIX,
          model: values.model,
          budgetUsd: "0.60",
          ...modeOptions(mode, root, grimoireConfig, emptyConfig, neutralCwd),
        });
        const answer = run.answer.toLowerCase();
        const ok = !run.error && question.expect.every((needle) => answer.includes(needle.toLowerCase()));
        rows.push({ question: question.id, type: question.type, mode, attempt, ok, run });
      }
    }
  }

  // 결과 저장
  const resultsDir = path.resolve("bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(resultsDir, `${stamp}${values.label ? `-${values.label}` : ""}.json`);
  const summary = summarize(rows);
  fs.writeFileSync(file, JSON.stringify({ label: values.label, model: values.model, root, summary, rows }, null, 2));

  // 표
  process.stdout.write("\n질문       모드      정답  시간     턴  도구  비용     도구 순서\n");
  for (const row of rows) {
    const tools = row.run.tools.map((tool) => tool.replace("mcp__grimoire__", "")).join("→");
    process.stdout.write(
      `${row.question.padEnd(10)} ${row.mode.padEnd(9)} ${row.ok ? " ✓  " : " ✗  "}${String((row.run.ms / 1000).toFixed(1)).padStart(5)}s ${String(row.run.turns ?? "-").padStart(4)} ${String(row.run.tools.length).padStart(4)}  $${(row.run.costUsd ?? 0).toFixed(3)}  ${tools.slice(0, 70)}\n`,
    );
    if (!row.ok) process.stdout.write(`           ↳ ${(row.run.error ?? row.run.answer).replace(/\s+/g, " ").slice(0, 160)}\n`);
  }
  process.stdout.write("\n모드       정답    총시간   평균턴  비용    캐시쓰기  캐시읽기\n");
  for (const item of summary) {
    process.stdout.write(
      `${item.mode.padEnd(9)} ${`${item.correct}/${item.total}`.padStart(5)}  ${String(item.seconds).padStart(7)}s  ${String(item.turns).padStart(5)}  $${item.cost.toFixed(3)}  ${String(item.cacheWrite).padStart(8)}  ${String(item.cacheRead).padStart(8)}\n`,
    );
  }

  // 목표 판정: grimoire가 각 기준선보다 정답 ≥, 총시간 <, 평균턴 ≤
  const mine = summary.find((item) => item.mode === "grimoire");
  const others = summary.filter((item) => item.mode !== "grimoire");
  if (mine && others.length > 0) {
    const beats = others.every((other) => mine.correct >= other.correct && mine.seconds < other.seconds && mine.turns <= other.turns);
    process.stdout.write(`\n판정: ${beats ? "✓ grimoire가 모든 기준선보다 빠르고 정확함" : "✗ 아직 지는 기준선이 있음"}\n`);
  }
  process.stdout.write(`결과: ${file}\n`);
  for (const dir of [data, neutralCwd]) fs.rmSync(dir, { recursive: true, force: true });
  for (const config of [grimoireConfig, emptyConfig]) fs.rmSync(config, { force: true });
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  },
);
