/**
 * 의미 있는 커밋 판정 — merge/오타/docs/chore 류를 걸러 낸다.
 *
 * 걸러진 커밋도 저장·검색은 된다. 개요의 "주요 커밋"과 임베딩 대상만 이 판정을 따른다.
 */
const MERGE = /^merge\s+(branch|pull request|remote|commit|tag)\b/i;
const TRIVIAL_PREFIX =
  /^(chore|docs|style|ci|build|test|revert)(\([^)]*\))?!?\s*:/i;
const TRIVIAL_WORDS =
  /^(wip\b|typo\b|오타|fix typo|update readme|readme 수정|readme update|initial commit|first commit|minor (fix|change)|formatting|lint\b|prettier\b|bump\b|version bump|\.$)/i;
const MEANINGFUL_PREFIX = /^(feat|fix|refactor|perf|feature)(\([^)]*\))?!?\s*:/i;

export function isMeaningfulSubject(subject: string): boolean {
  const trimmed = subject.trim();
  if (trimmed.length < 5) return false;
  if (MERGE.test(trimmed)) return false;
  if (MEANINGFUL_PREFIX.test(trimmed)) return true;
  if (TRIVIAL_PREFIX.test(trimmed)) return false;
  if (TRIVIAL_WORDS.test(trimmed)) return false;
  return true;
}
