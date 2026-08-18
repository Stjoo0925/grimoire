"use client";

/**
 * ③ 인터랙티브 도서관 — 책(레포) 한 권의 책등.
 *
 * 책등 색 = 주 언어, 높이·두께 = 커밋 수(로그 스케일).
 * 지식그래프상 연관되면 은은히 빛나고(glow), 뽑으면 상세가 펼쳐진다.
 * canvas 없이 DOM + Tailwind만 쓴다.
 */
import { useTranslations } from "next-intl";

import { spineMetrics } from "@/lib/library/shelves";
import type { BookView } from "@/lib/library/view";
import { RARITY_COLOR, rarityOf, tiltOf } from "./rarity";

export interface BookProps {
  book: BookView;
  selected?: boolean;
  /** 지식그래프상 연관되어 은은히 빛나는 상태 */
  glowing?: boolean;
  onSelect?: (id: string) => void;
}

export function Book({ book, selected = false, glowing = false, onSelect }: BookProps) {
  const t = useTranslations("library");
  const { height, width } = spineMetrics(book.commitCount);
  const rarity = rarityOf(book.commitCount);
  const tilt = tiltOf(book.id);

  return (
    <button
      type="button"
      data-book-id={book.id}
      onClick={() => onSelect?.(book.id)}
      aria-pressed={selected}
      title={`${book.fullName} · ${t("commitCount", { count: book.commitCount })}`}
      className={[
        "book-spine group relative flex shrink-0 items-end justify-center rounded-t-[3px] border border-black/50",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/80",
        selected ? "ring-2 ring-amber-200/90" : "",
        glowing && !selected ? "grimoire-glow" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          height,
          width,
          backgroundColor: book.spineColor,
          backgroundImage:
            "linear-gradient(90deg, rgba(0,0,0,0.45) 0%, rgba(255,255,255,0.10) 22%, rgba(0,0,0,0.10) 60%, rgba(0,0,0,0.55) 100%)",
          "--tilt": `${tilt}deg`,
        } as React.CSSProperties
      }
    >
      {/* 등급 보석 — 두꺼운 책일수록 귀한 판본 */}
      {rarity !== "common" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-2 left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full"
          style={{
            backgroundColor: RARITY_COLOR[rarity],
            boxShadow: `0 0 5px ${RARITY_COLOR[rarity]}`,
          }}
        />
      ) : null}

      {/* 위·아래 금박 띠 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-[3px] top-2 h-[2px] bg-amber-100/25"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-[3px] bottom-6 h-[2px] bg-amber-100/20"
      />

      {book.isPrivate ? (
        <span
          aria-label={t("privateBadge")}
          className="pointer-events-none absolute top-3.5 left-1/2 -translate-x-1/2 text-[9px] leading-none text-amber-100/80"
        >
          ✦
        </span>
      ) : null}

      <span className="mb-1 max-h-[calc(100%-2.5rem)] overflow-hidden text-[10px] leading-none font-medium tracking-tight text-white/90 [writing-mode:vertical-rl] drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
        {book.name}
      </span>
    </button>
  );
}

export default Book;
