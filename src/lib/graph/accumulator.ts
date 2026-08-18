/**
 * ② 지식그래프 — 노드/엣지 누산기.
 *
 * 정적 분석 결과와 LLM 추출 결과가 같은 그릇에 쌓인다.
 * 같은 canonical id가 다시 들어오면 병합한다(출처 합집합 + 비어 있던 속성 채우기).
 */
import {
  GRAPH_SCHEMA_VERSION,
  type ExtractorName,
  type GraphEdge,
  type GraphNode,
  type KnowledgeGraph,
} from "./types";

export class GraphAccumulator {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  get(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  /** 노드 추가 또는 병합 */
  addNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (!existing) {
      this.nodes.set(node.id, { ...node, sources: [...(node.sources ?? [])] });
      return this.nodes.get(node.id) as GraphNode;
    }
    // 같은 id인데 종류가 다르면 먼저 들어온 쪽을 신뢰한다(정적 분석 우선).
    if (existing.kind !== node.kind) return existing;

    const merged = existing as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(node)) {
      if (key === "sources" || key === "id" || key === "kind") continue;
      if (merged[key] === undefined || merged[key] === null) merged[key] = value;
    }
    merged.sources = unique([
      ...(existing.sources ?? []),
      ...(node.sources ?? []),
    ]);
    return existing;
  }

  /** 엣지 추가 또는 병합. 양 끝 노드가 없으면 무시한다. */
  addEdge(edge: GraphEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    const existing = this.edges.get(edge.id);
    if (!existing) {
      this.edges.set(edge.id, { ...edge, sources: [...(edge.sources ?? [])] });
      return;
    }
    const merged = existing as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(edge)) {
      if (key === "sources" || key === "id" || key === "kind") continue;
      if (merged[key] === undefined || merged[key] === null) merged[key] = value;
    }
    // 강도류 속성은 큰 값을 남긴다.
    for (const key of ["weight", "strength", "confidence"]) {
      const next = (edge as unknown as Record<string, unknown>)[key];
      const prev = merged[key];
      if (typeof next === "number" && typeof prev === "number") {
        merged[key] = Math.max(prev, next);
      }
    }
    merged.sources = unique([
      ...(existing.sources ?? []),
      ...(edge.sources ?? []),
    ]);
  }

  build(meta: {
    login: string;
    extractorUsed: ExtractorName;
    partial?: boolean;
    partialReason?: string;
  }): KnowledgeGraph {
    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      login: meta.login,
      builtAt: new Date().toISOString(),
      extractorUsed: meta.extractorUsed,
      partial: meta.partial,
      partialReason: meta.partial ? meta.partialReason : undefined,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
