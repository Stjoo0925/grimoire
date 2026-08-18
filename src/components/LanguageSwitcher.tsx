"use client";

/** 언어 전환 — URL 로케일 프리픽스(/ko, /en)를 유지한 채 현재 경로로 이동. */
import { useLocale, useTranslations } from "next-intl";

import { routing } from "@/i18n/routing";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LanguageSwitcher() {
  const t = useTranslations("language");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="flex items-center gap-1 text-[11px] text-stone-500">
      {routing.locales.map((loc, i) => (
        <span key={loc} className="flex items-center gap-1">
          {i > 0 ? <span className="text-stone-700">/</span> : null}
          <button
            type="button"
            onClick={() => router.replace(pathname, { locale: loc })}
            aria-current={loc === locale}
            className={`transition hover:text-amber-200/70 ${
              loc === locale ? "text-amber-100" : ""
            }`}
          >
            {t(loc)}
          </button>
        </span>
      ))}
    </div>
  );
}

export default LanguageSwitcher;
