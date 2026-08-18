/**
 * ① 수집기(Collector) — 도메인 타입.
 *
 * GitHub API에서 가져온 raw 데이터를 Grimoire 내부 표현으로 정규화한 형태.
 * 레포 = 마법서 한 권, 커밋 = 페이지, 잔디 = 수련 일지.
 */

/** 레포 = 마법서 한 권 */
export interface Repo {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  /** 책등 색을 결정하는 주 언어 */
  primaryLanguage: string | null;
  /** 언어별 바이트 수 (서가 분류용) */
  languages: Record<string, number>;
  isPrivate: boolean;
  isFork: boolean;
  stars: number;
  createdAt: string;
  pushedAt: string;
  /** 서문 — 원문 마크다운 */
  readme: string | null;
  htmlUrl: string;
}

/** 커밋 = 마법서의 한 페이지 */
export interface Commit {
  sha: string;
  repoFullName: string;
  message: string;
  authoredAt: string;
  authorLogin: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** 잔디 한 칸 = 수련 일지 하루 */
export interface ContributionDay {
  /** YYYY-MM-DD */
  date: string;
  count: number;
  /** GitHub 잔디 강도 0~4 */
  level: 0 | 1 | 2 | 3 | 4;
}

/** 한 사용자의 수집 결과 전체 (로컬 "소장" 단위) */
export interface CollectionSnapshot {
  login: string;
  collectedAt: string;
  repos: Repo[];
  commits: Commit[];
  contributions: ContributionDay[];
}
