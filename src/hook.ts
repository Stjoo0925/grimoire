#!/usr/bin/env node
/**
 * Claude Code 훅 진입점 — `grimoire install claude-code --hooks`가 settings.json에 적는 명령이다.
 *
 *   node hook.js [--env KEY=VALUE ...]   stdin으로 훅 JSON을 받아 처리하고, 돌려줄 것이 있으면 stdout에 JSON 한 줄.
 *
 * cli.js와 따로 둔 이유: 훅은 편집마다 돌고 150ms 예산이라 MCP SDK·검색 모듈을 불러오면 안 된다.
 * 절대 작업을 막지 않는다 — 어떤 경우에도 exit 0, 오류는 <GRIMOIRE_HOME>/hook.log에만, 3초 지나면 스스로 끝난다.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { dbPath, grimoireHome, type Env } from "./core/config";
import { openDb } from "./core/db";
import { myEmails } from "./core/identity";
import { handleHook, type HookInput } from "./hook/runner";

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
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "sync", repoPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, GRIMOIRE_UPDATE_CHECK: "0" },
    });
    child.on("error", (error) => log(env, `background sync: ${error.message}`));
    child.unref();
  } catch (error) {
    log(env, `background sync: ${error instanceof Error ? error.message : error}`);
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

async function main(): Promise<void> {
  const env = parseEnvArgs(process.argv.slice(2));
  const watchdog = setTimeout(() => {
    log(env, `timeout after ${SELF_TIMEOUT_MS}ms`);
    process.exit(0);
  }, SELF_TIMEOUT_MS);
  watchdog.unref();

  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch (error) {
    log(env, `bad stdin: ${error instanceof Error ? error.message : error}`);
    return;
  }
  // "나" — GRIMOIRE_ME가 있으면 그것, 없으면 git config user.email (CLI·MCP와 같은 규칙)
  const me = await myEmails(env);
  let db;
  try {
    // 잠금 대기는 동기라 SELF_TIMEOUT도 못 끊는다 — Claude Code의 훅 timeout(5초)보다 한참 짧게
    db = openDb(dbPath(env), { busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
  } catch (error) {
    log(env, `db: ${error instanceof Error ? error.message : error}`);
    return;
  }
  try {
    const output = await handleHook({ db, env, me }, input);
    if (output?.json) process.stdout.write(JSON.stringify(output.json) + "\n");
    else if (output?.stdout) process.stdout.write(output.stdout + "\n");
    trace(env, input, output?.json?.hookSpecificOutput.additionalContext ?? output?.stdout ?? "");
    if (output?.syncRepo) backgroundSync(env, output.syncRepo);
  } catch (error) {
    log(env, `${input.hook_event_name ?? "?"}: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    trace(env, input, "", error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 0;
  },
);
