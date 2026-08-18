/**
 * ② MCP 서버 — `record_new_learning`의 그래프 갱신 로직 (순수, SDK 비의존).
 *
 * 외부 AI와 대화하다 배운 것을 그 자리에서 그래프에 꽂는다(KNOWLEDGE_GRAPH.md §8.1-3).
 * 손으로 넣은 노드/엣지는 `meta.source = "mcp"` / `sources: ["mcp"]`로 표시해 두고,
 * 그래프를 다시 구울 때 builder가 그대로 보존한다(preserveManual).
 */
import {
  canonicalConcept,
  canonicalTech,
  conceptDomain,
  displayName,
  techCategory,
} from "../lib/graph/canonical";
import { toPeriod } from "../lib/graph/commits";
import {
  conceptId,
  edgeId,
  periodId,
  techId,
  type ConceptNode,
  type GraphEdge,
  type GraphNode,
  type KnowledgeGraph,
  type TechNode,
} from "../lib/graph/types";
import { resolveProject } from "./project";

/** MCP로 들어온 노드/엣지 표시 */
export const MANUAL_SOURCE = "mcp";

export interface RecordLearningInput {
  name: string;
  kind: "tech" | "concept";
  note?: string;
  relatedProject?: string;
}

export interface RecordLearningResult {
  /** 갱신된 그래프 (입력 그래프는 건드리지 않는다) */
  graph: KnowledgeGraph;
  nodeId: string;
  label: string;
  /** 이미 그래프에 있던 노드인가 */
  alreadyKnown: boolean;
  /** 이번에 추가된 엣지 id */
  addedEdges: string[];
  /** 연결된 프로젝트 fullName (해석 실패면 null) */
  linkedProject: string | null;
  period: string;
  messages: string[];
}

/**
 * 새 지식을 그래프에 적어 넣는다.
 *
 * - 이름은 canonical 정규화 → 이미 있으면 "already known"으로 알리고 메모만 갱신
 * - `relatedProject`가 풀리면 Project -[USES|ABOUT]-> 새 노드
 * - 현재 분기의 Period -[LEARNED]-> 새 노드 (없으면 Period 노드를 만든다)
 */
export function recordLearning(
  graph: KnowledgeGraph,
  input: RecordLearningInput,
  now: Date = new Date(),
): RecordLearningResult {
  const rawName = input.name.trim();
  if (!rawName) throw new Error("[mcp] name이 비어 있습니다.");

  const canonical =
    input.kind === "tech" ? canonicalTech(rawName) : canonicalConcept(rawName);
  if (!canonical) {
    throw new Error(`[mcp] 정규화할 수 없는 이름입니다: "${input.name}"`);
  }

  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const messages: string[] = [];
  const addedEdges: string[] = [];

  const id = input.kind === "tech" ? techId(canonical) : conceptId(canonical);
  const iso = now.toISOString();
  const note = input.note?.trim() || undefined;

  const existingIndex = nodes.findIndex((node) => node.id === id);
  const alreadyKnown = existingIndex >= 0;

  if (alreadyKnown) {
    const existing = nodes[existingIndex];
    const meta = { ...(existing.meta ?? {}) };
    if (note) {
      meta.note = meta.note && meta.note !== note ? `${meta.note}\n${note}` : note;
    }
    meta.recordedAt = iso;
    nodes[existingIndex] = { ...existing, meta } as GraphNode;
    messages.push(
      `already known — "${existing.label}"(${existing.id})는 이미 그래프에 있습니다.` +
        (note ? " 메모를 덧붙였습니다." : ""),
    );
  } else {
    const label = displayName(canonical, rawName);
    const base = {
      id,
      label,
      sources: [MANUAL_SOURCE],
      meta: { source: MANUAL_SOURCE, note, recordedAt: iso },
    };
    const node: GraphNode =
      input.kind === "tech"
        ? ({ ...base, kind: "tech", name: canonical, category: techCategory(canonical) } as TechNode)
        : ({
            ...base,
            kind: "concept",
            name: canonical,
            domain: conceptDomain(canonical),
            summary: note,
          } as ConceptNode);
    nodes.push(node);
    messages.push(`새 ${input.kind === "tech" ? "Tech" : "Concept"} 노드를 추가했습니다: ${label} (${id})`);
  }

  const label = nodes.find((node) => node.id === id)?.label ?? canonical;
  const hasEdge = (edgeIdValue: string) => edges.some((edge) => edge.id === edgeIdValue);
  const pushEdge = (edge: GraphEdge) => {
    if (hasEdge(edge.id)) return;
    edges.push(edge);
    addedEdges.push(edge.id);
  };

  /* ── 프로젝트 연결 (USES / ABOUT) ─────────────────────────────── */
  let linkedProject: string | null = null;
  if (input.relatedProject?.trim()) {
    const { match } = resolveProject(graph, input.relatedProject);
    if (!match) {
      messages.push(
        `프로젝트 "${input.relatedProject}"를 찾지 못해 연결은 건너뛰었습니다.`,
      );
    } else {
      linkedProject = match.project.fullName;
      const from = match.project.id;
      if (input.kind === "tech") {
        pushEdge({
          id: edgeId("USES", from, id),
          kind: "USES",
          from,
          to: id,
          weight: 0.5,
          source: MANUAL_SOURCE,
          sources: [MANUAL_SOURCE],
        });
      } else {
        pushEdge({
          id: edgeId("ABOUT", from, id),
          kind: "ABOUT",
          from,
          to: id,
          confidence: 0.9,
          sources: [MANUAL_SOURCE],
        });
      }
      messages.push(`${match.project.fullName}에 연결했습니다.`);
    }
  }

  /* ── 현재 분기 Period -[LEARNED]-> 노드 ───────────────────────── */
  const { year, quarter } = toPeriod(iso);
  const period = periodId(year, quarter);
  if (!nodes.some((node) => node.id === period)) {
    nodes.push({
      id: period,
      kind: "period",
      label: `${year} Q${quarter}`,
      year,
      quarter,
      sources: [MANUAL_SOURCE],
      meta: { source: MANUAL_SOURCE },
    });
  }
  pushEdge({
    id: edgeId("LEARNED", period, id),
    kind: "LEARNED",
    from: period,
    to: id,
    firstCommitDate: iso,
    sources: [MANUAL_SOURCE],
  });

  return {
    graph: { ...graph, nodes, edges },
    nodeId: id,
    label,
    alreadyKnown,
    addedEdges,
    linkedProject,
    period,
    messages,
  };
}
