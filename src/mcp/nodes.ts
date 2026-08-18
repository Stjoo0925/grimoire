/**
 * ② MCP 서버 — 노드 표현 헬퍼 (순수 로직).
 *
 * 그래프 노드를 MCP 응답에 실을 만큼만 납작하게 만든다.
 * Problem은 solutionSummary가 있으면 요약에도 항상 포함한다 (도구 설계 요구).
 */
import type {
  ConceptNode,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  PeriodNode,
  ProblemNode,
  ProjectNode,
  TechNode,
} from "../lib/graph/types";

/** 응답에 실리는 최소 표현 */
export interface NodeBrief {
  id: string;
  kind: GraphNode["kind"];
  label: string;
  /** Tech 분류 / Concept 도메인 */
  category?: string;
  /** Problem 해결 요약 (있으면 항상 싣는다) */
  solutionSummary?: string;
  /** MCP로 직접 기록한 노드 표시 */
  manual?: true;
}

/** seed 노드에 붙이는 상세 표현 */
export interface NodeDetail extends NodeBrief {
  summary?: string;
  description?: string;
  fullName?: string;
  isPrivate?: boolean;
  primaryLang?: string | null;
  stars?: number;
  lastPushedAt?: string;
  /** 스냅샷에서 온 레포 생성일 (그래프에는 없다) */
  createdAt?: string;
  year?: number;
  quarter?: number;
  note?: string;
  sources?: string[];
}

export function nodeBrief(node: GraphNode): NodeBrief {
  const brief: NodeBrief = { id: node.id, kind: node.kind, label: node.label };
  if (node.kind === "tech") brief.category = (node as TechNode).category;
  if (node.kind === "concept") brief.category = (node as ConceptNode).domain;
  if (node.kind === "problem") {
    const solution = (node as ProblemNode).solutionSummary;
    if (solution) brief.solutionSummary = solution;
  }
  if (node.meta?.source === "mcp") brief.manual = true;
  return brief;
}

export function nodeDetail(node: GraphNode): NodeDetail {
  const detail: NodeDetail = nodeBrief(node);
  switch (node.kind) {
    case "project": {
      const project = node as ProjectNode;
      detail.fullName = project.fullName;
      detail.isPrivate = project.isPrivate;
      detail.primaryLang = project.primaryLang;
      detail.stars = project.stars;
      detail.lastPushedAt = project.lastPushedAt;
      break;
    }
    case "concept": {
      const concept = node as ConceptNode;
      if (concept.summary) detail.summary = concept.summary;
      break;
    }
    case "problem": {
      const problem = node as ProblemNode;
      if (problem.description) detail.description = problem.description;
      break;
    }
    case "period": {
      const period = node as PeriodNode;
      detail.year = period.year;
      detail.quarter = period.quarter;
      break;
    }
    default:
      break;
  }
  if (typeof node.meta?.note === "string") detail.note = node.meta.note;
  if (node.sources && node.sources.length > 0) {
    detail.sources = node.sources.slice(0, 5);
  }
  return detail;
}

/** 검색 대상이 되는 텍스트 조각들 (라벨·이름·요약·별칭) */
export function searchableText(node: GraphNode): {
  names: string[];
  bodies: string[];
} {
  const names: string[] = [node.label];
  const bodies: string[] = [];
  switch (node.kind) {
    case "project": {
      const project = node as ProjectNode;
      names.push(project.name, project.fullName);
      break;
    }
    case "tech":
      names.push((node as TechNode).name);
      break;
    case "concept": {
      const concept = node as ConceptNode;
      names.push(concept.name);
      if (concept.summary) bodies.push(concept.summary);
      bodies.push(concept.domain);
      break;
    }
    case "problem": {
      const problem = node as ProblemNode;
      names.push(problem.title);
      if (problem.description) bodies.push(problem.description);
      if (problem.solutionSummary) bodies.push(problem.solutionSummary);
      break;
    }
    case "period": {
      const period = node as PeriodNode;
      names.push(`${period.year}`, `${period.year}-q${period.quarter}`);
      break;
    }
  }
  if (typeof node.meta?.note === "string") bodies.push(node.meta.note);
  return { names: names.filter(Boolean), bodies: bodies.filter(Boolean) };
}

/** 노드 id → 연결 차수 (검색 점수 가중치) */
export function degreeMap(graph: KnowledgeGraph): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  return degrees;
}

/** 노드 id → 노드 */
export function nodeIndex(graph: KnowledgeGraph): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

/** 노드 id → 그 노드에 닿는 엣지들 */
export function adjacency(graph: KnowledgeGraph): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  const push = (id: string, edge: GraphEdge) => {
    const list = map.get(id);
    if (list) list.push(edge);
    else map.set(id, [edge]);
  };
  for (const edge of graph.edges) {
    push(edge.from, edge);
    if (edge.to !== edge.from) push(edge.to, edge);
  }
  return map;
}
