/**
 * 파일 맥락 — "이 파일을 고치기 전에 알아야 할 것"을 git 이력에서 결정론적으로 뽑는다 (docs/enhancement-plan.md §3-1).
 *
 *   recent   그 경로를 건드린 의미 있는 커밋 최근 3개
 *   why      그 커밋들에 묶인 의도(세션 프롬프트·트레일러, capture.ts) — 검증 신호가 있는 가장 최근 하나
 *   related  같이 바뀌는 파일(공변경) ∪ import 이웃 — "A를 고치면 보통 B도"
 *   tests    같이 바뀌는 테스트 파일 + 이름 규칙 짝 — "뭘 돌려 확인하나"
 *   usedBy   이 파일을 import하는 파일 — "누가 나를 쓰나"
 *   fragile  최근 90일 fix류 커밋 비율 — "요즘 자주 고장 나는 곳인가"
 *
 * 공변경은 커밋을 거래로 본 연관 규칙이다. 파라미터는 문헌값(§10-3)을 따른다:
 *  - 머지·대량 커밋 제외, 파일 2~10개 (상한 6~8에서 MAP 최고, 10·20·30은 유의하게 하락)
 *  - 신뢰도(support/파일 커밋 수)는 필터(≥0.5), 정렬은 최근순 (신뢰도 순 정렬은 모든 시스템에서 최악)
 *  - 이력은 커밋 1만5천 개까지 (그 이상은 체감, 오래된 이력이 해롭다는 증거는 없음)
 *  - 동기화마다 새 커밋의 쌍만 더하는 증분 (모델은 커밋 20개 뒤 3%, 200개 뒤 8% 낡는다)
 * 훅(hook.ts)·MCP 도구(file_context)·CLI가 같은 함수를 쓴다.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { isIndexable, SOURCE_EXT } from "./code";
import type { DB } from "./db";
import type { GitCommit } from "./git";

/**
 * 공변경 거래로 쓰는 커밋의 변경 파일 수 범위. 상한은 GRIMOIRE_COCHANGE_MAX_FILES로 바꿀 수 있다 —
 * 기능 하나를 큰 커밋으로 넣는 레포(파일 10개 초과가 보통)에서는 20~30으로 올려야 신호가 생긴다. 바꾼 뒤 `grimoire sync`가 다시 집계한다.
 */
export const COCHANGE_MIN_FILES = 2;
export const COCHANGE_MAX_FILES = Math.min(60, Math.max(COCHANGE_MIN_FILES, Number.parseInt(process.env.GRIMOIRE_COCHANGE_MAX_FILES ?? "", 10) || 10));
/** 공변경 집계에 넣는 커밋 수 상한 (레포당, 최신부터) */
export const COCHANGE_HISTORY = 15_000;
/** related에 쓰는 신뢰도·지지도 문턱 */
export const MIN_CONFIDENCE = 0.5;
export const STRONG_CONFIDENCE = 0.7;
export const MIN_SUPPORT = 3;
/** 취약도 창과 문턱 */
const FRAGILE_DAYS = 90;
const FRAGILE_MIN_FIXES = 2;
const FRAGILE_MIN_RATIO = 0.3;
const RECENT_COMMITS = 3;
const RELATED_MAX = 3;
const TESTS_MAX = 2;
const USED_BY_MIN = 5;
const USED_BY_SHOWN = 3;

const MERGE_SUBJECT = /^merge\s+(branch|pull request|remote|commit|tag)\b/i;
/** fix류 커밋 — Bugspots 정규식 + bug/revert + 한국어 */
export const FIX_SUBJECT = /\b(fix(es|ed)?|bug|hotfix|regress(ion|ed)?|revert(s|ed)?|close[sd]?)\b|^(fix|hotfix|revert)(\([^)]*\))?!?\s*:|수정|버그|고침/i;
export const TEST_PATH = /(\.(test|spec)\.[^/]+$|(^|\/)(__tests__|tests?|spec)\/|(^|\/)test_[^/]+$|_test\.[^/]+$)/;
/** 문서·설정·잠금 — 취약도에서 "fix"로 세지 않는 변경 */
const NON_CODE = /\.(md|txt|json|ya?ml|toml|lock|snap|svg|png|jpe?g|gif|ico|webp)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/i;

export interface CommitLine {
  sha: string;
  date: string;
  author: string;
  authorEmail: string;
  subject: string;
}

export interface Related {
  path: string;
  support: number;
  /** support / 이 파일을 건드린 공변경 커밋 수 */
  confidence: number;
  strong: boolean;
  /** import 그래프에서도 이웃인가 */
  imports: boolean;
  lastAt: string;
}

export interface TestHint {
  path: string;
  /** "name": 이름 규칙 짝, "cochange": 같이 바뀐 테스트 */
  by: "name" | "cochange";
  support?: number;
  confidence?: number;
}

export interface Why {
  sha: string;
  text: string;
  /** 검증 신호(통과한 검증 명령·Tested 트레일러)가 있는 커밋인가 */
  verified: boolean;
  verify?: string;
}

export interface FileContext {
  path: string;
  recent: CommitLine[];
  why: Why | null;
  related: Related[];
  tests: TestHint[];
  usedBy: { count: number; files: string[] } | null;
  fragile: { fixes: number; total: number; reasons: CommitLine[] } | null;
  /** 줄 만한 것이 있나 — recent만 있으면 false (읽으면 아는 것은 주입하지 않는다) */
  worth: boolean;
}

/* ── 공변경 집계 ────────────────────────────────────────── */

/**
 * 같은 변경 키 — squash 머지 커밋과 브랜치의 원본 커밋은 제목(끝의 "(#N)" 제외)과 변경 파일 집합이 같다.
 * 둘 다 색인되므로(브랜치·태그·원격까지 읽는다) 이 키로 한 번만 센다. 제목만 같고 파일이 다르면 다른 변경이다.
 */
export function changeKey(subject: string, files: string[]): string {
  const normalized = subject.replace(/\s*\(#\d+\)\s*$/, "").trim();
  const set = [...new Set(files)].sort().join("\n");
  return createHash("sha1").update(`${normalized}\0${set}`).digest("hex").slice(0, 20);
}

/** 공변경 거래가 되는 커밋인가 */
export function isCochangeCommit(subject: string, files: string[], meaningful: boolean): boolean {
  if (!meaningful || MERGE_SUBJECT.test(subject)) return false;
  return files.length >= COCHANGE_MIN_FILES && files.length <= COCHANGE_MAX_FILES;
}

/** 커밋 하나를 공변경 테이블에 더한다 (트랜잭션 안에서 부른다) */
export function addCochange(db: DB, repoId: number, commit: { subject: string; authoredAt: string; files: string[]; meaningful: boolean }): boolean {
  const files = [...new Set(commit.files)];
  if (!isCochangeCommit(commit.subject, files, commit.meaningful)) return false;
  // 같은 변경(squash 머지 ↔ 브랜치 원본)은 한 번만 — 두 번 세면 지지도·신뢰도가 부풀어 "strong"이 남발된다
  const seen = db.prepare("INSERT OR IGNORE INTO cochange_seen (repo_id, key) VALUES (?, ?)").run(repoId, changeKey(commit.subject, files));
  if (seen.changes === 0) return false;
  const touch = db.prepare(
    `INSERT INTO file_touches (repo_id, path, commits) VALUES (?, ?, 1)
     ON CONFLICT (repo_id, path) DO UPDATE SET commits = commits + 1`,
  );
  const pair = db.prepare(
    `INSERT INTO cochange (repo_id, path, other, support, last_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (repo_id, path, other) DO UPDATE SET support = support + 1, last_at = max(last_at, excluded.last_at)`,
  );
  for (const file of files) {
    touch.run(repoId, file);
    for (const other of files) if (other !== file) pair.run(repoId, file, other, commit.authoredAt);
  }
  return true;
}

/**
 * DB에 이미 있는 커밋으로 공변경 테이블을 다시 만든다 — 마이그레이션 직후나 깨졌을 때. 최신 커밋부터 상한까지.
 * `until`을 주면 그 시각 미만의 커밋만 (오프라인 평가의 시간 분할용).
 */
export function rebuildCochange(db: DB, repoId: number, until?: string): number {
  db.prepare("DELETE FROM cochange WHERE repo_id = ?").run(repoId);
  db.prepare("DELETE FROM file_touches WHERE repo_id = ?").run(repoId);
  db.prepare("DELETE FROM cochange_seen WHERE repo_id = ?").run(repoId);
  const rows = db
    .prepare(
      `SELECT sha, subject, authored_at, meaningful FROM commits
        WHERE repo_id = ? AND meaningful = 1 AND files_changed BETWEEN ? AND ? ${until ? "AND authored_at < ?" : ""}
        ORDER BY authored_at DESC LIMIT ?`,
    )
    .all(repoId, COCHANGE_MIN_FILES, COCHANGE_MAX_FILES, ...(until ? [until] : []), COCHANGE_HISTORY) as {
    sha: string;
    subject: string;
    authored_at: string;
    meaningful: number;
  }[];
  const filesOf = db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?");
  let added = 0;
  for (const row of rows) {
    const files = (filesOf.all(repoId, row.sha) as { path: string }[]).map((item) => item.path);
    if (addCochange(db, repoId, { subject: row.subject, authoredAt: row.authored_at, files, meaningful: row.meaningful === 1 })) added++;
  }
  return added;
}

/**
 * 공변경 테이블을 다시 만들어야 하는 레포인가 — 비어 있거나(마이그레이션 직후), 같은 변경을 걸러 내지 않은 옛 버전이
 * 만든 것이거나. 후자는 업그레이드 중 아직 떠 있던 옛 프로세스(0.7.x MCP 서버 등)가 비워진 표를 다시 채운 경우로,
 * 공변경 행은 있는데 cochange_seen이 비어 있다 — 그대로 두면 squash 중복으로 부푼 지지도가 영영 남는다.
 */
export function needsCochangeBackfill(db: DB, repoId: number): boolean {
  const has = db.prepare("SELECT 1 FROM cochange WHERE repo_id = ? LIMIT 1").get(repoId);
  if (has) return !db.prepare("SELECT 1 FROM cochange_seen WHERE repo_id = ? LIMIT 1").get(repoId);
  // rebuildCochange와 같은 조건이어야 한다 — 의미 없는 커밋(wip·merge 등)만 있는 레포는 다시 만들어도 비어 있어서,
  // 조건이 다르면 영원히 "다시 계산해야 함"이 되어 세션마다 백그라운드 sync가 돌고 doctor가 계속 경고한다
  const commits = (
    db.prepare("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ? AND meaningful = 1 AND files_changed BETWEEN ? AND ?").get(repoId, COCHANGE_MIN_FILES, COCHANGE_MAX_FILES) as {
      n: number;
    }
  ).n;
  return commits > 0;
}

/** 경로 하나의 공변경 후보 — 신뢰도로 자르고 최근순으로 */
export function cochangeOf(db: DB, repoId: number, file: string, options: { minSupport?: number; minConfidence?: number; limit?: number } = {}): Related[] {
  const minSupport = options.minSupport ?? MIN_SUPPORT;
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
  const total = (db.prepare("SELECT commits FROM file_touches WHERE repo_id = ? AND path = ?").get(repoId, file) as { commits: number } | undefined)?.commits ?? 0;
  if (total === 0) return [];
  const imports = new Set(importNeighbors(db, repoId, file));
  const rows = db
    .prepare("SELECT other, support, last_at FROM cochange WHERE repo_id = ? AND path = ? AND support >= ? ORDER BY last_at DESC, support DESC LIMIT 200")
    .all(repoId, file, minSupport) as { other: string; support: number; last_at: string }[];
  const related = rows
    .map((row) => ({
      path: row.other,
      support: row.support,
      confidence: Math.round((row.support / total) * 100) / 100,
      strong: row.support / total >= STRONG_CONFIDENCE,
      imports: imports.has(row.other),
      lastAt: row.last_at,
    }))
    .filter((item) => item.confidence >= minConfidence);
  // import 이웃이기도 한 것을 앞에, 그 다음 최근순 (이미 그 순서)
  related.sort((a, b) => Number(b.imports) - Number(a.imports) || b.lastAt.localeCompare(a.lastAt));
  return related.slice(0, options.limit ?? 50);
}

/* ── import 그래프 ──────────────────────────────────────── */

const IMPORT_PATTERNS: RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];
const PY_RELATIVE = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm;
const PY_ABSOLUTE = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/gm;
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py"];

/**
 * 파일 하나의 import 지정자(원문). 상대 경로(JS/TS)와 Python의 상대·절대 모듈만 — 외부 패키지는 여기서 버린다.
 * 내용을 읽는 자리(색인)와 경로를 푸는 자리(트랜잭션 안, HEAD 파일 집합이 있는 곳)가 달라 둘로 나눴다.
 * 꼴: "js:<spec>" · "pyrel:<dots>|<module>" · "pyabs:<module>"
 */
export function extractImportSpecs(file: string, content: string): string[] {
  const ext = path.posix.extname(file).toLowerCase();
  const out = new Set<string>();
  if (ext === ".py") {
    for (const match of content.matchAll(PY_RELATIVE)) out.add(`pyrel:${match[1]}|${match[2]}`);
    for (const match of content.matchAll(PY_ABSOLUTE)) {
      const module = match[1] ?? match[2];
      if (module) out.add(`pyabs:${module}`);
    }
    return [...out];
  }
  if (!SOURCE_EXT.has(ext)) return [];
  for (const pattern of IMPORT_PATTERNS) for (const match of content.matchAll(pattern)) if (match[1].startsWith(".")) out.add(`js:${match[1]}`);
  return [...out];
}

/** 지정자 → 레포 안 경로. 확장자 생략·index·__init__은 `known`(HEAD의 색인 파일 집합)으로 푼다. */
export function resolveImportSpecs(file: string, specs: string[], known: Set<string>): string[] {
  const dir = path.posix.dirname(file);
  const out = new Set<string>();
  for (const spec of specs) {
    let target: string | null = null;
    if (spec.startsWith("js:")) {
      target = resolveCandidates(path.posix.normalize(path.posix.join(dir, spec.slice(3))), known);
    } else if (spec.startsWith("pyrel:")) {
      const [dots, module] = spec.slice(6).split("|");
      let base = dir;
      for (let i = 1; i < dots.length; i++) base = path.posix.dirname(base);
      const rel = module.replace(/\./g, "/");
      target = resolveCandidates(rel ? path.posix.normalize(path.posix.join(base, rel)) : base, known, true);
    } else if (spec.startsWith("pyabs:")) {
      target = resolveCandidates(spec.slice(6).replace(/\./g, "/"), known, true);
    }
    if (target && target !== file) out.add(target);
  }
  return [...out];
}

/** 파일 하나의 레포 안 import 대상 경로 (둘을 이어 붙인 것 — 테스트·CLI용) */
export function extractImports(file: string, content: string, known: Set<string>): string[] {
  return resolveImportSpecs(file, extractImportSpecs(file, content), known);
}

function resolveCandidates(base: string, known: Set<string>, python = false): string | null {
  const clean = base.replace(/^\.\//, "");
  if (known.has(clean)) return clean;
  const stripped = clean.replace(/\.(js|mjs|cjs|jsx)$/, "");
  const candidates = python
    ? [`${clean}.py`, `${clean}/__init__.py`]
    : [...RESOLVE_EXT.map((ext) => `${stripped}${ext}`), ...RESOLVE_EXT.map((ext) => `${clean}/index${ext}`)];
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}

/** 이 파일이 import하는 것과 이 파일을 import하는 것 (양방향 이웃) */
function importNeighbors(db: DB, repoId: number, file: string): string[] {
  const rows = db
    .prepare("SELECT target AS other FROM file_imports WHERE repo_id = ? AND path = ? UNION SELECT path FROM file_imports WHERE repo_id = ? AND target = ?")
    .all(repoId, file, repoId, file) as { other: string }[];
  return rows.map((row) => row.other);
}

/* ── 테스트 짝 ──────────────────────────────────────────── */

/** 이름 규칙으로 짝지어지는 테스트 파일 (foo.ts ↔ foo.test.ts · test_foo.py · foo_test.go · __tests__/foo.*) */
export function namedTests(db: DB, repoId: number, file: string): string[] {
  if (TEST_PATH.test(file)) return [];
  const ext = path.posix.extname(file);
  const stem = path.posix.basename(file, ext);
  if (!stem || stem === "index") return [];
  const rows = db
    .prepare("SELECT path FROM code_files WHERE repo_id = ? AND (path LIKE ? OR path LIKE ? OR path LIKE ?)")
    .all(repoId, `%${stem}.%`, `%test_${stem}.%`, `%${stem}_test.%`) as { path: string }[];
  const dir = path.posix.dirname(file);
  return rows
    .map((row) => row.path)
    .filter((candidate) => candidate !== file && TEST_PATH.test(candidate))
    .filter((candidate) => {
      const name = path.posix.basename(candidate);
      return (
        name.startsWith(`${stem}.`) || name === `test_${stem}${path.posix.extname(candidate)}` || name === `${stem}_test${path.posix.extname(candidate)}`
      );
    })
    // 같은 디렉터리(또는 그 아래) 짝을 먼저
    .sort((a, b) => Number(b.startsWith(dir)) - Number(a.startsWith(dir)) || a.length - b.length);
}

/* ── 파일 맥락 ──────────────────────────────────────────── */

/** CommitLine + 같은 변경으로 접힌 다른 sha들 (squash 머지 ↔ 브랜치 원본) */
interface ChangeLine extends CommitLine {
  shas: string[];
}

/**
 * 커밋 줄들을 같은 변경 키로 접는다 — 순서는 그대로, 각 변경의 첫 줄(최신)이 대표, 나머지 sha는 shas에.
 * change_key가 아직 없는 커밋(동기화 전 옛 DB)은 sha 자체를 키로 쓴다.
 */
function foldChanges(rows: (CommitLine & { changeKey: string | null })[]): ChangeLine[] {
  const out: ChangeLine[] = [];
  const index = new Map<string, number>();
  for (const { changeKey: key, ...row } of rows) {
    const id = key ?? row.sha;
    const at = index.get(id);
    if (at !== undefined) {
      out[at].shas.push(row.sha);
      continue;
    }
    index.set(id, out.length);
    out.push({ ...row, shas: [row.sha] });
  }
  return out;
}

/** 한 파일을 건드린 의미 있는 커밋들을 같은 변경으로 접어 최신부터 */
function changesTouching(db: DB, repoId: number, file: string, options: { since?: string; limit?: number } = {}): ChangeLine[] {
  const rows = db
    .prepare(
      `SELECT c.sha, c.authored_at AS date, c.author_name AS author, c.author_email AS authorEmail, c.subject, c.change_key AS changeKey
         FROM commit_files f JOIN commits c ON c.repo_id = f.repo_id AND c.sha = f.sha
        WHERE f.repo_id = ? AND f.path = ? AND c.meaningful = 1 ${options.since ? "AND c.authored_at >= ?" : ""}
        ORDER BY c.authored_at DESC ${options.limit ? "LIMIT ?" : ""}`,
    )
    .all(repoId, file, ...(options.since ? [options.since] : []), ...(options.limit ? [options.limit] : [])) as (CommitLine & { changeKey: string | null })[];
  return foldChanges(rows);
}

export function fileContext(db: DB, repoId: number, file: string): FileContext {
  // 같은 수정이 squash 머지 커밋과 브랜치 원본으로 두 번 보이지 않게 접는다 — 접히는 만큼 넉넉히 읽는다
  const changes = changesTouching(db, repoId, file, { limit: RECENT_COMMITS * 4 }).slice(0, RECENT_COMMITS);
  const recent: CommitLine[] = changes.map(({ shas: _shas, ...line }) => line);

  const related = cochangeOf(db, repoId, file).filter((item) => !TEST_PATH.test(item.path)).slice(0, RELATED_MAX);

  const tests: TestHint[] = namedTests(db, repoId, file).slice(0, 1).map((candidate) => ({ path: candidate, by: "name" as const }));
  for (const item of cochangeOf(db, repoId, file, { minConfidence: MIN_CONFIDENCE }).filter((candidate) => TEST_PATH.test(candidate.path))) {
    if (tests.length >= TESTS_MAX) break;
    if (tests.some((test) => test.path === item.path)) continue;
    tests.push({ path: item.path, by: "cochange", support: item.support, confidence: item.confidence });
  }

  const importers = (db.prepare("SELECT path FROM file_imports WHERE repo_id = ? AND target = ? ORDER BY path").all(repoId, file) as { path: string }[]).map(
    (row) => row.path,
  );
  const usedBy = importers.length >= USED_BY_MIN ? { count: importers.length, files: importers.slice(0, USED_BY_SHOWN) } : null;

  const fragile = fragility(db, repoId, file);
  const why = whyOf(db, repoId, changes);
  const worth = related.length > 0 || tests.length > 0 || usedBy !== null || fragile !== null || why !== null;
  return { path: file, recent, why, related, tests, usedBy, fragile, worth };
}

/** 최근 90일 fix류 커밋 비율 — 문턱을 넘을 때만 */
function fragility(db: DB, repoId: number, file: string): FileContext["fragile"] {
  if (NON_CODE.test(file) || !isIndexable(file, 0)) return null;
  const since = new Date(Date.now() - FRAGILE_DAYS * 86_400_000).toISOString();
  // 같은 수정은 한 번만 센다 — squash 머지 레포는 접지 않으면 fix 수와 전체 수가 모두 두 배가 된다
  const rows = changesTouching(db, repoId, file, { since }).map(({ shas: _shas, ...line }) => line);
  if (rows.length === 0) return null;
  const fixes = rows.filter((row) => FIX_SUBJECT.test(row.subject));
  if (fixes.length < FRAGILE_MIN_FIXES || fixes.length / rows.length < FRAGILE_MIN_RATIO) return null;
  return { fixes: fixes.length, total: rows.length, reasons: fixes.slice(0, 2) };
}

/**
 * recent 커밋들에 묶인 의도 중 하나 — 검증 신호(통과한 verify·Tested 트레일러)가 있는 가장 최근 커밋을 우선,
 * 없으면 가장 최근의 의도. 그 커밋의 변경 파일이 HEAD에 하나도 없으면(이름 바꾸기·삭제) 쓰지 않는다.
 */
function whyOf(db: DB, repoId: number, recent: ChangeLine[]): Why | null {
  if (recent.length === 0) return null;
  const context = db.prepare("SELECT kind, text FROM commit_context WHERE repo_id = ? AND sha = ? ORDER BY ord");
  const alive = db.prepare(
    "SELECT 1 FROM commit_files f JOIN code_files c ON c.repo_id = f.repo_id AND c.path = f.path WHERE f.repo_id = ? AND f.sha = ? LIMIT 1",
  );
  let fallback: Why | null = null;
  for (const commit of recent) {
    // 세션 기록은 워크트리의 브랜치 커밋에 묶이고, main에는 squash 커밋이 남는다 — 같은 변경의 모든 sha에서 찾는다
    const rows = commit.shas.flatMap((sha) => context.all(repoId, sha) as { kind: string; text: string }[]);
    if (rows.length === 0) continue;
    if (!alive.get(repoId, commit.sha)) continue;
    const intent =
      rows.find((row) => row.kind === "prompt")?.text ??
      rows.find((row) => row.kind === "trailer:why" || row.kind === "trailer:constraint" || row.kind === "trailer:rejected" || row.kind === "trailer:directive")?.text;
    if (!intent) continue;
    const verify = rows.find((row) => row.kind === "verify" && /\bpass\b/.test(row.text))?.text ?? rows.find((row) => row.kind === "trailer:tested")?.text;
    const why: Why = { sha: commit.sha, text: firstLine(intent), verified: Boolean(verify), ...(verify ? { verify: firstLine(verify) } : {}) };
    if (why.verified) return why;
    fallback ??= why;
  }
  return fallback;
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/* ── 한 줄 한 사실 형식 (훅·CLI) ───────────────────────── */

export interface FormatOptions {
  /** 내 이메일 — 작성자를 "me"로 */
  me?: string[];
  /** 글자 예산 — 넘으면 Used by → Co-changes → Fixes → Why 순으로 뺀다 */
  budget?: number;
  /** 세션에서 처음 보여 주는가 — "candidates, not instructions" 한 줄을 붙인다 */
  first?: boolean;
}

export const HOOK_BUDGET = 400;

/**
 * 제목을 max자 안으로 — 넘칠 때는 끝의 PR 번호 "(#N)"부터 뗀다(커밋 sha가 이미 근거라 PR 번호는 덜 중요하다).
 * 그래도 넘치면 자르고 "…". "(#…"처럼 번호 중간에서 잘리는 일이 없게.
 */
export function shortSubject(subject: string, max: number): string {
  if (subject.length <= max) return subject;
  const bare = subject.replace(/\s*\(#\d+\)\s*$/, "");
  return bare.length <= max ? bare : `${bare.slice(0, max - 1).trimEnd()}…`;
}

/**
 * `Key: value` 한 줄에 사실 하나 — Claude Code의 gitStatus 리마인더·Mistral Vibe의 git 블록과 같은 꼴이라 모델에게 익숙하다.
 * 마크다운·산문 없음. 줄 만한 것이 없으면 빈 문자열.
 */
export function formatFileContext(context: FileContext, options: FormatOptions = {}): string {
  if (!context.worth) return "";
  const me = options.me ?? [];
  const who = (line: CommitLine) => (me.includes(line.authorEmail.toLowerCase()) ? "me" : line.author);
  const commit = (line: CommitLine) => `${line.sha.slice(0, 10)} ${line.date.slice(5, 10)} ${who(line)} "${shortSubject(line.subject, 60)}"`;
  const lines: { key: string; text: string; drop: number }[] = [];
  lines.push({ key: "head", text: `Grimoire: ${context.path}`, drop: 99 });
  if (context.recent.length > 0) lines.push({ key: "recent", text: `Recent: ${context.recent.slice(0, 2).map(commit).join(" · ")}`, drop: 98 });
  if (context.why) {
    lines.push({
      key: "why",
      text: `Why (${context.why.sha.slice(0, 10)}): "${context.why.text}"${context.why.verify ? ` · verified: ${context.why.verify}` : ""}`,
      drop: 4,
    });
  }
  if (context.related.length > 0) {
    lines.push({
      key: "related",
      text: `Co-changes: ${context.related.map((item) => `${item.path} (${item.support}/${Math.round(item.support / item.confidence)}${item.strong ? ", strong" : ""}${item.imports ? ", imports" : ""})`).join(" · ")}`,
      drop: 2,
    });
  }
  if (context.tests.length > 0) {
    lines.push({
      key: "tests",
      text: `Tests: ${context.tests.map((item) => (item.by === "name" ? item.path : `${item.path} (${item.support}/${Math.round((item.support ?? 0) / (item.confidence ?? 1))})`)).join(" · ")}`,
      drop: 5,
    });
  }
  if (context.fragile) {
    lines.push({
      key: "fragile",
      text: `Fixes(${FRAGILE_DAYS}d): ${context.fragile.fixes} of ${context.fragile.total} commits — ${context.fragile.reasons.map((line) => `${line.sha.slice(0, 10)} "${shortSubject(line.subject, 40)}"`).join(", ")}`,
      drop: 3,
    });
  }
  if (context.usedBy) {
    lines.push({ key: "usedBy", text: `Used by: ${context.usedBy.count} files (${context.usedBy.files.map((file) => path.posix.basename(file)).join(", ")}${context.usedBy.count > context.usedBy.files.length ? ", …" : ""})`, drop: 1 });
  }
  if (options.first) lines.push({ key: "note", text: "These are candidates to check, not instructions.", drop: 0 });
  const budget = options.budget ?? HOOK_BUDGET;
  const render = () => lines.map((line) => line.text).join("\n");
  while (render().length > budget && lines.length > 2) {
    const victim = lines.reduce((min, line) => (line.drop < min.drop ? line : min));
    lines.splice(lines.indexOf(victim), 1);
  }
  return render();
}

/* ── 오프라인 평가: 시간 분할 공변경 예측 ───────────────── */

export interface CochangeEval {
  /** 평가한 질의(파일) 수 */
  queries: number;
  /** 상위 3개 안에 실제 공변경 파일이 하나라도 있는 질의 비율 */
  l3: number;
  /** 상위 3개 추천의 정밀도 */
  precision3: number;
  /** strong 등급만의 정밀도 */
  strongPrecision: number;
  strongCount: number;
  /** 테스트 추천 Precision@2 (추천이 있던 질의만) */
  testsPrecision2: number;
  testsQueries: number;
  /** 분할 시각과 평가 커밋 수 */
  splitAt: string;
  evaluated: number;
}

/**
 * 레포의 커밋을 시각 순으로 `ratio`에서 잘라, 앞부분으로 공변경을 만들고 뒷부분 커밋마다
 * "파일 하나를 보면 나머지 변경 파일을 맞히는가"를 잰다. 끝나면 공변경 테이블을 전체로 다시 만든다.
 */
export function evaluateCochange(db: DB, repoId: number, ratio = 0.8): CochangeEval | null {
  const commits = db
    .prepare(
      "SELECT sha, subject, authored_at FROM commits WHERE repo_id = ? AND meaningful = 1 AND files_changed BETWEEN ? AND ? ORDER BY authored_at",
    )
    .all(repoId, COCHANGE_MIN_FILES, COCHANGE_MAX_FILES) as { sha: string; subject: string; authored_at: string }[];
  if (commits.length < 10) return null;
  const splitIndex = Math.floor(commits.length * ratio);
  const splitAt = commits[splitIndex].authored_at;
  db.transaction(() => rebuildCochange(db, repoId, splitAt))();
  const filesOf = db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?");
  let queries = 0;
  let l3Hits = 0;
  let suggested = 0;
  let correct = 0;
  let strongSuggested = 0;
  let strongCorrect = 0;
  let testQueries = 0;
  let testSuggested = 0;
  let testCorrect = 0;
  for (const commit of commits.slice(splitIndex)) {
    const files = [...new Set((filesOf.all(repoId, commit.sha) as { path: string }[]).map((row) => row.path))];
    if (!isCochangeCommit(commit.subject, files, true)) continue;
    const actual = new Set(files);
    for (const file of files) {
      const related = cochangeOf(db, repoId, file).filter((item) => !TEST_PATH.test(item.path)).slice(0, RELATED_MAX);
      if (related.length === 0) continue;
      queries++;
      const hits = related.filter((item) => actual.has(item.path));
      if (hits.length > 0) l3Hits++;
      suggested += related.length;
      correct += hits.length;
      const strong = related.filter((item) => item.strong);
      strongSuggested += strong.length;
      strongCorrect += strong.filter((item) => actual.has(item.path)).length;
      const tests = cochangeOf(db, repoId, file).filter((item) => TEST_PATH.test(item.path)).slice(0, TESTS_MAX);
      if (tests.length > 0 && !TEST_PATH.test(file)) {
        testQueries++;
        testSuggested += tests.length;
        testCorrect += tests.filter((item) => actual.has(item.path)).length;
      }
    }
  }
  db.transaction(() => rebuildCochange(db, repoId))();
  const ratioOf = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 1000);
  return {
    queries,
    l3: ratioOf(l3Hits, queries),
    precision3: ratioOf(correct, suggested),
    strongPrecision: ratioOf(strongCorrect, strongSuggested),
    strongCount: strongSuggested,
    testsPrecision2: ratioOf(testCorrect, testSuggested),
    testsQueries: testQueries,
    splitAt,
    evaluated: commits.length - splitIndex,
  };
}

/** GitCommit → 공변경 입력 */
export function cochangeInput(commit: GitCommit, meaningful: boolean) {
  return { subject: commit.subject, authoredAt: commit.authoredAt, files: commit.files.map((file) => file.path), meaningful };
}
