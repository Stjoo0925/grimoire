"use client";

/**
 * ③ 인터랙티브 도서관 — 업적 진열장.
 *
 * 게임 프로필의 업적을 메달 진열장으로 그린다. 단계(tier)에 따라
 * 동·은·금 테두리, 미달성은 어둡게. 호버하면 진행도와 다음 목표가 뜬다.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AchievementState } from "../../lib/library/game";

/** 업적별 문장(이모지) — 라벨·설명은 i18n(game.achievement.*) */
const BADGE_ICON: Record<string, string> = {
  streak: "🔥",
  pages: "📖",
  polyglot: "🗣️",
  collection: "📚",
  stars: "⭐",
  "night-owl": "🦉",
  marathon: "🏃",
  "secret-archive": "🗝️",
  comeback: "🌅",
};

/** tier → 메달 색 (0은 미달성) */
const TIER_COLOR = ["#3f3f46", "#b45309", "#94a3b8", "#facc15"];

export default function AchievementShelf({
  achievements,
}: {
  achievements: AchievementState[];
}) {
  const t = useTranslations("library.game");
  const [openId, setOpenId] = useState<string | null>(null);
  const earnedCount = achievements.filter((a) => a.earned).length;

  return (
    <section
      className="rounded-lg border-2 border-stone-800 bg-stone-950/80 p-4"
      aria-label={t("achievementsLabel")}
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-stone-400">
          {t("achievementsTitle")}
        </h3>
        <span className="text-xs tabular-nums text-stone-500">
          {earnedCount} / {achievements.length}
        </span>
      </div>

      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-9">
        {achievements.map((achievement) => {
          const color = TIER_COLOR[Math.min(achievement.tier, 3)];
          const isOpen = openId === achievement.id;
          return (
            <li key={achievement.id} className="relative">
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : achievement.id)}
                onMouseEnter={() => setOpenId(achievement.id)}
                onMouseLeave={() => setOpenId(null)}
                className={`flex aspect-square w-full flex-col items-center justify-center rounded-md border-2 transition-transform hover:scale-105 ${
                  achievement.earned ? "" : "opacity-40 grayscale"
                }`}
                style={{
                  borderColor: color,
                  background: achievement.earned
                    ? `${color}1a`
                    : "rgba(20,18,28,0.8)",
                  boxShadow: achievement.tier >= 3 ? `0 0 10px ${color}66` : undefined,
                }}
                aria-label={t(`achievement.${achievement.id}.name`)}
              >
                <span className="text-xl" aria-hidden>
                  {BADGE_ICON[achievement.id] ?? "🏅"}
                </span>
                {achievement.maxTier > 1 && (
                  <span className="mt-0.5 flex gap-0.5" aria-hidden>
                    {Array.from({ length: achievement.maxTier }, (_, i) => (
                      <span
                        key={i}
                        className="h-1 w-1 rounded-full"
                        style={{
                          background: i < achievement.tier ? color : "#3f3f46",
                        }}
                      />
                    ))}
                  </span>
                )}
              </button>

              {isOpen && (
                <div
                  role="tooltip"
                  className="absolute left-1/2 top-full z-20 mt-1 w-44 -translate-x-1/2 rounded-md border border-stone-700 bg-stone-900 p-2 text-xs shadow-xl"
                >
                  <p className="font-semibold text-stone-200">
                    {t(`achievement.${achievement.id}.name`)}
                  </p>
                  <p className="mt-0.5 text-stone-400">
                    {t(`achievement.${achievement.id}.desc`)}
                  </p>
                  <p className="mt-1 tabular-nums text-stone-500">
                    {achievement.nextTarget !== null
                      ? t("progress", {
                          value: achievement.value.toLocaleString(),
                          target: achievement.nextTarget.toLocaleString(),
                        })
                      : t("maxed", { value: achievement.value.toLocaleString() })}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
