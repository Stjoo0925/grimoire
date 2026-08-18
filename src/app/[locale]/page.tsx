/**
 * 랜딩 — Grimoire 입구.
 * 비로그인: GitHub OAuth 로그인 하나.
 * 로그인: 사서 정보 + 수집 트리거 + 소장된 스냅샷 요약.
 */
import Image from "next/image";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { signIn, auth } from "@/auth";
import { signOutAction } from "@/app/actions";
import { CollectForm } from "@/components/collector/CollectForm";
import { SnapshotSummary } from "@/components/collector/SnapshotSummary";
import { GraphForm } from "@/components/graph/GraphForm";
import { GraphSummary } from "@/components/graph/GraphSummary";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { LibraryView } from "@/components/library/LibraryView";
import { fetchViewer } from "@/lib/collector/github";
import { loadSnapshot } from "@/lib/collector/storage";
import type { CollectionSnapshot } from "@/lib/collector/types";
import { loadGraph } from "@/lib/graph/storage";
import { buildHeatmap } from "@/lib/library/heatmap";
import { buildLibrary } from "@/lib/library/view";

/**
 * topics/manifests 없이 수집된 구버전 스냅샷인가.
 * (그래프는 그대로 만들어지되 노드가 적어진다 — 재수집을 권한다)
 */
function isStaleSnapshot(snapshot: CollectionSnapshot): boolean {
  if ((snapshot.schemaVersion ?? 1) >= 2) return false;
  return !snapshot.repos.some((repo) => repo.topics || repo.manifests);
}

/** 잔디 격자의 기준일 — 서버 타임존과 무관하게 서울 기준 오늘(YYYY-MM-DD) */
function todayInSeoul(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(
    new Date(),
  );
}

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

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [session, tLanding, tHome] = await Promise.all([
    auth(),
    getTranslations("landing"),
    getTranslations("home"),
  ]);

  if (!session?.user) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 bg-stone-950 px-6 text-center">
        <div className="absolute top-6 right-6">
          <LanguageSwitcher />
        </div>

        <div className="space-y-3">
          <h1 className="text-5xl font-semibold tracking-[0.2em] text-amber-100">
            {tLanding("title")}
          </h1>
          <p className="text-sm text-stone-400">{tLanding("tagline")}</p>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: `/${locale}` });
          }}
        >
          <button
            type="submit"
            className="rounded-md border border-amber-200/30 bg-stone-900 px-6 py-3 text-sm text-amber-100 transition hover:border-amber-200/60 hover:bg-stone-800"
          >
            {tLanding("signIn")}
          </button>
        </form>

        <p className="max-w-md text-xs leading-relaxed text-stone-600">
          {tLanding("signInHint")}
        </p>
      </main>
    );
  }

  const login = await resolveLogin(session.login, session.accessToken);
  const snapshot = login ? await loadSnapshot(login) : null;
  const graph = login ? await loadGraph(login) : null;

  return (
    <main className="relative flex min-h-screen flex-col items-center gap-10 bg-stone-950 px-6 py-16">
      <div className="absolute top-6 right-6">
        <LanguageSwitcher />
      </div>

      <div className="space-y-3 text-center">
        <h1 className="text-4xl font-semibold tracking-[0.2em] text-amber-100">
          {tLanding("title")}
        </h1>
        <p className="text-sm text-stone-400">{tLanding("tagline")}</p>
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
          {login ?? session.user.name ?? tHome("librarian")}
        </span>
        <form action={signOutAction}>
          <button
            type="submit"
            className="text-xs text-stone-500 transition hover:text-amber-200/70"
          >
            {tHome("signOut")}
          </button>
        </form>
      </div>

      {/* ③ 인터랙티브 도서관 — 수집을 마쳤다면 서재가 곧 첫 화면이다 */}
      {snapshot ? (
        <LibraryView
          books={buildLibrary(snapshot, graph).books}
          heatmap={buildHeatmap(snapshot.contributions, todayInSeoul())}
          hasGraph={graph !== null}
        />
      ) : (
        <p className="max-w-md text-center text-xs leading-relaxed text-stone-600">
          {tHome("emptyLibrary")}
        </p>
      )}

      {/* 서고 관리 — 수집·그래프 트리거와 명패는 서재 아래에 그대로 둔다 */}
      <div className="flex w-full max-w-2xl flex-col items-center gap-10 border-t border-amber-200/10 pt-10">
        <CollectForm hasSnapshot={snapshot !== null} />

        {snapshot ? <SnapshotSummary snapshot={snapshot} /> : null}

        <GraphForm hasSnapshot={snapshot !== null} hasGraph={graph !== null} />

        {graph ? (
          <GraphSummary
            graph={graph}
            staleSnapshot={snapshot ? isStaleSnapshot(snapshot) : false}
          />
        ) : null}
      </div>
    </main>
  );
}
