/**
 * Claude Code 훅 처리 — stdin JSON 하나를 받아 할 일을 정한다 (docs/enhancement-plan.md §3-2·§3-3·§3-5).
 *
 *   PreToolUse(Edit·Write·MultiEdit)  편집 직전: 그 파일의 맥락(context.ts)을 400자 안에 `additionalContext`로.
 *                                     세션당 파일당 한 번, 줄 것이 없으면 아무것도 내지 않는다.
 *   UserPromptSubmit                  사용자 프롬프트를 세션 기록에 (capture.ts)
 *   PostToolUse(Bash·Edit·Write)      검증 명령·편집 파일을 세션 기록에, `git commit`이면 그때까지의 기록을 커밋에 묶는다
 *   SessionStart(startup·clear·compact) 작업 레포 요약 한 덩어리 (plain stdout)
 *
 * 원칙: 절대 작업을 막지 않는다(항상 exit 0, 여기서는 던지지 않고 null), 동기화는 하지 않는다(DB만 읽고 세션 기록만 쓴다),
 * 세션 상태는 `<GRIMOIRE_HOME>/sessions/<session_id>.json` 파일 하나.
 */
import fs from "node:fs";
import path from "node:path";

import { isIndexable } from "../core/code";
import { grimoireHome, type Env } from "../core/config";
import { fileContext, formatFileContext, TEST_PATH, HOOK_BUDGET } from "../core/context";
import type { DB } from "../core/db";
import { relativeToRepo, repoOfPath, type RepoRow } from "../core/indexer";

/** 훅이 돌려주는 것 — Claude Code 규약(JSON은 hookSpecificOutput, 일부 이벤트는 plain stdout) */
export interface HookOutput {
  json?: { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  stdout?: string;
}

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  prompt?: string;
  source?: string;
  agent_id?: string;
  [key: string]: unknown;
}

/** 세션 파일 — 이 세션에서 이미 보여 준 파일과 상태 */
export interface SessionState {
  startedAt: string;
  updatedAt: string;
  /** "repoId:path" → 그때의 HEAD 트리 (바뀌면 다시 보여 준다) */
  shown: Record<string, string>;
  /** "candidates, not instructions" 한 줄을 이미 붙였나 */
  noted: boolean;
  /** 이 세션에서 첫 번째 실패한 검증이 지나갔나 (막혔을 때 2단계, §3-5) */
  struggled: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** 세션 파일 보존 기간 */
export const SESSION_TTL_DAYS = 14;

export function sessionsDir(env: Env): string {
  return path.join(grimoireHome(env), "sessions");
}

export function loadSession(env: Env, sessionId: string): SessionState {
  const file = path.join(sessionsDir(env), `${safeId(sessionId)}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SessionState>;
    return {
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      shown: parsed.shown ?? {},
      noted: parsed.noted ?? false,
      struggled: parsed.struggled ?? false,
    };
  } catch {
    return { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), shown: {}, noted: false, struggled: false };
  }
}

export function saveSession(env: Env, sessionId: string, state: SessionState): void {
  const dir = sessionsDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safeId(sessionId)}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 오래된 세션 파일 정리 (SessionStart 때) */
export function pruneSessions(env: Env, now = Date.now()): number {
  const dir = sessionsDir(env);
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SESSION_TTL_DAYS * 86_400_000) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // 이미 지워짐
    }
  }
  return removed;
}

function safeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown";
}

/** 편집 대상 파일의 절대경로 (도구별 인자 이름이 같다) */
function editedPath(input: HookInput): string | null {
  const value = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  return typeof value === "string" && value.trim() ? value : null;
}

export interface HookContext {
  db: DB;
  env: Env;
  me: string[];
  /** 레포 HEAD 트리를 읽는다 — 테스트에서 바꿔 끼운다 */
  headOf?: (repo: RepoRow) => string;
}

/**
 * 훅 입력 하나를 처리한다. 돌려줄 것이 없으면 null. 던지지 않는다 — 실패는 호출부가 로그로 남기고 exit 0.
 */
export function handleHook(context: HookContext, input: HookInput): HookOutput | null {
  if (context.env.GRIMOIRE_HOOKS === "0") return null;
  switch (input.hook_event_name) {
    case "PreToolUse":
      return preToolUse(context, input);
    default:
      return null;
  }
}

function preToolUse(context: HookContext, input: HookInput): HookOutput | null {
  if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return null;
  const file = editedPath(input);
  if (!file) return null;
  const repo = repoOfPath(context.db, file);
  if (!repo) return null;
  const relative = relativeToRepo(repo.path, file);
  // 테스트·생성·비소스 파일은 건너뛴다 — 맥락을 줄 가치가 낮고 매 편집마다 글자를 쓴다
  if (TEST_PATH.test(relative) || !isIndexable(relative, 0)) return null;

  const sessionId = input.session_id ?? "unknown";
  const state = loadSession(context.env, sessionId);
  const head = context.headOf ? context.headOf(repo) : (repo.head_tree ?? "");
  const key = `${repo.id}:${relative}`;
  // 같은 세션에서 같은 파일은 한 번만 — HEAD가 바뀌었으면(커밋 뒤) 다시 (§10-1: 고정 노출 < 한 번 노출)
  if (state.shown[key] === head) return null;
  state.shown[key] = head;

  const fileCtx = fileContext(context.db, repo.id, relative);
  let text = "";
  if (fileCtx.worth) {
    text = formatFileContext(fileCtx, { me: context.me, budget: HOOK_BUDGET, first: !state.noted });
    if (text && !state.noted) state.noted = true;
  }
  saveSession(context.env, sessionId, state);
  if (!text) return null;
  return { json: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } } };
}
