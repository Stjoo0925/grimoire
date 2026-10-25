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

import { upsertDoc, pruneOrphanFts, type DB } from "./db";
import {
  listFiles,
  listShas,
  readCommits,
  readFileAtHead,
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
}

export interface SyncResult {
  repo: string;
  added: number;
  total: number;
  tech: number;
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

export async function syncRepo(db: DB, repo: RepoRow): Promise<SyncResult> {
  if (!fs.existsSync(repo.path)) {
    throw new Error(`레포 경로가 사라졌습니다: ${repo.path} (grimoire remove로 정리하세요)`);
  }

  const known = new Set(
    (db.prepare("SELECT sha FROM commits WHERE repo_id = ?").all(repo.id) as { sha: string }[]).map(
      (row) => row.sha,
    ),
  );
  const fresh = (await listShas(repo.path)).filter((sha) => !known.has(sha));

  const commits: GitCommit[] = [];
  for (let start = 0; start < fresh.length; start += READ_BATCH) {
    commits.push(...(await readCommits(repo.path, fresh.slice(start, start + READ_BATCH))));
  }
  const tech = await readTechStack(repo.path);
  const remote = await remoteUrl(repo.path);

  db.transaction(() => {
    for (const commit of commits) insertCommit(db, repo, commit);

    db.prepare("DELETE FROM repo_tech WHERE repo_id = ?").run(repo.id);
    const insertTech = db.prepare(
      "INSERT OR IGNORE INTO repo_tech (repo_id, tech, category, manifest_path, dev) VALUES (?, ?, ?, ?, ?)",
    );
    for (const item of tech) {
      insertTech.run(repo.id, item.tech, item.category, item.manifestPath, item.dev ? 1 : 0);
    }

    db.prepare("UPDATE repos SET synced_at = ?, remote_url = ? WHERE id = ?").run(
      new Date().toISOString(),
      remote,
      repo.id,
    );
  })();

  return {
    repo: repo.name,
    added: commits.length,
    total: known.size + commits.length,
    tech: new Set(tech.map((item) => item.tech)).size,
  };
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
