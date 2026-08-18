"use client";

/**
 * ③ 관찰형 게임 — 책장 가구 한 점.
 *
 * 탑다운 방에 놓이는 나무 책장: 안에 미니 책등이 2~3단으로 꽂히고
 * 아래에 언어 명패가 붙는다. 미니 책등은 data-book-id를 지니므로
 * 사서 NPC의 좌표 탐색과 클릭(책 상세)이 그대로 동작한다.
 */
import { useTranslations } from "next-intl";

import {
  caseInnerRows,
  caseWidth,
  spineHeight,
  SPINE_GAP,
  SPINE_WIDTH,
  type BookcaseModel,
} from "@/lib/library/room";
import { languageColor } from "@/lib/library/colors";

export interface BookcaseProps {
  model: BookcaseModel;
  selectedId: string | null;
  glowIds: Set<string>;
  onSelect: (id: string) => void;
}

export function Bookcase({ model, selectedId, glowIds, onSelect }: BookcaseProps) {
  const t = useTranslations("library");
  const rows = caseInnerRows(model.books);
  const label = model.language ?? t("unknownLanguage");
  const plate = model.part > 0 ? `${label} ${model.part}` : label;
  const dotColor = model.language ? languageColor(model.language) : "#57534e";
  const hasGlow = model.books.some((book) => glowIds.has(book.id));

  return (
    <div
      data-case-id={model.id}
      className={`bookcase relative shrink-0 ${hasGlow ? "bookcase-lit" : ""}`}
      style={{ width: caseWidth(model.books.length) }}
    >
      {/* 상단 몰딩 */}
      <div aria-hidden className="bookcase-cornice" />

      <div className="bookcase-inner">
        {rows.map((row, index) => (
          <div key={index} className="bookcase-row">
            <div
              className="flex items-end justify-center"
              style={{ gap: SPINE_GAP }}
            >
              {row.map((book) => (
                <button
                  key={book.id}
                  type="button"
                  data-book-id={book.id}
                  onClick={() => onSelect(book.id)}
                  title={`${book.fullName} · ${t("commitCount", { count: book.commitCount })}`}
                  aria-label={book.fullName}
                  aria-pressed={book.id === selectedId}
                  className={[
                    "mini-spine relative rounded-t-[2px]",
                    book.id === selectedId ? "mini-spine-selected" : "",
                    glowIds.has(book.id) ? "grimoire-glow" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    width: SPINE_WIDTH,
                    height: spineHeight(book.commitCount),
                    backgroundColor: book.spineColor,
                  }}
                >
                  {book.isPrivate ? (
                    <span aria-hidden className="mini-spine-lock">
                      ✦
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {/* 단 판자 */}
            <div aria-hidden className="bookcase-shelfboard" />
          </div>
        ))}
      </div>

      {/* 명패 */}
      <div className="bookcase-plate">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="truncate">{plate}</span>
        <span className="text-stone-500">
          {t("bookCount", { count: model.books.length })}
        </span>
      </div>
    </div>
  );
}

export default Bookcase;
