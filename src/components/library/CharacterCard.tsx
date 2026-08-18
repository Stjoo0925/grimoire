"use client";

/**
 * ③ 인터랙티브 도서관 — 캐릭터 상태창 (RPG 스타일).
 *
 * 게임 프로필(lib/library/game.ts)을 상태창으로 그린다:
 * 직업 문장(紋章) + 레벨 + EXP 바 + 수련 스트릭 + 주 언어 스탯.
 * 데이터 계산은 전부 서버에서 끝났고 여기는 표시만 한다.
 */
import { useTranslations } from "next-intl";
import type { GameProfile } from "../../lib/library/game";

/** 직업별 문장(이모지)과 상징색 — 라벨은 i18n(game.class.*) */
const CLASS_STYLE: Record<string, { sigil: string; color: string }> = {
  mage: { sigil: "🔮", color: "#8b5cf6" },
  knight: { sigil: "🛡️", color: "#f59e0b" },
  alchemist: { sigil: "⚗️", color: "#34d399" },
  runesmith: { sigil: "⚒️", color: "#f87171" },
  summoner: { sigil: "🕯️", color: "#38bdf8" },
  sage: { sigil: "📜", color: "#a8a29e" },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)}KB`;
  return `${bytes}B`;
}

export default function CharacterCard({
  profile,
  login,
}: {
  profile: GameProfile;
  login: string;
}) {
  const t = useTranslations("library.game");
  const style = CLASS_STYLE[profile.classId] ?? CLASS_STYLE.sage;
  const expPercent = Math.min(
    100,
    Math.round((profile.expIntoLevel / profile.expForNext) * 100),
  );
  const maxLanguageBytes = profile.topLanguages[0]?.bytes ?? 1;

  return (
    <section
      className="relative overflow-hidden rounded-lg border-2 p-4"
      style={{
        borderColor: `${style.color}66`,
        background:
          "linear-gradient(160deg, rgba(30,25,45,0.95), rgba(15,12,24,0.98))",
        boxShadow: `0 0 24px ${style.color}22 inset`,
      }}
      aria-label={t("cardLabel")}
    >
      {/* 상단: 문장 + 이름 + 직업 + 레벨 */}
      <div className="flex items-center gap-3">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border text-3xl"
          style={{ borderColor: `${style.color}88`, background: `${style.color}18` }}
          aria-hidden
        >
          {style.sigil}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm text-stone-400">@{login}</p>
          <p className="text-lg font-semibold" style={{ color: style.color }}>
            {t(`class.${profile.classId}`)}
          </p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-xs uppercase tracking-widest text-stone-500">
            {t("level")}
          </p>
          <p
            className="text-3xl font-bold tabular-nums"
            style={{ color: style.color }}
          >
            {profile.level}
          </p>
        </div>
      </div>

      {/* EXP 바 */}
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-xs text-stone-400">
          <span>EXP</span>
          <span className="tabular-nums">
            {profile.expIntoLevel.toLocaleString()} /{" "}
            {profile.expForNext.toLocaleString()}
          </span>
        </div>
        <div
          className="h-3 overflow-hidden rounded-sm border border-stone-700 bg-stone-900"
          role="progressbar"
          aria-valuenow={expPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="exp-bar-fill h-full"
            style={{
              width: `${expPercent}%`,
              background: `linear-gradient(90deg, ${style.color}aa, ${style.color})`,
            }}
          />
        </div>
      </div>

      {/* 스트릭 + 총 EXP */}
      <div className="mt-3 flex items-center gap-4 text-sm">
        <span className="text-stone-300">
          🔥 {t("streak", { current: profile.streak.current })}
          <span className="ml-1 text-xs text-stone-500">
            {t("streakBest", { longest: profile.streak.longest })}
          </span>
        </span>
        <span className="ml-auto text-xs text-stone-500 tabular-nums">
          {t("totalExp", { exp: profile.exp.toLocaleString() })}
        </span>
      </div>

      {/* 주 언어 스탯 바 */}
      {profile.topLanguages.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <p className="text-xs uppercase tracking-widest text-stone-500">
            {t("stats")}
          </p>
          {profile.topLanguages.map((language) => (
            <div key={language.name} className="flex items-center gap-2 text-xs">
              <span className="w-24 truncate text-stone-300">
                {language.name}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-800">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(4, Math.round((language.bytes / maxLanguageBytes) * 100))}%`,
                    background: `${style.color}99`,
                  }}
                />
              </div>
              <span className="w-12 text-right tabular-nums text-stone-500">
                {formatBytes(language.bytes)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
