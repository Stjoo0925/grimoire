"use client";

/**
 * ③ 인터랙티브 도서관 — 서재 전체.
 *
 * 서가 배치 토글(언어별 서가 / 연도별 층), 비공개 서고 분리,
 * 책을 뽑으면 상세 + 연관된 책 발광, 사서가 언급한 책도 같은 방식으로 빛난다.
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { Book } from "./Book";
import { BookDetail } from "./BookDetail";
import { Bookshelf } from "./Bookshelf";
import { ContributionHeatmap } from "./ContributionHeatmap";
import { LibrarianChat } from "./LibrarianChat";
import type { Heatmap } from "@/lib/library/heatmap";
import { groupBooks, partitionPrivate, type ShelfMode } from "@/lib/library/shelves";
import type { BookView } from "@/lib/library/view";

export interface LibraryViewProps {
  books: BookView[];
  heatmap: Heatmap;
  hasGraph: boolean;
}

const MODES: ShelfMode[] = ["language", "year"];

export function LibraryView({ books, heatmap, hasGraph }: LibraryViewProps) {
  const t = useTranslations("library");
  const [mode, setMode] = useState<ShelfMode>("language");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [librarianGlow, setLibrarianGlow] = useState<string[]>([]);

  const { open, restricted } = useMemo(() => partitionPrivate(books), [books]);
  const openShelves = useMemo(() => groupBooks(open, mode), [open, mode]);
  const restrictedShelves = useMemo(
    () => groupBooks(restricted, mode),
    [restricted, mode],
  );

  const byId = useMemo(
    () => new Map(books.map((book) => [book.id, book])),
    [books],
  );
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  /** 선택된 책이 있으면 그 책의 연관 책이, 없으면 사서가 언급한 책이 빛난다 */
  const glowIds = useMemo(() => {
    if (selected) return new Set(selected.relatedIds);
    return new Set(librarianGlow);
  }, [selected, librarianGlow]);

  const relatedBooks = useMemo(
    () =>
      selected
        ? selected.relatedIds
            .map((id) => byId.get(id))
            .filter((book): book is BookView => Boolean(book))
        : [],
    [selected, byId],
  );

  const renderShelves = (shelves: ReturnType<typeof groupBooks>) =>
    shelves.map((shelf) => (
      <Bookshelf key={`${mode}-${shelf.key}`} shelf={shelf}>
        {shelf.books.map((book) => (
          <Book
            key={book.id}
            book={book}
            selected={book.id === selectedId}
            glowing={glowIds.has(book.id)}
            onSelect={setSelectedId}
          />
        ))}
      </Bookshelf>
    ));

  return (
    <div className="w-full max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm tracking-[0.3em] text-amber-100/80">
            {t("title")}
          </h2>
          <p className="text-[11px] text-stone-500">
            {t("subtitle", {
              books: books.length,
              shelves: openShelves.length + restrictedShelves.length,
            })}
          </p>
        </div>

        <div
          role="group"
          aria-label={t("shelfBy.label")}
          className="flex overflow-hidden rounded-md border border-amber-200/20"
        >
          {MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setMode(candidate)}
              aria-pressed={mode === candidate}
              className={`px-3 py-1.5 text-[11px] tracking-[0.15em] transition ${
                mode === candidate
                  ? "bg-amber-200/15 text-amber-100"
                  : "text-stone-500 hover:text-amber-200/70"
              }`}
            >
              {t(`shelfBy.${candidate}`)}
            </button>
          ))}
        </div>
      </header>

      <ContributionHeatmap heatmap={heatmap} />

      {!hasGraph ? (
        <p className="rounded border border-violet-200/15 bg-violet-950/10 px-3 py-2 text-[11px] leading-relaxed text-violet-200/70">
          {t("needGraph")}
        </p>
      ) : null}

      <div className="space-y-4">
        <h3 className="text-[11px] tracking-[0.25em] text-stone-500">
          {t("openStacks")}
        </h3>
        {renderShelves(openShelves)}
      </div>

      {restricted.length > 0 ? (
        <div className="space-y-4 rounded-lg border border-violet-300/20 bg-violet-950/10 p-4">
          <div className="space-y-1">
            <h3 className="text-[11px] tracking-[0.25em] text-violet-200/80">
              🔒 {t("restrictedStacks")}
            </h3>
            <p className="text-[10px] text-violet-200/50">{t("restrictedHint")}</p>
          </div>
          {renderShelves(restrictedShelves)}
        </div>
      ) : null}

      {selected ? (
        <BookDetail
          book={selected}
          relatedBooks={relatedBooks}
          onClose={() => setSelectedId(null)}
          onSelect={setSelectedId}
        />
      ) : null}

      <LibrarianChat
        hasGraph={hasGraph}
        onGlow={(ids) => {
          setSelectedId(null);
          setLibrarianGlow(ids);
        }}
      />
    </div>
  );
}

export default LibraryView;
