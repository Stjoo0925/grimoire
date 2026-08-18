/**
 * ② 지식그래프(Brain) — 빌더 스텁.
 *
 * 수집 스냅샷 → Claude 추출 → 노드/엣지 → JSON 그래프 + 임베딩.
 * 규모가 커지면 그래프 DB 도입을 검토한다.
 *
 * 현재는 스캐폴드 단계 — 추출 로직 미구현.
 */
import type { CollectionSnapshot, Repo } from "@/lib/collector/types";
import { EMPTY_GRAPH, type GraphEdge, type GraphNode, type KnowledgeGraph } from "./types";

/** 레포 하나에서 뽑아낸 조각 (커밋 메시지 + README 기반) */
export interface ExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 레포 한 권을 Claude에 넘겨 개념/기술 태그와 관계를 추출한다 */
export async function extractFromRepo(
  _repo: Repo,
  _snapshot: CollectionSnapshot,
): Promise<ExtractionResult> {
  void _repo;
  void _snapshot;
  throw new Error("[graph] extractFromRepo not implemented");
}

/** 스냅샷 전체를 하나의 지식그래프로 합성한다 */
export async function buildGraph(
  _snapshot: CollectionSnapshot,
): Promise<KnowledgeGraph> {
  void _snapshot;
  throw new Error("[graph] buildGraph not implemented");
}

/** 저장된 그래프를 읽어온다. 아직 없으면 빈 그래프. */
export async function loadGraph(): Promise<KnowledgeGraph> {
  return EMPTY_GRAPH;
}

/** 특정 노드와 이어진 이웃 노드 id 목록 (책 하이라이트용) */
export function neighborsOf(graph: KnowledgeGraph, nodeId: string): string[] {
  return graph.edges
    .filter((e) => e.from === nodeId || e.to === nodeId)
    .map((e) => (e.from === nodeId ? e.to : e.from));
}
