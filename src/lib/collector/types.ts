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
  /** 서문 — 원문 마크다운 (최대 약 10KB까지만 소장) */
  readme: string | null;
  htmlUrl: string;
  /**
   * 사람이 직접 붙인 레포 토픽 라벨.
   * 지식그래프에서 Concept 노드의 1차 재료가 된다 (LLM 없이도 성립).
   * schemaVersion 1 스냅샷에는 없다.
   */
  topics?: string[];
  /**
   * 의존성 매니페스트 원문 (경로 → 내용, 파일당 약 20KB까지).
   * 정적 분석으로 Tech 노드를 뽑는 재료. schemaVersion 1 스냅샷에는 없다.
   */
  manifests?: Record<string, string>;
}

/** 커밋 = 마법서의 한 페이지 */
export interface Commit {
  sha: string;
  repoFullName: string;
  message: string;
  authoredAt: string;
  authorLogin: string | null;
}

/** 잔디 한 칸 = 수련 일지 하루 */
export interface ContributionDay {
  /** YYYY-MM-DD */
  date: string;
  count: number;
  /** GitHub 잔디 강도 0~4 */
  level: 0 | 1 | 2 | 3 | 4;
}

/** 수집 결과 요약 — 서재 입구에 걸리는 명패 */
export interface CollectionStats {
  /** 책(레포) 수 */
  repoCount: number;
  /** 비공개 서고에 꽂힐 책 수 */
  privateRepoCount: number;
  /** 총 커밋(페이지) 수 */
  commitCount: number;
  /** 서가 분류 수 = 등장한 언어 종수 */
  languageCount: number;
  /** 잔디 총 기여 수 */
  contributionCount: number;
  /** 수집 기간 — 첫 커밋 (ISO, 커밋이 없으면 null) */
  firstCommitAt: string | null;
  /** 수집 기간 — 마지막 커밋 (ISO, 커밋이 없으면 null) */
  lastCommitAt: string | null;
}

/**
 * 스냅샷 스키마 버전.
 * 1 — 최초(레포·커밋·잔디)
 * 2 — Repo.topics / Repo.manifests 추가 (지식그래프 정적 분석 재료)
 *
 * 필드가 없는 옛 스냅샷은 1로 취급하며, 그래프 빌드는 그대로 동작한다(노드가 적어질 뿐).
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** 한 사용자의 수집 결과 전체 (로컬 "소장" 단위) */
export interface CollectionSnapshot {
  /** 없으면 1(구버전 스냅샷)로 취급한다 */
  schemaVersion?: number;
  login: string;
  collectedAt: string;
  repos: Repo[];
  commits: Commit[];
  contributions: ContributionDay[];
  stats: CollectionStats;
  /** rate limit 등으로 중간에 멈춘 불완전한 수집인지 */
  partial: boolean;
  /** partial일 때 그 사유 */
  partialReason?: string;
}

/** 수집 서버 액션의 결과 (UI 상태용) */
export interface CollectResult {
  ok: boolean;
  message: string | null;
}
