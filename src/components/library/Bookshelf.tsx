"use client";

/**
 * ③ 인터랙티브 도서관 — 서가 한 칸.
 * 언어별 서가 또는 연도별 층 하나. 책등이 나무 선반 위에 늘어선다.
 */
import { useTranslations } from "next-intl";

import type { Shelf } from "@/lib/library/shelves";
import { UNKNOWN_SHELF } from "@/lib/library/shelves";
import { languageColor } from "@/lib/library/colors";

export interface BookshelfProps {
  shelf: Shelf;
  /** 책등들 — 배치는 서가가, 선택 상태는 상위 뷰가 관리한다 */
  children?: React.ReactNode;
}

/** 서가 명패 — 언어 서가는 그 언어 색 점을 함께 단다 */
export function Bookshelf({ shelf, children }: BookshelfProps) {
  const t = useTranslations("library");
  const label = shelf.key === UNKNOWN_SHELF ? t("unknownLanguage") : shelf.label;
  const isLanguage = !/^\d{4}$/.test(shelf.key);

  return (
    <section className="rounded-md border border-amber-900/25 bg-stone-900/40 px-4 pt-3 pb-1">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs tracking-[0.2em] text-amber-200/75">
          {isLanguage ? (
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor:
                  shelf.key === UNKNOWN_SHELF
                    ? "#57534e"
                    : languageColor(shelf.key),
              }}
            />
          ) : null}
          {label}
        </h3>
        <span className="text-[10px] text-stone-500">
          {t("bookCount", { count: shelf.books.length })} ·{" "}
          {t("commitCount", { count: shelf.commitCount.toLocaleString() })}
        </span>
      </header>

      <div className="relative">
        <div className="flex min-h-[124px] flex-wrap items-end gap-[3px] pb-1">
          {shelf.books.length === 0 ? (
            <p className="pb-6 text-xs text-stone-500">{t("emptyShelf")}</p>
          ) : (
            children
          )}
        </div>
        {/* 선반 판 */}
        <div
          aria-hidden
          className="h-2 rounded-sm bg-gradient-to-b from-amber-950/80 to-stone-950 shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
        />
      </div>
    </section>
  );
}

export default Bookshelf;
