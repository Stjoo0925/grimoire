"use client";

/**
 * ③ 관찰형 게임 — 사서 NPC.
 *
 * 서가 사이를 걸어다니며 일하는 작은 사서. 일과표(lib/library/npc.ts)를 따라
 * 최근 집필된 책 앞으로 걸어가 새 페이지를 꽂고(shelve), 한가하면 먼지를 털거나
 * (dust) 아무 책이나 꺼내 훑는다(browse). 사서 채팅이 책을 언급하면 하던 일을
 * 멈추고 그 서가로 걸어가 가리킨다(point).
 *
 * 구현 노트:
 * - 이 레이어는 서가 영역(relative) 위에 absolute로 덮이며 클릭을 막지 않는다.
 * - 책의 위치는 data-book-id로 DOM에서 찾는다 — 레이아웃(줄바꿈·재배치)을
 *   따로 계산하지 않아도 항상 실제 화면 위치와 일치한다.
 * - 걷기는 transform 전이 하나로 처리한다(리플로우 없음). 타이머는 ref로 관리하고
 *   탭이 숨겨지면 멈춘다. prefers-reduced-motion이면 NPC는 정지 상태로만 선다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  buildNpcScript,
  TASK_DWELL,
  TASK_PAUSE,
  walkDuration,
  type NpcBookInput,
  type NpcTask,
  type NpcTaskType,
} from "@/lib/library/npc";

const NPC_WIDTH = 40;
const NPC_HEIGHT = 56;

type ActionKind = NpcTaskType | "point";
type Phase = "idle" | "walking" | "acting";

export interface NPCLibrarianProps {
  books: NpcBookInput[];
  /** 사서 채팅이 언급한 책 — 하던 일을 멈추고 이 책으로 간다 */
  focusBookId?: string | null;
  /** 지금 연출 중인 책 알림 (서가에서 반짝이게) */
  onActing?: (bookId: string | null) => void;
}

interface NpcPose {
  x: number;
  y: number;
  facing: 1 | -1;
}

/** 말풍선에 커밋 메시지를 실을 때의 최대 길이 */
const NOTE_LIMIT = 42;

export function NPCLibrarian({ books, focusBookId, onActing }: NPCLibrarianProps) {
  const t = useTranslations("library.npc");
  const locale = useLocale();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskIndexRef = useRef(0);
  const poseRef = useRef<NpcPose>({ x: 12, y: 0, facing: 1 });

  const [pose, setPose] = useState<NpcPose>({ x: 12, y: 0, facing: 1 });
  const [phase, setPhase] = useState<Phase>("idle");
  const [action, setAction] = useState<ActionKind | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const [walkMs, setWalkMs] = useState(1000);
  const [reduced, setReduced] = useState(false);

  const script = useMemo(() => buildNpcScript(books), [books]);
  const nameOf = useMemo(
    () => new Map(books.map((book) => [book.id, book.name])),
    [books],
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listen = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listen);
    return () => query.removeEventListener("change", listen);
  }, []);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const schedule = useCallback((fn: () => void, ms: number) => {
    clearTimer();
    timerRef.current = setTimeout(fn, ms);
  }, []);

  /**
   * data-book-id로 책의 화면 위치를 찾아 레이어 기준 좌표로 바꾼다.
   * 방 씬(책장 가구)에서는 책이 아니라 **책장 앞 통로**에 선다 —
   * x는 책에 맞추고, y는 책장(data-case-id)의 발치.
   */
  const locateBook = useCallback((bookId: string): NpcPose | null => {
    const layer = layerRef.current;
    if (!layer) return null;
    const el = layer.parentElement?.querySelector<HTMLElement>(
      `[data-book-id="${CSS.escape(bookId)}"]`,
    );
    if (!el) return null;
    const layerRect = layer.getBoundingClientRect();
    const bookRect = el.getBoundingClientRect();
    const caseEl = el.closest<HTMLElement>("[data-case-id]");
    const floorRect = (caseEl ?? el).getBoundingClientRect();
    const x =
      bookRect.left - layerRect.left + bookRect.width / 2 - NPC_WIDTH / 2;
    // 책장 아래 통로에 발이 닿게 — 몸이 책장 하단과 살짝 겹치면 "앞에 서 있는" 그림
    const y = floorRect.bottom - layerRect.top - NPC_HEIGHT + (caseEl ? 26 : 4);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      facing: x >= poseRef.current.x ? 1 : -1,
    };
  }, []);

  const bubbleFor = useCallback(
    (kind: ActionKind, bookId: string, note?: string): string => {
      const book = nameOf.get(bookId) ?? "";
      if (kind === "shelve" && note) {
        const line = note.split("\n")[0];
        const trimmed =
          line.length > NOTE_LIMIT ? `${line.slice(0, NOTE_LIMIT)}…` : line;
        return t("shelveNote", { book, note: trimmed });
      }
      return t(kind, { book });
    },
    [nameOf, t],
  );

  /** 한 가지 일: 걸어가서 → 연출하고 → 다음으로 */
  const performTask = useCallback(
    (task: NpcTask, kind: ActionKind, next: () => void) => {
      const target = locateBook(task.bookId);
      if (!target) {
        next();
        return;
      }
      const previous = poseRef.current;
      const distance = Math.hypot(target.x - previous.x, target.y - previous.y);
      const duration = walkDuration(distance);

      poseRef.current = target;
      setWalkMs(duration);
      setPose(target);
      setPhase("walking");
      setAction(null);
      setBubble(null);

      schedule(() => {
        setPhase("acting");
        setAction(kind);
        setBubble(bubbleFor(kind, task.bookId, task.note));
        onActing?.(task.bookId);
        const dwell = kind === "point" ? 3600 : TASK_DWELL[task.type];
        schedule(() => {
          setPhase("idle");
          setAction(null);
          setBubble(null);
          onActing?.(null);
          schedule(next, TASK_PAUSE);
        }, dwell);
      }, duration);
    },
    [bubbleFor, locateBook, onActing, schedule],
  );

  /** 일과표 순환 */
  const runScript = useCallback(() => {
    if (script.length === 0) return;
    const task = script[taskIndexRef.current % script.length];
    taskIndexRef.current += 1;
    performTask(task, task.type, runScript);
  }, [performTask, script]);

  // 시작·중단 관리: reduced-motion이거나 탭이 숨겨지면 쉰다
  useEffect(() => {
    if (reduced || script.length === 0) return;

    const start = () => schedule(runScript, 1200);
    const onVisibility = () => {
      if (document.hidden) clearTimer();
      else start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced, runScript, schedule, script.length]);

  // 사서 채팅이 책을 언급하면 하던 일을 멈추고 그 책으로 (point)
  useEffect(() => {
    if (reduced || !focusBookId) return;
    clearTimer();
    performTask(
      { type: "browse", bookId: focusBookId },
      "point",
      () => schedule(runScript, TASK_PAUSE),
    );
    // performTask/runScript는 안정된 콜백이다 — focus가 바뀔 때만 다시 걷는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBookId, reduced]);

  if (books.length === 0) return null;

  return (
    <div ref={layerRef} aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <div
        className={[
          "npc absolute",
          phase === "walking" ? "npc-walking" : "",
          action ? `npc-act-${action}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={
          {
            width: NPC_WIDTH,
            height: NPC_HEIGHT,
            transform: `translate3d(${pose.x}px, ${pose.y}px, 0)`,
            transitionDuration: `${walkMs}ms`,
            "--npc-facing": pose.facing,
          } as React.CSSProperties
        }
      >
        {/* 말풍선 */}
        {bubble ? (
          <div
            className="speech-bubble speech-bubble-left npc-bubble"
            lang={locale}
          >
            {bubble}
          </div>
        ) : null}

        {/* 스프라이트 — 로브를 입은 작은 사서 */}
        <div className="npc-body">
          <div className="npc-hood" />
          <div className="npc-face">
            <span className="npc-eye" />
            <span className="npc-eye" />
          </div>
          <div className="npc-robe" />
          <div className="npc-arm" />
          {/* 손에 든 것: 꽂을 책 / 먼지떨이 / 펼친 책 / 지팡이 */}
          <div className="npc-prop" />
          <div className="npc-candle">
            <span className="npc-flame" />
          </div>
        </div>

        {/* 연출 부속: 먼지 퍼프 / 반짝임 */}
        <span className="npc-puff npc-puff-1" />
        <span className="npc-puff npc-puff-2" />
        <span className="npc-spark" />
      </div>
    </div>
  );
}

export default NPCLibrarian;
