/**
 * 랜딩 — Grimoire 입구.
 * 비로그인: GitHub OAuth 로그인 하나.
 * 로그인: 사서 정보 + 수집 트리거 + 소장된 스냅샷 요약.
 */
import Image from "next/image";

import { signIn, auth } from "@/auth";
import { signOutAction } from "@/app/actions";
import { CollectForm } from "@/components/collector/CollectForm";
import { SnapshotSummary } from "@/components/collector/SnapshotSummary";
import { fetchViewer } from "@/lib/collector/github";
import { loadSnapshot } from "@/lib/collector/storage";

/** 세션에 login이 없는(구버전 세션) 경우에만 GitHub에 한 번 물어본다. */
async function resolveLogin(
  login: string | undefined,
  accessToken: string | undefined,
): Promise<string | null> {
  if (login) return login;
  if (!accessToken) return null;
  try {
    return (await fetchViewer({ accessToken })).login;
  } catch {
    return null;
  }
}

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-stone-950 px-6 text-center">
        <div className="space-y-3">
          <h1 className="text-5xl font-semibold tracking-[0.2em] text-amber-100">
            GRIMOIRE
          </h1>
          <p className="text-sm text-stone-400">
            커밋이 쌓여 완성되는 나만의 마법서
          </p>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="rounded-md border border-amber-200/30 bg-stone-900 px-6 py-3 text-sm text-amber-100 transition hover:border-amber-200/60 hover:bg-stone-800"
          >
            GitHub로 로그인
          </button>
        </form>

        <p className="max-w-md text-xs leading-relaxed text-stone-600">
          레포는 마법서 한 권, 커밋은 그 페이지가 됩니다. 로그인하면 당신의
          서재를 불러옵니다.
        </p>
      </main>
    );
  }

  const login = await resolveLogin(session.login, session.accessToken);
  const snapshot = login ? await loadSnapshot(login) : null;

  return (
    <main className="flex min-h-screen flex-col items-center gap-10 bg-stone-950 px-6 py-16">
      <div className="space-y-3 text-center">
        <h1 className="text-4xl font-semibold tracking-[0.2em] text-amber-100">
          GRIMOIRE
        </h1>
        <p className="text-sm text-stone-400">
          커밋이 쌓여 완성되는 나만의 마법서
        </p>
      </div>

      <div className="flex items-center gap-4 rounded-full border border-amber-200/15 bg-stone-900/40 px-4 py-2">
        {session.user.image ? (
          <Image
            src={session.user.image}
            alt=""
            width={36}
            height={36}
            unoptimized
            className="rounded-full border border-amber-200/20"
          />
        ) : null}
        <span className="text-sm text-amber-100">
          {login ?? session.user.name ?? "사서"}
        </span>
        <form action={signOutAction}>
          <button
            type="submit"
            className="text-xs text-stone-500 transition hover:text-amber-200/70"
          >
            로그아웃
          </button>
        </form>
      </div>

      <CollectForm hasSnapshot={snapshot !== null} />

      {snapshot ? (
        <SnapshotSummary snapshot={snapshot} />
      ) : (
        <p className="max-w-md text-center text-xs leading-relaxed text-stone-600">
          아직 서고가 비어 있습니다. 수집하면 당신의 레포가 마법서로 꽂힙니다.
        </p>
      )}
    </main>
  );
}
