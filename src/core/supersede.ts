/**
 * 판단의 확인·뒤집기 — 기억은 지우지 않고 그 위에 "언제 다시 봤고 어떻게 판단했나"를 쌓는다
 * (docs/memory-philosophy.md §3, docs/supersede-design.md).
 *
 * 사건(커밋)은 바뀌지 않고, 판단(노트·트레일러)은 뒤집힐 수 있고, 확인은 쌓인다.
 *  - supersede: 새 노트·커밋이 옛 노트·커밋을 **명시적으로** 가리켜 "이제 맞지 않는다"고 한다. 옛것은 남고 표시만 붙는다.
 *  - confirm:   노트를 다시 보고 "아직 맞다"고 한다. 묶인 파일의 blob을 지금 것으로 다시 적어 stale이 풀린다.
 *               확인은 노트를 만들지 않는다 — 사람(cli)·에이전트(mcp)가 직접 남긴 기록(by_kind = user)이다. 말을 붙이면 그 말은 노트가 되고
 *               노트가 확인의 주체가 된다.
 * 유사도·나이로 자동으로 하지 않는다(규칙 노트 #39의 실패). AI(mcp)가 사람(cli)의 노트를 뒤집으면 숨기지 않고 둘 다 보인다(disputed).
 */
import type { DB } from "./db";
import { parseNotePaths, type NotePath } from "./note-doc";

export type RefKind = "note" | "commit";
/** 판단의 주체 — 노트, 커밋, 또는 노트 없이 확인만 남긴 사람·에이전트(user: ref = "cli" | "mcp") */
export type ByKind = RefKind | "user";
/** 어떻게 뒤집혔나 — note: record_note supersedes, confirm: 다시 보고 맞다, trailer: 커밋의 Supersedes:, revert: git revert */
export type VerdictHow = "note" | "confirm" | "trailer" | "revert";

export interface ResolvedRef {
  kind: RefKind;
  /** 노트 번호 또는 전체 sha */
  ref: string;
}

export interface ByRef {
  kind: ByKind;
  ref: string;
}

export interface Verdict {
  targetKind: RefKind;
  targetRef: string;
  byKind: ByKind;
  byRef: string;
  how: VerdictHow;
  at: string;
}

const NOTE_TOKEN = /^#?(\d+)$/;
const SHA_TOKEN = /^[0-9a-f]{7,40}$/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;
/** record_note 하나가 뒤집거나 확인하는 대상 수 상한 — 넘으면 자르지 않고 거절한다 */
export const VERDICTS_MAX = 10;
/** 노트 하나에 물려주는 파일 수 상한 (notes.ts PATHS_MAX와 같다) */
const INHERIT_MAX = 20;

/** "#12" → 노트, 7자 이상 16진수 → 이 레포의 커밋. 없거나 여럿이면 오류 — 틀린 참조를 조용히 저장하지 않는다 */
export function resolveRef(db: DB, repoId: number | null, token: string): ResolvedRef {
  const text = token.trim();
  const note = NOTE_TOKEN.exec(text);
  if (note) {
    const row = db.prepare("SELECT id, repo_id FROM notes WHERE id = ?").get(Number(note[1])) as { id: number; repo_id: number | null } | undefined;
    if (!row) throw new Error(`#${note[1]} not found`);
    if (row.repo_id !== null && repoId !== null && row.repo_id !== repoId) throw new Error(`#${note[1]} belongs to another repo`);
    return { kind: "note", ref: String(row.id) };
  }
  if (SHA_TOKEN.test(text)) {
    if (repoId === null) throw new Error(`sha ${text}: repo is needed to resolve a commit`);
    const rows = db.prepare("SELECT sha FROM commits WHERE repo_id = ? AND sha LIKE ? LIMIT 3").all(repoId, `${text.toLowerCase()}%`) as { sha: string }[];
    if (rows.length === 0) throw new Error(`sha ${text} not in this repo`);
    if (rows.length > 1) throw new Error(`sha ${text} is ambiguous: ${rows.map((row) => row.sha.slice(0, 10)).join(", ")}`);
    return { kind: "commit", ref: rows[0].sha };
  }
  throw new Error(`"${text}" is neither a note (#12) nor a commit sha`);
}

/** 여러 토큰을 푼다 — VERDICTS_MAX를 넘으면 자르지 않고 오류 (조용한 손실 금지, docs/feature-audit.md F3) */
export function resolveRefs(db: DB, repoId: number | null, tokens: string[]): ResolvedRef[] {
  if (tokens.length > VERDICTS_MAX) throw new Error(`at most ${VERDICTS_MAX} targets per note (${tokens.length} given) — split the note`);
  const out: ResolvedRef[] = [];
  for (const token of tokens) {
    const resolved = resolveRef(db, repoId, token);
    if (!out.some((item) => item.kind === resolved.kind && item.ref === resolved.ref)) out.push(resolved);
  }
  return out;
}

export function refLabel(item: { kind: ByKind; ref: string }): string {
  if (item.kind === "note") return `#${item.ref}`;
  if (item.kind === "commit") return item.ref.slice(0, 10);
  return item.ref;
}

export interface VerdictInput {
  repoId: number | null;
  by: ByRef;
  targets: ResolvedRef[];
  how: VerdictHow;
  at?: string;
}

export interface VerdictResult {
  applied: Verdict[];
  /** 기록은 했지만 알아 둘 것 — "#12 is already superseded by #20" */
  notes: string[];
}

/**
 * 뒤집기·확인을 기록한다. 자기 자신, 그리고 나를 이미 뒤집은 것(몇 단계를 거쳐서라도)은 뒤집을 수 없다 — 고리가 생기면 모두 숨겨진다.
 * 이미 뒤집힌 대상은 알리고 그대로 기록한다. 뒤집기(confirm 아님)의 주체는 노트나 커밋이어야 한다 — 뒤집는 이유가 곧 그 기록이다.
 * confirm은 대상 노트가 묶인 파일의 blob을 지금 HEAD로 다시 적는다 — "파일은 바뀌었지만 이 결정은 그대로"의 유일한 표현.
 */
export function recordVerdicts(db: DB, input: VerdictInput): VerdictResult {
  const at = input.at ?? new Date().toISOString();
  const applied: Verdict[] = [];
  const notes: string[] = [];
  if (input.how !== "confirm" && input.by.kind === "user") throw new Error("superseding needs a note or a commit as the reason");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO supersessions (repo_id, target_kind, target_ref, by_kind, by_ref, how, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const target of input.targets) {
      if (target.kind === input.by.kind && target.ref === input.by.ref) throw new Error(`${refLabel(target)} cannot supersede itself`);
      if (input.how !== "confirm") {
        if (input.by.kind !== "user" && supersedes(db, target, { kind: input.by.kind, ref: input.by.ref })) {
          throw new Error(`${refLabel(target)} already supersedes ${refLabel(input.by)} (directly or through a chain) — supersede a newer note instead`);
        }
        const already = supersedersOf(db, target);
        if (already.length > 0) notes.push(`${refLabel(target)} is already superseded by ${already.map((item) => refLabel({ kind: item.byKind, ref: item.byRef })).join(", ")}`);
      }
      insert.run(input.repoId, target.kind, target.ref, input.by.kind, input.by.ref, input.how, at);
      applied.push({ targetKind: target.kind, targetRef: target.ref, byKind: input.by.kind, byRef: input.by.ref, how: input.how, at });
      if (input.how === "confirm" && target.kind === "note") refreshNoteBlobs(db, Number(target.ref));
    }
  })();
  return { applied, notes };
}

/** from이 to를 뒤집는가 — 직접, 또는 from → … → to 사슬로. 고리를 막는 데 쓴다 (너비 우선, 방문한 것은 다시 안 본다) */
function supersedes(db: DB, from: ResolvedRef, to: ResolvedRef): boolean {
  const seen = new Set<string>();
  const queue: ResolvedRef[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${current.kind}:${current.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const verdict of supersededBy(db, current)) {
      if (verdict.targetKind === to.kind && verdict.targetRef === to.ref) return true;
      queue.push({ kind: verdict.targetKind, ref: verdict.targetRef });
    }
  }
  return false;
}

/** 이것을 뒤집은 것들 (confirm 제외), 최근 것부터 */
export function supersedersOf(db: DB, target: { kind: RefKind; ref: string }): Verdict[] {
  return (
    db
      .prepare("SELECT target_kind, target_ref, by_kind, by_ref, how, at FROM supersessions WHERE target_kind = ? AND target_ref = ? AND how <> 'confirm' ORDER BY at DESC")
      .all(target.kind, target.ref) as VerdictRow[]
  ).map(toVerdict);
}

/** 이것이 뒤집은 것들 (confirm 제외) */
export function supersededBy(db: DB, by: { kind: ByKind; ref: string }): Verdict[] {
  return (
    db
      .prepare("SELECT target_kind, target_ref, by_kind, by_ref, how, at FROM supersessions WHERE by_kind = ? AND by_ref = ? AND how <> 'confirm' ORDER BY at DESC")
      .all(by.kind, by.ref) as VerdictRow[]
  ).map(toVerdict);
}

/** 이 노트를 다시 보고 맞다고 한 기록 — 횟수와 마지막 시각 */
export function confirmationsOf(db: DB, noteId: number): { count: number; last: string | null } {
  const row = db.prepare("SELECT COUNT(*) AS count, MAX(at) AS last FROM supersessions WHERE target_kind = 'note' AND target_ref = ? AND how = 'confirm'").get(String(noteId)) as {
    count: number;
    last: string | null;
  };
  return { count: row.count, last: row.last };
}

export function isSuperseded(db: DB, kind: RefKind, ref: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM supersessions WHERE target_kind = ? AND target_ref = ? AND how <> 'confirm' LIMIT 1").get(kind, ref));
}

/** 검색 결과에 붙일 한 토막 — 가장 최근에 뒤집은 것 ("#31" 또는 sha 10자), 없으면 null */
export function supersededMark(db: DB, kind: RefKind, ref: string): string | null {
  const latest = supersedersOf(db, { kind, ref })[0];
  return latest ? refLabel({ kind: latest.byKind, ref: latest.byRef }) : null;
}

/** 노트를 지우면 그 노트가 남긴 판단도 지운다 (그 노트를 가리킨 판단은 남는다 — 대상이 사라졌다는 것도 기록이다) */
export function forgetVerdictsBy(db: DB, noteId: number): void {
  db.prepare("DELETE FROM supersessions WHERE by_kind = 'note' AND by_ref = ?").run(String(noteId));
}

/** 뒤집거나 확인하는 노트들이 묶인 파일 — 새 판단이 옛 판단이 보이던 바로 그 자리에서 보이게 물려받는다 (MCP·CLI 공통) */
export function inheritedNotePaths(db: DB, targets: ResolvedRef[]): string[] {
  const out: string[] = [];
  for (const target of targets) {
    if (target.kind !== "note") continue;
    const row = db.prepare("SELECT paths FROM notes WHERE id = ?").get(Number(target.ref)) as { paths: string } | undefined;
    for (const item of parseNotePaths(row?.paths)) if (!out.includes(item.path)) out.push(item.path);
  }
  return out.slice(0, INHERIT_MAX);
}

/** 레포의 판단 기록 전부 — export용. 이 레포의 것(repo_id)과, 이 레포 노트를 가리키거나 그 노트가 남긴 것 */
export function verdictsOfRepo(db: DB, repoId: number): Verdict[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT s.target_kind, s.target_ref, s.by_kind, s.by_ref, s.how, s.at FROM supersessions s
          LEFT JOIN notes t ON s.target_kind = 'note' AND t.id = CAST(s.target_ref AS INTEGER)
          LEFT JOIN notes b ON s.by_kind = 'note' AND b.id = CAST(s.by_ref AS INTEGER)
          WHERE s.repo_id = ? OR t.repo_id = ? OR b.repo_id = ? ORDER BY s.at`,
      )
      .all(repoId, repoId, repoId) as VerdictRow[]
  ).map(toVerdict);
}

/** 확인: 묶인 파일의 blob을 지금 HEAD의 것으로 다시 적는다 — 그 뒤로는 stale이 아니다. 경로·출처(how)는 그대로 */
function refreshNoteBlobs(db: DB, noteId: number): void {
  const note = db.prepare("SELECT repo_id, paths FROM notes WHERE id = ?").get(noteId) as { repo_id: number | null; paths: string } | undefined;
  if (!note || note.repo_id === null) return;
  const paths = parseNotePaths(note.paths);
  if (paths.length === 0) return;
  const current = db.prepare("SELECT blob FROM code_files WHERE repo_id = ? AND path = ? UNION ALL SELECT blob FROM rule_files WHERE repo_id = ? AND path = ?");
  const refreshed: NotePath[] = paths.map((item) => {
    const row = current.get(note.repo_id, item.path, note.repo_id, item.path) as { blob: string } | undefined;
    return { ...item, blob: row?.blob ?? item.blob };
  });
  db.prepare("UPDATE notes SET paths = ? WHERE id = ?").run(JSON.stringify(refreshed), noteId);
}

interface VerdictRow {
  target_kind: RefKind;
  target_ref: string;
  by_kind: ByKind;
  by_ref: string;
  how: VerdictHow;
  at: string;
}

function toVerdict(row: VerdictRow): Verdict {
  return { targetKind: row.target_kind, targetRef: row.target_ref, byKind: row.by_kind, byRef: row.by_ref, how: row.how, at: row.at };
}

/* ── 커밋이 남기는 판단 ─────────────────────────────────── */

const REVERTS = /\bThis reverts commit ([0-9a-f]{7,40})\b/gi;
const REF_TOKEN = /#\d+|\b[0-9a-f]{7,40}\b/gi;

/**
 * 커밋 본문의 `Supersedes:` 트레일러와 `This reverts commit <sha>`를 판단으로 기록한다 (색인 때·백필 때).
 * 전체 sha(40자)는 풀어 보지 않고 그대로 적는다 — 색인은 최신 커밋부터 들어오므로(rev-list) 되돌린 원본이 아직 없을 수 있다.
 * 그 커밋이 끝내 색인되지 않으면 행은 아무 데서도 읽히지 않는다(해롭지 않다). 짧은 sha·노트 번호는 풀어 보고, 맞지 않으면 건너뛴다.
 */
export function recordCommitVerdicts(db: DB, repoId: number, sha: string, body: string, supersedesValues: string[]): number {
  const by: ResolvedRef = { kind: "commit", ref: sha };
  let recorded = 0;
  const apply = (tokens: string[], how: VerdictHow) => {
    for (const token of tokens) {
      try {
        const target: ResolvedRef = FULL_SHA.test(token) ? { kind: "commit", ref: token.toLowerCase() } : resolveRef(db, repoId, token);
        if (target.kind === by.kind && target.ref === by.ref) continue;
        recorded += recordVerdicts(db, { repoId, by, targets: [target], how }).applied.length;
      } catch {
        // 없는 참조·고리 — 커밋은 고칠 수 없으니 넘어간다
      }
    }
  };
  apply(supersedesValues.flatMap((value) => value.match(REF_TOKEN) ?? []), "trailer");
  apply([...body.matchAll(REVERTS)].map((match) => match[1]), "revert");
  return recorded;
}

/**
 * 이미 색인된 커밋의 판단을 한 번 채운다(마이그레이션 16) — revert 본문과 Supersedes: 트레일러가 있는 커밋만 읽는다.
 * 이미 있는 판단은 INSERT OR IGNORE로 겹치지 않는다(같은 커밋·같은 대상이면 at만 다르다 — 그래서 있는 것은 건너뛴다). 더한 행 수.
 */
export function backfillCommitVerdicts(db: DB): number {
  const rows = db
    .prepare(
      `SELECT c.repo_id, c.sha, c.body FROM commits c
        WHERE c.body LIKE '%This reverts commit %'
           OR EXISTS (SELECT 1 FROM commit_context x WHERE x.repo_id = c.repo_id AND x.sha = c.sha AND x.kind = 'trailer:supersedes')`,
    )
    .all() as { repo_id: number; sha: string; body: string }[];
  const trailers = db.prepare("SELECT text FROM commit_context WHERE repo_id = ? AND sha = ? AND kind = 'trailer:supersedes' ORDER BY ord");
  const done = db.prepare("SELECT 1 FROM supersessions WHERE by_kind = 'commit' AND by_ref = ? LIMIT 1");
  let added = 0;
  for (const row of rows) {
    if (done.get(row.sha)) continue;
    const values = (trailers.all(row.repo_id, row.sha) as { text: string }[]).map((item) => item.text);
    added += recordCommitVerdicts(db, row.repo_id, row.sha, row.body, values);
  }
  return added;
}

/* ── 사람이 정리하는 자리 ───────────────────────────────── */

export interface ReviewItem {
  id: number;
  title: string;
  createdAt: string;
  paths: string[];
  /** 왜 다시 볼 만한가 */
  reasons: string[];
}

/** 확인되지 않은 지 오래된 것으로 볼 기간 */
export const REVIEW_DAYS = 90;

/**
 * 다시 볼 만한 노트 — stale이거나, 추정(auto)으로만 묶였거나, 오래 확인되지 않았거나, 근거 커밋이 뒤집혔다.
 * 뒤집힌 노트는 뺀다(이미 판단이 끝났다). 자동으로 아무것도 하지 않는다 — 판단은 사람이 한다 (docs/memory-philosophy.md §3-E).
 */
export function reviewNotes(db: DB, repoId: number, options: { now?: number; days?: number } = {}): ReviewItem[] {
  const now = options.now ?? Date.now();
  const days = options.days ?? REVIEW_DAYS;
  const rows = db.prepare("SELECT id, text, paths, refs, created_at FROM notes WHERE repo_id = ? ORDER BY created_at DESC").all(repoId) as {
    id: number;
    text: string;
    paths: string;
    refs: string;
    created_at: string;
  }[];
  const current = db.prepare("SELECT blob FROM code_files WHERE repo_id = ? AND path = ? UNION ALL SELECT blob FROM rule_files WHERE repo_id = ? AND path = ?");
  const items: ReviewItem[] = [];
  for (const row of rows) {
    if (isSuperseded(db, "note", String(row.id))) continue;
    const paths = parseNotePaths(row.paths);
    const reasons: string[] = [];
    const stale = paths.filter((item) => {
      const head = (current.get(repoId, item.path, repoId, item.path) as { blob: string } | undefined)?.blob ?? null;
      return item.blob !== null && item.blob !== head;
    });
    if (stale.length > 0) reasons.push(`stale: ${stale.map((item) => item.path).join(", ")}`);
    if (paths.length > 0 && paths.every((item) => item.how === "auto")) reasons.push("bound only by guess (auto)");
    const confirmed = confirmationsOf(db, row.id);
    const lastSeen = Date.parse(confirmed.last ?? row.created_at);
    const age = Math.floor((now - lastSeen) / 86_400_000);
    if (age >= days) reasons.push(confirmed.count > 0 ? `not confirmed for ${age}d` : `never confirmed (${age}d old)`);
    let refs: string[] = [];
    try {
      refs = JSON.parse(row.refs) as string[];
    } catch {
      refs = [];
    }
    const overturned = refs.filter((sha) => isSuperseded(db, "commit", sha));
    if (overturned.length > 0) reasons.push(`cites overturned commit: ${overturned.map((sha) => sha.slice(0, 10)).join(", ")}`);
    if (reasons.length > 0) items.push({ id: row.id, title: row.text.split("\n")[0].slice(0, 80), createdAt: row.created_at, paths: paths.map((item) => item.path), reasons });
  }
  return items;
}
