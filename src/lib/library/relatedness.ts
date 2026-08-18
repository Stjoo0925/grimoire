/**
 * ③ 인터랙티브 도서관 — 발광 하이라이트의 근거 (순수 로직).
 *
 * "책을 뽑으면 지식그래프상 관련된 책들이 은은히 빛난다" (PLANNING.md §3 ③).
 * 무엇이 "관련"인가:
 *   - 같은 Tech를 쓴다 (USES 공유) — 흔한 기술일수록 약하게 센다
 *   - 같은 Concept을 다룬다 (ABOUT 공유) — 개념 공유가 기술 공유보다 귀하다
 *   - 각자의 Concept이 RELATED_TO로 이어져 있다 (횡적 연결망)
 *
 * 그래프만 읽는 순수 함수라 유닛 테스트가 쉽다.
 */
import { adjacency } from "../../mcp/nodes";
import type { KnowledgeGraph, RelatedToEdge } from "../graph/types";

/** 개념 공유 1건의 가중치 (기술 공유보다 귀하게 본다) */
const CONCEPT_WEIGHT = 3;
/** 기술 공유 1건의 기본 가중치 (희소도로 다시 나눈다) */
const TECH_WEIGHT = 2;
/** 서로 다른 개념이 RELATED_TO로 이어졌을 때의 가중치 */
const CONCEPT_LINK_WEIGHT = 1;
/** 하이라이트 상한 — 서가가 온통 빛나면 아무 의미가 없다 */
export const RELATED_LIMIT = 10;

export interface RelatedProject {
  id: string;
  score: number;
  sharedTech: number;
  sharedConcepts: number;
}

interface ProjectFacets {
  tech: Set<string>;
  concepts: Set<string>;
}

/**
 * 프로젝트별 Tech/Concept 집합.
 * (USES·ABOUT 엣지는 항상 Project → X 방향이다 — KNOWLEDGE_GRAPH.md §2.2)
 */
function facets(graph: KnowledgeGraph): Map<string, ProjectFacets> {
  const map = new Map<string, ProjectFacets>();
  for (const node of graph.nodes) {
    if (node.kind === "project") {
      map.set(node.id, { tech: new Set(), concepts: new Set() });
    }
  }
  for (const edge of graph.edges) {
    const facet = map.get(edge.from);
    if (!facet) continue;
    if (edge.kind === "USES") facet.tech.add(edge.to);
    else if (edge.kind === "ABOUT") facet.concepts.add(edge.to);
  }
  return map;
}

/** 개념 → RELATED_TO로 이어진 개념들 */
function conceptLinks(graph: KnowledgeGraph): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const set = links.get(a);
    if (set) set.add(b);
    else links.set(a, new Set([b]));
  };
  for (const edge of graph.edges) {
    if (edge.kind !== "RELATED_TO") continue;
    const related = edge as RelatedToEdge;
    add(related.from, related.to);
    add(related.to, related.from);
  }
  return links;
}

/**
 * 기술 희소도 가중치. 모든 책이 쓰는 TypeScript는 거의 정보가 없고,
 * 한두 권만 쓰는 기술이 강한 연결이다 — 1 / log2(1 + 사용 권수).
 */
function rarity(usage: number): number {
  if (usage <= 1) return 1;
  return 1 / Math.log2(1 + usage);
}

/**
 * 모든 프로젝트에 대해 "빛날 책" 목록을 한 번에 계산한다.
 * 반환: projectId → 점수 내림차순 RelatedProject[] (최대 `limit`권)
 */
export function relatedProjectMap(
  graph: KnowledgeGraph,
  limit = RELATED_LIMIT,
): Map<string, RelatedProject[]> {
  const projectFacets = facets(graph);
  const links = conceptLinks(graph);

  // 기술별 사용 권수 (희소도 계산용)
  const techUsage = new Map<string, number>();
  for (const facet of projectFacets.values()) {
    for (const tech of facet.tech) {
      techUsage.set(tech, (techUsage.get(tech) ?? 0) + 1);
    }
  }

  const ids = [...projectFacets.keys()].sort();
  const result = new Map<string, RelatedProject[]>();
  const scores = new Map<string, Map<string, RelatedProject>>();
  for (const id of ids) scores.set(id, new Map());

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const fa = projectFacets.get(a)!;
      const fb = projectFacets.get(b)!;

      let score = 0;
      let sharedTech = 0;
      for (const tech of fa.tech) {
        if (!fb.tech.has(tech)) continue;
        sharedTech += 1;
        score += TECH_WEIGHT * rarity(techUsage.get(tech) ?? 1);
      }

      let sharedConcepts = 0;
      for (const concept of fa.concepts) {
        if (!fb.concepts.has(concept)) continue;
        sharedConcepts += 1;
        score += CONCEPT_WEIGHT;
      }

      // 개념끼리 RELATED_TO로 이어진 경우 (같은 개념은 위에서 이미 셌다)
      let linked = 0;
      for (const concept of fa.concepts) {
        const neighbors = links.get(concept);
        if (!neighbors) continue;
        for (const other of fb.concepts) {
          if (other !== concept && neighbors.has(other)) linked += 1;
        }
      }
      score += Math.min(linked, 3) * CONCEPT_LINK_WEIGHT;

      if (score <= 0) continue;
      const rounded = Math.round(score * 1000) / 1000;
      scores.get(a)!.set(b, { id: b, score: rounded, sharedTech, sharedConcepts });
      scores.get(b)!.set(a, { id: a, score: rounded, sharedTech, sharedConcepts });
    }
  }

  for (const id of ids) {
    const list = [...scores.get(id)!.values()].sort(
      (x, y) => y.score - x.score || x.id.localeCompare(y.id),
    );
    result.set(id, list.slice(0, Math.max(0, limit)));
  }
  return result;
}

/** 한 권 기준 관련 책 (단발 조회용 — 내부적으로는 전체 계산과 같은 규칙) */
export function relatedProjects(
  graph: KnowledgeGraph,
  projectNodeId: string,
  limit = RELATED_LIMIT,
): RelatedProject[] {
  return relatedProjectMap(graph, limit).get(projectNodeId) ?? [];
}

/**
 * 사서가 언급한 노드들에서 빛낼 책 id를 모은다.
 * 프로젝트 노드는 그대로, 기술·개념 노드는 그것을 쓰는 프로젝트로 한 홉 펼친다.
 */
export function projectsForNodes(
  graph: KnowledgeGraph,
  nodeIds: string[],
  limit = RELATED_LIMIT,
): string[] {
  const projects = new Set(
    graph.nodes.filter((node) => node.kind === "project").map((node) => node.id),
  );
  const edgesByNode = adjacency(graph);
  const picked: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!projects.has(id) || seen.has(id)) return;
    seen.add(id);
    picked.push(id);
  };

  for (const id of nodeIds) push(id);
  for (const id of nodeIds) {
    if (projects.has(id)) continue;
    for (const edge of edgesByNode.get(id) ?? []) {
      push(edge.from === id ? edge.to : edge.from);
    }
  }
  return picked.slice(0, Math.max(0, limit));
}
