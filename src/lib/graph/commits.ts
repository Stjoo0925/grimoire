/**
 * ② 지식그래프 — 2단계: 커밋 사전 압축·스마트 필터링 (KNOWLEDGE_GRAPH.md §4.1).
 *
 * merge/오타/docs/chore 류를 걷어내고 레포별로 묶어 LLM 컨텍스트를 최소화한다.
 * 이 단계 자체는 LLM과 무관하게 항상 돌며, Period 계산에도 쓰인다.
 */
import type { Commit } from "../collector/types";

/** 레포당 다이제스트에 담을 최대 커밋 수 */
export const MAX_COMMITS_PER_REPO = 60;
/** 레포당 다이제스트 최대 길이 (문자) */
export const MAX_DIGEST_CHARS = 6000;

const MERGE = /^merge\s+(branch|pull request|remote|commit|tag)\b/i;
const TRIVIAL_PREFIX =
  /^(chore|docs|style|ci|build|test|revert)(\([^)]*\))?!?\s*:/i;
const TRIVIAL_WORDS =
  /^(wip\b|typo\b|오타|fix typo|update readme|readme 수정|readme update|initial commit|first commit|minor (fix|change)|formatting|lint\b|prettier\b|bump\b|version bump|\.$)/i;
const MEANINGFUL_PREFIX = /^(feat|fix|refactor|perf|feature)(\([^)]*\))?!?\s*:/i;

/** 커밋 메시지 첫 줄 (제목) */
export function commitSubject(message: string): string {
  return message.split(/\r?\n/)[0].trim();
}

/** LLM 다이제스트에 넣을 가치가 있는 커밋인가 */
export function isMeaningfulCommit(commit: Commit): boolean {
  const subject = commitSubject(commit.message);
  if (subject.length < 5) return false;
  if (MERGE.test(subject)) return false;
  if (MEANINGFUL_PREFIX.test(subject)) return true;
  if (TRIVIAL_PREFIX.test(subject)) return false;
  if (TRIVIAL_WORDS.test(subject)) return false;
  return true;
}

/** 의미 있는 커밋만 남긴다 */
export function filterCommits(commits: Commit[]): Commit[] {
  return commits.filter(isMeaningfulCommit);
}

/** repoFullName → 커밋 (시간 오름차순) */
export function groupCommitsByRepo(commits: Commit[]): Map<string, Commit[]> {
  const byRepo = new Map<string, Commit[]>();
  for (const commit of commits) {
    const list = byRepo.get(commit.repoFullName);
    if (list) list.push(commit);
    else byRepo.set(commit.repoFullName, [commit]);
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => a.authoredAt.localeCompare(b.authoredAt));
  }
  return byRepo;
}

/**
 * 레포 하나의 커밋 → LLM에 넘길 텍스트 다이제스트.
 * 최신 커밋이 더 많은 정보를 담으므로 넘칠 때는 오래된 쪽을 버린다.
 */
export function buildCommitDigest(
  commits: Commit[],
  options: { maxCommits?: number; maxChars?: number } = {},
): string {
  const maxCommits = options.maxCommits ?? MAX_COMMITS_PER_REPO;
  const maxChars = options.maxChars ?? MAX_DIGEST_CHARS;

  const kept = filterCommits(commits)
    .slice(-maxCommits)
    .map((c) => `- ${c.authoredAt.slice(0, 10)} ${commitSubject(c.message)}`);

  const lines: string[] = [];
  let total = 0;
  // 뒤(최신)에서부터 채우고 다시 시간순으로 되돌린다.
  for (let i = kept.length - 1; i >= 0; i--) {
    const line = kept[i];
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.reverse().join("\n");
}

/** ISO 날짜 → { year, quarter } */
export function toPeriod(iso: string): { year: number; quarter: number } {
  const date = new Date(iso);
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return { year, quarter };
}
