/**
 * ③ 인터랙티브 도서관 — 게임 프로필 (순수 로직).
 *
 * 스냅샷을 게임 문법으로 번역한다: 커밋은 경험치, 언어는 직업, 잔디는 수련,
 * 이력의 이정표는 업적. 전부 결정론적 계산이며 네트워크·난수·현재시각이 없다
 * (스냅샷의 마지막 활동일을 "오늘"의 기준으로 삼는다 — 재현 가능해야 테스트된다).
 */
import type { CollectionSnapshot } from "../collector/types";

/** 업적 하나의 상태. 라벨·설명 문구는 UI(i18n)가 id로 찾는다. */
export interface AchievementState {
  id: string;
  /** 달성한 단계 (0 = 미달성, 최대 tiers 수) */
  tier: number;
  /** 총 단계 수 */
  maxTier: number;
  /** 현재 수치 (진행도 표시용) */
  value: number;
  /** 다음 단계 목표치. 만렙이면 null */
  nextTarget: number | null;
  earned: boolean;
}

export interface GameProfile {
  /** 총 경험치 */
  exp: number;
  /** 1부터 시작 */
  level: number;
  /** 현재 레벨 구간에서 채운 경험치 */
  expIntoLevel: number;
  /** 다음 레벨까지 필요한 구간 크기 */
  expForNext: number;
  /** 직업 id — UI가 라벨·아이콘으로 번역 (mage/knight/alchemist/runesmith/summoner/sage) */
  classId: string;
  /** 언어 바이트 상위 (직업 판정 근거 표시용) */
  topLanguages: Array<{ name: string; bytes: number }>;
  achievements: AchievementState[];
  /** 수련(잔디) 스트릭 */
  streak: { longest: number; current: number };
}

/** 레벨 곡선: 레벨 n 도달에 필요한 누적 EXP = CURVE * n^2 */
const CURVE = 150;

/** EXP 배점 — 페이지(커밋)가 주 수입, 별과 장서는 보너스 */
const EXP_PER_COMMIT = 10;
const EXP_PER_STAR = 25;
const EXP_PER_REPO = 30;

/** 언어 → 직업 성향. 여기 없는 언어는 sage(현자)로 흡수된다. */
const LANGUAGE_CLASS: Record<string, string> = {
  typescript: "mage",
  javascript: "mage",
  html: "mage",
  css: "mage",
  vue: "mage",
  svelte: "mage",
  java: "knight",
  kotlin: "knight",
  "c#": "knight",
  go: "knight",
  python: "alchemist",
  "jupyter notebook": "alchemist",
  r: "alchemist",
  c: "runesmith",
  "c++": "runesmith",
  rust: "runesmith",
  zig: "runesmith",
  assembly: "runesmith",
  shell: "summoner",
  powershell: "summoner",
  dockerfile: "summoner",
  hcl: "summoner",
  makefile: "summoner",
};

/** 업적 정의: id + 단계별 목표치 (오름차순) */
const ACHIEVEMENTS: Array<{ id: string; tiers: number[] }> = [
  { id: "streak", tiers: [7, 30, 100] }, // 연속 수련
  { id: "pages", tiers: [100, 1000, 3000] }, // 총 페이지(커밋)
  { id: "polyglot", tiers: [5, 10, 20] }, // 언어 종수
  { id: "collection", tiers: [10, 30, 70] }, // 장서 수
  { id: "stars", tiers: [5, 20, 100] }, // 받은 별
  { id: "night-owl", tiers: [10, 50, 200] }, // 심야(00~05시) 집필
  { id: "marathon", tiers: [50, 150, 400] }, // 한 권 최다 페이지
  { id: "secret-archive", tiers: [3, 10, 30] }, // 비공개 서고
  { id: "comeback", tiers: [1] }, // 180일 이상 쉬었다 복귀
];

/** ISO 문자열에 적힌 시(hour)를 그대로 읽는다 — 타임존 변환 없이 기록된 시각 기준. */
export function hourOfIso(iso: string): number | null {
  const match = /T(\d{2})/.exec(iso);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

/** 날짜 문자열(YYYY-MM-DD)을 일수로 — 스트릭 계산용, UTC 고정 */
function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/** 잔디에서 최장/현재 스트릭. "현재"는 잔디의 마지막 활동일 기준. */
export function computeStreaks(
  contributions: Array<{ date: string; count: number }>,
): { longest: number; current: number } {
  const activeDays = [
    ...new Set(
      contributions.filter((day) => day.count > 0).map((day) => day.date),
    ),
  ]
    .map(dayNumber)
    .sort((a, b) => a - b);
  if (activeDays.length === 0) return { longest: 0, current: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < activeDays.length; i++) {
    run = activeDays[i] - activeDays[i - 1] === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // 현재 스트릭: 마지막 활동일에서 뒤로 이어지는 연속 구간
  let current = 1;
  for (let i = activeDays.length - 1; i > 0; i--) {
    if (activeDays[i] - activeDays[i - 1] === 1) current += 1;
    else break;
  }
  return { longest, current };
}

/** 180일 이상 공백 후 활동 재개가 있었는가 (comeback 업적) */
export function hasComeback(
  contributions: Array<{ date: string; count: number }>,
  gapDays = 180,
): boolean {
  const activeDays = [
    ...new Set(
      contributions.filter((day) => day.count > 0).map((day) => day.date),
    ),
  ]
    .map(dayNumber)
    .sort((a, b) => a - b);
  for (let i = 1; i < activeDays.length; i++) {
    if (activeDays[i] - activeDays[i - 1] >= gapDays) return true;
  }
  return false;
}

function tierOf(value: number, tiers: number[]): number {
  let tier = 0;
  for (const target of tiers) if (value >= target) tier += 1;
  return tier;
}

function achievementState(
  id: string,
  tiers: number[],
  value: number,
): AchievementState {
  const tier = tierOf(value, tiers);
  return {
    id,
    tier,
    maxTier: tiers.length,
    value,
    nextTarget: tier < tiers.length ? tiers[tier] : null,
    earned: tier > 0,
  };
}

/** 언어 바이트 합산 → 직업 판정 + 상위 언어 */
export function computeClass(snapshot: CollectionSnapshot): {
  classId: string;
  topLanguages: Array<{ name: string; bytes: number }>;
} {
  const byLanguage = new Map<string, number>();
  for (const repo of snapshot.repos) {
    if (repo.isFork) continue; // 남의 책을 필사한 것은 직업 판정에서 뺀다
    for (const [name, bytes] of Object.entries(repo.languages ?? {})) {
      byLanguage.set(name, (byLanguage.get(name) ?? 0) + bytes);
    }
  }
  const topLanguages = [...byLanguage.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  const byClass = new Map<string, number>();
  for (const [name, bytes] of byLanguage) {
    const classId = LANGUAGE_CLASS[name.toLowerCase()] ?? "sage";
    byClass.set(classId, (byClass.get(classId) ?? 0) + bytes);
  }
  let classId = "sage";
  let best = -1;
  for (const [id, bytes] of byClass) {
    if (bytes > best) {
      best = bytes;
      classId = id;
    }
  }
  return { classId, topLanguages };
}

/** 스냅샷 → 게임 프로필. 그래프 없이도 성립한다. */
export function computeGameProfile(snapshot: CollectionSnapshot): GameProfile {
  const commitCount = snapshot.commits.length;
  const ownRepos = snapshot.repos.filter((repo) => !repo.isFork);
  const totalStars = ownRepos.reduce((sum, repo) => sum + repo.stars, 0);

  const exp =
    commitCount * EXP_PER_COMMIT +
    totalStars * EXP_PER_STAR +
    ownRepos.length * EXP_PER_REPO;

  // 누적 CURVE*n^2 곡선에서 현재 레벨 구간을 계산
  const level = Math.max(1, Math.floor(Math.sqrt(exp / CURVE)));
  const floorExp = CURVE * level * level;
  const ceilExp = CURVE * (level + 1) * (level + 1);
  const expIntoLevel = exp - floorExp;
  const expForNext = ceilExp - floorExp;

  const streak = computeStreaks(snapshot.contributions);

  const languageCount = new Set(
    snapshot.repos.flatMap((repo) => Object.keys(repo.languages ?? {})),
  ).size;

  const nightCommits = snapshot.commits.filter((commit) => {
    const hour = hourOfIso(commit.authoredAt);
    return hour !== null && hour < 5;
  }).length;

  const perRepo = new Map<string, number>();
  for (const commit of snapshot.commits) {
    perRepo.set(
      commit.repoFullName,
      (perRepo.get(commit.repoFullName) ?? 0) + 1,
    );
  }
  const marathon = Math.max(0, ...perRepo.values());

  const values: Record<string, number> = {
    streak: streak.longest,
    pages: commitCount,
    polyglot: languageCount,
    collection: snapshot.repos.length,
    stars: totalStars,
    "night-owl": nightCommits,
    marathon,
    "secret-archive": snapshot.repos.filter((repo) => repo.isPrivate).length,
    comeback: hasComeback(snapshot.contributions) ? 1 : 0,
  };

  const { classId, topLanguages } = computeClass(snapshot);

  return {
    exp,
    level,
    expIntoLevel,
    expForNext,
    classId,
    topLanguages,
    achievements: ACHIEVEMENTS.map(({ id, tiers }) =>
      achievementState(id, tiers, values[id] ?? 0),
    ),
    streak,
  };
}
