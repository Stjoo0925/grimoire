#!/usr/bin/env node
/**
 * Claude Code 훅 진입점 — `grimoire install claude-code --hooks`가 settings.json에 적는 명령이다.
 *
 *   node hook.js [--env KEY=VALUE ...]   stdin으로 훅 JSON을 받아 처리하고, 돌려줄 것이 있으면 stdout에 JSON 한 줄.
 *
 * cli.js와 따로 둔 이유: 훅은 편집마다 돌고 150ms 예산이라 MCP SDK·검색 모듈을 불러오면 안 된다.
 * 절대 작업을 막지 않는다 — 어떤 경우에도 exit 0, 오류는 <GRIMOIRE_HOME>/hook.log에만, 3초 지나면 스스로 끝난다.
 * 끝나는 법: 출력이 OS로 넘어가고 DB를 닫으면 process.exit(0)으로 바로 끝낸다 — 저절로 끝나기를 기다리면 무엇인지 모를
 * 핸들 하나가 프로세스를 3초 타임아웃까지 붙잡았다(2026-11 PreToolUse:Write, 일은 190ms 안에 끝났는데 프로세스 3186ms).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isGitCommit } from "./core/capture";
import { dbPath, grimoireHome, type Env } from "./core/config";
import { openDb } from "./core/db";
import { myEmails } from "./core/identity";
import { handleHook, type HookInput } from "./hook/runner";
import { settingsPath } from "./setup/hook-config";

/** 자체 타임아웃 — Claude Code의 timeout보다 짧게, 느린 디스크에서도 편집을 붙잡지 않게 */
const SELF_TIMEOUT_MS = 3_000;
const STDIN_MAX = 2 * 1024 * 1024;
/** 다른 grimoire 프로세스(sync·MCP)가 쓰기 잠금을 쥐었을 때 훅이 기다리는 최대 시간 — 넘으면 그 기록은 버리고 hook.log에 남긴다 */
const HOOK_BUSY_TIMEOUT_MS = 1_500;

function parseEnvArgs(argv: string[]): Env {
  const env: Env = { ...process.env };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) {
      const [key, ...rest] = argv[i + 1].split("=");
      if (key) env[key] = rest.join("=");
      i++;
    }
  }
  return env;
}

/** hook.log 크기 상한 — 넘으면 뒤쪽 절반만 남긴다 (훅은 편집마다 돌아 로그가 끝없이 커질 수 있다) */
const LOG_MAX_BYTES = 512 * 1024;

function log(env: Env, message: string): void {
  try {
    const home = grimoireHome(env);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, "hook.log");
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        const text = fs.readFileSync(file, "utf8");
        const tail = text.slice(text.length - LOG_MAX_BYTES / 2);
        fs.writeFileSync(file, tail.slice(tail.indexOf("\n") + 1), { mode: 0o600 });
      }
    } catch {
      // 아직 없음
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message.replace(/\r?\n/g, " ⏎ ")}\n`, { mode: 0o600 });
  } catch {
    // 로그도 못 쓰면 조용히
  }
}

/** trace 한 줄에 남기는 주입 본문 글자 수 상한 */
const TRACE_TEXT_MAX = 2_000;

/**
 * `GRIMOIRE_HOOK_TRACE=<파일>`이면 훅이 불릴 때마다 JSON 한 줄을 덧붙인다 — 벤치(e2e/taskbench.ts)가 "이 실행에서 훅이 실제로
 * 무엇을 넣었나"를 세려고 쓴다. 꺼져 있으면(기본) 아무것도 하지 않는다. 기록 실패는 무시한다(훅은 작업을 막지 않는다).
 * enabled: GRIMOIRE_HOOKS=0으로 꺼진 훅이었나(벤치의 대조군에서 사용자 전역 훅이 새지 않았는지 확인용)
 */
function trace(env: Env, input: HookInput, text: string, error?: string): void {
  const file = env.GRIMOIRE_HOOK_TRACE?.trim();
  if (!file) return;
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const line = {
    at: new Date().toISOString(),
    event: input.hook_event_name ?? null,
    session: input.session_id ?? null,
    tool: input.tool_name ?? null,
    file: typeof target === "string" ? target : null,
    enabled: env.GRIMOIRE_HOOKS !== "0",
    injected: text.length > 0,
    chars: text.length,
    text: text.slice(0, TRACE_TEXT_MAX),
    ...(error ? { error } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {
    // 기록 못 해도 훅은 계속
  }
}

/**
 * `grimoire sync <레포>`를 떼어 낸 프로세스로 띄우고 기다리지 않는다 — 훅은 바로 끝나고 동기화는 뒤에서 돈다.
 * 업데이트 확인(네트워크)은 끈다. 띄우지 못해도 로그만 남긴다.
 */
function backgroundSync(env: Env, repoPath: string): void {
  background(env, ["sync", repoPath], "background sync");
}

/** cli.js 명령 하나를 떼어 낸 프로세스로 — 훅은 기다리지 않는다 */
function background(env: Env, args: string[], label: string): void {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, GRIMOIRE_UPDATE_CHECK: "0" },
    });
    child.on("error", (error) => log(env, `${label}: ${error.message}`));
    child.unref();
  } catch (error) {
    log(env, `${label}: ${error instanceof Error ? error.message : error}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (data.length < STDIN_MAX) data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * stdout에 쓰고 OS로 넘어갈 때까지 기다린다 — Windows·macOS의 파이프 쓰기는 비동기라, 기다리지 않고 exit하면 큰 카드가 잘린다.
 * 읽는 쪽이 닫혀 실패해도(EPIPE) 그냥 풀린다. 읽는 쪽이 안 읽어 영영 안 풀리면 자체 타임아웃이 끝낸다.
 */
function writeOut(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** 살아 있는 핸들 이름을 개수와 함께 짧게 — "PipeWrap×2 TTYWrap Timeout" */
function activeResources(): string {
  const counts = new Map<string, number>();
  for (const name of process.getActiveResourcesInfo()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join(" ") || "없음";
}

/** 지금 어느 훅의 어느 단계인가 — 시간 초과 줄에 남긴다 (stdin → identity → db → handle → output → close → flush → exit) */
let event = "?";
let phase = "stdin";

async function main(): Promise<void> {
  const env = parseEnvArgs(process.argv.slice(2));
  // 시간 초과 줄에 어느 훅이 어느 단계에서 멈췄는지 남긴다 — "timeout after 3000ms"만으로는 원인을 가를 수 없었다
  // (실사용 5~16초 정지 9건). 시작 지연(node 기동·모듈 로드)과, 타이머 지연(예정보다 늦게 불린 만큼 — 크면 동기 작업이
  // 이벤트 루프를 막은 것, 0에 가까우면 루프는 놀았는데 핸들이 프로세스를 붙잡은 것), 그때 살아 있던 핸들도 같이 적는다.
  const bootMs = Math.round(process.uptime() * 1000);
  const armedAt = performance.now();
  const watchdog = setTimeout(() => {
    const total = Math.round(process.uptime() * 1000);
    const lag = Math.round(performance.now() - armedAt - SELF_TIMEOUT_MS);
    log(env, `timeout after ${SELF_TIMEOUT_MS}ms — ${event}, 단계 ${phase}, 시작 지연 ${bootMs}ms, 프로세스 ${total}ms, 타이머 지연 ${lag}ms, 핸들 ${activeResources()}`);
    process.exit(0);
  }, SELF_TIMEOUT_MS);
  watchdog.unref();
  // 읽는 쪽이 먼저 닫혀도(EPIPE) 잡히지 않은 예외로 exit 1이 되지 않게
  process.stdout.on("error", () => undefined);

  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch (error) {
    log(env, `bad stdin: ${error instanceof Error ? error.message : error}`);
    return;
  }
  event = `${input.hook_event_name ?? "?"}${input.tool_name ? `:${input.tool_name}` : ""}`;
  phase = "identity";
  // 커밋이 아닌 Bash의 편집 직전 훅은 할 일이 없다 — Bash마다 불리므로 DB를 열기 전에 끝낸다
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command !== "string" || !isGitCommit(command)) return;
  }
  // "나" — GRIMOIRE_ME가 있으면 그것, 없으면 git config user.email (CLI·MCP와 같은 규칙)
  const me = await myEmails(env);
  phase = "db";
  let db;
  try {
    // 잠금 대기는 동기라 SELF_TIMEOUT도 못 끊는다 — Claude Code의 훅 timeout(5초)보다 한참 짧게
    db = openDb(dbPath(env), { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
  } catch (error) {
    log(env, `db: ${error instanceof Error ? error.message : error}`);
    return;
  }
  phase = "handle";
  let flushed: Promise<void> = Promise.resolve();
  try {
    const output = await handleHook({ db, env, me, settingsFile: settingsPath(), hookPath: path.join(__dirname, "hook.js") }, input);
    phase = "output";
    if (output?.json) flushed = writeOut(JSON.stringify(output.json) + "\n");
    else if (output?.stdout) flushed = writeOut(output.stdout + "\n");
    trace(env, input, output?.json?.hookSpecificOutput.additionalContext ?? output?.stdout ?? "");
    if (output?.syncRepo) backgroundSync(env, output.syncRepo);
    if (output?.refreshSetup) background(env, ["setup-refresh"], "setup refresh");
  } catch (error) {
    log(env, `${input.hook_event_name ?? "?"}: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    trace(env, input, "", error instanceof Error ? error.message : String(error));
  } finally {
    phase = "close";
    db.close();
  }
  phase = "flush";
  await flushed;
}

// 저절로 끝나기를 기다리지 않는다 — 출력은 main 안에서 다 나갔고(flush) DB도 닫혔다.
// 떼어 낸 자식(backgroundSync·setup-refresh)은 detached + unref라 여기서 끝나도 계속 돈다
const exit = () => {
  phase = "exit";
  process.exit(0);
};
main().then(exit, exit);
