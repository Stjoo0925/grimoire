"use client";

/**
 * ② 지식그래프 — 그래프 생성 트리거.
 * 소장된 스냅샷만 읽어 서버에서 그래프를 굽는다 (GitHub 재호출 없음).
 */
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { buildGraphAction } from "@/app/actions";
import type { GraphBuildResult } from "@/lib/graph/types";

function SubmitButton({
  hasSnapshot,
  hasGraph,
}: {
  hasSnapshot: boolean;
  hasGraph: boolean;
}) {
  const t = useTranslations("graph");
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || !hasSnapshot}
      className="rounded-md border border-violet-200/25 bg-stone-900 px-6 py-3 text-sm text-violet-100 transition hover:border-violet-200/60 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {pending ? t("pending") : hasGraph ? t("rebuild") : t("build")}
    </button>
  );
}

export function GraphForm({
  hasSnapshot,
  hasGraph,
}: {
  hasSnapshot: boolean;
  hasGraph: boolean;
}) {
  const t = useTranslations("graph");
  const [state, formAction] = useActionState<GraphBuildResult | null, FormData>(
    buildGraphAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col items-center gap-3">
      <SubmitButton hasSnapshot={hasSnapshot} hasGraph={hasGraph} />
      {state?.message ? (
        <p
          className={`max-w-md text-center text-xs leading-relaxed ${
            state.ok ? "text-violet-200/70" : "text-rose-300/80"
          }`}
        >
          {state.message}
        </p>
      ) : (
        <p className="max-w-md text-center text-xs leading-relaxed text-stone-600">
          {hasSnapshot ? t("hint") : t("needSnapshot")}
        </p>
      )}
    </form>
  );
}
