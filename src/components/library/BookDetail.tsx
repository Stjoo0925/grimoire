"use client";

/**
 * ③ 인터랙티브 도서관 — 뽑은 책이 펼쳐지는 면.
 *
 * 표지(레포 메타) + 집필 연혁(분기별 커밋 막대·최근 기록) + 지식그래프 연결.
 * 차트 라이브러리 없이 div 높이로만 막대를 그린다.
 */
import { useEffect, useMemo, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";

import type { BookView } from "@/lib/library/view";

const SOURCE_KEYS = ["static", "llm", "topics", "mcp"] as const;

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-l border-amber-200/15 pl-3">
      <dt className="text-xs tracking-[0.15em] text-stone-500">{label}</dt>
      <dd className="text-sm text-amber-100/90">{value}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-[13px] tracking-[0.25em] text-amber-200/60">{title}</h4>
      {children}
    </section>
  );
}

export interface BookDetailProps {
  book: BookView;
  /** 함께 빛나는 책들 (id → 이름) */
  relatedBooks: BookView[];
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function BookDetail({
  book,
  relatedBooks,
  onClose,
  onSelect,
}: BookDetailProps) {
  const t = useTranslations("library");
  const locale = useLocale();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [locale],
  );
  const day = (iso: string | null) => (iso ? date.format(new Date(iso)) : "—");

  const peak = Math.max(1, ...book.quarters.map((bucket) => bucket.count));
  const hasConnections =
    book.tech.length + book.concepts.length + book.problems.length > 0;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-10 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={book.fullName}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className="w-full max-w-3xl space-y-6 rounded-lg border border-amber-200/20 bg-stone-950/95 p-6 shadow-[0_0_60px_rgba(0,0,0,0.8)]">
        {/* 표지 */}
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: book.spineColor }}
              />
              <h2 className="truncate text-xl text-amber-100">{book.name}</h2>
              {book.isPrivate ? (
                <span className="rounded-full border border-violet-300/30 px-2 py-0.5 text-xs text-violet-200/80">
                  {t("privateBadge")}
                </span>
              ) : null}
              {book.isFork ? (
                <span className="rounded-full border border-stone-500/30 px-2 py-0.5 text-xs text-stone-400">
                  {t("forkBadge")}
                </span>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-stone-400">
              {book.description ?? t("book.noDescription")}
            </p>
            {book.topics.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {book.topics.map((topic) => (
                  <li
                    key={topic}
                    className="rounded-full border border-amber-200/15 px-2 py-0.5 text-xs text-amber-200/70"
                  >
                    {topic}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-amber-200/20 px-3 py-1 text-xs text-amber-100/80 transition hover:border-amber-200/50 hover:text-amber-100"
          >
            {t("book.close")}
          </button>
        </header>

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Meta
            label={t("book.primaryLanguage")}
            value={book.primaryLanguage ?? t("unknownLanguage")}
          />
          <Meta label={t("book.stars")} value={String(book.stars)} />
          <Meta
            label={t("book.commits")}
            value={t("commitCount", {
              count: book.commitCount.toLocaleString(locale),
            })}
          />
          <Meta label={t("book.created")} value={day(book.createdAt)} />
        </dl>

        {/* 집필 연혁 */}
        <Section title={t("book.history")}>
          {book.quarters.length === 0 ? (
            <p className="text-xs text-stone-500">{t("book.historyEmpty")}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex h-24 items-end gap-[3px] overflow-x-auto border-b border-amber-900/40 pb-1">
                {book.quarters.map((bucket) => (
                  <div
                    key={bucket.key}
                    title={t("book.quarterCount", {
                      quarter: bucket.key,
                      count: bucket.count,
                    })}
                    className="flex w-3 shrink-0 flex-col justify-end"
                  >
                    <div
                      className="w-full rounded-t-[2px] bg-amber-300/45 transition hover:bg-amber-200/80"
                      style={{
                        height: `${Math.max(
                          bucket.count > 0 ? 6 : 2,
                          (bucket.count / peak) * 88,
                        )}px`,
                      }}
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-stone-500">
                {book.quarters[0]?.key} — {book.quarters.at(-1)?.key} ·{" "}
                {t("book.lastPushed", { date: day(book.lastCommitAt ?? book.pushedAt) })}
              </p>
            </div>
          )}

          {book.recentCommits.length > 0 ? (
            <ul className="max-h-52 space-y-1 overflow-y-auto pr-1">
              {book.recentCommits.map((commit, index) => (
                <li
                  key={`${commit.date}-${index}`}
                  className="flex gap-3 text-[13px] leading-relaxed"
                >
                  <span className="shrink-0 font-mono text-stone-600">
                    {commit.date}
                  </span>
                  <span className="truncate text-stone-300">{commit.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        {/* 지식그래프 연결 */}
        <Section title={t("book.connections")}>
          {!hasConnections ? (
            <p className="text-xs text-stone-500">{t("book.connectionsEmpty")}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {book.tech.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs tracking-[0.15em] text-stone-500">
                    {t("book.tech")}
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {book.tech.map((tech) => (
                      <li
                        key={tech.id}
                        className="flex items-center gap-1 rounded border border-emerald-300/20 px-2 py-0.5 text-[13px] text-emerald-100/85"
                      >
                        {tech.label}
                        {tech.source &&
                        (SOURCE_KEYS as readonly string[]).includes(tech.source) ? (
                          <span className="text-[9px] text-emerald-300/50">
                            {t(`book.source.${tech.source}`)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {book.concepts.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs tracking-[0.15em] text-stone-500">
                    {t("book.concepts")}
                  </p>
                  <ul className="space-y-1">
                    {book.concepts.map((concept) => (
                      <li key={concept.id} className="text-[13px] text-violet-100/85">
                        {concept.label}
                        {concept.detail ? (
                          <span className="text-stone-500"> — {concept.detail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {book.problems.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs tracking-[0.15em] text-stone-500">
                    {t("book.problems")}
                  </p>
                  <ul className="space-y-1">
                    {book.problems.map((problem) => (
                      <li key={problem.id} className="text-[13px] text-rose-100/80">
                        {problem.label}
                        {problem.detail ? (
                          <span className="text-stone-500"> — {problem.detail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {book.periods.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs tracking-[0.15em] text-stone-500">
                    {t("book.periods")}
                  </p>
                  <p className="text-[13px] text-amber-100/70">
                    {book.periods.join(" · ")}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </Section>

        {/* 함께 빛나는 책 */}
        {relatedBooks.length > 0 ? (
          <Section title={t("book.related")}>
            <ul className="flex flex-wrap gap-1.5">
              {relatedBooks.map((related) => (
                <li key={related.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(related.id)}
                    className="flex items-center gap-1.5 rounded border border-amber-200/20 px-2 py-1 text-[13px] text-amber-100/80 transition hover:border-amber-200/60 hover:text-amber-100"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{ backgroundColor: related.spineColor }}
                    />
                    {related.name}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <footer className="flex justify-end">
          <a
            href={book.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13px] text-stone-500 underline-offset-4 transition hover:text-amber-200/80 hover:underline"
          >
            {t("book.open")}
          </a>
        </footer>
      </article>
    </div>
  );
}

export default BookDetail;
