/**
 * 노트 — 대화 중 배운 것·결정 사항을 남긴다. 커밋과 같은 색인으로 검색된다.
 *
 * 노트는 파일이나 폴더에 묶일 수 있다(paths). 그 파일(폴더 아래 파일)을 고치기 직전 훅과 file_context가 노트를 보여 주고
 * (docs/signal-design.md §5-1 K3), 노트를 남긴 뒤 파일이 바뀌었으면 "오래됐을 수 있음"으로 표시한다 — 묶을 때의 blob을 함께 적어
 * 두고 지금 HEAD의 blob과 비교한다. 폴더(끝에 "/")는 blob이 없어 stale을 재지 않는다.
 * paths를 주지 않아도 본문에 적힌 레포 파일 경로(code_files에 있는 것)는 자동으로 묶는다.
 *
 * 규칙(태그 `rule`): 컨벤션·"이 헬퍼를 써라" 같은 약속. 같은 파일의 다른 노트보다 먼저 보인다.
 * 규칙이 바뀌면 새 노트가 옛 노트를 대신한다(supersedes) — 옛 노트는 훅에서 사라지고 검색에만 "superseded by #N"으로 남는다.
 * 쌓기만 하고 안 지우면 서로 어긋난 규칙이 같이 뜨므로, 같은 경로에 규칙이 이미 있는데 supersedes 없이 또 남기면 호출부가 알린다.
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
  /** 레포 기준 경로(posix). 절대경로는 호출부(MCP·CLI)가 레포 기준으로 바꿔서 준다. 폴더는 끝에 "/"(없어도 레포의 폴더면 폴더로 본다) */
  paths?: string[];
  /** 이 노트가 대신하는 노트 id — 규칙이 바뀌었을 때. paths·tags를 안 주면 옛 노트의 것을 물려받는다 */
  supersedes?: number;
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
  /** 이 노트를 대신한 노트 id (notes.ts supersede) */
  superseded_by: number | null;
}

/** 파일을 고치기 전에 보여 줄 노트 한 줄 */
export interface NoteHint {
  id: number;
  title: string;
  createdAt: string;
  /** 노트를 남긴 뒤 그 파일이 바뀌었나(또는 사라졌나) — 노트가 가리키는 코드가 지금과 다를 수 있다 */
  stale: boolean;
  /** 태그 rule — 컨벤션·약속. 다른 노트보다 먼저 보인다 */
  rule: boolean;
}

const NOTE_MAX = 4000;
/** 태그 수와 태그 하나의 길이 상한 — 태그는 검색 본문에도 들어가므로 노트 하나가 색인을 부풀리지 않게 */
export const TAGS_MAX = 20;
export const TAG_CHARS = 40;
/** 노트 하나에 묶는 파일 수 상한 */
export const PATHS_MAX = 20;
/** 파일 하나에 보여 주는 노트 수 — 규칙과 그 밖의 노트 각각 */
export const NOTES_PER_FILE = 3;
/** 규칙 노트의 태그 */
export const RULE_TAG = "rule";

export function isDirPath(path: string): boolean {
  return path.endsWith("/");
}

/** 태그 문자열(공백 구분)에 rule이 있나 */
export function hasRuleTag(tags: string): boolean {
  return tags.split(" ").includes(RULE_TAG);
}

/** 파일 경로의 조상 폴더들 — "a/b/c.ts" → ["a/", "a/b/"] */
export function ancestorDirs(file: string): string[] {
  const parts = file.split("/");
  const dirs: string[] = [];
  for (let index = 1; index < parts.length; index++) dirs.push(`${parts.slice(0, index).join("/")}/`);
  return dirs;
}

/**
 * 노트에 묶을 파일·폴더 목록 — 준 경로와 본문에서 찾은 경로를 합치고, 파일이면 지금 HEAD의 blob을 적는다.
 * 폴더는 끝에 "/"로 저장한다: 끝에 "/"를 붙여 줬거나, 레포 파일이 아닌데 레포 파일의 폴더면 폴더다.
 */
export function resolveNotePaths(db: DB, repoId: number | null, text: string, given: string[] = []): NotePath[] {
  const known = new Map<string, string>();
  if (repoId !== null) {
    for (const row of db.prepare("SELECT path, blob FROM code_files WHERE repo_id = ?").all(repoId) as { path: string; blob: string }[]) known.set(row.path, row.blob);
  }
  const dirs = new Set<string>();
  for (const file of known.keys()) for (const dir of ancestorDirs(file)) dirs.add(dir);
  const normalized = given
    .map(normalizeNotePath)
    .filter(Boolean)
    .map((path) => {
      if (isDirPath(path)) return path;
      return !known.has(path) && dirs.has(`${path}/`) ? `${path}/` : path;
    });
  const paths = [...new Set([...normalized, ...pathsInText(text, new Set(known.keys()))])].slice(0, PATHS_MAX);
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

  // 대신할 노트 — 있어야 하고, 이미 대신된 노트는 다시 대신할 수 없다(최신 노트를 가리키게)
  const old = input.supersedes !== undefined ? getNote(db, input.supersedes) : undefined;
  if (input.supersedes !== undefined) {
    if (!old) throw new Error(`대신할 노트 #${input.supersedes}이(가) 없습니다`);
    if (old.superseded_by !== null) throw new Error(`노트 #${old.id}은(는) 이미 #${old.superseded_by}(으)로 바뀌었습니다 — 그 노트를 대신하세요`);
  }
  // 넘치면 오류 대신 자른다 (앞의 TAGS_MAX개, 각 TAG_CHARS자)
  const givenTags = input.tags ?? (old ? old.tags.split(" ").filter(Boolean) : []);
  const tags = givenTags.map((tag) => tag.trim().toLowerCase().slice(0, TAG_CHARS).trim()).filter(Boolean).slice(0, TAGS_MAX).join(" ");
  const repoId = input.repoId ?? old?.repo_id ?? null;
  const inherited = old && input.paths === undefined ? parseNotePathsOf(old).map((item) => item.path) : undefined;
  const paths = resolveNotePaths(db, repoId, text, input.paths ?? inherited);
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
    if (old) supersedeNote(db, old, id);
    return { ...getNote(db, id)!, redacted };
  })();
}

export function getNote(db: DB, id: number): NoteRow | undefined {
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
}

function parseNotePathsOf(note: NoteRow): NotePath[] {
  try {
    const parsed = JSON.parse(note.paths) as unknown;
    return Array.isArray(parsed) ? (parsed as NotePath[]) : [];
  } catch {
    return [];
  }
}

/**
 * 옛 노트를 새 노트로 갈아 끼운다 — 훅·file_context·impact에서 빠지고, 검색 문서에는 "superseded by #N"을 덧붙여
 * "왜 바뀌었나"를 물을 때 옛 규칙도 찾히게 한다.
 */
function supersedeNote(db: DB, old: NoteRow, byId: number): void {
  db.prepare("UPDATE notes SET superseded_by = ? WHERE id = ?").run(byId, old.id);
  const fields = noteDocFields(old.text, old.tags);
  upsertDoc(db, {
    kind: "note",
    ref: String(old.id),
    repoId: old.repo_id,
    at: old.created_at,
    title: fields.title,
    body: `${fields.body}\nsuperseded by #${byId}`,
    paths: notePathsField(parseNotePathsOf(old)),
  });
}

function toHint(row: { id: number; text: string; tags: string; created_at: string; blob: string | null }, current: string | null): NoteHint {
  return {
    id: row.id,
    title: noteDocFields(row.text, "").title,
    createdAt: row.created_at,
    stale: row.blob !== null && row.blob !== current,
    rule: hasRuleTag(row.tags),
  };
}

/**
 * 이 파일에 묶인 노트 — 규칙(rule)이 먼저, 그 안에서는 최근 것부터. 파일에 직접 묶인 것과 조상 폴더에 묶인 것을 함께 본다.
 * stale은 노트를 남긴 뒤 파일 내용이 바뀌었거나(blob이 다름) 파일이 사라졌을 때다.
 * 묶을 때 blob을 몰랐던 노트(색인 전 파일·옛 노트·폴더)는 비교할 수 없어 stale로 보지 않는다.
 * 대신된 노트(superseded_by)는 보이지 않는다 — 옛 규칙이 새 규칙과 나란히 뜨면 어느 쪽을 따를지 알 수 없다.
 */
export function notesForFile(db: DB, repoId: number, file: string, limit = NOTES_PER_FILE): NoteHint[] {
  const targets = [file, ...ancestorDirs(file)];
  const rows = db
    .prepare(
      `SELECT n.id, n.text, n.tags, n.created_at, json_extract(j.value, '$.blob') AS blob FROM notes n, json_each(n.paths) AS j
        WHERE n.repo_id = ? AND n.superseded_by IS NULL AND json_extract(j.value, '$.path') IN (${targets.map(() => "?").join(", ")})
        GROUP BY n.id ORDER BY n.created_at DESC, n.id DESC`,
    )
    .all(repoId, ...targets) as { id: number; text: string; tags: string; created_at: string; blob: string | null }[];
  if (rows.length === 0) return [];
  const current = (db.prepare("SELECT blob FROM code_files WHERE repo_id = ? AND path = ?").get(repoId, file) as { blob: string } | undefined)?.blob ?? null;
  const hints = rows.map((row) => toHint(row, current));
  return [...hints.filter((hint) => hint.rule).slice(0, limit), ...hints.filter((hint) => !hint.rule).slice(0, limit)];
}

export interface RuleNote extends NoteHint {
  /** 묶인 경로(파일·폴더). 비어 있으면 레포 전체 규칙 */
  paths: string[];
}

/**
 * 레포의 살아 있는 규칙 노트(태그 rule, 대신되지 않은 것) — 최근 것부터.
 * paths를 주면 그 경로(파일·폴더, 또는 그 조상 폴더)에 묶인 규칙만; 빈 배열이면 레포 전체 규칙(경로 없는 것)만; 안 주면 전부.
 */
export function ruleNotes(db: DB, repoId: number, paths?: string[], limit = 20): RuleNote[] {
  const rows = db
    .prepare(`SELECT id, text, tags, paths, created_at FROM notes WHERE repo_id = ? AND superseded_by IS NULL ORDER BY created_at DESC, id DESC`)
    .all(repoId) as { id: number; text: string; tags: string; paths: string; created_at: string }[];
  const wanted = paths ? new Set(paths.flatMap((path) => [path, ...ancestorDirs(path)])) : null;
  const result: RuleNote[] = [];
  for (const row of rows) {
    if (!hasRuleTag(row.tags)) continue;
    const bound = parseNotePathsOf({ ...row, repo_id: repoId, source: "", superseded_by: null }).map((item) => item.path);
    if (wanted && (wanted.size === 0 ? bound.length > 0 : !bound.some((path) => wanted.has(path)))) continue;
    result.push({ ...toHint({ ...row, blob: null }, null), paths: bound });
    if (result.length >= limit) break;
  }
  return result;
}
