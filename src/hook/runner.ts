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

import {
  bindToCommit,
  commitContextOf,
  commitDir,
  commitSucceeded,
  isGitCommit,
  isSymptomOnly,
  isVerifyCommand,
  lineHashes,
  pendingEvents,
  pruneEvents,
  recordEvent,
  recordPrompt,
  verifyOutcome,
  verifyRecord,
  whyLine,
} from "../core/capture";
import { isIndexable } from "../core/code";
import { grimoireHome, type Env } from "../core/config";
import { fileContext, formatFileContext, needsCochangeBackfill, TEST_PATH, HOOK_BUDGET } from "../core/context";
import type { DB } from "../core/db";
import { addedLines, headSha } from "../core/git";
import { indexCommitSha, resolveRepoFile, type RepoRow } from "../core/indexer";

/** 훅이 돌려주는 것 — Claude Code 규약(JSON은 hookSpecificOutput, 일부 이벤트는 plain stdout) */
export interface HookOutput {
  json?: { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  stdout?: string;
  /** 응답을 낸 뒤 백그라운드로 동기화할 레포 경로 — 훅은 기다리지 않는다(hook.ts가 떼어 낸 프로세스로 띄운다) */
  syncRepo?: string;
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
 * 훅 입력 하나를 처리한다. 돌려줄 것이 없으면 null. 던질 수 있다 — 호출부(hook.ts)가 로그로 남기고 exit 0.
 */
export async function handleHook(context: HookContext, input: HookInput): Promise<HookOutput | null> {
  if (context.env.GRIMOIRE_HOOKS === "0") return null;
  switch (input.hook_event_name) {
    case "PreToolUse":
      return preToolUse(context, input);
    case "UserPromptSubmit":
      return userPromptSubmit(context, input);
    case "PostToolUse":
      return postToolUse(context, input);
    case "SessionStart":
      return sessionStart(context, input);
    default:
      return null;
  }
}

/** 캡처가 켜져 있나 — 기본 켜짐(훅을 설치한 것이 opt-in), GRIMOIRE_CAPTURE=0이면 끔. 서브에이전트의 말은 사용자의 말이 아니다 */
function captureOn(context: HookContext, input: HookInput): boolean {
  return context.env.GRIMOIRE_CAPTURE !== "0" && !input.agent_id;
}

/** 세션의 작업 폴더가 속한 등록 레포 — 레포 밖의 추가 작업 트리(git worktree)면 본 레포 */
async function sessionRepo(context: HookContext, input: HookInput): Promise<RepoRow | undefined> {
  return input.cwd ? (await resolveRepoFile(context.db, input.cwd))?.repo : undefined;
}

async function userPromptSubmit(context: HookContext, input: HookInput): Promise<HookOutput | null> {
  if (!captureOn(context, input) || typeof input.prompt !== "string" || !input.session_id) return null;
  recordPrompt(context.db, input.session_id, (await sessionRepo(context, input))?.id ?? null, input.prompt);
  return null;
}

async function postToolUse(context: HookContext, input: HookInput): Promise<HookOutput | null> {
  if (!captureOn(context, input) || !input.session_id) return null;
  const repo = await sessionRepo(context, input);
  if (!repo) return null;
  if (EDIT_TOOLS.has(input.tool_name ?? "")) {
    const file = editedPath(input);
    if (!file) return null;
    // 세션 레포의 파일만 — 다른 레포 파일을 고친 것은 이 세션의 커밋에 묶이지 않는다
    const resolved = await resolveRepoFile(context.db, file);
    if (!resolved || resolved.repo.id !== repo.id) return null;
    const relative = resolved.relative;
    const added = newText(input.tool_input ?? {});
    recordEvent(context.db, { sessionId: input.session_id, repoId: repo.id, kind: "edit", text: relative, path: relative, lineHashes: lineHashes(added) });
    return null;
  }
  if (input.tool_name !== "Bash") return null;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command) return null;
  if (isVerifyCommand(command)) {
    const outcome = verifyOutcome(input.tool_response);
    const text = verifyRecord(command, outcome);
    recordEvent(context.db, { sessionId: input.session_id, repoId: repo.id, kind: "verify", text });
    if (!outcome.ok) {
      // 막혔을 때 2단계(§3-5): 이 세션의 첫 번째 실패한 검증 뒤 한 번만, 편집 중인 파일들의 왜·검증·버린 편집을 건넨다.
      // 막히지 않은 세션에는 비용이 없다. (REM: "막혔을 때 한 번" > "첫 편집 때 바로" > "항상 고정")
      const state = loadSession(context.env, input.session_id);
      if (!state.struggled) {
        state.struggled = true;
        saveSession(context.env, input.session_id, state);
        const text = struggleContext(context, repo, input.session_id);
        if (text) return { json: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } } };
      }
    }
  }
  if (isGitCommit(command) && commitSucceeded(input.tool_response)) {
    // 커밋은 명령이 돈 작업 폴더의 HEAD다 — 워크트리에서 일하는 세션이면 본 레포 폴더의 HEAD와 다르다
    // (본 레포 폴더에서 읽으면 세션 기록이 엉뚱한 커밋에 묶인다). 커밋 저장소는 같으므로 색인은 본 레포로 한다
    const cwd = input.cwd ?? repo.path;
    const where = commitDir(command, cwd);
    // `git -C ../다른레포 commit`이면 그 커밋은 이 세션 레포의 것이 아니다 — 세션 기록을 남의 sha에 묶지 않는다
    if (where !== cwd && (await resolveRepoFile(context.db, where))?.repo.id !== repo.id) return null;
    const sha = await headSha(where);
    if (!sha) return null;
    // 커밋을 바로 색인해 두면(다음 동기화를 기다리지 않고) 묶을 수 있고 검색에도 바로 걸린다
    const files = (await indexCommitSha(context.db, repo, sha)) ?? [];
    const addedHashes = new Set(lineHashes((await addedLines(where, sha)).join("\n")));
    bindToCommit(context.db, { sessionId: input.session_id, repoId: repo.id, sha, files, addedHashes });
  }
  return null;
}

/** 편집 도구가 새로 넣는 텍스트 (Edit의 new_string, Write의 content, MultiEdit의 edits[].new_string) */
function newText(toolInput: Record<string, unknown>): string {
  if (typeof toolInput.new_string === "string") return toolInput.new_string;
  if (typeof toolInput.content === "string") return toolInput.content;
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((edit) => (edit && typeof edit === "object" && typeof (edit as { new_string?: unknown }).new_string === "string" ? (edit as { new_string: string }).new_string : "")).join("\n");
  }
  if (typeof toolInput.new_source === "string") return toolInput.new_source;
  return "";
}

/** 막혔을 때 2단계의 글자 예산과 커밋 수 */
const STRUGGLE_BUDGET = 1_200;
const STRUGGLE_COMMITS = 3;

function struggleContext(context: HookContext, repo: RepoRow, sessionId: string): string {
  const edited = [...new Set(pendingEvents(context.db, sessionId, repo.id).filter((event) => event.kind === "edit" && event.path).map((event) => event.path as string))];
  if (edited.length === 0) return "";
  const lines: string[] = [`Grimoire: first failing check in this session — what past commits on the files you're editing recorded`];
  // 본 커밋은 줄 것이 없었어도 다시 보지 않는다 — 여러 파일이 같은 커밋을 공유한다
  const checked = new Set<string>();
  let shown = 0;
  for (const file of edited.slice(0, 5)) {
    const recent = context.db
      .prepare(
        `SELECT c.sha FROM commit_files f JOIN commits c ON c.repo_id = f.repo_id AND c.sha = f.sha
          WHERE f.repo_id = ? AND f.path = ? AND c.meaningful = 1 ORDER BY c.authored_at DESC LIMIT 5`,
      )
      .all(repo.id, file) as { sha: string }[];
    for (const { sha } of recent) {
      if (checked.has(sha) || shown >= STRUGGLE_COMMITS) continue;
      checked.add(sha);
      const view = commitContextOf(context.db, repo.id, sha);
      if (!view) continue;
      // 줄 것부터 모은다 — Co-Authored-By 같은 꼬리표만 있는 커밋은 머리줄만 남는 빈 항목이 되므로 뺀다(도그푸딩).
      // 이 커밋에 줄 것이 없으면 자리(STRUGGLE_COMMITS)도 쓰지 않고 다음 커밋을 본다
      const details: string[] = [];
      const why = whyLine(context.db, repo.id, sha, 160);
      if (why) details.push(`  why: ${why}`);
      const verify = [...view.verify.slice(-2), ...view.trailers.filter((trailer) => trailer.key === "tested").map((trailer) => trailer.value)];
      if (verify.length > 0) details.push(`  verified: ${verify.join(" · ").slice(0, 200)}`);
      if (view.dropped.length > 0) details.push(`  dropped (edited then left out of the commit): ${view.dropped.slice(0, 4).join(", ")}`);
      const rejected = view.trailers.filter((trailer) => trailer.key === "rejected" || trailer.key === "constraint").slice(0, 2);
      for (const trailer of rejected) details.push(`  ${trailer.key}: ${trailer.value.slice(0, 160)}`);
      if (details.length === 0) continue;
      shown++;
      lines.push(`${sha.slice(0, 10)} ${file}:`, ...details);
    }
  }
  if (lines.length === 1) return "";
  const text = lines.join("\n");
  return text.length > STRUGGLE_BUDGET ? `${text.slice(0, STRUGGLE_BUDGET - 1)}…` : text;
}

/** 세션 시작 요약의 글자 예산 */
const START_BUDGET = 600;

/** 마지막 동기화가 이보다 오래면 세션 시작 때 백그라운드로 다시 동기화한다 */
export const SYNC_STALE_MS = 10 * 60_000;

/**
 * 세션 시작 때 이 레포를 백그라운드로 동기화해야 하나 — MCP 없이 훅만 쓰면 아무도 sync를 돌리지 않아
 * 터미널에서 한 커밋·pull로 받은 커밋이 색인되지 않고, 업그레이드로 비워진 공변경 이력도 그대로 남는다.
 * GRIMOIRE_SYNC_ON_START=0이면 MCP 서버와 똑같이 끈다.
 */
export function needsBackgroundSync(db: DB, env: Env, repo: RepoRow, now = Date.now()): boolean {
  if (env.GRIMOIRE_SYNC_ON_START === "0") return false;
  if (!repo.synced_at || needsCochangeBackfill(db, repo.id)) return true;
  return now - Date.parse(repo.synced_at) > SYNC_STALE_MS;
}

/**
 * SessionStart(startup·clear·compact): 작업 레포의 "지난 세션 이후 내 커밋 + 묶인 왜 + 커밋 안 된 편집"을 600자 안에
 * plain stdout으로 (이 이벤트는 stdout이 그대로 컨텍스트가 된다). resume은 세션 파일을 이어 쓸 뿐 다시 내지 않는다.
 */
async function sessionStart(context: HookContext, input: HookInput): Promise<HookOutput | null> {
  pruneSessions(context.env);
  pruneEvents(context.db);
  const repo = await sessionRepo(context, input);
  if (!repo) return null;
  const sync = needsBackgroundSync(context.db, context.env, repo) ? { syncRepo: repo.path } : null;
  if (input.source === "resume") return sync;
  const mine = context.me.map((email) => email.toLowerCase());
  const recent = context.db
    .prepare(
      `SELECT sha, authored_at AS date, author_email AS email, subject FROM commits
        WHERE repo_id = ? AND meaningful = 1 ${mine.length > 0 ? `AND author_email IN (${mine.map(() => "?").join(", ")})` : ""}
        ORDER BY authored_at DESC LIMIT 3`,
    )
    .all(repo.id, ...mine) as { sha: string; date: string; email: string; subject: string }[];
  if (recent.length === 0) return sync;
  const lines = [`Grimoire: ${repo.name} — recent commits${mine.length > 0 ? " (me)" : ""}`];
  for (const commit of recent) {
    const why = whyLine(context.db, repo.id, commit.sha, 100);
    lines.push(`${commit.sha.slice(0, 10)} ${commit.date.slice(0, 10)} "${commit.subject.length > 70 ? `${commit.subject.slice(0, 69)}…` : commit.subject}"${why && !isSymptomOnly(why) ? ` — why: ${why}` : ""}`);
  }
  // 이 레포에서 커밋에 묶이지 않은 채 남은 편집(이전 세션들) — 끝내지 못한 작업의 흔적
  const uncommitted = context.db
    .prepare(
      `SELECT DISTINCT path FROM session_events e WHERE repo_id = ? AND kind = 'edit' AND path IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM session_events c WHERE c.session_id = e.session_id AND c.repo_id = e.repo_id AND c.kind = 'commit' AND c.at > e.at)
        ORDER BY at DESC LIMIT 5`,
    )
    .all(repo.id) as { path: string }[];
  if (uncommitted.length > 0) lines.push(`Edited but not committed in earlier sessions: ${uncommitted.map((row) => row.path).join(", ")}`);
  lines.push("Use file_context before editing; search_memory for \"where/how did I…\".");
  let text = lines.join("\n");
  while (text.length > START_BUDGET && lines.length > 2) {
    lines.splice(lines.length - 2, 1);
    text = lines.join("\n");
  }
  return { stdout: text, ...sync };
}

async function preToolUse(context: HookContext, input: HookInput): Promise<HookOutput | null> {
  if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return null;
  const file = editedPath(input);
  if (!file) return null;
  // 레포 폴더 안이면 git을 부르지 않는다. 레포 밖 워크트리의 파일이면 git 한 번으로 본 레포를 찾는다
  const resolved = await resolveRepoFile(context.db, file);
  if (!resolved) return null;
  const { repo, relative } = resolved;
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
