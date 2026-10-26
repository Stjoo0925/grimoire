/**
 * 노트 — 대화 중 배운 것·결정 사항을 남긴다. 커밋과 같은 색인으로 검색된다.
 */
import { upsertDoc, type DB } from "./db";

export interface NoteInput {
  text: string;
  repoId?: number | null;
  tags?: string[];
  source: "mcp" | "cli";
}

export interface NoteRow {
  id: number;
  repo_id: number | null;
  text: string;
  tags: string;
  source: string;
  created_at: string;
}

const NOTE_MAX = 4000;
const TITLE_MAX = 120;
/** 태그 수와 태그 하나의 길이 상한 — 태그는 검색 본문에도 들어가므로 노트 하나가 색인을 부풀리지 않게 */
export const TAGS_MAX = 20;
export const TAG_CHARS = 40;

export function addNote(db: DB, input: NoteInput): NoteRow {
  const text = input.text.trim().slice(0, NOTE_MAX);
  if (!text) throw new Error("노트 내용이 비어 있습니다");
  // 넘치면 오류 대신 자른다 (앞의 TAGS_MAX개, 각 TAG_CHARS자)
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim().toLowerCase().slice(0, TAG_CHARS).trim())
    .filter(Boolean)
    .slice(0, TAGS_MAX)
    .join(" ");
  const createdAt = new Date().toISOString();

  return db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO notes (repo_id, text, tags, source, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(input.repoId ?? null, text, tags, input.source, createdAt).lastInsertRowid,
    );
    const [firstLine, ...rest] = text.split("\n");
    upsertDoc(db, {
      kind: "note",
      ref: String(id),
      repoId: input.repoId ?? null,
      at: createdAt,
      title: firstLine.slice(0, TITLE_MAX),
      body: [firstLine.length > TITLE_MAX ? firstLine : "", ...rest, tags].filter(Boolean).join("\n"),
      paths: "",
    });
    return db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow;
  })();
}
