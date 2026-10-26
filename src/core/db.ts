/**
 * SQLite 저장소 — 스키마와 연결.
 *
 * WAL 모드라 CLI 동기화(쓰기)와 MCP 질의(읽기)가 동시에 돌아도 서로 막지 않는다.
 * 쓰기는 전부 트랜잭션 안에서 하므로 중간에 죽어도 반쯤 쓴 상태가 남지 않는다.
 */
import fs from "node:fs";
import path from "node:path";

import type * as NodeSqlite from "node:sqlite";

/** node:sqlite가 들어간 첫 버전(플래그 없이) — package.json engines와 맞춘다 */
export const MIN_NODE = "22.13.0";

/**
 * Node 내장 SQLite(node:sqlite). 네이티브 모듈을 따로 빌드하지 않으므로 node를 바꿔도 다시 설치할 필요가 없다.
 * 모듈 최상단이 아니라 여기서 늦게 불러야 `grimoire doctor`가 오래된 Node를 진단할 수 있다.
 * 불러올 때 한 번 나오는 ExperimentalWarning은 CLI 출력만 어지럽히므로 그것만 삼킨다.
 */
export function loadSqlite(): typeof NodeSqlite {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /SQLite/.test(text)) return;
    return (emitWarning as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof NodeSqlite;
  } catch (error) {
    throw new Error(
      `지금 Node(${process.version}, ${process.execPath})에는 내장 SQLite(node:sqlite)가 없습니다. ` +
        `Node ${MIN_NODE} 이상으로 실행한 뒤 'grimoire install'을 다시 하세요.`,
      { cause: error },
    );
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** 준비된 문장. 행 모양은 SQL을 쓴 호출부가 정하므로 unknown으로 돌려준다. */
export interface Statement {
  run(...params: NodeSqlite.SQLInputValue[]): NodeSqlite.StatementResultingChanges;
  get(...params: NodeSqlite.SQLInputValue[]): unknown;
  all(...params: NodeSqlite.SQLInputValue[]): unknown[];
}

/**
 * 연결 하나. 호출부가 쓰던 모양(prepare·exec·pragma·transaction)을 node:sqlite 위에 그대로 둔다.
 */
export class DB {
  private depth = 0;

  constructor(private readonly raw: NodeSqlite.DatabaseSync) {}

  /** node:sqlite는 행을 null 프로토타입 객체로 주므로, 응답에 그대로 실려도 되게 보통 객체로 바꾼다 */
  prepare(sql: string): Statement {
    const statement = this.raw.prepare(sql);
    return {
      run: (...params) => statement.run(...params),
      get: (...params) => {
        const row = statement.get(...params);
        return row && { ...row };
      },
      all: (...params) => statement.all(...params).map((row) => ({ ...row })),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** PRAGMA를 실행하고 첫 행의 첫 값을 돌려준다 (설정만 하는 PRAGMA면 undefined) */
  pragma(source: string): unknown {
    const row = this.raw.prepare(`PRAGMA ${source}`).get();
    return row ? Object.values(row)[0] : undefined;
  }

  /**
   * fn을 트랜잭션으로 감싼 함수를 돌려준다. 던지면 되돌린다.
   * 트랜잭션 안에서 또 부르면 SAVEPOINT로 안쪽만 되돌릴 수 있게 한다.
   * 바깥 트랜잭션은 BEGIN IMMEDIATE — 쓰기 잠금을 시작할 때 busy_timeout만큼 기다려 얻는다.
   * 지연 모드(BEGIN)는 읽다가 쓰기로 올라갈 때 다른 프로세스와 부딪히면 기다리지 않고 바로 실패한다.
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const name = `grimoire_${this.depth}`;
      const nested = this.depth > 0;
      this.raw.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
      this.depth++;
      let result: T;
      try {
        result = fn();
      } catch (error) {
        this.depth--;
        this.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
        throw error;
      }
      this.depth--;
      this.raw.exec(nested ? `RELEASE ${name}` : "COMMIT");
      return result;
    };
  }

  close(): void {
    this.raw.close();
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
  // 4: 증분 동기화 기준점 — 지난번 ref 끝 커밋들(JSON 배열)과 HEAD 트리. 그대로면 git을 거의 부르지 않는다.
  //    commits.insertions·deletions는 이제 색인 때 세지 않는다(0). 줄 수는 show_commit 때 git에서 바로 센다.
  `
  ALTER TABLE repos ADD COLUMN tips TEXT;
  ALTER TABLE repos ADD COLUMN head_tree TEXT;
  `,
  // 5: 커밋 diff의 식별자 색인(diffs.ts) — FTS에 code 컬럼을 더하고(가상 테이블이라 새로 만들어 옮긴다),
  //    커밋마다 diff를 읽었는지(code_state)와 바뀐 선언(symbols, JSON)을 둔다. 기존 커밋은 뒤에서 채워진다.
  `
  CREATE VIRTUAL TABLE docs_fts_next USING fts5(
    title, body, paths, code,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO docs_fts_next (rowid, title, body, paths, code) SELECT rowid, title, body, paths, '' FROM docs_fts;
  DROP TABLE docs_fts;
  ALTER TABLE docs_fts_next RENAME TO docs_fts;
  ALTER TABLE commits ADD COLUMN code_state INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE commits ADD COLUMN symbols TEXT;
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") makePrivate(file);
  const { DatabaseSync } = loadSqlite();
  const db = new DB(new DatabaseSync(file));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/**
 * DB에는 비공개 레포의 커밋 메시지·코드 심볼·경로가 들어 있으므로 나만 읽게 한다 — 폴더 0700, 파일 0600.
 * 폴더는 새로 만들 때만 권한을 정한다(GRIMOIRE_HOME으로 고른 기존 폴더는 건드리지 않는다).
 * 파일은 SQLite보다 먼저 0600으로 만들어 둔다 — SQLite는 -wal·-shm을 DB 파일과 같은 권한으로 만든다.
 * 이전 버전이 0644로 만든 파일도 열 때 고친다. Windows에서는 chmod가 의미 없어 실패해도 넘어간다.
 */
function makePrivate(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, "a", 0o600));
  for (const target of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.statSync(target).mode & 0o077) fs.chmodSync(target, 0o600);
    } catch {
      // 없거나 권한을 바꿀 수 없음
    }
  }
}

function migrate(db: DB): void {
  const current = db.pragma("user_version") as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      // 첫 실행에서 두 프로세스가 동시에 열면, 잠금을 기다리는 사이 다른 쪽이 이 단계를 끝냈을 수 있다
      if ((db.pragma("user_version") as number) > version) return;
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
    "INSERT INTO docs_fts (rowid, title, body, paths, code) VALUES (?, ?, ?, ?, '')",
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
/** 다른 연결(다른 grimoire 프로세스)이 쓰기 잠금을 쥐고 있어 busy_timeout 안에 못 얻은 실패인가 */
export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(error.message);
}

export function pruneOrphanFts(db: DB): void {
  db.exec("DELETE FROM docs_fts WHERE rowid NOT IN (SELECT id FROM docs)");
}
