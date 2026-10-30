/**
 * 노트 — 대화 중 배운 것·결정 사항을 남긴다. 커밋과 같은 색인으로 검색된다.
 *
 * 노트는 파일에 묶일 수 있다(paths). 그 파일을 고치기 직전 훅과 file_context가 노트를 보여 주고(docs/signal-design.md §5-1 K3),
 * 노트를 남긴 뒤 파일이 바뀌었으면 "오래됐을 수 있음"으로 표시한다 — 묶을 때의 blob을 함께 적어 두고 지금 HEAD의 blob과 비교한다.
 * paths를 주지 않아도 본문에 적힌 레포 파일 경로(code_files·rule_files에 있는 것)는 자동으로 묶는다 — "CLAUDE.md의 커밋 규칙은…"이라고 쓰면
 * 그 노트는 CLAUDE.md에 묶이고, CLAUDE.md가 바뀌면 오래됐을 수 있다고 표시된다.
 */
import { stripSystemBlocks } from "./capture";
import { upsertDoc, type DB } from "./db";
import { noteDocFields, normalizeNotePath, notePathsField, pathsInText, type NotePath } from "./note-doc";
import { redact } from "./redact";

export type { NotePath } from "./note-doc";

export interface NoteInput {
  text: string;
  repoId?: number | null;
  tags?: string[];
  /** 레포 기준 경로(posix). 절대경로는 호출부(MCP·CLI)가 레포 기준으로 바꿔서 준다 */
  paths?: string[];
  source: "mcp" | "cli";
}

export interface NoteRow {
  id: number;
  repo_id: number | null;
  text: string;
  tags: string;
  /** JSON: NotePath[] */
  paths: string;
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
}

const NOTE_MAX = 4000;
/** 태그 수와 태그 하나의 길이 상한 — 태그는 검색 본문에도 들어가므로 노트 하나가 색인을 부풀리지 않게 */
export const TAGS_MAX = 20;
export const TAG_CHARS = 40;
/** 노트 하나에 묶는 파일 수 상한 */
export const PATHS_MAX = 20;
/** 파일 하나에 보여 주는 노트 수 */
export const NOTES_PER_FILE = 3;

/** 노트에 묶을 파일 목록 — 준 경로와 본문에서 찾은 경로를 합치고, 지금 HEAD의 blob을 적는다 */
export function resolveNotePaths(db: DB, repoId: number | null, text: string, given: string[] = []): NotePath[] {
  const known = new Map<string, string>();
  if (repoId !== null) {
    // 소스 파일과 규칙 파일(rules.ts) — 규칙 파일에 묶은 노트도 그 파일이 바뀌면 stale이 된다(규칙이 바뀌면 그 규칙에 대한 노트는 오래됐다)
    const rows = db.prepare("SELECT path, blob FROM code_files WHERE repo_id = ? UNION ALL SELECT path, blob FROM rule_files WHERE repo_id = ?").all(repoId, repoId);
    for (const row of rows as { path: string; blob: string }[]) known.set(row.path, row.blob);
  }
  const paths = [...new Set([...given.map(normalizeNotePath).filter(Boolean), ...pathsInText(text, new Set(known.keys()))])].slice(0, PATHS_MAX);
  return paths.map((path) => ({ path, blob: known.get(path) ?? null }));
}

/**
 * redacted: 비밀로 보이는 값을 지우고 저장했는가 — 노트는 검색 결과로 다시 모델에게 건네지므로, 원인 분석에 섞여 든
 * 연결 문자열·토큰도 세션 캡처와 같은 규칙(redact.ts)으로 지운다.
 */
export function addNote(db: DB, input: NoteInput): NoteRow & { redacted: boolean } {
  const raw = input.text.trim().slice(0, NOTE_MAX);
  if (!raw) throw new Error("노트 내용이 비어 있습니다");
  // 에이전트가 받은 맥락을 그대로 붙여 넣으면 클라이언트의 자동 블록(<system-reminder> 등)이 섞인다 — 프롬프트와 같은 규칙으로 뗀다
  const unblocked = stripSystemBlocks(raw);
  if (!unblocked) throw new Error("자동으로 붙은 블록(<system-reminder> 등)뿐이라 노트로 남길 내용이 없습니다");
  const text = redact(unblocked);
  const redacted = text !== unblocked;
  // 넘치면 오류 대신 자른다 (앞의 TAGS_MAX개, 각 TAG_CHARS자)
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim().toLowerCase().slice(0, TAG_CHARS).trim())
    .filter(Boolean)
    .slice(0, TAGS_MAX)
    .join(" ");
  const repoId = input.repoId ?? null;
  const paths = resolveNotePaths(db, repoId, text, input.paths);
  const createdAt = new Date().toISOString();

  return db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO notes (repo_id, text, tags, paths, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(repoId, text, tags, JSON.stringify(paths), input.source, createdAt).lastInsertRowid,
    );
    upsertDoc(db, {
      kind: "note",
      ref: String(id),
      repoId,
      at: createdAt,
      ...noteDocFields(text, tags),
      paths: notePathsField(paths),
    });
    return { ...(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow), redacted };
  })();
}

/**
 * 이 파일에 묶인 노트 — 최근 것부터. stale은 노트를 남긴 뒤 파일 내용이 바뀌었거나(blob이 다름) 파일이 사라졌을 때다.
 * 묶을 때 blob을 몰랐던 노트(색인 전 파일·옛 노트)는 비교할 수 없어 stale로 보지 않는다.
 */
export function notesForFile(db: DB, repoId: number, file: string, limit = NOTES_PER_FILE): NoteHint[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.text, n.created_at, json_extract(j.value, '$.blob') AS blob FROM notes n, json_each(n.paths) AS j
        WHERE n.repo_id = ? AND json_extract(j.value, '$.path') = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    )
    .all(repoId, file, limit) as { id: number; text: string; created_at: string; blob: string | null }[];
  if (rows.length === 0) return [];
  const current =
    (
      db.prepare("SELECT blob FROM code_files WHERE repo_id = ? AND path = ? UNION ALL SELECT blob FROM rule_files WHERE repo_id = ? AND path = ?").get(repoId, file, repoId, file) as
        | { blob: string }
        | undefined
    )?.blob ?? null;
  return rows.map((row) => ({
    id: row.id,
    title: noteDocFields(row.text, "").title,
    createdAt: row.created_at,
    stale: row.blob !== null && row.blob !== current,
  }));
}
