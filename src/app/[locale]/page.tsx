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
import { GameScene } from "@/components/library/GameScene";
import { ModelSettings } from "@/components/library/ModelSettings";
import { fetchViewer } from "@/lib/collector/github";
import { loadSnapshot } from "@/lib/collector/storage";
import type { CollectionSnapshot } from "@/lib/collector/types";
import { loadGraph } from "@/lib/graph/storage";
import { buildLibrary } from "@/lib/library/view";

/**
 * topics/manifests 없이 수집된 구버전 스냅샷인가.
 * (그래프는 그대로 만들어지되 노드가 적어진다 — 재수집을 권한다)
 */
function isStaleSnapshot(snapshot: CollectionSnapshot): boolean {
  if ((snapshot.schemaVersion ?? 1) >= 2) return false;
  return !snapshot.repos.some((repo) => repo.topics || repo.manifests);
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

  /** HUD 오른쪽 끝 — 유저 명패 + 언어 전환 + 로그아웃 */
  const hudTail = (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        {session.user.image ? (
          <Image
            src={session.user.image}
            alt=""
            width={22}
            height={22}
            unoptimized
            className="rounded-full border border-amber-200/20"
          />
        ) : null}
        <span className="text-[11px] text-amber-100/80">
          {login ?? session.user.name ?? tHome("librarian")}
        </span>
      </div>
      <LanguageSwitcher />
      <form action={signOutAction}>
        <button
          type="submit"
          className="text-[10px] text-stone-500 transition hover:text-amber-200/70"
        >
          {tHome("signOut")}
        </button>
      </form>
    </div>
  );

  /** 서고 관리 오버레이 내용물 — 수집·그래프 폼과 명패 */
  const managePanel = (
    <>
      <CollectForm hasSnapshot={snapshot !== null} />
      {snapshot ? <SnapshotSummary snapshot={snapshot} /> : null}
      <GraphForm hasSnapshot={snapshot !== null} hasGraph={graph !== null} />
      {graph ? (
        <GraphSummary
          graph={graph}
          staleSnapshot={snapshot ? isStaleSnapshot(snapshot) : false}
        />
      ) : null}
    </>
  );

  // 수집 전: 관리 패널만 가운데 보여주는 입구
  if (!snapshot) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 bg-stone-950 px-6">
        <div className="absolute top-6 right-6">{hudTail}</div>
        <h1 className="text-3xl font-semibold tracking-[0.2em] text-amber-100">
          {tLanding("title")}
        </h1>
        <p className="max-w-md text-center text-xs leading-relaxed text-stone-600">
          {tHome("emptyLibrary")}
        </p>
        <div className="flex w-full max-w-2xl flex-col items-center gap-8">
          {managePanel}
        </div>
      </main>
    );
  }

  // ③ 쯔꾸르 씬 — 책장 벽 + 사서 NPC가 화면 전부다
  return (
    <GameScene
      books={buildLibrary(snapshot, graph).books}
      hasGraph={graph !== null}
      managePanel={managePanel}
      settingsPanel={<ModelSettings />}
      hudTail={hudTail}
    />
  );
}
