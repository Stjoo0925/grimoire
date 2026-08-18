/**
 * ③ 인터랙티브 도서관 — 책(레포) 한 권.
 * 책등 색 = 주 언어. 뽑으면 커밋 연혁이 페이지로 펼쳐질 자리.
 * 현재는 자리표시 컴포넌트.
 */
"use client";

export interface BookProps {
  title: string;
  /** 책등 색 (주 언어에서 유도) */
  spineColor?: string;
  /** 페이지 수 ≈ 커밋 수 → 두께 */
  pages?: number;
  isPrivate?: boolean;
  /** 지식그래프상 연관되어 은은히 빛나는 상태 */
  highlighted?: boolean;
  onSelect?: () => void;
}

export function Book({
  title,
  spineColor = "#4b5563",
  pages = 40,
  isPrivate = false,
  highlighted = false,
  onSelect,
}: BookProps) {
  const height = Math.min(180, 100 + pages / 4);
  const width = Math.min(48, 16 + pages / 12);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      className={`flex items-end justify-center rounded-sm border border-black/40 transition ${
        highlighted ? "ring-2 ring-amber-300/70" : ""
      }`}
      style={{
        backgroundColor: spineColor,
        height,
        width,
        opacity: isPrivate ? 0.65 : 1,
      }}
    >
      <span className="[writing-mode:vertical-rl] truncate py-2 text-[10px] text-white/90">
        {title}
      </span>
    </button>
  );
}

export default Book;
