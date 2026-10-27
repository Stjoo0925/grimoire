/**
 * 레포 개요·커밋 상세 — 검색 결과를 따라 들어갈 때 쓰는 읽기 전용 질의.
 */
import fs from "node:fs";

import type { DB } from "./db";
import { CancelledError, commitWebUrl, lineCounts, showCommit } from "./git";
import type { RepoRow } from "./indexer";
import { displayName } from "./tech/canonical";

const RECENT_COMMITS = 15;
const TOP_DIRS = 12;
/** diff 기본 줄 수 — 전체가 필요하면 파일을 지정해 다시 부른다 (응답 토큰을 아끼기 위해 작게) */
const DEFAULT_DIFF_LINES = 120;
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
  repoId: number;
  sha: string;
  url: string | null;
  author: string;
  date: string;
  subject: string;
  body: string;
  /** binary: 바이너리 파일. 줄 수가 null인데 binary가 아니면 줄 수를 알 수 없는 것(로컬 레포 없음) */
  files: { path: string; insertions: number | null; deletions: number | null; binary?: boolean }[];
  /** 로컬 레포에서 읽은 패치. 레포가 없거나 실패하면 null */
  patch: string | null;
  patchTruncated: boolean;
  patchNote?: string;
  /**
   * 읽은 diff 줄 수. 잘리지 않았으면 전체 줄 수, 잘렸으면(patchTruncated) 하한이다 —
   * 큰 커밋을 메모리에 다 올리지 않으려고 보낼 만큼 + 1줄에서 읽기를 멈춘다.
   */
  patchLines: number;
  /** paths로 좁혔을 때 실제로 고른 파일 */
  selectedFiles?: string[];
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
  options: { repoId?: number; maxDiffLines?: number; paths?: string[]; signal?: AbortSignal } = {},
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
  // 줄 수는 색인하지 않는다 — 이 커밋 하나만 지금 센다 (레포가 없으면 옛 색인 값이 있으면 그것을 쓴다)
  if (fs.existsSync(row.repo_path)) {
    try {
      const counts = new Map((await lineCounts(row.repo_path, row.sha, options.signal)).map((file) => [file.path, file]));
      for (const file of files) {
        const count = counts.get(file.path);
        if (!count) continue;
        file.insertions = count.insertions;
        file.deletions = count.deletions;
        file.binary = count.insertions === null;
      }
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      // 줄 수 없이 경로만 보여 준다
    }
  }

  const maxLines = Math.min(Math.max(20, options.maxDiffLines ?? DEFAULT_DIFF_LINES), MAX_DIFF_LINES);
  let patch: string | null = null;
  let patchTruncated = false;
  let patchNote: string | undefined;
  let patchLines = 0;

  // 경로는 커밋의 변경 파일 중에서 일부 일치로 고른다 ("route.ts" → src/app/api/github/route.ts)
  let selectedFiles: string[] | undefined;
  const wanted = (options.paths ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (wanted.length > 0) {
    selectedFiles = files.map((file) => file.path).filter((file) => wanted.some((want) => file.toLowerCase().includes(want)));
    if (selectedFiles.length === 0) {
      return {
        repo: row.repo,
        repoId: row.repo_id,
        sha: row.sha,
        url: commitWebUrl(row.remote_url, row.sha),
        author: `${row.author_name} <${row.author_email}>`,
        date: row.authored_at,
        subject: row.subject,
        body: row.body,
        files,
        patch: null,
        patchTruncated: false,
        patchLines: 0,
        selectedFiles,
        patchNote: `이 커밋에서 '${wanted.join(", ")}'와 일치하는 파일이 없습니다`,
      };
    }
  }

  if (!fs.existsSync(row.repo_path)) {
    patchNote = `로컬 레포가 없어 diff를 읽지 못했습니다: ${row.repo_path}`;
  } else {
    try {
      const shown = await showCommit(row.repo_path, row.sha, selectedFiles, { maxLines, signal: options.signal });
      patchTruncated = shown.truncated;
      patchLines = shown.lines.length + (shown.truncated ? 1 : 0);
      patch = shown.lines.join("\n");
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      patchNote = error instanceof Error ? error.message : "git show 실패";
    }
  }

  return {
    repo: row.repo,
    repoId: row.repo_id,
    sha: row.sha,
    url: commitWebUrl(row.remote_url, row.sha),
    author: `${row.author_name} <${row.author_email}>`,
    date: row.authored_at,
    subject: row.subject,
    body: row.body,
    files,
    patch,
    patchTruncated,
    patchLines,
    selectedFiles,
    patchNote,
  };
}
