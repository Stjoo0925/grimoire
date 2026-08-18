/**
 * ③ 인터랙티브 도서관 — 서가 한 칸.
 * 언어별 서가 / 연도별 층으로 배치될 예정. 현재는 자리표시 컴포넌트.
 */
"use client";

import { Book, type BookProps } from "./Book";

export interface BookshelfProps {
  /** 서가 이름 — 언어 계열 또는 연도 */
  label: string;
  books?: BookProps[];
}

export function Bookshelf({ label, books = [] }: BookshelfProps) {
  return (
    <section className="rounded-md border border-amber-900/30 bg-stone-900/60 p-4">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-amber-200/70">
        {label}
      </h2>
      <div className="flex min-h-[120px] items-end gap-1 border-b-4 border-amber-950/70 pb-1">
        {books.length === 0 ? (
          <p className="pb-4 text-xs text-stone-500">아직 꽂힌 마법서가 없습니다.</p>
        ) : (
          books.map((book) => <Book key={book.title} {...book} />)
        )}
      </div>
    </section>
  );
}

export default Bookshelf;
