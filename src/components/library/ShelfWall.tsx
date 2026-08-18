"use client";

/**
 * ③ 쯔꾸르 씬 — 책장 벽.
 *
 * 화면(씬 영역)을 꽉 채우는 책장. 책들은 컨테이너 폭에 맞춰 여러 단으로
 * 나뉘어 꽂히고, 단 수가 화면보다 크면 벽 전체를 축소해 스크롤 없이
 * 한 화면에 들어온다. NPC 레이어는 이 벽 안에 함께 살아서(children)
 * 책 좌표(data-book-id)와 항상 일치한다.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { spineMetrics } from "@/lib/library/shelves";
import type { BookView } from "@/lib/library/view";
import { Book } from "./Book";

export type WallMode = "language" | "year";

export interface ShelfWallProps {
  books: BookView[];
  mode: WallMode;
  selectedId: string | null;
  glowIds: Set<string>;
  onSelect: (id: string) => void;
  /** NPC 레이어 — 벽과 같은 좌표계에 두기 위해 안에서 그린다 */
  children?: React.ReactNode;
}

/** 단 하나의 높이(px) — 책 최대 높이 + 선반 판 + 여백 */
const ROW_HEIGHT = 196;
/** 책 사이 간격(px) — Book의 gap과 맞춘다 */
const BOOK_GAP = 3;
/** 벽 좌우 패딩(px) */
const WALL_PADDING = 28;

/** 배치 순서: 언어별(서가처럼 같은 계열이 모임) 또는 연도별 */
function sortForWall(books: BookView[], mode: WallMode): BookView[] {
  const sorted = [...books];
  if (mode === "language") {
    sorted.sort(
      (a, b) =>
        (a.primaryLanguage ?? "≈").localeCompare(b.primaryLanguage ?? "≈") ||
        b.commitCount - a.commitCount,
    );
  } else {
    sorted.sort(
      (a, b) => b.activeYear - a.activeYear || b.commitCount - a.commitCount,
    );
  }
  return sorted;
}

/** 폭 기준 탐욕 분배 — 넘치면 다음 단으로 */
export function chunkRows(
  books: BookView[],
  containerWidth: number,
): BookView[][] {
  if (books.length === 0) return [];
  const usable = Math.max(240, containerWidth - WALL_PADDING * 2);
  const rows: BookView[][] = [];
  let row: BookView[] = [];
  let width = 0;
  for (const book of books) {
    const spine = spineMetrics(book.commitCount).width + BOOK_GAP;
    if (width + spine > usable && row.length > 0) {
      rows.push(row);
      row = [];
      width = 0;
    }
    row.push(book);
    width += spine;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export function ShelfWall({
  books,
  mode,
  selectedId,
  glowIds,
  onSelect,
  children,
}: ShelfWallProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ordered = useMemo(() => sortForWall(books, mode), [books, mode]);
  const rows = useMemo(
    () => chunkRows(ordered, size?.width ?? 1200),
    [ordered, size?.width],
  );

  // 단이 화면보다 많으면 벽 전체를 축소해 한 화면에 넣는다
  const neededHeight = rows.length * ROW_HEIGHT;
  const scale =
    size && neededHeight > size.height
      ? Math.max(0.55, size.height / neededHeight)
      : 1;

  return (
    <div ref={outerRef} className="relative h-full w-full overflow-hidden">
      <div
        className="relative flex h-full flex-col justify-evenly"
        style={{
          padding: `8px ${WALL_PADDING}px 4px`,
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: "top center",
          width: scale < 1 ? `${100 / scale}%` : undefined,
          marginLeft: scale < 1 ? `${(100 - 100 / scale) / 2}%` : undefined,
        }}
      >
        {rows.map((row, index) => (
          <div key={index} className="relative">
            <div className="flex items-end justify-center gap-[3px] pb-1">
              {row.map((book) => (
                <Book
                  key={book.id}
                  book={book}
                  selected={book.id === selectedId}
                  glowing={glowIds.has(book.id)}
                  onSelect={onSelect}
                />
              ))}
            </div>
            {/* 나무 선반 판 — 단마다 */}
            <div aria-hidden className="shelf-plank h-3 rounded-sm" />
          </div>
        ))}

        {children}
      </div>
    </div>
  );
}

export default ShelfWall;
