/**
 * ③ 관찰형 게임 — 도서관 "방" 배치 (순수 로직).
 *
 * AI 일꾼 시뮬레이터 문법: 탑다운 방에 책장이 가구로 놓이고,
 * 사서(일꾼)가 통로를 걸어다닌다. 여기서는 책 → 책장(가구) 묶음과
 * 책장 크기·행 배치를 결정론적으로 계산한다. 렌더·좌표는 컴포넌트 몫.
 */
import type { BookView } from "./view";

/** 책장 하나에 꽂는 최대 권수 — 넘치면 같은 언어의 2호장·3호장으로 분권 */
export const CASE_MAX_BOOKS = 12;
/** 미니 책등 폭(px) — 방 시점에서는 책이 작아 보인다 */
export const SPINE_WIDTH = 11;
/** 미니 책등 사이 간격(px) */
export const SPINE_GAP = 2;
/** 책장 좌우 프레임 + 안쪽 여백(px, 한쪽) */
export const CASE_PADDING = 12;
/** 책장 사이 통로(px) */
export const CASE_GAP = 28;
/** 책장 행 사이 통로(세로) 포함 행 높이(px) */
export const ROOM_ROW_HEIGHT = 190;

export interface BookcaseModel {
  /** data-case-id — NPC가 이 앞 통로에 선다 */
  id: string;
  /** 언어명. null이면 미분류(UI가 번역) */
  language: string | null;
  /** 같은 언어가 여러 장으로 나뉠 때의 순번 (1부터, 한 장뿐이면 0) */
  part: number;
  books: BookView[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-");
}

/**
 * 책 → 책장 묶음. 언어별로 모으고(큰 언어 먼저), CASE_MAX_BOOKS 넘으면 분권.
 * 각 책장 안에서는 커밋 많은 책이 앞(왼쪽)에 온다.
 */
export function groupCases(
  books: BookView[],
  maxPerCase = CASE_MAX_BOOKS,
): BookcaseModel[] {
  const byLanguage = new Map<string | null, BookView[]>();
  const sorted = [...books].sort((a, b) => b.commitCount - a.commitCount);
  for (const book of sorted) {
    const key = book.primaryLanguage;
    const group = byLanguage.get(key);
    if (group) group.push(book);
    else byLanguage.set(key, [book]);
  }

  const groups = [...byLanguage.entries()].sort(
    (a, b) =>
      b[1].length - a[1].length ||
      String(a[0] ?? "￿").localeCompare(String(b[0] ?? "￿")),
  );

  const cases: BookcaseModel[] = [];
  for (const [language, group] of groups) {
    const parts = Math.ceil(group.length / maxPerCase);
    for (let i = 0; i < parts; i += 1) {
      cases.push({
        id: `case-${slug(language ?? "misc")}-${i + 1}`,
        language,
        part: parts > 1 ? i + 1 : 0,
        books: group.slice(i * maxPerCase, (i + 1) * maxPerCase),
      });
    }
  }
  return cases;
}

/** 책장 내부 한 단에 꽂는 권수 — 2단을 기본으로 균형 있게 */
export function spinesPerRow(count: number): number {
  return Math.min(8, Math.max(3, Math.ceil(count / 2)));
}

/** 책장 내부 단 나누기 */
export function caseInnerRows(books: BookView[]): BookView[][] {
  const per = spinesPerRow(books.length);
  const rows: BookView[][] = [];
  for (let start = 0; start < books.length; start += per) {
    rows.push(books.slice(start, start + per));
  }
  return rows;
}

/** 책장 가구의 바깥 폭(px) */
export function caseWidth(count: number): number {
  return spinesPerRow(count) * (SPINE_WIDTH + SPINE_GAP) + CASE_PADDING * 2;
}

/** 미니 책등 높이(px) — 커밋 수 로그 스케일 */
export function spineHeight(commitCount: number): number {
  return Math.round(20 + Math.min(16, Math.log2(1 + commitCount) * 2.4));
}

/** 방 폭에 맞춰 책장들을 행으로 나눈다 (탐욕) */
export function chunkCaseRows(
  cases: BookcaseModel[],
  containerWidth: number,
): BookcaseModel[][] {
  if (cases.length === 0) return [];
  const usable = Math.max(280, containerWidth - 48);
  const rows: BookcaseModel[][] = [];
  let row: BookcaseModel[] = [];
  let width = 0;
  for (const bookcase of cases) {
    const w = caseWidth(bookcase.books.length) + CASE_GAP;
    if (width + w > usable && row.length > 0) {
      rows.push(row);
      row = [];
      width = 0;
    }
    row.push(bookcase);
    width += w;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}
