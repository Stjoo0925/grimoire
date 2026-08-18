/**
 * ② 지식그래프(Brain) — 온톨로지.
 *
 * KNOWLEDGE_GRAPH.md §2의 노드/엣지 스키마를 그대로 옮긴 것.
 * 노드: Project · Tech · Concept · Problem · Period
 * 엣지: USES · ABOUT · SOLVED · LEARNED · DEVELOPED · RELATED_TO · DEPENDS_ON
 *
 * 1차 저장은 JSON(`data/graph/{login}.json`), 2차에 Neo4j/Qdrant로 옮긴다(PLANNING.md §3).
 */

/** 그래프 JSON 스키마 버전 */
export const GRAPH_SCHEMA_VERSION = 1;

/** 어떤 추출기로 만든 그래프인가 — "none"은 정상 티어다(PLANNING.md §7) */
export type ExtractorName = "none" | "ollama" | "claude";

/** env로 고르는 추출기 모드. auto는 절대 claude를 고르지 않는다. */
export type ExtractorMode = ExtractorName | "auto";

/** Tech 노드 분류 */
export type TechCategory =
  | "frontend"
  | "backend"
  | "database"
  | "devops"
  | "testing"
  | "mobile"
  | "ai"
  | "language"
  | "tooling"
  | "other";

export type NodeKind = "project" | "tech" | "concept" | "problem" | "period";

/**
 * 파이프라인 밖에서 붙는 부가 정보.
 * `source: "mcp"`인 노드는 MCP `record_new_learning`으로 손수 적어 넣은 것이며,
 * 그래프를 다시 구울 때 보존된다(builder.ts `preserveManual`).
 */
export interface NodeMeta {
  source?: "mcp";
  /** 기록 당시 남긴 메모 */
  note?: string;
  /** 기록 시각 (ISO) */
  recordedAt?: string;
  [key: string]: unknown;
}

interface NodeBase {
  id: string;
  kind: NodeKind;
  /** 화면에 그대로 쓰는 표시명 */
  label: string;
  /** 근거 출처 (레포 fullName, 매니페스트 경로, "topic", 커밋 sha 등) */
  sources?: string[];
  /** 시맨틱 검색용 임베딩 (2차: Qdrant로 이관) */
  embedding?: number[];
  /** 파이프라인 외부(MCP 등)에서 붙인 메모 */
  meta?: NodeMeta;
}

/** 레포지토리 = 마법서 한 권 */
export interface ProjectNode extends NodeBase {
  kind: "project";
  name: string;
  fullName: string;
  isPrivate: boolean;
  primaryLang: string | null;
  stars: number;
  lastPushedAt: string;
}

/** 프레임워크/라이브러리/언어/도구 */
export interface TechNode extends NodeBase {
  kind: "tech";
  /** 정규화된 표준명 */
  name: string;
  category: TechCategory;
}

/** 도메인 개념/아키텍처/기능 */
export interface ConceptNode extends NodeBase {
  kind: "concept";
  name: string;
  /** auth, ai, realtime, state … (모르면 "general") */
  domain: string;
  summary?: string;
}

/** 해결한 문제/도전과제 */
export interface ProblemNode extends NodeBase {
  kind: "problem";
  title: string;
  description?: string;
  solutionSummary?: string;
}

/** 개발 시기 (연-분기) */
export interface PeriodNode extends NodeBase {
  kind: "period";
  /** e.g. 2024 */
  year: number;
  /** 1~4 */
  quarter: number;
}

export type GraphNode =
  | ProjectNode
  | TechNode
  | ConceptNode
  | ProblemNode
  | PeriodNode;

export type EdgeKind =
  /** Project → Tech */
  | "USES"
  /** Project → Concept */
  | "ABOUT"
  /** Project|Tech → Problem */
  | "SOLVED"
  /** Period → Tech (처음 습득·적용한 시점) */
  | "LEARNED"
  /** Period → Project */
  | "DEVELOPED"
  /** Concept ↔ Concept */
  | "RELATED_TO"
  /** Tech → Tech */
  | "DEPENDS_ON";

/** USES 엣지의 근거가 어디서 왔는지 ("mcp"는 MCP로 손수 기록한 것) */
export type UsesSource = "static" | "llm" | "topics" | "mcp";

interface EdgeBase {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  sources?: string[];
}

export interface UsesEdge extends EdgeBase {
  kind: "USES";
  /** 사용 강도 (의존성 등장 횟수 등을 0~1로 정규화) */
  weight?: number;
  source: UsesSource;
}

export interface AboutEdge extends EdgeBase {
  kind: "ABOUT";
  /** 0~1. 토픽 유래는 1에 가깝고 LLM 유래는 모델이 준 값 */
  confidence?: number;
}

export interface SolvedEdge extends EdgeBase {
  kind: "SOLVED";
}

export interface LearnedEdge extends EdgeBase {
  kind: "LEARNED";
  /** 그 기술이 처음 등장한 커밋 날짜 (ISO) */
  firstCommitDate: string;
}

export interface DevelopedEdge extends EdgeBase {
  kind: "DEVELOPED";
}

export interface RelatedToEdge extends EdgeBase {
  kind: "RELATED_TO";
  /** 0~1 공동 등장 기반 연결 강도 */
  strength?: number;
}

export interface DependsOnEdge extends EdgeBase {
  kind: "DEPENDS_ON";
}

export type GraphEdge =
  | UsesEdge
  | AboutEdge
  | SolvedEdge
  | LearnedEdge
  | DevelopedEdge
  | RelatedToEdge
  | DependsOnEdge;

/** AI 사서의 기억 — 한 사용자의 지식그래프 전체 */
export interface KnowledgeGraph {
  schemaVersion: number;
  login: string;
  builtAt: string;
  /** 실제로 사용된 추출기. "none"이면 정적 분석만으로 만든 그래프 */
  extractorUsed: ExtractorName;
  /**
   * 노드 임베딩을 만든 로컬 모델 (예: "nomic-embed-text").
   * null/undefined면 임베딩 없이 저장된 그래프 — 검색은 키워드만 쓴다 (PLANNING.md §6 5-a).
   */
  embeddingModel?: string | null;
  /** 일부 레포 추출이 실패했거나 스냅샷이 불완전한 경우 */
  partial?: boolean;
  partialReason?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function emptyGraph(login: string): KnowledgeGraph {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    login,
    builtAt: new Date(0).toISOString(),
    extractorUsed: "none",
    nodes: [],
    edges: [],
  };
}

/* ── 노드 ID 규칙 (Neo4j 이관 시에도 그대로 쓰는 canonical id) ─────────── */

export function projectId(fullName: string): string {
  return `project-${fullName.toLowerCase()}`;
}
export function techId(canonicalName: string): string {
  return `tech-${canonicalName}`;
}
export function conceptId(canonicalName: string): string {
  return `concept-${canonicalName}`;
}
export function problemId(repoFullName: string, slug: string): string {
  return `problem-${repoFullName.toLowerCase()}-${slug}`;
}
export function periodId(year: number, quarter: number): string {
  return `period-${year}-Q${quarter}`;
}
export function edgeId(kind: EdgeKind, from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}

/** 그래프 생성 서버 액션의 결과 (UI 상태용) */
export interface GraphBuildResult {
  ok: boolean;
  message: string | null;
}

/* ── 요약 (UI 명패용) ───────────────────────────────────────────────── */

export interface GraphSummary {
  nodes: Record<NodeKind, number>;
  edges: Record<EdgeKind, number>;
  nodeTotal: number;
  edgeTotal: number;
}

export function summarizeGraph(graph: KnowledgeGraph): GraphSummary {
  const nodes: Record<NodeKind, number> = {
    project: 0,
    tech: 0,
    concept: 0,
    problem: 0,
    period: 0,
  };
  const edges: Record<EdgeKind, number> = {
    USES: 0,
    ABOUT: 0,
    SOLVED: 0,
    LEARNED: 0,
    DEVELOPED: 0,
    RELATED_TO: 0,
    DEPENDS_ON: 0,
  };
  for (const node of graph.nodes) nodes[node.kind] += 1;
  for (const edge of graph.edges) edges[edge.kind] += 1;
  return {
    nodes,
    edges,
    nodeTotal: graph.nodes.length,
    edgeTotal: graph.edges.length,
  };
}
