/**
 * 훅 설정의 가벼운 부분 — 이벤트 목록, settings.json 위치, 설치된 우리 훅 읽기. 훅 진입점(hook.ts)이 SessionStart에서
 * "훅 설정이 낡았나"를 보려고 불러오므로, install.ts(→ MCP 도구 정의)를 끌어오지 않게 hooks.ts에서 떼어 냈다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import { skillState } from "./skills";

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** 이벤트별로 넣는 항목 — matcher는 도구 이름(PreToolUse·PostToolUse)이나 source(SessionStart) */
export const HOOK_EVENTS: { event: string; matcher?: string; timeout: number }[] = [
  { event: "PreToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", timeout: 5 },
  { event: "PostToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", timeout: 10 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "SessionStart", matcher: "startup|clear|compact", timeout: 5 },
];

export const MARKER = /[\\/]hook\.js"?(\s|$)/;

export function settingsPath(home = os.homedir()): string {
  return path.join(home, ".claude", "settings.json");
}

/** settings.json에 적힌 우리 훅 명령들 (doctor용). 없으면 빈 배열. */
export function readInstalledHooks(file: string): { event: string; command: string; matcher?: string }[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: Record<string, HookGroup[]> };
    const out: { event: string; command: string; matcher?: string }[] = [];
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of group.hooks ?? []) {
          if (hook?.type === "command" && MARKER.test(hook.command ?? "")) out.push({ event, command: hook.command, ...(group.matcher ? { matcher: group.matcher } : {}) });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 설치된 우리 훅이 이 버전의 이벤트·matcher(HOOK_EVENTS)와 다른가 — 업데이트는 옛 코드가 돌아 훅 설정을 새로 쓰지 못한다.
 * 다르면 빠진 이벤트·matcher를 돌려준다(0.10.0: PreToolUse에 Bash — 커밋 직전 알림). 훅이 없으면 빈 배열.
 */
export function outdatedHooks(installed: { event: string; matcher?: string }[]): string[] {
  if (installed.length === 0) return [];
  return HOOK_EVENTS.filter((item) => !installed.some((hook) => hook.event === item.event && (hook.matcher ?? "") === (item.matcher ?? ""))).map(
    (item) => `${item.event}${item.matcher ? `(${item.matcher})` : ""}`,
  );
}


/**
 * 갱신할 것이 있나 — 훅 안에서 부르므로 settings.json 읽기와 파일 하나 확인뿐이다.
 * runningHook: 지금 도는 hook.js. settings.json에 등록된 것이 바로 이 파일일 때만 갱신한다 — 벤치·개발 빌드의 훅(다른 위치의
 * hook.js)이 사용자의 실제 설정을 자기 경로로 덮어쓰지 않게.
 */
export function setupNeeded(env: Env, home = os.homedir(), runningHook?: string): { hooks: boolean; skill: boolean } {
  const none = { hooks: false, skill: false };
  if (env.GRIMOIRE_AUTO_SETUP === "0") return none;
  const installed = readInstalledHooks(settingsPath(home));
  if (installed.length === 0) return none;
  const registered = /^"([^"]+)"\s+"([^"]+)"/.exec(installed[0].command)?.[2];
  const norm = (value: string) => path.resolve(value).toLowerCase();
  if (!runningHook || !registered || norm(registered) !== norm(runningHook)) return none;
  const state = skillState(home);
  return { hooks: outdatedHooks(installed).length > 0, skill: state === "missing" || state === "stale" };
}
