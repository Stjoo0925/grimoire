/**
 * ① 수집기 — 소장 목록 명패.
 * 로컬에 소장된 스냅샷을 어두운 마법 도서관 톤으로 요약해 보여준다.
 */
import type { CollectionSnapshot } from "@/lib/collector/types";

const DATE = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "long",
  day: "numeric",
});

const DATETIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "medium",
  timeStyle: "short",
});

function day(iso: string | null): string {
  return iso ? DATE.format(new Date(iso)) : "—";
}

function Entry({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-l border-amber-200/15 pl-4 text-left">
      <dt className="text-[11px] tracking-[0.2em] text-stone-500">{label}</dt>
      <dd className="text-lg text-amber-100">{value}</dd>
    </div>
  );
}

export function SnapshotSummary({ snapshot }: { snapshot: CollectionSnapshot }) {
  const { stats } = snapshot;

  return (
    <section className="w-full max-w-2xl space-y-5 rounded-lg border border-amber-200/15 bg-stone-900/40 p-6">
      <header className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm tracking-[0.3em] text-amber-100/80">서고 목록</h2>
        <span className="text-[11px] text-stone-500">
          마지막 수집 — {DATETIME.format(new Date(snapshot.collectedAt))}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
        <Entry label="책(레포)" value={`${stats.repoCount}권`} />
        <Entry label="총 커밋" value={`${stats.commitCount.toLocaleString("ko-KR")}쪽`} />
        <Entry label="서가(언어)" value={`${stats.languageCount}종`} />
        <Entry
          label="잔디 총 기여"
          value={`${stats.contributionCount.toLocaleString("ko-KR")}회`}
        />
        <Entry label="비공개 서고" value={`${stats.privateRepoCount}권`} />
        <Entry
          label="수집 기간"
          value={`${day(stats.firstCommitAt)} ~ ${day(stats.lastCommitAt)}`}
        />
      </dl>

      {snapshot.partial ? (
        <p className="rounded border border-rose-300/20 bg-rose-950/20 px-3 py-2 text-xs text-rose-200/80">
          불완전한 수집입니다 —{" "}
          {snapshot.partialReason ?? "GitHub API 한도로 중간에 멈췄습니다."}
        </p>
      ) : null}
    </section>
  );
}
