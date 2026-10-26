/**
 * 레포 등록과 증분 동기화.
 *
 * 동기화는 "git이 아는 sha 중 DB에 없는 것"만 읽어 넣는다. 그래서
 * - 몇 번을 돌려도 결과가 같고(멱등),
 * - rebase로 히스토리가 바뀌어도 새 sha만 더해진다(옛 sha는 근거로 남는다).
 * 레포 하나의 쓰기는 한 트랜잭션이다.
 */
import fs from "node:fs";
import path from "node:path";

import { extractSymbols, headerComment, listHeadFiles, readBlobs, splitIdentifier } from "./code";
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

export async function addRepo(db: DB, dir: string): Promise<RepoRow> {
  const root = await repoRoot(path.resolve(dir));
  if (!root) throw new Error(`git 레포가 아닙니다: ${dir}`);

  const existing = db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as
    | RepoRow
    | undefined;
  if (existing) return existing;

  db.prepare(
    "INSERT INTO repos (path, name, remote_url, added_at) VALUES (?, ?, ?, ?)",
  ).run(root, path.basename(root), await remoteUrl(root), new Date().toISOString());
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

/** 이름·경로·원격 URL 일부로 레포를 찾는다. 여럿이면 정확한 이름 일치를 우선. */
export function findRepo(db: DB, query: string): RepoRow | null {
  const repos = listRepos(db);
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = repos.find(
    (repo) => repo.name.toLowerCase() === q || repo.path.toLowerCase() === q,
  );
  if (exact) return exact;
  const partial = repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(q) ||
      repo.path.toLowerCase().includes(q) ||
      (repo.remote_url ?? "").toLowerCase().includes(q),
  );
  return partial.length === 1 ? partial[0] : (partial[0] ?? null);
}

/** 하위 디렉터리에서 git 레포를 찾는다 (레포 안으로는 더 내려가지 않는다). */
export function discoverRepos(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
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

export function syncRepo(db: DB, repo: RepoRow): Promise<SyncResult> {
  const previous = syncing.get(repo.path) ?? Promise.resolve(null);
  const next = previous.then(
    () => syncRepoNow(db, repo),
    () => syncRepoNow(db, repo),
  );
  syncing.set(repo.path, next);
  const clear = () => {
    if (syncing.get(repo.path) === next) syncing.delete(repo.path);
  };
  next.then(clear, clear);
  return next;
}

async function syncRepoNow(db: DB, repo: RepoRow): Promise<SyncResult> {
  if (!fs.existsSync(repo.path)) {
    throw new Error(`레포 경로가 사라졌습니다: ${repo.path} (grimoire remove로 정리하세요)`);
  }

  // 넘겨받은 repo 행은 오래됐을 수 있다 — 기준점은 DB에서 다시 읽는다
  const saved = db.prepare("SELECT tips, head_tree FROM repos WHERE id = ?").get(repo.id) as
    | { tips: string | null; head_tree: string | null }
    | undefined;
  // 서로 기다릴 필요 없는 git 호출은 함께 띄운다 — 프로세스 띄우기가 호출마다 20ms 안팎이라(Windows),
  // 바뀐 것 없는 재동기화는 거의 이 셋이 전부다 (npm run perf: 재동기화 시간)
  const [tips, tree, remote] = await Promise.all([refTips(repo.path), headTree(repo.path), remoteUrl(repo.path)]);
  const fresh = await newShas(db, repo, saved?.tips ?? null, tips);

  const readFresh = async () => {
    const out: GitCommit[] = [];
    for (let start = 0; start < fresh.length; start += READ_BATCH) {
      out.push(...(await readCommits(repo.path, fresh.slice(start, start + READ_BATCH))));
    }
    return out;
  };
  // HEAD 트리가 그대로면 현재 코드·기술 스택도 그대로다. 커밋·기술 스택·코드 읽기는 서로 독립이라 함께 돌린다
  const treeChanged = tree === null || tree !== saved?.head_tree;
  const [commits, tech, code] = await Promise.all([
    readFresh(),
    treeChanged ? readTechStack(repo.path) : null,
    treeChanged ? readChangedCode(db, repo) : { changed: [], removed: [] },
  ]);

  db.transaction(() => {
    for (const commit of commits) insertCommit(db, repo, commit);

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
    added: commits.length,
    total: count("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?"),
    tech: count("SELECT COUNT(DISTINCT tech) AS n FROM repo_tech WHERE repo_id = ?"),
    files: code.changed.length,
  };
}

/**
 * DB에 없는 새 sha. ref 끝 커밋이 지난번과 같으면 git을 더 부르지 않고, 달라졌으면 그 뒤 커밋만 받는다.
 * 기준점이 없거나(첫 동기화·옛 DB) 지난 끝 커밋이 사라졌으면 전체 목록과 DB를 비교한다.
 */
async function newShas(db: DB, repo: RepoRow, savedTips: string | null, tips: string[]): Promise<string[]> {
  const previous = parseTips(savedTips);
  if (previous && previous.length === tips.length && previous.every((sha, index) => sha === tips[index])) return [];
  let candidates: string[] | null = null;
  if (previous && previous.length > 0) {
    try {
      candidates = await listNewShas(repo.path, previous);
    } catch {
      candidates = null; // 지난 끝 커밋이 사라짐 → 전체 비교
    }
  }
  if (candidates === null) {
    const known = new Set(
      (db.prepare("SELECT sha FROM commits WHERE repo_id = ?").all(repo.id) as { sha: string }[]).map((row) => row.sha),
    );
    return (await listShas(repo.path)).filter((sha) => !known.has(sha));
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

interface CodeChanges {
  changed: { path: string; blob: string; content: string }[];
  removed: string[];
}

/** HEAD의 파일 중 blob이 바뀐 것만 읽는다 (트랜잭션 밖 — git 호출이 느릴 수 있어서) */
async function readChangedCode(db: DB, repo: RepoRow): Promise<CodeChanges> {
  const head = await listHeadFiles(repo.path);
  const known = new Map(
    (db.prepare("SELECT path, blob FROM code_files WHERE repo_id = ?").all(repo.id) as { path: string; blob: string }[]).map(
      (row) => [row.path, row.blob],
    ),
  );
  const stale = head.filter((file) => known.get(file.path) !== file.blob);
  const contents = await readBlobs(repo.path, [...new Set(stale.map((file) => file.blob))]);
  const present = new Set(head.map((file) => file.path));
  return {
    changed: stale.map((file) => ({ path: file.path, blob: file.blob, content: contents.get(file.blob) ?? "" })),
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
    const symbols = extractSymbols(file.content);
    const header = headerComment(file.content);
    upsert.run(repo.id, file.path, file.blob, file.content.split("\n").length, JSON.stringify(symbols), header);
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
  db.prepare(
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
async function readTechStack(dir: string): Promise<TechItem[]> {
  const manifests = (await listFiles(dir))
    .filter((file) => MANIFEST_NAMES.has(path.posix.basename(file)) && !VENDORED.test(file))
    .slice(0, MANIFESTS_MAX);

  const items: TechItem[] = [];
  for (const manifestPath of manifests) {
    const content = await readFileAtHead(dir, manifestPath);
    if (!content) continue;
    for (const dependency of parseManifest(manifestPath, content)) {
      const tech = canonicalTech(dependency.raw);
      if (!tech) continue;
      items.push({ tech, category: techCategory(tech), manifestPath, dev: dependency.dev });
    }
  }
  return items;
}
