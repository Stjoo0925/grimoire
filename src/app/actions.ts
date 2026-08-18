"use server";

/**
 * 서버 액션 — 수집(collect) 트리거와 로그아웃.
 * 토큰은 서버 세션에서만 읽어 GitHub API 호출에 쓰고, 클라이언트로 넘기지 않는다.
 */
import { revalidatePath } from "next/cache";

import { auth, signOut } from "@/auth";
import { collectAll } from "@/lib/collector/github";
import { saveSnapshot } from "@/lib/collector/storage";
import type { CollectResult } from "@/lib/collector/types";

/** useActionState 시그니처 — 이전 상태와 폼 데이터는 쓰지 않는다. */
export async function collectAction(
  _prev: CollectResult | null,
  _formData: FormData,
): Promise<CollectResult> {
  void _prev;
  void _formData;

  const session = await auth();
  const token = session?.accessToken;
  if (!token) {
    return { ok: false, message: "세션이 만료되었습니다. 다시 로그인해 주세요." };
  }

  try {
    // login을 넘기지 않으면 collectAll이 GET /user로 직접 확인한다.
    const snapshot = await collectAll({
      accessToken: token,
      login: session.login,
    });
    await saveSnapshot(snapshot);
    revalidatePath("/");

    return {
      ok: true,
      message: snapshot.partial
        ? (snapshot.partialReason ??
          "일부만 수집되었습니다. 잠시 후 다시 시도해 주세요.")
        : `${snapshot.stats.repoCount}권의 마법서를 서고에 들였습니다.`,
    };
  } catch (error) {
    console.error("[collector] 수집 실패", error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? `수집에 실패했습니다: ${error.message}`
          : "수집에 실패했습니다.",
    };
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
