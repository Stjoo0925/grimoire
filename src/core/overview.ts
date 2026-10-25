/**
 * 레포 개요·커밋 상세 — 검색 결과를 따라 들어갈 때 쓰는 읽기 전용 질의.
 */
import fs from "node:fs";

import type { DB } from "./db";
import { commitWebUrl, showCommit } from "./git";
import type { RepoRow } from "./indexer";
import { displayName } from "./tech/canonical";

const RECENT_COMMITS = 15;
const TOP_DIRS = 12;
const DEFAULT_DIFF_LINES = 400;
const MAX_DIFF_LINES = 3000;

export interface RepoSummary {
  name: string;
  path: string;
  remote: string | null;
  commits: number;
  mine: number;
  firstCommit: string | null;
  lastCommit: string | null;
  syncedAt: string | null;
}

export function repoSummaries(db: DB, me: string[]): RepoSummary[] {
  const rows = db
    .prepare(
      `SELECT r.*, COUNT(c.sha) AS commits, MIN(c.authored_at) AS first, MAX(c.authored_at) AS last
         FROM repos r LEFT JOIN commits c ON c.repo_id = r.id
        GROUP BY r.id ORDER BY last DESC`,
    )
    .all() as (RepoRow & { commits: number; first: string | null; last: string | null })[];
  return rows.map((row) => ({
    name: row.name,
    path: row.path,
    remote: row.remote_url,
    commits: row.commits,
    mine: countMine(db, row.id, me),
    firstCommit: row.first,
    lastCommit: row.last,
    syncedAt: row.synced_at,
  }));
}

function countMine(db: DB, repoId: number, me: string[]): number {
  if (me.length === 0) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM commits WHERE repo_id = ? AND author_email IN (${me.map(() => "?").join(", ")})`,
      )
      .get(repoId, ...me) as { n: number }
  ).n;
}

export interface RepoOverview extends RepoSummary {
  tech: { category: string; items: string[] }[];
  /** 활동이 있었던 분기별 커밋 수 */
  activity: { period: string; commits: number }[];
  topDirectories: { path: string; commits: number }[];
  topAuthors: { author: string; commits: number }[];
  recentCommits: { sha: string; date: string; subject: string; author: string; url: string | null }[];
}

export function repoOverview(db: DB, repo: RepoRow, me: string[]): RepoOverview {
  const summary = repoSummaries(db, me).find((item) => item.path === repo.path)!;

  const techRows = db
    .prepare(
      "SELECT DISTINCT tech, category, MIN(dev) AS dev FROM repo_tech WHERE repo_id = ? GROUP BY tech ORDER BY dev, tech",
    )
    .all(repo.id) as { tech: string; category: string; dev: number }[];
  const byCategory = new Map<string, string[]>();
  for (const row of techRows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(displayName(row.tech) + (row.dev ? " (dev)" : ""));
    byCategory.set(row.category, list);
  }

  const activity = db
    .prepare(
      `SELECT substr(authored_at, 1, 4) || '-Q' || ((CAST(substr(authored_at, 6, 2) AS INTEGER) + 2) / 3) AS period,
              COUNT(*) AS commits
         FROM commits WHERE repo_id = ? GROUP BY period ORDER BY period`,
    )
    .all(repo.id) as { period: string; commits: number }[];

  // 최상위 두 단계 디렉터리 기준으로 "어디를 많이 건드렸나"
  const dirCounts = new Map<string, Set<string>>();
  const fileRows = db.prepare("SELECT sha, path FROM commit_files WHERE repo_id = ?").all(repo.id) as {
    sha: string;
    path: string;
  }[];
  for (const row of fileRows) {
    const parts = row.path.split("/");
    const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0] : "(root)";
    const set = dirCounts.get(dir) ?? new Set<string>();
    set.add(row.sha);
    dirCounts.set(dir, set);
  }
  const topDirectories = [...dirCounts.entries()]
    .map(([path, shas]) => ({ path, commits: shas.size }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, TOP_DIRS);

  const topAuthors = (
    db
      .prepare(
        `SELECT author_name || ' <' || author_email || '>' AS author, COUNT(*) AS commits
           FROM commits WHERE repo_id = ? GROUP BY author_email ORDER BY commits DESC LIMIT 5`,
      )
      .all(repo.id) as { author: string; commits: number }[]
  );

  const recentCommits = (
    db
      .prepare(
        `SELECT sha, authored_at AS date, subject, author_name AS author
           FROM commits WHERE repo_id = ? AND meaningful = 1
          ORDER BY authored_at DESC LIMIT ?`,
      )
      .all(repo.id, RECENT_COMMITS) as { sha: string; date: string; subject: string; author: string }[]
  ).map((row) => ({ ...row, url: commitWebUrl(repo.remote_url, row.sha) }));

  return {
    ...summary,
    tech: [...byCategory.entries()].map(([category, items]) => ({ category, items })),
    activity,
    topDirectories,
    topAuthors,
    recentCommits,
  };
}

export interface CommitDetail {
  repo: string;
  sha: string;
  url: string | null;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: { path: string; insertions: number | null; deletions: number | null }[];
  /** 로컬 레포에서 읽은 패치. 레포가 없거나 실패하면 null */
  patch: string | null;
  patchTruncated: boolean;
  patchNote?: string;
}

/** sha 접두(7자 이상)로 커밋을 찾는다. 여러 레포에 있으면 repoId로 좁힌다. */
export function findCommits(db: DB, shaPrefix: string, repoId?: number) {
  const prefix = shaPrefix.trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(prefix)) return [];
  return db
    .prepare(
      `SELECT c.*, r.name AS repo, r.path AS repo_path, r.remote_url
         FROM commits c JOIN repos r ON r.id = c.repo_id
        WHERE c.sha LIKE ? ${repoId !== undefined ? "AND c.repo_id = ?" : ""}
        LIMIT 5`,
    )
    .all(...(repoId !== undefined ? [`${prefix}%`, repoId] : [`${prefix}%`])) as {
    sha: string;
    repo_id: number;
    repo: string;
    repo_path: string;
    remote_url: string | null;
    author_name: string;
    author_email: string;
    authored_at: string;
    subject: string;
    body: string;
  }[];
}

export async function commitDetail(
  db: DB,
  shaPrefix: string,
  options: { repoId?: number; maxDiffLines?: number } = {},
): Promise<CommitDetail | { error: string; candidates?: string[] }> {
  const matches = findCommits(db, shaPrefix, options.repoId);
  if (matches.length === 0) return { error: `커밋을 찾지 못했습니다: ${shaPrefix}` };
  if (matches.length > 1) {
    return {
      error: "여러 커밋이 일치합니다. sha를 더 길게 주거나 repo를 지정하세요.",
      candidates: matches.map((row) => `${row.repo} ${row.sha.slice(0, 12)} ${row.subject}`),
    };
  }
  const row = matches[0];
  const files = db
    .prepare("SELECT path, insertions, deletions FROM commit_files WHERE repo_id = ? AND sha = ?")
    .all(row.repo_id, row.sha) as CommitDetail["files"];

  const maxLines = Math.min(Math.max(20, options.maxDiffLines ?? DEFAULT_DIFF_LINES), MAX_DIFF_LINES);
  let patch: string | null = null;
  let patchTruncated = false;
  let patchNote: string | undefined;
  if (!fs.existsSync(row.repo_path)) {
    patchNote = `로컬 레포가 없어 diff를 읽지 못했습니다: ${row.repo_path}`;
  } else {
    try {
      const lines = (await showCommit(row.repo_path, row.sha)).split("\n");
      patchTruncated = lines.length > maxLines;
      patch = lines.slice(0, maxLines).join("\n");
    } catch (error) {
      patchNote = error instanceof Error ? error.message : "git show 실패";
    }
  }

  return {
    repo: row.repo,
    sha: row.sha,
    url: commitWebUrl(row.remote_url, row.sha),
    author: `${row.author_name} <${row.author_email}>`,
    date: row.authored_at,
    subject: row.subject,
    body: row.body,
    files,
    patch,
    patchTruncated,
    patchNote,
  };
}
