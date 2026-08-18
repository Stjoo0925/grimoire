/**
 * ③ 인터랙티브 도서관 — 서가 배치 (순수 로직).
 *
 * "언어별 서가 / 연도별 층" (PLANNING.md §3 ③).
 * 비공개 서고는 따로 떼어 낸다 — 본인만 열람하는 구역이다.
 */
import type { BookView } from "./view";

export type ShelfMode = "language" | "year";

/** 주 언어를 모르는 책이 모이는 서가 키 */
export const UNKNOWN_SHELF = "unknown";

export interface Shelf {
  /** 언어명(소문자 아님, 원문 그대로) 또는 연도 문자열. 언어 미상은 UNKNOWN_SHELF */
  key: string;
  /** 화면 표시용 (언어명 또는 "2024"). 미상이면 빈 문자열 — UI가 번역어를 넣는다 */
  label: string;
  books: BookView[];
  /** 서가에 꽂힌 총 커밋(페이지) 수 */
  commitCount: number;
}

/** 공개 서고 / 비공개 서고로 가른다 */
export function partitionPrivate(books: BookView[]): {
  open: BookView[];
  restricted: BookView[];
} {
  const open: BookView[] = [];
  const restricted: BookView[] = [];
  for (const book of books) {
    if (book.isPrivate) restricted.push(book);
    else open.push(book);
  }
  return { open, restricted };
}

/** 책 정렬: 두꺼운(커밋 많은) 책이 왼쪽, 동률이면 이름순 */
function byThickness(a: BookView, b: BookView): number {
  return b.commitCount - a.commitCount || a.name.localeCompare(b.name);
}

/**
 * 서가 묶기.
 * - language: 권수 많은 서가부터. 언어 미상 서가는 항상 맨 끝.
 * - year: 최근 연도가 위층.
 */
export function groupBooks(books: BookView[], mode: ShelfMode): Shelf[] {
  const groups = new Map<string, Shelf>();

  for (const book of books) {
    const key =
      mode === "language"
        ? (book.primaryLanguage?.trim() || UNKNOWN_SHELF)
        : String(book.activeYear || UNKNOWN_SHELF);
    const label = key === UNKNOWN_SHELF ? "" : key;
    const shelf = groups.get(key);
    if (shelf) {
      shelf.books.push(book);
      shelf.commitCount += book.commitCount;
    } else {
      groups.set(key, {
        key,
        label,
        books: [book],
        commitCount: book.commitCount,
      });
    }
  }

  const shelves = [...groups.values()];
  for (const shelf of shelves) shelf.books.sort(byThickness);

  if (mode === "year") {
    shelves.sort((a, b) => {
      if (a.key === UNKNOWN_SHELF) return 1;
      if (b.key === UNKNOWN_SHELF) return -1;
      return Number(b.key) - Number(a.key);
    });
  } else {
    shelves.sort((a, b) => {
      if (a.key === UNKNOWN_SHELF) return 1;
      if (b.key === UNKNOWN_SHELF) return -1;
      return (
        b.books.length - a.books.length ||
        b.commitCount - a.commitCount ||
        a.key.localeCompare(b.key)
      );
    });
  }

  return shelves;
}

/**
 * 책등 치수 — 커밋 수에 따라 은근하게만 달라진다.
 * 1850커밋짜리 한 권이 서가를 뚫고 나가면 안 되므로 로그 스케일로 누른다.
 */
export function spineMetrics(commitCount: number): {
  height: number;
  width: number;
} {
  // 500쪽이 넘으면 더 자라지 않는다 (서가를 뚫지 않도록 상한을 건다)
  const scale = Math.min(
    1,
    Math.log10(Math.max(1, commitCount) + 1) / Math.log10(501),
  );
  return {
    height: Math.round(104 + scale * 76), // 104~180px
    width: Math.round(18 + scale * 20), // 18~38px
  };
}
