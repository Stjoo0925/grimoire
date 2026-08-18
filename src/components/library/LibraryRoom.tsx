"use client";

/**
 * ③ 관찰형 게임 — 도서관 방 (탑다운 씬).
 *
 * 타일 바닥 위에 책장 가구들이 통로를 두고 줄지어 서고,
 * 사서 NPC(children)가 그 사이를 걸어다닌다. 행이 화면보다 많으면
 * 방 전체를 축소해 스크롤 없이 한 화면에 담는다.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  chunkCaseRows,
  groupCases,
  ROOM_ROW_HEIGHT,
} from "@/lib/library/room";
import type { BookView } from "@/lib/library/view";
import { Bookcase } from "./Bookcase";

export interface LibraryRoomProps {
  books: BookView[];
  selectedId: string | null;
  glowIds: Set<string>;
  onSelect: (id: string) => void;
  /** 사서 NPC 레이어 — 방과 같은 좌표계에 두려고 안에서 그린다 */
  children?: React.ReactNode;
}

/** 뒷벽 높이(px) — 창문·현판이 걸리는 벽 */
const WALL_HEIGHT = 64;

export function LibraryRoom({
  books,
  selectedId,
  glowIds,
  onSelect,
  children,
}: LibraryRoomProps) {
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

  const cases = useMemo(() => groupCases(books), [books]);
  const rows = useMemo(
    () => chunkCaseRows(cases, size?.width ?? 1200),
    [cases, size?.width],
  );

  const neededHeight = WALL_HEIGHT + rows.length * ROOM_ROW_HEIGHT + 30;
  const scale =
    size && neededHeight > size.height
      ? Math.max(0.5, size.height / neededHeight)
      : 1;

  return (
    <div
      ref={outerRef}
      className="room-floor relative h-full w-full overflow-hidden"
    >
      <div
        className="relative"
        style={{
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: "top center",
          width: scale < 1 ? `${100 / scale}%` : undefined,
          marginLeft: scale < 1 ? `${(100 - 100 / scale) / 2}%` : undefined,
        }}
      >
        {/* 뒷벽 — 달빛 창문과 현판 */}
        <div
          aria-hidden
          className="room-wall relative"
          style={{ height: WALL_HEIGHT }}
        >
          <div className="room-window" style={{ left: "18%" }} />
          <div className="room-banner">✦ GRIMOIRE ✦</div>
          <div className="room-window" style={{ right: "18%" }} />
        </div>

        {/* 책장 행들 — 사이가 통로다 */}
        <div className="relative px-6 pt-5">
          {rows.map((row, index) => (
            <div
              key={index}
              className="flex items-end justify-center"
              style={{
                gap: 28,
                minHeight: ROOM_ROW_HEIGHT - 34,
                marginBottom: 34,
              }}
            >
              {row.map((model) => (
                <Bookcase
                  key={model.id}
                  model={model}
                  selectedId={selectedId}
                  glowIds={glowIds}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))}

          {children}
        </div>
      </div>
    </div>
  );
}

export default LibraryRoom;
