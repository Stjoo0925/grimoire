/**
 * ② 지식그래프(Brain) — 노드/엣지 타입.
 *
 * 커밋 메시지와 README를 Claude가 읽고 추출한 결과.
 * 이 그래프가 "AI 사서의 기억"이며 질의응답의 근거가 된다.
 */

/** 노드 종류: 프로젝트(책) · 기술 · 개념(도메인) · 시기 */
export type GraphNodeKind = "project" | "tech" | "concept" | "period";

/** 엣지 종류 */
export type GraphEdgeKind =
  /** 프로젝트 → 기술: 이 기술을 사용함 */
  | "uses"
  /** 프로젝트 → 개념: 이 도메인을 다룸 */
  | "about"
  /** 임의의 두 노드: 연관됨 */
  | "relatedTo"
  /** 시기 → 기술/개념: 최초 등장(= 배운) 시점 */
  | "learned";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** 근거 출처 (레포 full name, 커밋 sha 등) */
  sources?: string[];
  /** 시맨틱 검색용 임베딩 (MVP는 JSON에 그대로 보관) */
  embedding?: number[];
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  from: string;
  to: string;
  /** 0~1 신뢰도 */
  weight?: number;
  sources?: string[];
}

export interface KnowledgeGraph {
  version: 1;
  builtAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const EMPTY_GRAPH: KnowledgeGraph = {
  version: 1,
  builtAt: "1970-01-01T00:00:00.000Z",
  nodes: [],
  edges: [],
};
