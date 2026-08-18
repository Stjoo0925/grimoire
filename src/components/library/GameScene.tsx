"use client";

/**
 * ③ 쯔꾸르 씬 — Grimoire의 메인 화면.
 *
 * 스크롤 없는 한 화면: 주인공은 책장 벽과 그 앞을 걸어다니는 사서 NPC.
 * 나머지(서고 관리·모델 설정)는 HUD 버튼 → 오버레이 창으로만 연다.
 * 하단은 클래식 RPG 대화창 — 사서에게 묻고, 답은 그 창에 뜬다.
 */
import { useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { askLibrarianAction } from "@/app/actions";
import type { LibrarianAnswer } from "@/lib/library/librarian";
import type { BookView } from "@/lib/library/view";
import AmbientScene from "./AmbientScene";
import { BookDetail } from "./BookDetail";
import { LibraryRoom } from "./LibraryRoom";
import { NPCLibrarian } from "./NPCLibrarian";

export interface GameSceneProps {
  books: BookView[];
  hasGraph: boolean;
  /** 서고 관리 오버레이 내용물 (수집·그래프 폼 — 서버 액션 포함이라 페이지가 만들어 내려준다) */
  managePanel: React.ReactNode;
  /** 모델 설정 오버레이 내용물 */
  settingsPanel: React.ReactNode;
  /** HUD 오른쪽 끝 (언어 전환 · 로그아웃) */
  hudTail?: React.ReactNode;
}

type Overlay = "manage" | "settings" | null;

export function GameScene({
  books,
  hasGraph,
  managePanel,
  settingsPanel,
  hudTail,
}: GameSceneProps) {
  const t = useTranslations("library");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [librarianGlow, setLibrarianGlow] = useState<string[]>([]);
  const [npcBookId, setNpcBookId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);

  // ── 대화창 상태 (히스토리는 최신 한 턴만 — RPG 메시지창답게) ──
  const [question, setQuestion] = useState("");
  const [lastAnswer, setLastAnswer] = useState<LibrarianAnswer | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(
    () => new Map(books.map((book) => [book.id, book])),
    [books],
  );
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const glowIds = useMemo(() => {
    const ids = selected
      ? new Set(selected.relatedIds)
      : new Set(librarianGlow);
    if (npcBookId) ids.add(npcBookId);
    return ids;
  }, [selected, librarianGlow, npcBookId]);

  const relatedBooks = useMemo(
    () =>
      selected
        ? selected.relatedIds
            .map((id) => byId.get(id))
            .filter((book): book is BookView => Boolean(book))
        : [],
    [selected, byId],
  );

  const npcBooks = useMemo(
    () =>
      books.map((book) => ({
        id: book.id,
        name: book.name,
        lastCommitAt: book.lastCommitAt,
        recentCommits: book.recentCommits,
        commitCount: book.commitCount,
      })),
    [books],
  );

  const ask = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || pending) return;
    setQuestion("");
    startTransition(async () => {
      const answer = await askLibrarianAction(trimmed);
      setLastAnswer(answer);
      setSelectedId(null);
      setLibrarianGlow(answer.projectIds);
    });
  };

  return (
    <div className="fixed inset-0 z-0 flex h-dvh flex-col overflow-hidden bg-stone-950">
      <AmbientScene />

      {/* ── HUD 바 ─────────────────────────────────────────── */}
      <header className="relative z-20 flex shrink-0 items-center gap-3 border-b border-amber-200/10 bg-stone-950/80 px-4 py-2">
        <h1 className="text-base font-semibold tracking-[0.3em] text-amber-100">
          GRIMOIRE
        </h1>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOverlay("manage")}
            className="rounded border border-amber-200/20 px-3 py-1.5 text-xs tracking-[0.15em] text-stone-400 transition hover:border-amber-200/50 hover:text-amber-100"
          >
            {t("hud.manage")}
          </button>
          <button
            type="button"
            onClick={() => setOverlay("settings")}
            className="rounded border border-amber-200/20 px-3 py-1.5 text-xs tracking-[0.15em] text-stone-400 transition hover:border-amber-200/50 hover:text-amber-100"
          >
            ⚙ {t("hud.settings")}
          </button>
          {hudTail}
        </div>
      </header>

      {/* ── 씬: 도서관 방 + 사서 NPC ─────────────────────────── */}
      <div className="relative z-10 min-h-0 flex-1">
        <LibraryRoom
          books={books}
          selectedId={selectedId}
          glowIds={glowIds}
          onSelect={(id) => {
            setSelectedId((prev) => (prev === id ? null : id));
            setLibrarianGlow([]);
          }}
        >
          <NPCLibrarian
            books={npcBooks}
            focusBookId={librarianGlow.length > 0 ? librarianGlow[0] : null}
            onActing={setNpcBookId}
          />
        </LibraryRoom>
      </div>

      {/* ── RPG 대화창 ─────────────────────────────────────── */}
      <div className="relative z-20 shrink-0 px-3 pb-3">
        <div className="rpg-window mx-auto flex max-w-4xl flex-col gap-2 px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="rpg-nameplate shrink-0">🕯 {t("hud.dialogName")}</span>
            <div className="dialog-scroll min-h-[3.6rem] max-h-32 flex-1 overflow-y-auto text-sm leading-relaxed text-stone-200">
              {pending ? (
                <span className="text-stone-500">{t("chat.pending")}</span>
              ) : lastAnswer ? (
                <>
                  {lastAnswer.answer ? (
                    <p className="whitespace-pre-wrap">{lastAnswer.answer}</p>
                  ) : null}
                  {lastAnswer.message ? (
                    <p
                      className={
                        lastAnswer.ok
                          ? "mt-1 text-xs text-amber-200/60"
                          : "mt-1 text-xs text-rose-300/80"
                      }
                    >
                      {lastAnswer.message}
                    </p>
                  ) : null}
                  {lastAnswer.degraded && lastAnswer.items.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-[13px] text-stone-400">
                      {lastAnswer.items.slice(0, 5).map((item) => (
                        <li key={item.id}>
                          <span className="mr-1 text-[11px] tracking-widest text-stone-600">
                            {t(`chat.kind.${item.kind}`)}
                          </span>
                          {item.label}
                          {item.detail ? ` — ${item.detail}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <span className="text-stone-500">
                  {hasGraph ? t("chat.intro") : t("chat.noGraph")}
                </span>
              )}
            </div>
          </div>

          <form
            className="flex gap-2"
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
              className="min-w-0 flex-1 rounded border border-stone-700/80 bg-stone-900/80 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-600 focus:border-amber-200/50 focus:outline-none"
            />
            <button
              type="submit"
              disabled={pending || question.trim().length === 0}
              className="rounded border border-amber-200/30 px-4 py-2 text-[13px] text-amber-100 transition hover:border-amber-200/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "…" : t("chat.send")}
            </button>
          </form>
        </div>
      </div>

      {/* ── 오버레이: 책 상세 ──────────────────────────────── */}
      {selected ? (
        <BookDetail
          book={selected}
          relatedBooks={relatedBooks}
          onClose={() => setSelectedId(null)}
          onSelect={setSelectedId}
        />
      ) : null}

      {/* ── 오버레이: 서고 관리 / 설정 ─────────────────────── */}
      {overlay ? (
        <div
          className="veil-enter fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOverlay(null)}
        >
          <div
            className="rpg-window book-open-enter max-h-[85vh] w-full max-w-2xl overflow-y-auto px-6 py-5"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-sm tracking-[0.25em] text-amber-100/90">
                {overlay === "manage" ? t("hud.manage") : t("hud.settings")}
              </h2>
              <button
                type="button"
                onClick={() => setOverlay(null)}
                className="text-[13px] text-stone-500 transition hover:text-amber-200/70"
              >
                ✕ {t("hud.close")}
              </button>
            </header>
            <div className="flex flex-col items-center gap-8">
              {overlay === "manage" ? managePanel : settingsPanel}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default GameScene;
