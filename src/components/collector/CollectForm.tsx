"use client";

/**
 * ① 수집기 — 수집 트리거 버튼.
 * 서버 액션 하나로 전체 수집을 돌리고, 진행 중에는 버튼만 잠근다(스트리밍 없음).
 */
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { collectAction } from "@/app/actions";
import type { CollectResult } from "@/lib/collector/types";

function SubmitButton({ hasSnapshot }: { hasSnapshot: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-amber-200/30 bg-stone-900 px-6 py-3 text-sm text-amber-100 transition hover:border-amber-200/60 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending
        ? "서고를 뒤지는 중…"
        : hasSnapshot
          ? "다시 수집하기"
          : "수집하기"}
    </button>
  );
}

export function CollectForm({ hasSnapshot }: { hasSnapshot: boolean }) {
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
        <p className="text-xs text-stone-600">
          수집은 한 번에 전부 — 레포·커밋·README·잔디를 훑습니다. 다소 걸립니다.
        </p>
      )}
    </form>
  );
}
