/**
 * 노트 — 대화 중 배운 것·결정 사항을 남긴다. 커밋과 같은 색인으로 검색된다.
 *
 * 노트는 파일에 묶일 수 있다(paths). 그 파일을 고치기 직전 훅과 file_context가 노트를 보여 주고(docs/signal-design.md §5-1 K3),
 * 노트를 남긴 뒤 파일이 바뀌었으면 "오래됐을 수 있음"으로 표시한다 — 묶을 때의 blob을 함께 적어 두고 지금 HEAD의 blob과 비교한다.
 * paths를 주지 않아도 본문에 적힌 레포 파일 경로(code_files·rule_files에 있는 것)는 자동으로 묶는다 — "CLAUDE.md의 커밋 규칙은…"이라고 쓰면
 * 그 노트는 CLAUDE.md에 묶이고, CLAUDE.md가 바뀌면 오래됐을 수 있다고 표시된다.
 * 본문에 적힌 커밋 sha는 refs로 묶는다 — 과거에 대한 노트의 근거다. 그 커밋을 보면(show_commit) 이 노트가 보인다 (docs/memory-philosophy.md §3-C).
 *
 * 노트는 판단이다. 뒤집히거나(supersede) 다시 확인될(confirm) 수 있고, 그 기록은 supersede.ts에 쌓인다. 뒤집힌 노트는 카드에서 빠지되
 * 검색에는 남는다. AI가 사람의 노트를 뒤집으면 숨기지 않고 둘 다 보인다 (docs/memory-philosophy.md §3).
 */
import { stripSystemBlocks } from "./capture";
import { deleteDoc, upsertDoc, type DB } from "./db";
import { noteDocFields, normalizeNotePath, notePathsField, pathsInText, shasInText, type NoteBindHow, type NotePath } from "./note-doc";
import { redact } from "./redact";
import { confirmationsOf, forgetVerdictsBy, supersededBy, supersedersOf } from "./supersede";

export type { NotePath } from "./note-doc";

export interface NoteInput {
  text: string;
  repoId?: number | null;
  tags?: string[];
  /** 레포 기준 경로(posix). 절대경로는 호출부(MCP·CLI)가 레포 기준으로 바꿔서 준다 */
  paths?: string[];
  /** 작업 폴더의 바뀐 파일로 추정해 묶는 경로(note-autobind.ts) — 사람이 준 것과 구별해 저장한다 */
  autoPaths?: string[];
  source: "mcp" | "cli";
}

export interface NoteRow {
  id: number;
  repo_id: number | null;
  text: string;
  tags: string;
  /** JSON: NotePath[] */
  paths: string;
  /** JSON: string[] — 본문에 적힌 이 레포의 커밋 sha(전체) */
  refs: string;
  source: string;
  created_at: string;
}

/** 파일을 고치기 전에 보여 줄 노트 한 줄 */
export interface NoteHint {
  id: number;
  title: string;
  createdAt: string;
  /** 노트를 남긴 뒤 그 파일이 바뀌었나(또는 사라졌나) — 노트가 가리키는 코드가 지금과 다를 수 있다 */
  stale: boolean;
  /** 이 파일에 어떻게 묶였나 — auto는 추정이다 */
  how: NoteBindHow;
  /** 다시 보고 맞다고 한 횟수와 마지막 날 (supersede.ts confirm) */
  confirmed?: { count: number; last: string };
  /** 이 노트가 뒤집은 노트들 */
  replaces?: number[];
  /** AI가 이 사람의 노트를 뒤집었다 — 숨기지 않고 함께 보인다 */
  disputedBy?: number;
}

/** 노트 본문 상한 — 넘으면 자르지 않고 오류 (나눠 적게) */
export const NOTE_MAX = 4000;
/** 태그 수와 태그 하나의 길이 상한 — 태그는 검색 본문에도 들어가므로 노트 하나가 색인을 부풀리지 않게 */
export const TAGS_MAX = 20;
export const TAG_CHARS = 40;
/** 노트 하나에 묶는 파일 수 상한 */
export const PATHS_MAX = 20;
/** 파일 하나에 보여 주는 노트 수 */
export const NOTES_PER_FILE = 3;
/** 노트 하나가 근거로 묶는 커밋 수 상한 */
export const REFS_MAX = 10;

/** 노트에 묶을 파일 목록 — 준 경로·본문에서 찾은 경로·추정한 경로를 합치고(출처를 남기며), 지금 HEAD의 blob을 적는다 */
export function resolveNotePaths(db: DB, repoId: number | null, text: string, given: string[] = [], auto: string[] = []): NotePath[] {
  const known = new Map<string, string>();
  if (repoId !== null) {
    // 소스 파일과 규칙 파일(rules.ts) — 규칙 파일에 묶은 노트도 그 파일이 바뀌면 stale이 된다(규칙이 바뀌면 그 규칙에 대한 노트는 오래됐다)
    const rows = db.prepare("SELECT path, blob FROM code_files WHERE repo_id = ? UNION ALL SELECT path, blob FROM rule_files WHERE repo_id = ?").all(repoId, repoId);
    for (const row of rows as { path: string; blob: string }[]) known.set(row.path, row.blob);
  }
  const how = new Map<string, NoteBindHow>();
  // 같은 파일이 여러 출처로 묶이면 더 확실한 출처가 남는다: given > text > auto
  for (const path of auto.map(normalizeNotePath).filter(Boolean)) how.set(path, "auto");
  for (const path of pathsInText(text, new Set(known.keys()))) how.set(path, "text");
  for (const path of given.map(normalizeNotePath).filter(Boolean)) how.set(path, "given");
  const order = (item: NoteBindHow) => (item === "given" ? 0 : item === "text" ? 1 : 2);
  return [...how.entries()]
    .sort((a, b) => order(a[1]) - order(b[1]))
    .slice(0, PATHS_MAX)
    .map(([path, source]) => ({ path, blob: known.get(path) ?? null, how: source }));
}

/** 본문에 적힌 sha 중 이 레포의 커밋과 하나로 맞는 것(전체 sha). 레포가 없으면 묶지 않는다 */
export function resolveNoteRefs(db: DB, repoId: number | null, text: string): string[] {
  if (repoId === null) return [];
  const find = db.prepare("SELECT sha FROM commits WHERE repo_id = ? AND sha LIKE ? LIMIT 2");
  const refs: string[] = [];
  for (const token of shasInText(text)) {
    const rows = find.all(repoId, `${token.toLowerCase()}%`) as { sha: string }[];
    if (rows.length === 1 && !refs.includes(rows[0].sha)) refs.push(rows[0].sha);
    if (refs.length >= REFS_MAX) break;
  }
  return refs;
}

/**
 * redacted: 비밀로 보이는 값을 지우고 저장했는가 — 노트는 검색 결과로 다시 모델에게 건네지므로, 원인 분석에 섞여 든
 * 연결 문자열·토큰도 세션 캡처와 같은 규칙(redact.ts)으로 지운다.
 */
export function addNote(db: DB, input: NoteInput): NoteRow & { redacted: boolean; tagsDropped: number } {
  const raw = input.text.trim();
  if (!raw) throw new Error("노트 내용이 비어 있습니다");
  // 노트는 사람이 남기라고 한 기억이다 — 조용히 자르지 않고 나눠 적게 한다 (docs/feature-audit.md F3)
  if (raw.length > NOTE_MAX) throw new Error(`노트가 ${raw.length}자로 상한 ${NOTE_MAX}자를 넘습니다 — 둘로 나눠 남기세요`);
  // 에이전트가 받은 맥락을 그대로 붙여 넣으면 클라이언트의 자동 블록(<system-reminder> 등)이 섞인다 — 프롬프트와 같은 규칙으로 뗀다
  const unblocked = stripSystemBlocks(raw);
  if (!unblocked) throw new Error("자동으로 붙은 블록(<system-reminder> 등)뿐이라 노트로 남길 내용이 없습니다");
  const text = redact(unblocked);
  const redacted = text !== unblocked;
  // 넘치면 오류 대신 자른다 (앞의 TAGS_MAX개, 각 TAG_CHARS자) — 잘랐으면 몇 개를 버렸는지 돌려준다
  const cleanTags = (input.tags ?? []).map((tag) => tag.trim().toLowerCase().slice(0, TAG_CHARS).trim()).filter(Boolean);
  const tagsDropped = Math.max(0, cleanTags.length - TAGS_MAX);
  const tags = cleanTags.slice(0, TAGS_MAX).join(" ");
  const repoId = input.repoId ?? null;
  const paths = resolveNotePaths(db, repoId, text, input.paths, input.autoPaths);
  const refs = resolveNoteRefs(db, repoId, text);
  const createdAt = new Date().toISOString();

  return db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO notes (repo_id, text, tags, paths, refs, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(repoId, text, tags, JSON.stringify(paths), JSON.stringify(refs), input.source, createdAt).lastInsertRowid,
    );
    upsertDoc(db, {
      kind: "note",
      ref: String(id),
      repoId,
      at: createdAt,
      ...noteDocFields(text, tags),
      paths: notePathsField(paths),
    });
    return { ...(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow), redacted, tagsDropped };
  })();
}

/**
 * 노트를 지운다 — 비밀이 섞였거나 실수로 남긴 것. 사람만(CLI) 부른다; 에이전트가 기억을 지울 수 있으면 안 된다.
 * 그 노트가 남긴 판단(뒤집기·확인)도 함께 지운다. 없는 번호면 false.
 */
export function deleteNote(db: DB, id: number): boolean {
  const row = db.prepare("SELECT id, repo_id FROM notes WHERE id = ?").get(id) as { id: number; repo_id: number | null } | undefined;
  if (!row) return false;
  db.transaction(() => {
    deleteDoc(db, "note", String(id), row.repo_id);
    forgetVerdictsBy(db, id);
    db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  })();
  return true;
}

/** 이 커밋을 근거로 적은 노트들 — show_commit에 붙인다 */
export function notesCiting(db: DB, repoId: number, sha: string, limit = 5): { id: number; title: string; createdAt: string }[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.text, n.created_at FROM notes n, json_each(n.refs) AS j WHERE n.repo_id = ? AND j.value = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    )
    .all(repoId, sha, limit) as { id: number; text: string; created_at: string }[];
  return rows.map((row) => ({ id: row.id, title: noteDocFields(row.text, "").title, createdAt: row.created_at }));
}

/**
 * 이 파일에 묶인 노트 — 뒤집힌 것은 빼고, 마지막으로 확인(또는 작성)한 순서로. stale은 노트를 남긴 뒤 파일 내용이 바뀌었거나(blob이 다름)
 * 파일이 사라졌을 때다. 묶을 때 blob을 몰랐던 노트(색인 전 파일·옛 노트)는 비교할 수 없어 stale로 보지 않는다.
 *
 * 숨기는 규칙 (docs/supersede-design.md §3-3): 사람(cli)·커밋이 뒤집은 것은 숨긴다. AI(mcp)가 AI 노트를 뒤집은 것도 숨긴다.
 * AI가 사람의 노트를 뒤집었으면 둘 다 보이고 disputed로 표시한다 — AI가 사람의 결정을 조용히 내리지 못하게.
 */
export function notesForFile(db: DB, repoId: number, file: string, limit = NOTES_PER_FILE): NoteHint[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.text, n.source, n.created_at, json_extract(j.value, '$.blob') AS blob, json_extract(j.value, '$.how') AS how FROM notes n, json_each(n.paths) AS j
        WHERE n.repo_id = ? AND json_extract(j.value, '$.path') = ? ORDER BY n.created_at DESC, n.id DESC`,
    )
    .all(repoId, file) as { id: number; text: string; source: string; created_at: string; blob: string | null; how: string | null }[];
  if (rows.length === 0) return [];
  const current =
    (
      db.prepare("SELECT blob FROM code_files WHERE repo_id = ? AND path = ? UNION ALL SELECT blob FROM rule_files WHERE repo_id = ? AND path = ?").get(repoId, file, repoId, file) as
        | { blob: string }
        | undefined
    )?.blob ?? null;
  const sourceOf = db.prepare("SELECT source FROM notes WHERE id = ?");
  const hints: (NoteHint & { seen: string })[] = [];
  for (const row of rows) {
    const verdicts = supersedersOf(db, { kind: "note", ref: String(row.id) });
    let hidden = false;
    let disputedBy: number | undefined;
    for (const verdict of verdicts) {
      if (verdict.byKind === "commit") {
        hidden = true;
        break;
      }
      const by = (sourceOf.get(Number(verdict.byRef)) as { source: string } | undefined)?.source;
      if (row.source === "cli" && by === "mcp") disputedBy ??= Number(verdict.byRef);
      else {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    const confirmed = confirmationsOf(db, row.id);
    const replaces = supersededBy(db, { kind: "note", ref: String(row.id) })
      .filter((item) => item.targetKind === "note")
      .map((item) => Number(item.targetRef));
    hints.push({
      id: row.id,
      title: noteDocFields(row.text, "").title,
      createdAt: row.created_at,
      stale: row.blob !== null && row.blob !== current,
      how: row.how === "auto" || row.how === "text" ? row.how : "given",
      ...(confirmed.count > 0 && confirmed.last ? { confirmed: { count: confirmed.count, last: confirmed.last } } : {}),
      ...(replaces.length > 0 ? { replaces } : {}),
      ...(disputedBy !== undefined ? { disputedBy } : {}),
      seen: confirmed.last && confirmed.last > row.created_at ? confirmed.last : row.created_at,
    });
  }
  // 최근에 다시 본 결정이 먼저 — 자주 떠올린 것이 먼저 떠오르는 성질 (docs/memory-philosophy.md §3-B)
  return hints
    .sort((a, b) => (a.seen < b.seen ? 1 : a.seen > b.seen ? -1 : b.id - a.id))
    .slice(0, limit)
    .map(({ seen: _seen, ...hint }) => hint);
}

/**
 * 카드·응답에 붙이는 노트 표식 — " (stale, auto-bound, replaces #12, confirmed 3× 2026-11-02, disputed by #31 (ai))". 없으면 "".
 * staleWord: 자리마다 쓰는 말이 다르다 ("stale" / "file changed since").
 */
export function noteFlags(note: NoteHint, staleWord = "stale"): string {
  const flags: string[] = [];
  if (note.stale) flags.push(staleWord);
  if (note.how === "auto") flags.push("auto-bound");
  if (note.replaces?.length) flags.push(`replaces ${note.replaces.map((id) => `#${id}`).join(" ")}`);
  if (note.confirmed) flags.push(`confirmed ${note.confirmed.count}× ${note.confirmed.last.slice(0, 10)}`);
  if (note.disputedBy !== undefined) flags.push(`disputed by #${note.disputedBy} (ai)`);
  return flags.length > 0 ? ` (${flags.join(", ")})` : "";
}
