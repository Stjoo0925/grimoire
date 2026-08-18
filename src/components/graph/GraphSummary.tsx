/**
 * ② 지식그래프 — 기억의 명패.
 * 노드/엣지 종류별 개수와 어떤 추출기로 구웠는지를 어두운 서재 톤으로 보여준다.
 */
import { getLocale, getTranslations } from "next-intl/server";

import { summarizeGraph, type KnowledgeGraph } from "@/lib/graph/types";

const EXTRACTOR_TONE: Record<string, string> = {
  none: "border-stone-500/30 text-stone-300",
  ollama: "border-emerald-300/30 text-emerald-200",
  claude: "border-amber-300/40 text-amber-200",
};

function Entry({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-l border-violet-200/15 pl-4 text-left">
      <dt className="text-[11px] tracking-[0.2em] text-stone-500">{label}</dt>
      <dd className="text-lg text-violet-100">{value}</dd>
    </div>
  );
}

export async function GraphSummary({
  graph,
  /** 스냅샷에 topics/manifests가 없는 구버전인가 */
  staleSnapshot,
}: {
  graph: KnowledgeGraph;
  staleSnapshot: boolean;
}) {
  const [t, locale] = await Promise.all([getTranslations("graph"), getLocale()]);
  const summary = summarizeGraph(graph);
  const datetime = new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(graph.builtAt));

  return (
    <section className="w-full max-w-2xl space-y-5 rounded-lg border border-violet-200/15 bg-stone-900/40 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm tracking-[0.3em] text-violet-100/80">
          {t("title")}
        </h2>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] tracking-[0.15em] ${
              EXTRACTOR_TONE[graph.extractorUsed] ?? EXTRACTOR_TONE.none
            }`}
          >
            {t(`extractor.${graph.extractorUsed}`)}
          </span>
          <span className="text-[11px] text-stone-500">
            {t("builtAt", { datetime })}
          </span>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
        <Entry
          label={t("projects")}
          value={t("projectsUnit", { count: summary.nodes.project })}
        />
        <Entry
          label={t("tech")}
          value={t("techUnit", { count: summary.nodes.tech })}
        />
        <Entry
          label={t("concepts")}
          value={t("conceptsUnit", { count: summary.nodes.concept })}
        />
        <Entry
          label={t("problems")}
          value={t("problemsUnit", { count: summary.nodes.problem })}
        />
        <Entry
          label={t("periods")}
          value={t("periodsUnit", { count: summary.nodes.period })}
        />
        <Entry
          label={t("edges")}
          value={t("edgesUnit", { count: summary.edgeTotal })}
        />
      </dl>

      <p className="text-[11px] leading-relaxed text-stone-500">
        {t("edgeBreakdown", {
          uses: summary.edges.USES,
          about: summary.edges.ABOUT,
          learned: summary.edges.LEARNED,
          developed: summary.edges.DEVELOPED,
          related: summary.edges.RELATED_TO,
          solved: summary.edges.SOLVED,
          dependsOn: summary.edges.DEPENDS_ON,
        })}
      </p>

      {graph.extractorUsed === "none" ? (
        <p className="rounded border border-emerald-300/15 bg-emerald-950/20 px-3 py-2 text-xs leading-relaxed text-emerald-200/70">
          {t("noneHint")}
        </p>
      ) : null}

      {staleSnapshot ? (
        <p className="rounded border border-amber-200/15 bg-amber-950/10 px-3 py-2 text-xs leading-relaxed text-amber-200/70">
          {t("staleSnapshotHint")}
        </p>
      ) : null}

      {graph.partial ? (
        <p className="rounded border border-rose-300/20 bg-rose-950/20 px-3 py-2 text-xs text-rose-200/80">
          {t("partial", { reason: graph.partialReason ?? t("partialDefault") })}
        </p>
      ) : null}
    </section>
  );
}
