/**
 * 세션 캡처 → 커밋에 묶기 (docs/enhancement-plan.md §3-3).
 *
 * 훅(hook/runner.ts)이 세션 중에 모은 것 — 사용자 프롬프트, 검증 명령과 결과, 편집한 파일의 새 줄 해시 — 은
 * `session_events`에 임시로 쌓인다. `git commit`이 감지되면 **직전 커밋 이후**의 기록을 그 sha에 묶어
 * `commit_context`에 영구 저장하고, 커밋 doc 본문에 `[why]`를 덧붙여 그 말로 검색되게 한다.
 * 커밋 없이 끝난 세션의 기록은 SESSION_TTL_DAYS 뒤 지운다.
 *
 * 원문만, 요약 없음. 저장되는 것은 사용자의 말·명령 문자열·줄 해시뿐이다(도구 출력은 실패 stderr 끝 300자만).
 */
import { createHash } from "node:crypto";

import type { DB } from "./db";
import { redact } from "./redact";
import { parseTrailers, whyLines, type Trailer } from "./trailers";

export type EventKind = "prompt" | "verify" | "edit" | "commit";

export interface SessionEvent {
  id: number;
  session_id: string;
  repo_id: number | null;
  at: string;
  kind: EventKind;
  text: string;
  path: string | null;
  line_hashes: string | null;
}

/** 상한 (커밋당) */
const PROMPTS_PER_COMMIT = 10;
const VERIFIES_PER_COMMIT = 20;
const EDITS_PER_COMMIT = 200;
export const PROMPT_MAX = 1_000;
const STDERR_TAIL = 300;
const HASHES_PER_EDIT = 200;
export const SESSION_TTL_DAYS = 14;

/** 검증 명령 — 테스트·린트·타입체크·빌드 */
export const VERIFY_COMMAND =
  /\b(npm (test|run (test|e2e|typecheck|lint|check|build)\w*)|npx (vitest|jest|tsc|eslint|playwright)|pnpm (test|run (test|lint|typecheck)\w*)|yarn (test|lint|typecheck)|bun test|pytest|python -m (pytest|unittest)|go (test|vet)|cargo (test|check|clippy)|gradle(w)? (test|check)|mvn (test|verify)|make (test|check)|dotnet test|mix test|rspec|bundle exec rspec|phpunit|swift test|ruff|mypy|flake8)\b/;
const GIT_COMMIT = /(^|[;&|]\s*)git\s+(-C\s+\S+\s+)?commit\b/;
const COMMIT_FAILED = /nothing to commit|nothing added to commit|error:|fatal:|Aborting commit/i;

export function isVerifyCommand(command: string): boolean {
  return VERIFY_COMMAND.test(command);
}

export function isGitCommit(command: string): boolean {
  return GIT_COMMIT.test(command);
}

/** `git commit`이 실제로 커밋을 만들었나 — tool_response로 추정 */
export function commitSucceeded(response: { stdout?: unknown; stderr?: unknown; interrupted?: unknown } | undefined): boolean {
  if (!response || response.interrupted === true) return false;
  const text = `${String(response.stdout ?? "")}\n${String(response.stderr ?? "")}`;
  return !COMMIT_FAILED.test(text);
}

/** 검증 결과 추정 — exit code가 없으므로 stderr가 비고 중단되지 않았으면 통과로 본다 */
export function verifyOutcome(response: { stdout?: unknown; stderr?: unknown; interrupted?: unknown } | undefined): { ok: boolean; tail: string } {
  const stderr = String(response?.stderr ?? "").trim();
  const stdout = String(response?.stdout ?? "");
  const failedWords = /\b(FAIL|failed|failing|error|Error|✗|✖|not ok)\b/.test(stdout) && !/\b0 (failed|failing)\b/.test(stdout);
  const ok = response?.interrupted !== true && !stderr && !failedWords;
  const tail = ok ? "" : (stderr || stdout).slice(-STDERR_TAIL).trim();
  return { ok, tail };
}

/** 줄 해시 — 정확 해시와 공백 제거 해시 (Agent Blame 방식: 1.0 / 0.95) */
export function lineHashes(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.push(hash(line), hash(line.replace(/\s+/g, "")));
    if (out.length >= HASHES_PER_EDIT * 2) break;
  }
  return out;
}

function hash(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 14);
}

/* ── 세션 기록 ──────────────────────────────────────────── */

export function recordEvent(
  db: DB,
  event: { sessionId: string; repoId: number | null; kind: EventKind; text: string; path?: string | null; lineHashes?: string[] },
  at = new Date().toISOString(),
): void {
  db.prepare("INSERT INTO session_events (session_id, repo_id, at, kind, text, path, line_hashes) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    event.sessionId,
    event.repoId,
    at,
    event.kind,
    event.text,
    event.path ?? null,
    event.lineHashes ? JSON.stringify(event.lineHashes) : null,
  );
}

/** 프롬프트 하나를 기록한다 — 슬래시 명령·빈 것은 버리고, 비밀을 지우고, 길이를 자른다 */
export function recordPrompt(db: DB, sessionId: string, repoId: number | null, prompt: string): boolean {
  const cleaned = redact(prompt).trim();
  if (!cleaned || cleaned.startsWith("/")) return false;
  recordEvent(db, { sessionId, repoId, kind: "prompt", text: cleaned.slice(0, PROMPT_MAX) });
  return true;
}

/** 직전 커밋 이후 이 세션·레포의 기록 */
export function pendingEvents(db: DB, sessionId: string, repoId: number): SessionEvent[] {
  const last = db
    .prepare("SELECT at FROM session_events WHERE session_id = ? AND repo_id = ? AND kind = 'commit' ORDER BY at DESC, id DESC LIMIT 1")
    .get(sessionId, repoId) as { at: string } | undefined;
  return db
    .prepare(
      `SELECT * FROM session_events WHERE session_id = ? AND (repo_id = ? OR (repo_id IS NULL AND kind = 'prompt')) AND kind <> 'commit'
        ${last ? "AND at > ?" : ""} ORDER BY at, id`,
    )
    .all(sessionId, repoId, ...(last ? [last.at] : [])) as SessionEvent[];
}

/** 오래된 세션 기록 삭제 */
export function pruneEvents(db: DB, now = Date.now()): number {
  const cutoff = new Date(now - SESSION_TTL_DAYS * 86_400_000).toISOString();
  return Number(db.prepare("DELETE FROM session_events WHERE at < ?").run(cutoff).changes);
}

/* ── 커밋에 묶기 ────────────────────────────────────────── */

export interface BindInput {
  sessionId: string;
  repoId: number;
  sha: string;
  /** 커밋의 변경 파일 (레포 기준 경로) */
  files: string[];
  /** 커밋 diff에 새로 들어간 줄의 해시 집합 (edit 이벤트의 해시와 대조해 dropped를 가린다) */
  addedHashes: Set<string>;
}

export interface BindResult {
  prompts: number;
  verifies: number;
  dropped: string[];
}

/**
 * 직전 커밋 이후의 세션 기록을 sha에 묶는다. 기록의 형태는 네 칸 — 어디(변경 파일·심볼은 커밋에 있다) → 왜(프롬프트) →
 * 무엇(symbols) → 검증(verify). 버린 편집(dropped) = 편집했으나 커밋 diff에 그 줄이 하나도 없는 파일.
 * 증상만 있는 프롬프트(에러 메시지 붙여 넣기 등)는 "왜"로 쓰지 않는다 — 기록은 하되 첫 줄이 길이 20 미만이거나 코드 블록이면 뒤로.
 */
export function bindToCommit(db: DB, input: BindInput): BindResult {
  const events = pendingEvents(db, input.sessionId, input.repoId);
  const prompts = events.filter((event) => event.kind === "prompt").slice(-PROMPTS_PER_COMMIT);
  const verifies = events.filter((event) => event.kind === "verify").slice(-VERIFIES_PER_COMMIT);
  const edits = events.filter((event) => event.kind === "edit").slice(-EDITS_PER_COMMIT);
  const committed = new Set(input.files);
  const dropped = new Set<string>();
  for (const edit of edits) {
    if (!edit.path || committed.has(edit.path)) continue;
    const hashes = edit.line_hashes ? (JSON.parse(edit.line_hashes) as string[]) : [];
    if (hashes.length === 0 || !hashes.some((item) => input.addedHashes.has(item))) dropped.add(edit.path);
  }
  // 의도가 될 프롬프트를 앞으로 — 증상만 있는 줄(짧거나 코드 블록·스택 트레이스 꼴)은 뒤로
  const ordered = [...prompts].sort((a, b) => Number(isSymptomOnly(b.text)) - Number(isSymptomOnly(a.text)) || a.id - b.id);

  const insert = db.prepare("INSERT OR REPLACE INTO commit_context (repo_id, sha, kind, text, ord) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    ordered.forEach((event, index) => insert.run(input.repoId, input.sha, "prompt", event.text, index));
    verifies.forEach((event, index) => insert.run(input.repoId, input.sha, "verify", event.text, index));
    [...dropped].forEach((file, index) => insert.run(input.repoId, input.sha, "dropped", file, index));
    recordEvent(db, { sessionId: input.sessionId, repoId: input.repoId, kind: "commit", text: input.sha });
    refreshWhy(db, input.repoId, input.sha);
  })();
  return { prompts: prompts.length, verifies: verifies.length, dropped: [...dropped] };
}

/** 첫 줄이 증상·오류 붙여 넣기 꼴인가 (의도가 아니라 현상) */
export function isSymptomOnly(text: string): boolean {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (first.length < 12) return true;
  if (/^(```|Error|TypeError|Traceback|at |\w+Error:|FAIL|npm ERR!|error TS\d+)/.test(first)) return true;
  if (/^[\[{<]/.test(first)) return true;
  return false;
}

/* ── 트레일러 → commit_context ──────────────────────────── */

/** 커밋 본문의 트레일러를 commit_context에 넣는다 (indexer가 커밋을 넣을 때·백필 때). 돌려주는 값은 넣은 수. */
export function storeTrailers(db: DB, repoId: number, sha: string, body: string): Trailer[] {
  const trailers = parseTrailers(body);
  if (trailers.length === 0) return [];
  const insert = db.prepare("INSERT OR REPLACE INTO commit_context (repo_id, sha, kind, text, ord) VALUES (?, ?, ?, ?, ?)");
  const counts = new Map<string, number>();
  for (const trailer of trailers) {
    const ord = counts.get(trailer.key) ?? 0;
    counts.set(trailer.key, ord + 1);
    insert.run(repoId, sha, `trailer:${trailer.key}`, trailer.value, ord);
  }
  return trailers;
}

/* ── 검색 본문의 [why] ──────────────────────────────────── */

const WHY_MARK = "\n[why] ";
/** 검색 본문에 덧붙이는 왜 줄 수·길이 상한 */
const WHY_LINES_MAX = 6;
const WHY_LINE_CHARS = 200;

/** 커밋에 묶인 왜(프롬프트·트레일러)를 커밋 doc 본문 뒤에 다시 붙인다 — 그 말로 검색되게 */
export function refreshWhy(db: DB, repoId: number, sha: string): void {
  const doc = db.prepare("SELECT d.id, f.title, f.body, f.paths, f.code FROM docs d JOIN docs_fts f ON f.rowid = d.id WHERE d.kind = 'commit' AND d.repo_id = ? AND d.ref = ?").get(repoId, sha) as
    | { id: number; title: string; body: string; paths: string; code: string }
    | undefined;
  if (!doc) return;
  const rows = db.prepare("SELECT kind, text FROM commit_context WHERE repo_id = ? AND sha = ? ORDER BY kind, ord").all(repoId, sha) as { kind: string; text: string }[];
  const lines = [
    ...rows.filter((row) => row.kind === "prompt").map((row) => row.text.split("\n")[0]),
    ...whyLines(rows.filter((row) => row.kind.startsWith("trailer:")).map((row) => ({ key: row.kind.slice("trailer:".length), value: row.text }))),
  ]
    .map((line) => line.trim().slice(0, WHY_LINE_CHARS))
    .filter(Boolean)
    .slice(0, WHY_LINES_MAX);
  const base = doc.body.split(WHY_MARK)[0];
  const body = lines.length > 0 ? `${base}${WHY_MARK}${lines.join(WHY_MARK)}` : base;
  if (body === doc.body) return;
  db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(doc.id);
  db.prepare("INSERT INTO docs_fts (rowid, title, body, paths, code) VALUES (?, ?, ?, ?, ?)").run(doc.id, doc.title, body, doc.paths, doc.code ?? "");
}

/* ── 읽기 ───────────────────────────────────────────────── */

export interface CommitContextView {
  prompts: string[];
  verify: string[];
  dropped: string[];
  trailers: Trailer[];
}

export function commitContextOf(db: DB, repoId: number, sha: string): CommitContextView | null {
  const rows = db.prepare("SELECT kind, text FROM commit_context WHERE repo_id = ? AND sha = ? ORDER BY kind, ord").all(repoId, sha) as { kind: string; text: string }[];
  if (rows.length === 0) return null;
  return {
    prompts: rows.filter((row) => row.kind === "prompt").map((row) => row.text),
    verify: rows.filter((row) => row.kind === "verify").map((row) => row.text),
    dropped: rows.filter((row) => row.kind === "dropped").map((row) => row.text),
    trailers: rows.filter((row) => row.kind.startsWith("trailer:")).map((row) => ({ key: row.kind.slice("trailer:".length), value: row.text })),
  };
}

/** 검색 결과 한 줄짜리 why — 첫 프롬프트의 첫 줄, 없으면 Why/Constraint 트레일러 */
export function whyLine(db: DB, repoId: number, sha: string, max = 120): string | undefined {
  const view = commitContextOf(db, repoId, sha);
  if (!view) return undefined;
  const intent =
    view.prompts.find((text) => !isSymptomOnly(text))?.split("\n")[0] ??
    view.trailers.find((trailer) => trailer.key === "why" || trailer.key === "constraint" || trailer.key === "what")?.value;
  if (!intent) return undefined;
  const line = intent.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
