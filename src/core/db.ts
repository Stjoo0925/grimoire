/**
 * SQLite 저장소 — 스키마와 연결.
 *
 * WAL 모드라 CLI 동기화(쓰기)와 MCP 질의(읽기)가 동시에 돌아도 서로 막지 않는다.
 * 쓰기는 전부 트랜잭션 안에서 하므로 중간에 죽어도 반쯤 쓴 상태가 남지 않는다.
 */
import fs from "node:fs";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

export type DB = BetterSqlite3.Database;

/**
 * better-sqlite3는 네이티브 모듈이라 빌드할 때의 Node로만 열린다.
 * 모듈 최상단이 아니라 여기서 늦게 불러야 `grimoire doctor`가 이 실패를 진단할 수 있다.
 */
export function loadSqlite(): typeof BetterSqlite3 {
  try {
    return require("better-sqlite3") as typeof BetterSqlite3;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/.test(message)) {
      throw new Error(
        `SQLite 모듈이 지금 Node(${process.version}, ${process.execPath})와 맞지 않습니다. ` +
          "설치할 때 쓴 node로 실행하거나, 이 node로 'npm rebuild better-sqlite3'를 실행한 뒤 " +
          "'grimoire install'을 다시 하세요.",
      );
    }
    throw error;
  }
}

/** 스키마 버전 — 바꾸면 MIGRATIONS에 한 단계를 덧붙인다. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE repos (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    remote_url  TEXT,
    added_at    TEXT NOT NULL,
    synced_at   TEXT
  );

  CREATE TABLE commits (
    sha            TEXT NOT NULL,
    repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    author_name    TEXT NOT NULL,
    author_email   TEXT NOT NULL,
    authored_at    TEXT NOT NULL,
    subject        TEXT NOT NULL,
    body           TEXT NOT NULL,
    files_changed  INTEGER NOT NULL,
    insertions     INTEGER NOT NULL,
    deletions      INTEGER NOT NULL,
    meaningful     INTEGER NOT NULL,
    PRIMARY KEY (repo_id, sha)
  );
  CREATE INDEX commits_time ON commits(repo_id, authored_at);
  CREATE INDEX commits_sha ON commits(sha);
  CREATE INDEX commits_author ON commits(author_email);

  CREATE TABLE commit_files (
    repo_id     INTEGER NOT NULL,
    sha         TEXT NOT NULL,
    path        TEXT NOT NULL,
    insertions  INTEGER,
    deletions   INTEGER,
    FOREIGN KEY (repo_id, sha) REFERENCES commits(repo_id, sha) ON DELETE CASCADE
  );
  CREATE INDEX commit_files_commit ON commit_files(repo_id, sha);

  CREATE TABLE repo_tech (
    repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    tech           TEXT NOT NULL,
    category       TEXT NOT NULL,
    manifest_path  TEXT NOT NULL,
    dev            INTEGER NOT NULL,
    PRIMARY KEY (repo_id, tech, manifest_path)
  );

  CREATE TABLE notes (
    id          INTEGER PRIMARY KEY,
    repo_id     INTEGER REFERENCES repos(id) ON DELETE SET NULL,
    text        TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  -- 검색 단위. kind='commit'이면 ref=sha, kind='note'면 ref=notes.id
  CREATE TABLE docs (
    id       INTEGER PRIMARY KEY,
    kind     TEXT NOT NULL,
    ref      TEXT NOT NULL,
    repo_id  INTEGER REFERENCES repos(id) ON DELETE CASCADE,
    at       TEXT NOT NULL,
    UNIQUE (kind, repo_id, ref)
  );

  CREATE VIRTUAL TABLE docs_fts USING fts5(
    title, body, paths,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE embeddings (
    doc_id  INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    model   TEXT NOT NULL,
    vector  BLOB NOT NULL,
    PRIMARY KEY (doc_id, model)
  );
  `,
  // 2: 현재 코드 색인 (HEAD의 파일별 심볼) — docs kind='file', ref=경로
  `
  CREATE TABLE code_files (
    repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    path     TEXT NOT NULL,
    blob     TEXT NOT NULL,
    lines    INTEGER NOT NULL,
    symbols  TEXT NOT NULL,
    header   TEXT NOT NULL,
    PRIMARY KEY (repo_id, path)
  );
  `,
  // 3: 시맨틱 검색(로컬 임베딩) 제거 — 질의를 만드는 AI가 스스로 말을 바꿔 다시 찾으므로 키워드로 충분했다
  `
  DROP TABLE IF EXISTS embeddings;
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const Database = loadSqlite();
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/**
 * 문서 하나를 색인에 넣거나 갈아 끼운다. FTS 행 id는 docs.id와 같게 맞춘다.
 */
export function upsertDoc(
  db: DB,
  doc: {
    kind: "commit" | "note" | "file";
    ref: string;
    repoId: number | null;
    at: string;
    title: string;
    body: string;
    paths: string;
  },
): number {
  const existing = db
    .prepare(
      "SELECT id FROM docs WHERE kind = ? AND ref = ? AND repo_id IS ?",
    )
    .get(doc.kind, doc.ref, doc.repoId) as { id: number } | undefined;

  let id: number;
  if (existing) {
    id = existing.id;
    db.prepare("UPDATE docs SET at = ? WHERE id = ?").run(doc.at, id);
    db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(id);
  } else {
    id = Number(
      db
        .prepare("INSERT INTO docs (kind, ref, repo_id, at) VALUES (?, ?, ?, ?)")
        .run(doc.kind, doc.ref, doc.repoId, doc.at).lastInsertRowid,
    );
  }
  db.prepare(
    "INSERT INTO docs_fts (rowid, title, body, paths) VALUES (?, ?, ?, ?)",
  ).run(id, doc.title, doc.body, doc.paths);
  return id;
}

export function deleteDoc(db: DB, kind: string, ref: string, repoId: number | null): void {
  const existing = db
    .prepare("SELECT id FROM docs WHERE kind = ? AND ref = ? AND repo_id IS ?")
    .get(kind, ref, repoId) as { id: number } | undefined;
  if (!existing) return;
  db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(existing.id);
  db.prepare("DELETE FROM docs WHERE id = ?").run(existing.id);
}

/** 레포를 지우면 docs는 CASCADE로 지워지지만 FTS 가상 테이블은 따로 정리해야 한다. */
export function pruneOrphanFts(db: DB): void {
  db.exec("DELETE FROM docs_fts WHERE rowid NOT IN (SELECT id FROM docs)");
}
