/**
 * 레포 등록과 증분 동기화.
 *
 * 동기화는 "git이 아는 sha 중 DB에 없는 것"만 읽어 넣는다. 그래서
 * - 몇 번을 돌려도 결과가 같고(멱등),
 * - rebase로 히스토리가 바뀌어도 새 sha만 더해진다(옛 sha는 근거로 남는다).
 * 커밋은 READ_BATCH개씩 따로 트랜잭션으로 넣는다 — 큰 레포의 첫 동기화가 쓰기 잠금을 오래 쥐어
 * 다른 grimoire 프로세스(다른 창·CLI)의 쓰기를 `database is locked`로 실패시키지 않게. 중간에 실패해도
 * 들어간 커밋은 멱등이라 다음 동기화가 이어 간다. 기준점(tips·head_tree)과 기술 스택·현재 코드는
 * 마지막 트랜잭션에서 함께 바꾼다 — 기준점이 앞서 나가 빠지는 커밋이 생기지 않게.
 */
import fs from "node:fs";
import path from "node:path";

import { BLOB_BATCH_BYTES, extractSymbols, headerComment, listHeadFiles, readBlobs, splitIdentifier, type CodeSymbol, type HeadFile } from "./code";
import { deleteDoc, upsertDoc, pruneOrphanFts, type DB } from "./db";
import {
  headTree,
  listFiles,
  listNewShas,
  listShas,
  readCommits,
  readFileAtHead,
  refTips,
  remoteUrl,
  repoRoot,
  throwIfCancelled,
  type GitCommit,
} from "./git";
import { isMeaningfulSubject } from "./meaningful";
import { canonicalTech, techCategory } from "./tech/canonical";
import { parseManifest } from "./tech/manifests";

/** 한 번에 git에서 읽어 올 커밋 수 */
const READ_BATCH = 500;
/** 검색 문서에 넣는 변경 파일 경로 수 상한 (대량 이동 커밋이 색인을 부풀리지 않게) */
const DOC_PATHS_MAX = 200;
/** 기술 스택을 읽을 매니페스트 파일 수 상한 (모노레포 대비) */
const MANIFESTS_MAX = 40;
const MANIFEST_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
]);
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.venv|dist|build)\//;

export interface RepoRow {
  id: number;
  path: string;
  name: string;
  remote_url: string | null;
  added_at: string;
  synced_at: string | null;
  /** 지난 동기화의 ref 끝 커밋들 (JSON 배열) */
  tips?: string | null;
  /** 지난 동기화의 HEAD 트리 sha */
  head_tree?: string | null;
}

export interface SyncResult {
  repo: string;
  added: number;
  total: number;
  tech: number;
  /** 다시 읽은 코드 파일 수 (바뀐 것만) */
  files: number;
}

export async function addRepo(db: DB, dir: string, signal?: AbortSignal): Promise<RepoRow> {
  const root = await repoRoot(path.resolve(dir), signal);
  if (!root) throw new Error(`git 레포가 아닙니다: ${dir}`);

  const existing = db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as
    | RepoRow
    | undefined;
  if (existing) return existing;

  const remote = await remoteUrl(root, signal);
  throwIfCancelled(signal);
  // 다른 프로세스가 그 사이 같은 레포를 넣었을 수 있다 — 있으면 그대로 쓴다
  db.prepare(
    "INSERT OR IGNORE INTO repos (path, name, remote_url, added_at) VALUES (?, ?, ?, ?)",
  ).run(root, path.basename(root), remote, new Date().toISOString());
  return db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as RepoRow;
}

export function removeRepo(db: DB, repo: RepoRow): void {
  db.transaction(() => {
    db.prepare("DELETE FROM repos WHERE id = ?").run(repo.id);
    pruneOrphanFts(db);
  })();
}

export function listRepos(db: DB): RepoRow[] {
  return db.prepare("SELECT * FROM repos ORDER BY name").all() as RepoRow[];
}

/**
 * 이름·경로·원격 URL 일부와 맞는 레포들. 정확한 이름·경로 일치가 있으면 그것 하나만.
 * 여럿이면 호출부가 후보를 보여 주고 고르게 한다 (findRepo는 모호하면 null).
 */
export function matchRepos(db: DB, query: string): RepoRow[] {
  const repos = listRepos(db);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = repos.find(
    (repo) => repo.name.toLowerCase() === q || repo.path.toLowerCase() === q,
  );
  if (exact) return [exact];
  return repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(q) ||
      repo.path.toLowerCase().includes(q) ||
      (repo.remote_url ?? "").toLowerCase().includes(q),
  );
}

/** 이름·경로·원격 URL 일부로 레포 하나를 찾는다. 정확한 일치가 우선이고, 부분 일치가 여럿이면(모호) null. */
export function findRepo(db: DB, query: string): RepoRow | null {
  const matches = matchRepos(db, query);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 하위 디렉터리에서 git 레포를 찾는다 (레포 안으로는 더 내려가지 않는다).
 * limit을 주면 그보다 하나 더 찾은 데서 멈춘다 — 호출부가 "너무 많다"를 알 수 있을 만큼만 걷는다.
 */
export function discoverRepos(root: string, maxDepth = 4, limit = Infinity): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length > limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}

/**
 * 같은 레포의 동기화는 한 번에 하나만 — 기동 시 자동 동기화·작업 레포 등록·add_repo가 겹치면
 * 둘 다 같은 "새 sha"를 읽어 commit_files에 중복 행을 넣는다. 레포 경로별로 줄을 세운다.
 */
const syncing = new Map<string, Promise<SyncResult>>();

export function syncRepo(db: DB, repo: RepoRow, signal?: AbortSignal): Promise<SyncResult> {
  const previous = syncing.get(repo.path) ?? Promise.resolve(null);
  const next = previous.then(
    () => syncRepoNow(db, repo, signal),
    () => syncRepoNow(db, repo, signal),
  );
  syncing.set(repo.path, next);
  const clear = () => {
    if (syncing.get(repo.path) === next) syncing.delete(repo.path);
  };
  next.then(clear, clear);
  return next;
}

async function syncRepoNow(db: DB, repo: RepoRow, signal?: AbortSignal): Promise<SyncResult> {
  if (!fs.existsSync(repo.path)) {
    throw new Error(`레포 경로가 사라졌습니다: ${repo.path} (grimoire remove로 정리하세요)`);
  }

  // 넘겨받은 repo 행은 오래됐을 수 있다 — 기준점은 DB에서 다시 읽는다
  const saved = db.prepare("SELECT tips, head_tree FROM repos WHERE id = ?").get(repo.id) as
    | { tips: string | null; head_tree: string | null }
    | undefined;
  // 서로 기다릴 필요 없는 git 호출은 함께 띄운다 — 프로세스 띄우기가 호출마다 20ms 안팎이라(Windows),
  // 바뀐 것 없는 재동기화는 거의 이 셋이 전부다 (npm run perf: 재동기화 시간)
  const [tips, tree, remote] = await Promise.all([refTips(repo.path, signal), headTree(repo.path, signal), remoteUrl(repo.path, signal)]);
  const fresh = await newShas(db, repo, saved?.tips ?? null, tips, signal);

  // 커밋은 읽은 묶음마다 따로 쓴다 — 쓰기 잠금을 짧게 쥐고, 전 커밋을 메모리에 모아 두지 않는다.
  // 트랜잭션은 동기라 아래 기술 스택·코드 읽기와 겹쳐 돌아도 서로 섞이지 않는다
  const writeFresh = async () => {
    let added = 0;
    for (let start = 0; start < fresh.length; start += READ_BATCH) {
      const batch = await readCommits(repo.path, fresh.slice(start, start + READ_BATCH), signal);
      throwIfCancelled(signal);
      db.transaction(() => {
        for (const commit of batch) insertCommit(db, repo, commit);
      })();
      added += batch.length;
    }
    return added;
  };
  // HEAD 트리가 그대로면 현재 코드·기술 스택도 그대로다. 커밋·기술 스택·코드 읽기는 서로 독립이라 함께 돌린다
  const treeChanged = tree === null || tree !== saved?.head_tree;
  const [added, tech, code] = await Promise.all([
    writeFresh(),
    treeChanged ? readTechStack(repo.path, signal) : null,
    treeChanged ? readChangedCode(db, repo, signal) : { changed: [], removed: [] },
  ]);
  // git 실패를 기본값으로 삼키는 함수들이 있어, 취소됐으면 그 기본값을 쓰기 전에 멈춘다
  throwIfCancelled(signal);

  db.transaction(() => {
    if (tech) {
      db.prepare("DELETE FROM repo_tech WHERE repo_id = ?").run(repo.id);
      const insertTech = db.prepare(
        "INSERT OR IGNORE INTO repo_tech (repo_id, tech, category, manifest_path, dev) VALUES (?, ?, ?, ?, ?)",
      );
      for (const item of tech) {
        insertTech.run(repo.id, item.tech, item.category, item.manifestPath, item.dev ? 1 : 0);
      }
    }

    applyCode(db, repo, code);

    db.prepare("UPDATE repos SET synced_at = ?, remote_url = ?, tips = ?, head_tree = ? WHERE id = ?").run(
      new Date().toISOString(),
      remote,
      JSON.stringify(tips),
      tree,
      repo.id,
    );
  })();

  const count = (sql: string) => (db.prepare(sql).get(repo.id) as { n: number }).n;
  return {
    repo: repo.name,
    added,
    total: count("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?"),
    tech: count("SELECT COUNT(DISTINCT tech) AS n FROM repo_tech WHERE repo_id = ?"),
    files: code.changed.length,
  };
}

/**
 * DB에 없는 새 sha. ref 끝 커밋이 지난번과 같으면 git을 더 부르지 않고, 달라졌으면 그 뒤 커밋만 받는다.
 * 기준점이 없거나(첫 동기화·옛 DB) 지난 끝 커밋이 사라졌으면 전체 목록과 DB를 비교한다.
 */
async function newShas(
  db: DB,
  repo: RepoRow,
  savedTips: string | null,
  tips: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const previous = parseTips(savedTips);
  if (previous && previous.length === tips.length && previous.every((sha, index) => sha === tips[index])) return [];
  let candidates: string[] | null = null;
  if (previous && previous.length > 0) {
    try {
      candidates = await listNewShas(repo.path, previous, signal);
    } catch {
      throwIfCancelled(signal);
      candidates = null; // 지난 끝 커밋이 사라짐 → 전체 비교
    }
  }
  if (candidates === null) {
    const all = await listShas(repo.path, signal);
    // 목록을 받은 뒤에 읽는다 — 그 사이 다른 묶음이 들어갔어도 중복으로 읽지 않게
    const known = new Set(
      (db.prepare("SELECT sha FROM commits WHERE repo_id = ?").all(repo.id) as { sha: string }[]).map((row) => row.sha),
    );
    return all.filter((sha) => !known.has(sha));
  }
  // rebase로 같은 커밋이 다른 ref에서 다시 닿는 경우 등 — 이미 있는 것은 뺀다
  const exists = db.prepare("SELECT 1 FROM commits WHERE repo_id = ? AND sha = ?");
  return candidates.filter((sha) => !exists.get(repo.id, sha));
}

function parseTips(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** 바뀐 파일에서 미리 뽑아 둔 것 — 내용 자체는 들고 있지 않는다 */
interface ChangedFile {
  path: string;
  blob: string;
  lines: number;
  symbols: CodeSymbol[];
  header: string;
}

interface CodeChanges {
  changed: ChangedFile[];
  removed: string[];
}

/** blob 크기 합계가 BLOB_BATCH_BYTES를 넘지 않게 나눈다 (cat-file 출력이 버퍼 하나에 올라오므로) */
export function blobBatches(files: HeadFile[], maxBytes = BLOB_BATCH_BYTES): HeadFile[][] {
  const batches: HeadFile[][] = [];
  let current: HeadFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && bytes + file.size > maxBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * HEAD의 파일 중 blob이 바뀐 것만 읽는다 (트랜잭션 밖 — git 호출이 느릴 수 있어서).
 * 묶음별로 읽어 심볼·머리 주석을 바로 뽑고 내용은 버린다 — 트랜잭션 안에서는 INSERT만 한다.
 */
async function readChangedCode(db: DB, repo: RepoRow, signal?: AbortSignal): Promise<CodeChanges> {
  const head = await listHeadFiles(repo.path, signal);
  const known = new Map(
    (db.prepare("SELECT path, blob FROM code_files WHERE repo_id = ?").all(repo.id) as { path: string; blob: string }[]).map(
      (row) => [row.path, row.blob],
    ),
  );
  const stale = head.filter((file) => known.get(file.path) !== file.blob);
  // 같은 내용(blob)의 파일은 한 번만 읽는다
  const unique = [...new Map(stale.map((file) => [file.blob, file])).values()];
  const extracted = new Map<string, Omit<ChangedFile, "path" | "blob">>();
  for (const batch of blobBatches(unique)) {
    const contents = await readBlobs(repo.path, batch.map((file) => file.blob), signal);
    for (const file of batch) {
      const content = contents.get(file.blob) ?? "";
      extracted.set(file.blob, {
        lines: content.split("\n").length,
        symbols: extractSymbols(content),
        header: headerComment(content),
      });
    }
  }
  const present = new Set(head.map((file) => file.path));
  const empty = { lines: 1, symbols: [], header: "" };
  return {
    changed: stale.map((file) => ({ path: file.path, blob: file.blob, ...(extracted.get(file.blob) ?? empty) })),
    removed: [...known.keys()].filter((file) => !present.has(file)),
  };
}

function applyCode(db: DB, repo: RepoRow, code: CodeChanges): void {
  const upsert = db.prepare(
    `INSERT INTO code_files (repo_id, path, blob, lines, symbols, header) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, path) DO UPDATE SET blob = excluded.blob, lines = excluded.lines,
       symbols = excluded.symbols, header = excluded.header`,
  );
  const now = new Date().toISOString();
  for (const file of code.changed) {
    const { symbols, header } = file;
    upsert.run(repo.id, file.path, file.blob, file.lines, JSON.stringify(symbols), header);
    upsertDoc(db, {
      kind: "file",
      ref: file.path,
      repoId: repo.id,
      at: now,
      title: file.path,
      // 심볼 원형 + 낱말로 쪼갠 형태를 함께 넣어 "rate limit"·"ratelimit" 둘 다 걸리게 한다
      body: [repo.name, header, symbols.map((symbol) => `${symbol.name} ${splitIdentifier(symbol.name)}`).join(" ")]
        .filter(Boolean)
        .join("\n"),
      paths: `${file.path} ${splitIdentifier(file.path)}`,
    });
  }
  const remove = db.prepare("DELETE FROM code_files WHERE repo_id = ? AND path = ?");
  for (const file of code.removed) {
    remove.run(repo.id, file);
    deleteDoc(db, "file", file, repo.id);
  }
}

function insertCommit(db: DB, repo: RepoRow, commit: GitCommit): void {
  const insertions = commit.files.reduce((sum, file) => sum + (file.insertions ?? 0), 0);
  const deletions = commit.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO commits
       (sha, repo_id, author_name, author_email, authored_at, subject, body,
        files_changed, insertions, deletions, meaningful)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    commit.sha,
    repo.id,
    commit.authorName,
    commit.authorEmail,
    commit.authoredAt,
    commit.subject,
    commit.body,
    commit.files.length,
    insertions,
    deletions,
    isMeaningfulSubject(commit.subject) ? 1 : 0,
  );
  // 이미 있던 커밋(다른 프로세스가 먼저 넣음)이면 파일·문서도 이미 같은 트랜잭션으로 들어가 있다 — 중복 행을 만들지 않는다
  if (inserted.changes === 0) return;

  const insertFile = db.prepare(
    "INSERT INTO commit_files (repo_id, sha, path, insertions, deletions) VALUES (?, ?, ?, ?, ?)",
  );
  for (const file of commit.files) {
    insertFile.run(repo.id, commit.sha, file.path, file.insertions, file.deletions);
  }

  upsertDoc(db, {
    kind: "commit",
    ref: commit.sha,
    repoId: repo.id,
    at: commit.authoredAt,
    title: commit.subject,
    body: [repo.name, commit.body].filter(Boolean).join("\n"),
    paths: commit.files
      .slice(0, DOC_PATHS_MAX)
      .map((file) => file.path)
      .join(" "),
  });
}

interface TechItem {
  tech: string;
  category: string;
  manifestPath: string;
  dev: boolean;
}

/** HEAD의 의존성 매니페스트 → 정규화된 기술 목록 */
async function readTechStack(dir: string, signal?: AbortSignal): Promise<TechItem[]> {
  const manifests = (await listFiles(dir, signal))
    .filter((file) => MANIFEST_NAMES.has(path.posix.basename(file)) && !VENDORED.test(file))
    .slice(0, MANIFESTS_MAX);

  const items: TechItem[] = [];
  for (const manifestPath of manifests) {
    const content = await readFileAtHead(dir, manifestPath, signal);
    if (!content) continue;
    for (const dependency of parseManifest(manifestPath, content)) {
      const tech = canonicalTech(dependency.raw);
      if (!tech) continue;
      items.push({ tech, category: techCategory(tech), manifestPath, dev: dependency.dev });
    }
  }
  return items;
}
