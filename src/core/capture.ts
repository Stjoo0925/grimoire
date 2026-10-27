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
import path from "node:path";

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
const GIT_COMMIT = /(^|[;&|]\s*)git\s+(-C\s+("[^"]+"|'[^']+'|\S+)\s+)?commit\b/;
const COMMIT_FAILED = /nothing to commit|nothing added to commit|error:|fatal:|Aborting commit/i;

export function isVerifyCommand(command: string): boolean {
  return VERIFY_COMMAND.test(command);
}

export function isGitCommit(command: string): boolean {
  return GIT_COMMIT.test(command);
}

/**
 * `git commit`이 돈 폴더 — `git -C <경로> commit`이면 그 경로(따옴표 허용, 상대경로는 cwd 기준), 아니면 cwd.
 * 에이전트가 다른 폴더(다른 워크트리)를 -C로 가리키고 커밋하면 세션 폴더의 HEAD는 그 커밋이 아니다.
 */
export function commitDir(command: string, cwd: string): string {
  const match = /(?:^|[;&|]\s*)git\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))\s+commit\b/.exec(command);
  const target = match ? (match[2] ?? match[3] ?? match[4]) : null;
  return target ? path.resolve(cwd, target) : cwd;
}

/** `git commit`이 실제로 커밋을 만들었나 — tool_response로 추정 */
export function commitSucceeded(response: { stdout?: unknown; stderr?: unknown; interrupted?: unknown } | undefined): boolean {
  if (!response || response.interrupted === true) return false;
  const text = `${String(response.stdout ?? "")}\n${String(response.stderr ?? "")}`;
  return !COMMIT_FAILED.test(text);
}

/**
 * 검증 도구들이 실패했을 때 실제로 찍는 요약 꼴. Bash 응답에는 종료 코드가 없어 출력으로 짐작하는데,
 * "error"·"FAIL" 낱말이나 stderr가 비지 않은 것만으로는 판정하지 않는다 — git의 줄바꿈 경고, npm warn, 검증 명령과 함께
 * 돌린 다른 명령의 출력(소스 줄의 `row.error` 등)이 모두 실패로 잡혔다(도그푸딩). 실패 수는 1 이상일 때만 센다.
 */
const FAILURE_SUMMARY: RegExp[] = [
  /^ℹ fail [1-9]\d*/m, // node:test
  /^# fail [1-9]\d*/m, // node:test TAP
  /^not ok \d+ /m, // TAP
  // 실패 수는 요약 줄 모양일 때만 — 통과한 테스트 이름에 "2 failed attempts" 같은 말이 들어 있을 수 있다
  /^\s*Tests?:?\s+(.*[,|]\s*)?[1-9]\d* failed\b/m, // jest "Tests:  1 failed, 2 passed" · vitest "Tests  1 failed | 2 passed"
  /^\s*Test Files\s+[1-9]\d* failed\b/m, // vitest
  /^\s+[1-9]\d* failing\b/m, // mocha
  /^=+ .*\b[1-9]\d* (failed|errors?)\b.*=+\s*$/m, // pytest "==== 1 failed, 2 passed in 0.1s ===="
  /^\s*FAIL\s+\S/m, // jest·vitest 파일 줄
  /^(--- )?FAIL\b/m, // go test
  /^FAILED\s+\S/m, // pytest
  /\btest result: FAILED\b/, // cargo test
  /\berror TS\d+:/, // tsc
  /^\S+\.(ts|tsx|js|jsx|py|go|rs):\d+(:\d+)?: error\b/m, // 컴파일러 꼴 "file:line: error"
  /^error(\[E\d+\])?: /m, // rustc·cargo
  /^npm (ERR!|error) /m, // npm (10+는 "npm error")
  /✖ [1-9]\d* problems?\b/, // eslint
  /^Found [1-9]\d* errors?\b/m, // tsc --build·mypy
  /\bexit(ed)? (with )?code [1-9]\d*\b/i, // 실행기가 남기는 종료 코드
  // 요약을 찍기 전에 죽은 경우 — 러너·빌드 도구가 시작부터 실패하면 위의 요약 줄이 없다
  /^Traceback \(most recent call last\):/m, // python
  /^Error: Cannot find module\b/m, // node: 없는 모듈로 러너가 못 뜸
  /^\w*Error \[ERR_[A-Z_]+\]/m, // node 내부 오류 코드 (ERR_MODULE_NOT_FOUND 등)
  /^error during build:/m, // vite
  /^ERROR in /m, // webpack
  /^Build failed\b/im, // esbuild·tsup 등
];

export function verifyOutcome(response: { stdout?: unknown; stderr?: unknown; interrupted?: unknown } | undefined): { ok: boolean; tail: string } {
  const stdout = String(response?.stdout ?? "");
  const stderr = String(response?.stderr ?? "");
  const text = `${stdout}\n${stderr}`;
  const failed = response?.interrupted === true || FAILURE_SUMMARY.some((pattern) => pattern.test(text));
  const tail = failed ? text.trim().slice(-STDERR_TAIL).trim() : "";
  return { ok: !failed, tail };
}

/**
 * 저장할 검증 기록 한 줄 — "명령 → pass|fail :: 실패 출력 끝". 명령과 출력은 저장 전에 비밀을 지운다
 * (`API_KEY=sk-… npm test`처럼 명령에 값을 붙여 돌리거나, 실패 출력에 토큰이 찍힐 수 있다). 자르기 전에 지운다 —
 * 자른 뒤 지우면 반쯤 잘린 토큰이 패턴에 안 걸려 남는다.
 */
export function verifyRecord(command: string, outcome: { ok: boolean; tail: string }): string {
  const cleanCommand = redact(command).trim().slice(0, 200);
  const cleanTail = outcome.tail ? redact(outcome.tail) : "";
  return `${cleanCommand} → ${outcome.ok ? "pass" : "fail"}${cleanTail ? ` :: ${cleanTail}` : ""}`;
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

/**
 * 이미 저장된 세션 기록(대기 중인 이벤트와 커밋에 묶인 프롬프트·검증)에 지금의 비밀 지우기 규칙을 다시 적용한다 —
 * 규칙이 보강되면 그 전에 저장된 것에도 닿게(마이그레이션 8). 프롬프트가 바뀐 커밋은 검색 문서의 [why]도 다시 쓴다.
 * 트레일러는 git 커밋 본문 그대로라 건드리지 않는다. 바뀐 행 수를 돌려준다.
 */
export function reRedactStored(db: DB): number {
  let changed = 0;
  const events = db.prepare("SELECT id, text FROM session_events WHERE kind IN ('prompt', 'verify')").all() as { id: number; text: string }[];
  const setEvent = db.prepare("UPDATE session_events SET text = ? WHERE id = ?");
  for (const row of events) {
    const clean = redact(row.text);
    if (clean === row.text) continue;
    setEvent.run(clean, row.id);
    changed++;
  }
  const rows = db.prepare("SELECT repo_id, sha, kind, ord, text FROM commit_context WHERE kind IN ('prompt', 'verify')").all() as {
    repo_id: number;
    sha: string;
    kind: string;
    ord: number;
    text: string;
  }[];
  const setContext = db.prepare("UPDATE commit_context SET text = ? WHERE repo_id = ? AND sha = ? AND kind = ? AND ord = ?");
  const touched = new Map<string, { repoId: number; sha: string }>();
  for (const row of rows) {
    const clean = redact(row.text);
    if (clean === row.text) continue;
    setContext.run(clean, row.repo_id, row.sha, row.kind, row.ord);
    changed++;
    if (row.kind === "prompt") touched.set(`${row.repo_id}\0${row.sha}`, { repoId: row.repo_id, sha: row.sha });
  }
  for (const { repoId, sha } of touched.values()) refreshWhy(db, repoId, sha);
  return changed;
}

/* ── 읽기 ───────────────────────────────────────────────── */

export interface CommitContextView {
  prompts: string[];
  verify: string[];
  dropped: string[];
  trailers: Trailer[];
}

/** 같은 변경으로 남은 다른 커밋들 (squash 머지 ↔ 브랜치 원본, commits.change_key) */
export function sameChangeShas(db: DB, repoId: number, sha: string): string[] {
  return (
    db
      .prepare(
        `SELECT other.sha FROM commits self JOIN commits other ON other.repo_id = self.repo_id AND other.change_key = self.change_key
          WHERE self.repo_id = ? AND self.sha = ? AND self.change_key IS NOT NULL AND other.sha <> self.sha
          ORDER BY other.authored_at DESC`,
      )
      .all(repoId, sha) as { sha: string }[]
  ).map((row) => row.sha);
}

/**
 * 커밋에 묶인 맥락. 세션 기록(프롬프트·검증·버린 편집)은 커밋이 생긴 자리(워크트리의 브랜치 커밋)에 묶이는데,
 * PR을 squash로 합치면 main에는 다른 sha가 남는다 — 그 커밋에 세션 기록이 없으면 같은 변경의 다른 커밋에서 가져온다.
 * 트레일러도 자기 것이 없을 때만 빌려 온다(squash 메시지가 다시 쓰였을 수 있다).
 */
export function commitContextOf(db: DB, repoId: number, sha: string): CommitContextView | null {
  const query = db.prepare("SELECT kind, text FROM commit_context WHERE repo_id = ? AND sha = ? ORDER BY kind, ord");
  let rows = query.all(repoId, sha) as { kind: string; text: string }[];
  const isSession = (kind: string) => kind === "prompt" || kind === "verify" || kind === "dropped";
  const isTrailer = (kind: string) => kind.startsWith("trailer:");
  // 세션 기록과 트레일러는 따로 찾는다 — 한 형제에 트레일러만, 다른 형제에 세션 기록만 있을 수 있다.
  // 같은 종류는 한 커밋 것만 통째로 (두 커밋 것을 섞지 않는다)
  let needSession = !rows.some((row) => isSession(row.kind));
  let needTrailers = !rows.some((row) => isTrailer(row.kind));
  if (needSession || needTrailers) {
    for (const other of sameChangeShas(db, repoId, sha)) {
      const theirs = query.all(repoId, other) as { kind: string; text: string }[];
      const session = needSession ? theirs.filter((row) => isSession(row.kind)) : [];
      const trailers = needTrailers ? theirs.filter((row) => isTrailer(row.kind)) : [];
      rows = [...rows, ...session, ...trailers];
      if (session.length > 0) needSession = false;
      if (trailers.length > 0) needTrailers = false;
      if (!needSession && !needTrailers) break;
    }
  }
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
