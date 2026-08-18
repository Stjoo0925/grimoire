/**
 * ① 수집기(Collector) — GitHub API 페처 스텁.
 *
 * 실제 구현 시 세션의 accessToken(auth.ts 참고)으로 REST/GraphQL을 호출한다.
 * - 레포/커밋: REST, per_page=100 페이지네이션으로 전체 이력
 * - 잔디: GraphQL contributionsCollection, 연도 단위로 소급 반복
 * - Events API는 90일/300개 제한 때문에 사용하지 않는다.
 *
 * 현재는 스캐폴드 단계 — 모두 미구현.
 */
import type {
  CollectionSnapshot,
  Commit,
  ContributionDay,
  Repo,
} from "./types";

export interface CollectorContext {
  /** GitHub 사용자 액세스 토큰 (서버에서만 사용) */
  accessToken: string;
  login?: string;
}

function notImplemented(name: string): never {
  throw new Error(`[collector] ${name} not implemented`);
}

/** 인증된 사용자의 레포 전체 (private 포함) */
export async function fetchRepos(_ctx: CollectorContext): Promise<Repo[]> {
  void _ctx;
  return notImplemented("fetchRepos");
}

/** 레포 하나의 커밋 전체 이력 */
export async function fetchCommits(
  _ctx: CollectorContext,
  _repoFullName: string,
): Promise<Commit[]> {
  void _ctx;
  void _repoFullName;
  return notImplemented("fetchCommits");
}

/** 레포 README 원문 (없으면 null) */
export async function fetchReadme(
  _ctx: CollectorContext,
  _repoFullName: string,
): Promise<string | null> {
  void _ctx;
  void _repoFullName;
  return notImplemented("fetchReadme");
}

/** 잔디 — 지정 연도 범위 전체 소급 */
export async function fetchContributions(
  _ctx: CollectorContext,
  _fromYear: number,
  _toYear: number,
): Promise<ContributionDay[]> {
  void _ctx;
  void _fromYear;
  void _toYear;
  return notImplemented("fetchContributions");
}

/** 전체 수집 파이프라인 — 결과를 로컬에 "소장"한다 */
export async function collectAll(
  _ctx: CollectorContext,
): Promise<CollectionSnapshot> {
  void _ctx;
  return notImplemented("collectAll");
}
