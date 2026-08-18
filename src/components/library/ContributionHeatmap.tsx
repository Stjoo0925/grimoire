"use client";

/**
 * ③ 인터랙티브 도서관 — 수련 일지(잔디).
 * 최근 1년치 기여를 CSS 격자로만 그린다 (차트 라이브러리 없음).
 */
import { useLocale, useTranslations } from "next-intl";

import type { Heatmap } from "@/lib/library/heatmap";

/** 강도 0~4 → 촛불 색 */
const LEVEL_CLASS = [
  "bg-stone-800/70",
  "bg-amber-900/60",
  "bg-amber-700/70",
  "bg-amber-500/70",
  "bg-amber-300/85",
] as const;

export function ContributionHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const t = useTranslations("library");
  const locale = useLocale();
  // 달 이름은 로케일 포맷터에 맡긴다 (6월 / Jun)
  const month = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
  });
  const monthLabel = new Map(
    heatmap.monthTicks.map((tick) => [
      tick.column,
      month.format(new Date(Date.UTC(tick.year, tick.month - 1, 1))),
    ]),
  );

  return (
    <section className="w-full space-y-2 rounded-lg border border-amber-200/15 bg-stone-900/40 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] tracking-[0.25em] text-amber-200/70">
          {t("heatmap.title")}
        </h3>
        <span className="text-[10px] text-stone-500">
          {t("heatmap.total", { count: heatmap.total.toLocaleString() })}
        </span>
      </header>

      <div className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1">
          <div className="flex gap-[3px]">
            {heatmap.weeks.map((_, column) => (
              <span
                key={`m-${column}`}
                className="w-[10px] overflow-visible text-[8px] leading-none whitespace-nowrap text-stone-600"
              >
                {monthLabel.get(column) ?? ""}
              </span>
            ))}
          </div>
          <div className="flex gap-[3px]">
            {heatmap.weeks.map((week, column) => (
              <div key={column} className="flex flex-col gap-[3px]">
                {week.map((cell) => (
                  <span
                    key={cell.date}
                    title={
                      cell.future
                        ? undefined
                        : t("heatmap.cell", { date: cell.date, count: cell.count })
                    }
                    className={`h-[10px] w-[10px] rounded-[2px] ${
                      cell.future ? "bg-transparent" : LEVEL_CLASS[cell.level]
                    }`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5 text-[9px] text-stone-600">
        <span>{t("heatmap.less")}</span>
        {LEVEL_CLASS.map((cls, index) => (
          <span key={index} className={`h-[10px] w-[10px] rounded-[2px] ${cls}`} />
        ))}
        <span>{t("heatmap.more")}</span>
      </div>
    </section>
  );
}

export default ContributionHeatmap;
