/**
 * 에이전트 수준 하네스 — 실제 Claude(`claude -p`)에게 질문만 주고,
 * Grimoire 도구를 제대로 골라 쓰는지와 답에 맞는 근거 커밋을 대는지 본다.
 *
 *   npm run e2e:agent                     전체 사례
 *   npm run e2e:agent -- --case recall    사례 하나
 *   npm run e2e:agent -- --repeat 3       사례마다 3번 (모델 응답은 흔들리므로)
 *   npm run e2e:agent -- --model sonnet
 *
 * - Claude Code가 설치·로그인돼 있어야 한다. 실행마다 API 사용량이 든다(사례당 상한 --max-budget-usd).
 * - 내장 도구는 모두 끈다(`--tools ""`). 에이전트가 git으로 픽스처를 직접 읽어 "커닝"하지 못하게 —
 *   답의 근거는 Grimoire MCP를 거친 것뿐이다.
 * - DB는 임시 폴더, MCP 설정은 --strict-mcp-config로 이 하네스의 것만 쓴다(사용자 설정 무시).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { tempDir } from "../tests/helpers";
import { runClaude, type AgentRun } from "./claude";
import { makeFixture, ME, type Fixture } from "./fixture";

const CASE_TIMEOUT_MS = 240_000;
const BUDGET_USD = "0.50";

interface Shas {
  refresh: string;
  lock: string;
  all: string[];
}

interface Case {
  name: string;
  /** 이 사례 전에 DB에 레포를 미리 넣어 둘지 */
  preindex: boolean;
  prompt: (fixture: Fixture) => string;
  /** 통과하지 못한 이유 목록 (비면 통과) */
  judge: (run: AgentRun, shas: Shas) => string[];
}

/** 답에 sha(7자 이상 접두)가 들어 있는가 */
const cites = (answer: string, sha: string) => answer.toLowerCase().includes(sha.slice(0, 7));
const used = (run: AgentRun, tool: string) => run.tools.includes(`mcp__grimoire__${tool}`);

const CASES: Case[] = [
  {
    name: "onboarding",
    preindex: false,
    prompt: (fixture) =>
      `내 레포들은 ${fixture.root} 폴더 아래에 있어. 거기서 내가 JWT 리프레시 토큰을 어떻게 구현했는지 찾아서 ` +
      "근거가 된 커밋 sha도 같이 알려줘.",
    judge: (run, shas) => {
      const problems: string[] = [];
      if (!used(run, "add_repo")) problems.push("빈 DB인데 add_repo로 등록하지 않았습니다");
      if (!used(run, "search_memory")) problems.push("search_memory를 쓰지 않았습니다");
      if (!cites(run.answer, shas.refresh)) problems.push(`리프레시 토큰 커밋 sha(${shas.refresh.slice(0, 7)})를 대지 않았습니다`);
      return problems;
    },
  },
  {
    name: "recall",
    preindex: true,
    prompt: () => "예전에 재고 차감 동시성 문제를 어떻게 해결했었지? 누가 했는지와 근거 커밋도 알려줘.",
    judge: (run, shas) => {
      const problems: string[] = [];
      if (!used(run, "search_memory")) problems.push("search_memory를 쓰지 않았습니다");
      if (!cites(run.answer, shas.lock)) problems.push(`분산 락 커밋 sha(${shas.lock.slice(0, 7)})를 대지 않았습니다`);
      if (!/redis/i.test(run.answer)) problems.push("해결 방법(Redis 분산 락)을 말하지 않았습니다");
      if (!/teammate/i.test(run.answer)) problems.push("작성자(teammate)를 말하지 않았습니다 — 내 커밋이 아님");
      return problems;
    },
  },
  {
    name: "no-memory",
    preindex: true,
    prompt: () => "예전에 Kafka 컨슈머 재시도 로직을 구현한 적 있어? 있으면 근거 커밋을 알려줘.",
    judge: (run, shas) => {
      const problems: string[] = [];
      if (!used(run, "search_memory")) problems.push("찾아보지도 않고 답했습니다");
      const cited = shas.all.filter((sha) => cites(run.answer, sha));
      if (cited.length > 0) problems.push(`없는 기억에 커밋을 갖다 댔습니다: ${cited.map((sha) => sha.slice(0, 7)).join(", ")}`);
      if (!/(없|못 찾|찾지 못|no |not find|couldn't|could not)/i.test(run.answer)) problems.push("없다고 분명히 말하지 않았습니다");
      return problems;
    },
  },
];

function fixtureShas(fixture: Fixture): Shas {
  const log = (dir: string) =>
    execFileSync("git", ["log", "--format=%H %s"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  const lines = [...log(fixture.api), ...log(fixture.web)];
  const find = (needle: string) => {
    const line = lines.find((entry) => entry.includes(needle));
    if (!line) throw new Error(`픽스처에 '${needle}' 커밋이 없습니다`);
    return line.split(" ")[0];
  };
  return { refresh: find("리프레시 토큰"), lock: find("분산 락"), all: lines.map((line) => line.split(" ")[0]) };
}

function cliPath(): string {
  const cli = path.resolve(__dirname, "..", "..", "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error(`${cli}가 없습니다 — npm run build를 먼저 하세요`);
  return cli;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      case: { type: "string" },
      repeat: { type: "string" },
      model: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const cases = values.case ? CASES.filter((item) => item.name === values.case) : CASES;
  if (cases.length === 0) throw new Error(`사례 이름: ${CASES.map((item) => item.name).join(", ")}`);
  const repeat = Math.max(1, Number.parseInt(values.repeat ?? "1", 10) || 1);
  const cli = cliPath();

  const report: { case: string; attempt: number; ok: boolean; problems: string[]; run: AgentRun }[] = [];
  for (const item of cases) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const fixture = makeFixture();
      const shas = fixtureShas(fixture);
      const data = tempDir("grimoire-agent-data-");
      const workdir = tempDir("grimoire-agent-cwd-");
      const env = { GRIMOIRE_HOME: data, GRIMOIRE_ME: ME, OLLAMA_HOST: "http://127.0.0.1:9", GRIMOIRE_SYNC_ON_START: "0" };
      if (item.preindex) {
        execFileSync(process.execPath, [cli, "scan", fixture.root], { env: { ...process.env, ...env }, stdio: "ignore" });
      }
      const mcpConfig = path.join(workdir, "mcp.json");
      fs.writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { grimoire: { command: process.execPath, args: [cli, "mcp"], env } } }),
      );

      if (!values.json) process.stdout.write(`… ${item.name}${repeat > 1 ? ` #${attempt}` : ""}\n`);
      const run = await runClaude({
        prompt: item.prompt(fixture),
        cwd: workdir,
        mcpConfig,
        tools: "",
        allowedTools: ["mcp__grimoire"],
        model: values.model,
        budgetUsd: BUDGET_USD,
        timeoutMs: CASE_TIMEOUT_MS,
      });
      const problems = run.error ? [run.error] : item.judge(run, shas);
      report.push({ case: item.name, attempt, ok: problems.length === 0, problems, run });

      for (const dir of [fixture.root, data, workdir]) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const passed = report.filter((entry) => entry.ok).length;
  if (values.json) {
    process.stdout.write(JSON.stringify({ passed, total: report.length, report }, null, 2) + "\n");
  } else {
    process.stdout.write("\nGrimoire 에이전트 하네스\n\n");
    for (const entry of report) {
      const { run } = entry;
      const cost = run.costUsd !== null ? `$${run.costUsd.toFixed(3)}` : "-";
      process.stdout.write(
        `${entry.ok ? "✓" : "✗"} ${entry.case}${repeat > 1 ? ` #${entry.attempt}` : ""}  ` +
          `(${(run.ms / 1000).toFixed(1)}s, ${run.turns ?? "-"}턴, ${cost})\n`,
      );
      process.stdout.write(`    도구: ${run.tools.map((tool) => tool.replace("mcp__grimoire__", "")).join(" → ") || "(없음)"}\n`);
      for (const problem of entry.problems) process.stdout.write(`    ✗ ${problem}\n`);
      const answer = run.answer.replace(/\s+/g, " ").trim();
      process.stdout.write(`    답: ${answer.length > 300 ? answer.slice(0, 300) + "…" : answer || "(없음)"}\n`);
    }
    const total = report.reduce((sum, entry) => sum + (entry.run.costUsd ?? 0), 0);
    process.stdout.write(`\n${passed}/${report.length} 통과 · 비용 합계 $${total.toFixed(3)}\n`);
  }
  return passed === report.length ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  },
);
