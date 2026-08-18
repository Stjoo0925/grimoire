/**
 * ① 수집기 — 소장 목록 명패.
 * 로컬에 소장된 스냅샷을 어두운 마법 도서관 톤으로 요약해 보여준다.
 */
import { getLocale, getTranslations } from "next-intl/server";

import type { CollectionSnapshot } from "@/lib/collector/types";

function dateFormatter(locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function datetimeFormatter(locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function Entry({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-l border-amber-200/15 pl-4 text-left">
      <dt className="text-[11px] tracking-[0.2em] text-stone-500">{label}</dt>
      <dd className="text-lg text-amber-100">{value}</dd>
    </div>
  );
}

export async function SnapshotSummary({
  snapshot,
}: {
  snapshot: CollectionSnapshot;
}) {
  const { stats } = snapshot;
  const locale = await getLocale();
  const t = await getTranslations("snapshot");
  const date = dateFormatter(locale);
  const datetime = datetimeFormatter(locale);
  const day = (iso: string | null) =>
    iso ? date.format(new Date(iso)) : t("periodUnknown");

  return (
    <section className="w-full max-w-2xl space-y-5 rounded-lg border border-amber-200/15 bg-stone-900/40 p-6">
      <header className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm tracking-[0.3em] text-amber-100/80">
          {t("title")}
        </h2>
        <span className="text-[11px] text-stone-500">
          {t("lastCollected", {
            datetime: datetime.format(new Date(snapshot.collectedAt)),
          })}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
        <Entry
          label={t("repoCount")}
          value={t("repoCountUnit", { count: stats.repoCount })}
        />
        <Entry
          label={t("commitCount")}
          value={t("commitCountUnit", {
            count: stats.commitCount.toLocaleString(locale),
          })}
        />
        <Entry
          label={t("languageCount")}
          value={t("languageCountUnit", { count: stats.languageCount })}
        />
        <Entry
          label={t("contributionCount")}
          value={t("contributionCountUnit", {
            count: stats.contributionCount.toLocaleString(locale),
          })}
        />
        <Entry
          label={t("privateRepoCount")}
          value={t("privateRepoCountUnit", { count: stats.privateRepoCount })}
        />
        <Entry
          label={t("period")}
          value={t("periodRange", {
            from: day(stats.firstCommitAt),
            to: day(stats.lastCommitAt),
          })}
        />
      </dl>

      {snapshot.partial ? (
        <p className="rounded border border-rose-300/20 bg-rose-950/20 px-3 py-2 text-xs text-rose-200/80">
          {t("partial", {
            reason: snapshot.partialReason ?? t("partialReasonDefault"),
          })}
        </p>
      ) : null}
    </section>
  );
}
