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

export function addNote(db: DB, input: NoteInput): NoteRow {
  const text = input.text.trim().slice(0, NOTE_MAX);
  if (!text) throw new Error("노트 내용이 비어 있습니다");
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
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
