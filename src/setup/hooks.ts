/**
 * `grimoire install claude-code --hooks` — Claude Code 훅을 `~/.claude/settings.json`에 적는다.
 *
 * 명령은 install.ts와 같은 규칙으로 **지금 node의 절대경로**와 `dist/hook.js`를 적고, CLI·MCP와 같은 DB를 보게
 * 환경 변수는 `--env KEY=VALUE` 인자로 넘긴다(훅 설정에는 env 칸이 없다). 경로는 `/` 구분자에 큰따옴표로 감싼다 —
 * cmd·PowerShell·bash 어디서 실행돼도 같은 뜻이다.
 * 다른 훅은 건드리지 않는다. 우리 항목은 명령에 `hook.js`가 든 것으로 알아보고 갈아 끼운다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import { FORWARDED_ENV, InstallError, planJson, writeJson } from "./install";

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
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", timeout: 5 },
  { event: "PostToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", timeout: 10 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "SessionStart", matcher: "startup|clear|compact", timeout: 5 },
];

const MARKER = /[\\/]hook\.js"?(\s|$)/;

export function settingsPath(home = os.homedir()): string {
  return path.join(home, ".claude", "settings.json");
}

/** 훅 명령 문자열 — `"<node>" "<hook.js>" --env K=V …` */
export function hookCommand(hookPath: string, env: Env = process.env, nodePath = process.execPath): string {
  const quote = (value: string) => `"${value.split(path.sep).join("/")}"`;
  const parts = [quote(nodePath), quote(path.resolve(hookPath))];
  for (const key of FORWARDED_ENV) {
    const value = env[key]?.trim();
    if (value) parts.push("--env", `"${key}=${(key === "GRIMOIRE_HOME" ? path.resolve(value) : value).split(path.sep).join("/")}"`);
  }
  return parts.join(" ");
}

export function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some((hook) => hook?.type === "command" && MARKER.test(hook.command ?? ""));
}

/** 기존 settings JSON에 우리 훅을 넣거나(remove=false) 뺀(remove=true) 결과. 다른 키·다른 훅은 그대로. */
export function mergeHooks(existing: unknown, command: string, remove = false): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const hooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks) ? { ...(base.hooks as Record<string, unknown>) } : {};
  for (const item of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[item.event]) ? (hooks[item.event] as HookGroup[]) : [];
    const kept = groups.filter((group) => !isOurs(group));
    if (!remove) kept.push({ ...(item.matcher ? { matcher: item.matcher } : {}), hooks: [{ type: "command", command, timeout: item.timeout }] });
    if (kept.length > 0) hooks[item.event] = kept;
    else delete hooks[item.event];
  }
  if (Object.keys(hooks).length > 0) base.hooks = hooks;
  else delete base.hooks;
  return base;
}

export interface HooksInstallOptions {
  hookPath: string;
  env?: Env;
  home?: string;
  dryRun?: boolean;
  remove?: boolean;
}

export interface HooksInstallResult {
  file: string;
  backup: string | null;
  unchanged: boolean;
  command: string;
  events: string[];
}

export async function installHooks(options: HooksInstallOptions): Promise<HooksInstallResult> {
  const hookPath = path.resolve(options.hookPath);
  if (!options.remove && !fs.existsSync(hookPath)) {
    throw new InstallError(`훅 파일이 없습니다: ${hookPath} — 먼저 'npm run build'를 하세요.`);
  }
  const file = settingsPath(options.home);
  const command = hookCommand(hookPath, options.env);
  // install.ts와 같은 계획·쓰기 — 깨진 JSON이면 건드리지 않고 멈추고, .bak을 남기고, 임시 파일 + rename
  const plan = planJson(file, (existing) => mergeHooks(existing, command, options.remove));
  const events = HOOK_EVENTS.map((item) => item.event);
  if (options.dryRun || plan.unchanged) return { file, backup: null, unchanged: plan.unchanged, command, events };
  return { file, backup: writeJson(plan), unchanged: false, command, events };
}

/** settings.json에 적힌 우리 훅 명령들 (doctor용). 없으면 빈 배열. */
export function readInstalledHooks(file: string): { event: string; command: string }[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: Record<string, HookGroup[]> };
    const out: { event: string; command: string }[] = [];
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of group.hooks ?? []) if (hook?.type === "command" && MARKER.test(hook.command ?? "")) out.push({ event, command: hook.command });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 훅 명령 문자열에서 node와 hook.js 경로를 꺼낸다 (doctor가 존재 여부를 본다) */
export function parseHookCommand(command: string): { node: string; hook: string } | null {
  const match = /^"([^"]+)"\s+"([^"]+)"/.exec(command);
  return match ? { node: match[1], hook: match[2] } : null;
}
