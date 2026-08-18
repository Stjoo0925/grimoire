/**
 * ③ 인터랙티브 도서관 — 수련 일지(잔디) 격자 (순수 로직).
 *
 * 스냅샷의 contributions(전체 소급 잔디)에서 최근 1년치만 잘라
 * GitHub식 주(週) 열 격자로 접는다. 날짜 계산은 전부 UTC 문자열 기준이라
 * 서버·클라이언트 타임존이 달라도 같은 격자가 나온다.
 */
import type { ContributionDay } from "../collector/types";

/** 기본 열 수 (53주 ≈ 최근 1년) */
export const DEFAULT_WEEKS = 53;

export interface HeatmapCell {
  /** YYYY-MM-DD */
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** 오늘 이후 — 칸은 자리만 차지하고 그리지 않는다 */
  future: boolean;
}

export interface Heatmap {
  /** 열 = 한 주(일→토), 총 `weeks`개 */
  weeks: HeatmapCell[][];
  /** 열 인덱스 → 그 열에서 시작하는 달 (1~12). 눈금용 */
  monthTicks: Array<{ column: number; month: number; year: number }>;
  /** 격자에 담긴 기간의 총 기여 수 */
  total: number;
  /** 기간 시작/끝 (YYYY-MM-DD) */
  from: string;
  to: string;
}

function toUtc(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

function levelOf(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count < 3) return 1;
  if (count < 6) return 2;
  if (count < 10) return 3;
  return 4;
}

/**
 * 잔디 격자 만들기.
 * @param days 스냅샷 contributions (전 기간)
 * @param todayIso 기준일 YYYY-MM-DD (마지막 열이 이 날이 속한 주)
 */
export function buildHeatmap(
  days: ContributionDay[],
  todayIso: string,
  weeks = DEFAULT_WEEKS,
): Heatmap {
  const counts = new Map<string, ContributionDay>();
  for (const day of days) counts.set(day.date, day);

  const today = toUtc(todayIso);
  const weekday = new Date(today).getUTCDay(); // 0=일
  const lastSaturday = today + (6 - weekday) * DAY;
  const columnCount = Math.max(1, weeks);
  const firstSunday = lastSaturday - (columnCount * 7 - 1) * DAY;

  const grid: HeatmapCell[][] = [];
  const monthTicks: Heatmap["monthTicks"] = [];
  let total = 0;
  let previousMonth = -1;

  for (let column = 0; column < columnCount; column += 1) {
    const cells: HeatmapCell[] = [];
    for (let row = 0; row < 7; row += 1) {
      const ms = firstSunday + (column * 7 + row) * DAY;
      const date = toIso(ms);
      const entry = counts.get(date);
      const count = entry?.count ?? 0;
      const future = ms > today;
      if (!future) total += count;
      cells.push({
        date,
        count: future ? 0 : count,
        level: future ? 0 : (entry?.level ?? levelOf(count)),
        future,
      });
    }
    grid.push(cells);

    const columnStart = new Date(firstSunday + column * 7 * DAY);
    const month = columnStart.getUTCMonth() + 1;
    if (month !== previousMonth) {
      monthTicks.push({ column, month, year: columnStart.getUTCFullYear() });
      previousMonth = month;
    }
  }

  return {
    weeks: grid,
    monthTicks,
    total,
    from: toIso(firstSunday),
    to: toIso(lastSaturday),
  };
}
