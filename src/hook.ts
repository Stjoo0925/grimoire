#!/usr/bin/env node
/**
 * Claude Code 훅 진입점 — `grimoire install claude-code --hooks`가 settings.json에 적는 명령이다.
 *
 *   node hook.js [--env KEY=VALUE ...]   stdin으로 훅 JSON을 받아 처리하고, 돌려줄 것이 있으면 stdout에 JSON 한 줄.
 *
 * cli.js와 따로 둔 이유: 훅은 편집마다 돌고 150ms 예산이라 MCP SDK·검색 모듈을 불러오면 안 된다.
 * 절대 작업을 막지 않는다 — 어떤 경우에도 exit 0, 오류는 <GRIMOIRE_HOME>/hook.log에만, 3초 지나면 스스로 끝난다.
 */
import fs from "node:fs";
import path from "node:path";

import { dbPath, grimoireHome, type Env } from "./core/config";
import { openDb } from "./core/db";
import { handleHook, type HookInput } from "./hook/runner";

/** 자체 타임아웃 — Claude Code의 timeout보다 짧게, 느린 디스크에서도 편집을 붙잡지 않게 */
const SELF_TIMEOUT_MS = 3_000;
const STDIN_MAX = 2 * 1024 * 1024;

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

function log(env: Env, message: string): void {
  try {
    const home = grimoireHome(env);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(home, "hook.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // 로그도 못 쓰면 조용히
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
  const me = (env.GRIMOIRE_ME ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  let db;
  try {
    db = openDb(dbPath(env));
  } catch (error) {
    log(env, `db: ${error instanceof Error ? error.message : error}`);
    return;
  }
  try {
    const output = handleHook({ db, env, me }, input);
    if (output?.json) process.stdout.write(JSON.stringify(output.json) + "\n");
    else if (output?.stdout) process.stdout.write(output.stdout + "\n");
  } catch (error) {
    log(env, `${input.hook_event_name ?? "?"}: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
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
