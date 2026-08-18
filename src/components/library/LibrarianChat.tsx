"use client";

/**
 * ③ AI 사서 채팅.
 *
 * 질문 → 서버 액션(그래프 검색 + 로컬 Ollama 합성) → 답변.
 * 대화는 이 컴포넌트의 state에만 남는다 (저장하지 않는다).
 * 로컬 LLM이 없으면 사서가 "찾은 항목" 목록만 돌려준다 (degraded).
 */
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { askLibrarianAction } from "@/app/actions";
import type { LibrarianAnswer } from "@/lib/library/librarian";

interface Turn {
  question: string;
  answer: LibrarianAnswer | null;
}

export interface LibrarianChatProps {
  /** 그래프가 없으면 사서가 답할 근거가 없다 */
  hasGraph: boolean;
  /** 답변이 언급한 책들을 서가에서 빛나게 한다 */
  onGlow: (projectIds: string[]) => void;
}

export function LibrarianChat({ hasGraph, onGlow }: LibrarianChatProps) {
  const t = useTranslations("library");
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || pending) return;
    setQuestion("");
    setTurns((prev) => [...prev, { question: trimmed, answer: null }]);
    startTransition(async () => {
      const answer = await askLibrarianAction(trimmed);
      setTurns((prev) => {
        const next = [...prev];
        const last = next.findLastIndex((turn) => turn.answer === null);
        if (last >= 0) next[last] = { question: trimmed, answer };
        return next;
      });
      onGlow(answer.projectIds);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-6 bottom-6 z-30 rounded-full border border-amber-200/30 bg-stone-900/90 px-5 py-3 text-xs tracking-[0.15em] text-amber-100 shadow-[0_0_24px_rgba(251,191,36,0.15)] transition hover:border-amber-200/70 hover:bg-stone-800"
      >
        ✦ {t("chat.open")}
      </button>
    );
  }

  return (
    <aside className="fixed right-4 bottom-4 z-30 flex max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] flex-col rounded-lg border border-amber-200/25 bg-stone-950/95 shadow-[0_0_50px_rgba(0,0,0,0.75)] backdrop-blur">
      <header className="flex items-center justify-between border-b border-amber-200/15 px-4 py-3">
        <h3 className="text-xs tracking-[0.25em] text-amber-100/90">
          ✦ {t("chat.title")}
        </h3>
        <div className="flex items-center gap-3">
          {turns.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                onGlow([]);
              }}
              className="text-[10px] text-stone-500 transition hover:text-amber-200/70"
            >
              {t("chat.clear")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[10px] text-stone-500 transition hover:text-amber-200/70"
          >
            {t("chat.close")}
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {turns.length === 0 ? (
          <div className="space-y-2 text-[11px] leading-relaxed text-stone-500">
            <p>{t("chat.intro")}</p>
            <p className="text-stone-600">{t("chat.privacy")}</p>
            {!hasGraph ? (
              <p className="text-rose-300/70">{t("chat.noGraph")}</p>
            ) : null}
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <div key={index} className="space-y-2">
            <p className="text-right text-[11px] text-amber-100/80">
              <span className="rounded-md bg-stone-800/70 px-2 py-1">
                {turn.question}
              </span>
            </p>

            {turn.answer === null ? (
              <p className="text-[11px] text-stone-500">{t("chat.pending")}</p>
            ) : (
              <div className="space-y-2">
                {turn.answer.answer ? (
                  <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-stone-200">
                    {turn.answer.answer}
                  </p>
                ) : null}

                {turn.answer.message ? (
                  <p
                    className={`rounded border px-2 py-1.5 text-[10px] leading-relaxed ${
                      turn.answer.ok
                        ? "border-amber-200/15 bg-amber-950/10 text-amber-200/70"
                        : "border-rose-300/20 bg-rose-950/20 text-rose-200/80"
                    }`}
                  >
                    {turn.answer.message}
                  </p>
                ) : null}

                {turn.answer.degraded && turn.answer.items.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[10px] tracking-[0.2em] text-amber-200/60">
                      {t("chat.found")}
                    </p>
                    <ul className="space-y-1.5">
                      {turn.answer.items.map((item) => (
                        <li
                          key={item.id}
                          className="rounded border border-stone-700/60 px-2 py-1.5"
                        >
                          <p className="text-[11px] text-amber-100/85">
                            <span className="mr-1 text-[9px] tracking-widest text-stone-500">
                              {t(`chat.kind.${item.kind}`)}
                            </span>
                            {item.label}
                          </p>
                          {item.detail ? (
                            <p className="text-[10px] leading-relaxed text-stone-500">
                              {item.detail}
                            </p>
                          ) : null}
                          {item.connections.length > 0 ? (
                            <p className="mt-0.5 text-[10px] leading-relaxed text-stone-600">
                              {item.connections.slice(0, 3).join(" / ")}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {turn.answer.projectIds.length > 0 ? (
                  <p className="text-[10px] text-amber-200/50">
                    {t("chat.glowNotice", { count: turn.answer.projectIds.length })}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="flex gap-2 border-t border-amber-200/15 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={t("chat.placeholder")}
          maxLength={500}
          className="min-w-0 flex-1 rounded border border-stone-700 bg-stone-900/80 px-3 py-2 text-[12px] text-stone-100 placeholder:text-stone-600 focus:border-amber-200/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || question.trim().length === 0}
          className="rounded border border-amber-200/30 px-3 py-2 text-[11px] text-amber-100 transition hover:border-amber-200/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "…" : t("chat.send")}
        </button>
      </form>
    </aside>
  );
}

export default LibrarianChat;
