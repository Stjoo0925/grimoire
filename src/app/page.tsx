/**
 * 랜딩 — Grimoire 입구.
 * GitHub OAuth 로그인 하나만 있는 최소 화면.
 */
import { signIn } from "@/auth";

export default function Home() {
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
        레포는 마법서 한 권, 커밋은 그 페이지가 됩니다. 로그인하면 당신의 서재를
        불러옵니다.
      </p>
    </main>
  );
}
