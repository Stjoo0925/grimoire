/**
 * ① 수집기(Collector) — GitHub API 페처.
 *
 * 세션의 accessToken(auth.ts 참고)으로 REST/GraphQL을 호출한다.
 * - 레포/커밋: REST, per_page=100 페이지네이션으로 전체 이력
 * - 잔디: GraphQL contributionsCollection, 연도 단위로 소급 반복
 * - Events API는 90일/300개 제한 때문에 사용하지 않는다.
 * - 커밋 상세(stats)는 커밋당 1콜이라 rate limit을 태워먹으므로 수집하지 않는다.
 */
import {
  SNAPSHOT_SCHEMA_VERSION,
  type CollectionSnapshot,
  type Commit,
  type ContributionDay,
  type Repo,
} from "./types";

const API = "https://api.github.com";
const GRAPHQL = "https://api.github.com/graphql";

/** 남은 rate limit이 이 아래로 떨어지면 수집을 멈추고 partial로 표시한다. */
const RATE_LIMIT_FLOOR = 50;
/** README는 레포당 이만큼(약 10KB)만 소장한다. */
const README_MAX_BYTES = 10 * 1024;
/** 의존성 매니페스트는 파일당 이만큼(약 20KB)만 소장한다. */
const MANIFEST_MAX_BYTES = 20 * 1024;
/** 정적 분석(Tech 노드) 재료가 되는 매니페스트 후보 경로 */
const MANIFEST_PATHS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
] as const;
/** 레포 단위 병렬도 */
const REPO_CONCURRENCY = 5;

/** REST 호출 예산 — 컨텍스트 단위로 공유되는 가변 상태 */
export interface RateBudget {
  /** 마지막 응답 기준 남은 REST 호출 수 (모르면 null) */
  remaining: number | null;
  /** REST 예산 소진 — 이후 REST 호출을 더 하지 않는다 */
  stopped: boolean;
  /** 어떤 이유로든 결과가 불완전한지 */
  partial: boolean;
  reason?: string;
}

export interface CollectorContext {
  /** GitHub 사용자 액세스 토큰 (서버에서만 사용) */
  accessToken: string;
  login?: string;
  /** collectAll이 주입하는 공유 예산. 없으면 무제한으로 취급한다. */
  budget?: RateBudget;
}

export function createBudget(): RateBudget {
  return { remaining: null, stopped: false, partial: false };
}

/** 결과가 불완전함을 기록한다 (이후 호출은 계속한다) */
function markPartial(ctx: CollectorContext, reason: string): void {
  if (!ctx.budget) return;
  ctx.budget.partial = true;
  ctx.budget.reason ??= reason;
}

/** REST 예산 소진 — 더 이상 REST를 호출하지 않는다 */
function stop(ctx: CollectorContext, reason: string): void {
  if (!ctx.budget) return;
  ctx.budget.stopped = true;
  markPartial(ctx, reason);
}

/** 예산이 바닥났거나 이미 중단된 상태인가 */
function exhausted(ctx: CollectorContext): boolean {
  const budget = ctx.budget;
  if (!budget) return false;
  if (budget.stopped) return true;
  if (budget.remaining !== null && budget.remaining < RATE_LIMIT_FLOOR) {
    stop(
      ctx,
      `GitHub API 잔여 호출이 ${budget.remaining}회로 떨어져 수집을 중단했습니다.`,
    );
    return true;
  }
  return false;
}

function headers(ctx: CollectorContext): HeadersInit {
  return {
    Authorization: `Bearer ${ctx.accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "grimoire-collector",
  };
}

function trackRateLimit(ctx: CollectorContext, res: Response): void {
  const raw = res.headers.get("x-ratelimit-remaining");
  if (raw === null || !ctx.budget) return;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed)) ctx.budget.remaining = parsed;
}

class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * REST 요청 한 번. rate limit 헤더를 추적하고, 소진/차단 시 예산을 중단 처리한다.
 * `allowStatus`에 적힌 상태 코드는 에러 대신 응답 그대로 돌려준다.
 */
async function rest(
  ctx: CollectorContext,
  url: string,
  allowStatus: number[] = [],
): Promise<Response> {
  const res = await fetch(url, { headers: headers(ctx), cache: "no-store" });
  trackRateLimit(ctx, res);

  if (res.status === 403 || res.status === 429) {
    // 1차/2차 rate limit — 더 밀어붙이지 않고 여기서 멈춘다.
    if (ctx.budget?.remaining === 0 || res.headers.has("retry-after")) {
      stop(ctx, "GitHub API rate limit에 도달해 수집을 중단했습니다.");
      throw new GitHubError(res.status, "rate limited");
    }
  }
  if (!res.ok && !allowStatus.includes(res.status)) {
    throw new GitHubError(
      res.status,
      `GitHub REST ${res.status} ${res.statusText} — ${url}`,
    );
  }
  return res;
}

/**
 * rest()와 같지만, rate limit으로 중단된 경우 throw 대신 null을 준다.
 * (그 밖의 진짜 오류는 그대로 올려보내 UI에 노출한다)
 */
async function tryRest(
  ctx: CollectorContext,
  url: string,
  allowStatus: number[] = [],
): Promise<Response | null> {
  try {
    return await rest(ctx, url, allowStatus);
  } catch (error) {
    if (ctx.budget?.stopped) return null;
    throw error;
  }
}

/** Link 헤더에 rel="next"가 있는지 */
function hasNextPage(res: Response): boolean {
  const link = res.headers.get("link");
  return link !== null && /<[^>]+>;\s*rel="next"/.test(link);
}

/** 인증된 사용자 정보 (login, 계정 생성 연도) */
export async function fetchViewer(
  ctx: CollectorContext,
): Promise<{ login: string; createdAt: string; avatarUrl: string | null }> {
  const res = await rest(ctx, `${API}/user`);
  const user = (await res.json()) as {
    login: string;
    created_at: string;
    avatar_url?: string;
  };
  return {
    login: user.login,
    createdAt: user.created_at,
    avatarUrl: user.avatar_url ?? null,
  };
}

interface RestRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  private: boolean;
  fork: boolean;
  stargazers_count: number;
  created_at: string;
  pushed_at: string | null;
  html_url: string;
  /** 최신 REST 응답에는 기본 포함된다. 구버전 프록시를 대비해 optional. */
  topics?: string[];
}

function toRepo(raw: RestRepo): Repo {
  return {
    id: String(raw.id),
    name: raw.name,
    fullName: raw.full_name,
    description: raw.description,
    primaryLanguage: raw.language,
    languages: {},
    isPrivate: raw.private,
    isFork: raw.fork,
    stars: raw.stargazers_count,
    createdAt: raw.created_at,
    pushedAt: raw.pushed_at ?? raw.created_at,
    readme: null,
    htmlUrl: raw.html_url,
    topics: raw.topics ?? [],
    manifests: {},
  };
}

/** 인증된 사용자가 소유한 레포 전체 (private 포함) */
export async function fetchRepos(ctx: CollectorContext): Promise<Repo[]> {
  const repos: Repo[] = [];
  for (let page = 1; ; page++) {
    if (exhausted(ctx)) break;
    const res = await tryRest(
      ctx,
      `${API}/user/repos?affiliation=owner&per_page=100&sort=pushed&page=${page}`,
    );
    if (!res) break;
    const batch = (await res.json()) as RestRepo[];
    repos.push(...batch.map(toRepo));
    // Link 헤더가 없는 구현/프록시를 대비해 짧은 페이지도 종료 조건으로 둔다.
    if (batch.length < 100 || !hasNextPage(res)) break;
  }
  return repos;
}

/** 레포의 언어별 바이트 수 (서가 분류용) */
export async function fetchLanguages(
  ctx: CollectorContext,
  repoFullName: string,
): Promise<Record<string, number>> {
  if (exhausted(ctx)) return {};
  const res = await tryRest(ctx, `${API}/repos/${repoFullName}/languages`, [
    403, 404,
  ]);
  if (!res || !res.ok) return {};
  return (await res.json()) as Record<string, number>;
}

interface RestCommit {
  sha: string;
  commit: {
    message: string;
    author: { date?: string } | null;
    committer: { date?: string } | null;
  };
  author: { login?: string } | null;
}

/**
 * 레포 하나의 커밋 전체 이력.
 * author 필터를 걸어 두므로 fork한 레포에서도 본인 커밋만 걸린다.
 * 빈 레포(409)·접근 불가(404/451)는 조용히 빈 배열.
 */
export async function fetchCommits(
  ctx: CollectorContext,
  repoFullName: string,
): Promise<Commit[]> {
  const login = ctx.login;
  if (!login) throw new Error("[collector] fetchCommits: login이 필요합니다");

  const commits: Commit[] = [];
  const author = encodeURIComponent(login);
  for (let page = 1; ; page++) {
    if (exhausted(ctx)) break;
    const res = await tryRest(
      ctx,
      `${API}/repos/${repoFullName}/commits?author=${author}&per_page=100&page=${page}`,
      [409, 404, 451],
    );
    // null = rate limit 중단, 409 = 빈 레포, 404 = 삭제/권한 없음, 451 = 차단
    if (!res || !res.ok) break;
    const batch = (await res.json()) as RestCommit[];
    for (const raw of batch) {
      commits.push({
        sha: raw.sha,
        repoFullName,
        message: raw.commit.message,
        authoredAt:
          raw.commit.author?.date ??
          raw.commit.committer?.date ??
          new Date(0).toISOString(),
        authorLogin: raw.author?.login ?? null,
      });
    }
    if (batch.length < 100 || !hasNextPage(res)) break;
  }
  return commits;
}

/** 레포 README 원문 (없으면 null). 약 10KB까지만 소장한다. */
export async function fetchReadme(
  ctx: CollectorContext,
  repoFullName: string,
): Promise<string | null> {
  if (exhausted(ctx)) return null;
  const res = await tryRest(ctx, `${API}/repos/${repoFullName}/readme`, [
    404, 403, 451,
  ]);
  if (!res || !res.ok) return null;

  const body = (await res.json()) as {
    content?: string;
    encoding?: string;
  };
  if (!body.content) return null;
  const decoded =
    body.encoding === "base64"
      ? Buffer.from(body.content, "base64").toString("utf8")
      : body.content;
  const buf = Buffer.from(decoded, "utf8");
  if (buf.byteLength <= README_MAX_BYTES) return decoded;
  // 잘린 자리에서 멀티바이트 문자가 쪼개지면 대체 문자가 남으므로 지운다.
  return new TextDecoder("utf-8")
    .decode(buf.subarray(0, README_MAX_BYTES))
    .replace(/�+$/, "");
}

/**
 * 레포 루트의 의존성 매니페스트들 (없으면 그 파일만 건너뜀).
 * 지식그래프 1단계(결정론적 정적 분석)의 재료 — KNOWLEDGE_GRAPH.md §4.1
 */
export async function fetchManifests(
  ctx: CollectorContext,
  repoFullName: string,
): Promise<Record<string, string>> {
  const manifests: Record<string, string> = {};
  for (const file of MANIFEST_PATHS) {
    if (exhausted(ctx)) break;
    const res = await tryRest(
      ctx,
      `${API}/repos/${repoFullName}/contents/${file}`,
      [404, 403, 451],
    );
    // 404 = 그 매니페스트를 안 쓰는 레포 — 정상적인 경우다.
    if (!res || !res.ok) continue;

    const body = (await res.json()) as {
      content?: string;
      encoding?: string;
      type?: string;
      size?: number;
    };
    // 같은 이름의 디렉터리면 배열이 오거나 type이 file이 아니다.
    if (body.type !== "file" || !body.content) continue;
    if (body.encoding !== "base64") continue;

    const buf = Buffer.from(body.content, "base64");
    const text = new TextDecoder("utf-8")
      .decode(buf.subarray(0, MANIFEST_MAX_BYTES))
      .replace(/�+$/, "");
    if (text.trim().length > 0) manifests[file] = text;
  }
  return manifests;
}

const CONTRIBUTIONS_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
            contributionLevel
          }
        }
      }
    }
  }
}`;

const LEVELS: Record<string, ContributionDay["level"]> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

interface GraphQLContributionsResponse {
  data?: {
    user: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: {
            contributionDays: {
              date: string;
              contributionCount: number;
              contributionLevel: string;
            }[];
          }[];
        };
      };
    } | null;
  };
  errors?: { message: string }[];
}

/**
 * 잔디 — 지정 연도 범위 전체 소급.
 * contributionsCollection은 1년 범위 제한이 있어 연도 단위로 나눠 호출한다.
 * (GraphQL은 REST와 rate limit 풀이 분리되어 있어 REST 예산과 별개로 센다.)
 */
export async function fetchContributions(
  ctx: CollectorContext,
  fromYear: number,
  toYear: number,
): Promise<ContributionDay[]> {
  const login = ctx.login;
  if (!login)
    throw new Error("[collector] fetchContributions: login이 필요합니다");

  const byDate = new Map<string, ContributionDay>();
  for (let year = fromYear; year <= toYear; year++) {
    const from = new Date(Date.UTC(year, 0, 1)).toISOString();
    const yearEnd = Date.UTC(year, 11, 31, 23, 59, 59);
    // 올해는 미래 구간을 요청하지 않도록 현재 시각으로 자른다.
    const to = new Date(Math.min(yearEnd, Date.now())).toISOString();

    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        ...headers(ctx),
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        query: CONTRIBUTIONS_QUERY,
        variables: { login, from, to },
      }),
    });

    if (res.status === 403 || res.status === 429) {
      // GraphQL은 REST와 rate limit 풀이 다르므로 REST 수집까지 막지는 않는다.
      markPartial(
        ctx,
        "GitHub GraphQL rate limit에 도달해 잔디 수집을 중단했습니다.",
      );
      break;
    }
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        `GitHub GraphQL ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as GraphQLContributionsResponse;
    if (body.errors?.length) {
      throw new Error(`[collector] GraphQL: ${body.errors[0].message}`);
    }
    const weeks =
      body.data?.user?.contributionsCollection.contributionCalendar.weeks ?? [];
    const prefix = `${year}-`;
    for (const week of weeks) {
      for (const day of week.contributionDays) {
        // 주 단위 캘린더가 연 경계를 넘어 이웃 해의 날짜를 흘릴 수 있다.
        // 해당 연도 호출의 결과만 받아 다른 해의 값을 덮어쓰지 않게 한다.
        if (!day.date.startsWith(prefix)) continue;
        byDate.set(day.date, {
          date: day.date,
          count: day.contributionCount,
          level: LEVELS[day.contributionLevel] ?? 0,
        });
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 간단한 동시 실행 풀 — 레포 단위로 modest concurrency */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/** 전체 수집 파이프라인 — 결과를 로컬에 "소장"한다 */
export async function collectAll(
  ctx: CollectorContext,
): Promise<CollectionSnapshot> {
  const budget = ctx.budget ?? createBudget();
  const scoped: CollectorContext = { ...ctx, budget };

  const viewer = await fetchViewer(scoped);
  scoped.login = scoped.login ?? viewer.login;
  const login = scoped.login;

  // 잔디를 먼저 — GraphQL 풀은 REST와 분리되어 있어 REST 예산과 무관하다.
  const contributions = await fetchContributions(
    scoped,
    new Date(viewer.createdAt).getUTCFullYear(),
    new Date().getUTCFullYear(),
  );

  const repos = await fetchRepos(scoped);

  const commits: Commit[] = [];
  const failed: string[] = [];
  await pooled(repos, REPO_CONCURRENCY, async (repo) => {
    if (exhausted(scoped)) return;
    try {
      repo.languages = await fetchLanguages(scoped, repo.fullName);
      repo.readme = await fetchReadme(scoped, repo.fullName);
      repo.manifests = await fetchManifests(scoped, repo.fullName);
      commits.push(...(await fetchCommits(scoped, repo.fullName)));
    } catch (error) {
      // 레포 한 권이 실패해도 서고 전체 수집은 계속한다.
      console.error(`[collector] ${repo.fullName} 수집 실패`, error);
      failed.push(repo.fullName);
    }
  });
  if (failed.length > 0) {
    markPartial(
      scoped,
      `${failed.length}개 레포를 읽지 못했습니다 (${failed.slice(0, 3).join(", ")}${
        failed.length > 3 ? " 외" : ""
      }).`,
    );
  }

  commits.sort((a, b) => a.authoredAt.localeCompare(b.authoredAt));

  const languages = new Set<string>();
  for (const repo of repos) {
    for (const lang of Object.keys(repo.languages)) languages.add(lang);
    if (repo.primaryLanguage) languages.add(repo.primaryLanguage);
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    login,
    collectedAt: new Date().toISOString(),
    repos,
    commits,
    contributions,
    stats: {
      repoCount: repos.length,
      privateRepoCount: repos.filter((r) => r.isPrivate).length,
      commitCount: commits.length,
      languageCount: languages.size,
      contributionCount: contributions.reduce((sum, d) => sum + d.count, 0),
      firstCommitAt: commits.at(0)?.authoredAt ?? null,
      lastCommitAt: commits.at(-1)?.authoredAt ?? null,
    },
    partial: budget.partial,
    partialReason: budget.partial ? budget.reason : undefined,
  };
}
