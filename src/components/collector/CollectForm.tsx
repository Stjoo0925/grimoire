"use client";

/**
 * ① 수집기 — 수집 트리거 버튼.
 * 서버 액션 하나로 전체 수집을 돌리고, 진행 중에는 버튼만 잠근다(스트리밍 없음).
 */
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";

import { collectAction } from "@/app/actions";
import type { CollectResult } from "@/lib/collector/types";

function SubmitButton({ hasSnapshot }: { hasSnapshot: boolean }) {
  const t = useTranslations("collect");
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-amber-200/30 bg-stone-900 px-6 py-3 text-sm text-amber-100 transition hover:border-amber-200/60 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? t("pending") : hasSnapshot ? t("recollect") : t("collect")}
    </button>
  );
}

export function CollectForm({ hasSnapshot }: { hasSnapshot: boolean }) {
  const t = useTranslations("collect");
  const [state, formAction] = useActionState<CollectResult | null, FormData>(
    collectAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-center gap-3">
      <SubmitButton hasSnapshot={hasSnapshot} />
      {state?.message ? (
        <p
          className={`max-w-md text-xs leading-relaxed ${
            state.ok ? "text-amber-200/70" : "text-rose-300/80"
          }`}
        >
          {state.message}
        </p>
      ) : (
        <p className="text-xs text-stone-600">{t("hint")}</p>
      )}
    </form>
  );
}
