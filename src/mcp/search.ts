/**
 * ② MCP 서버 — `query_grimoire_graph`의 검색 로직 (순수, SDK 비의존).
 *
 * 1차에는 임베딩이 없으므로(KNOWLEDGE_GRAPH.md §5의 Qdrant 단계는 5차) 키워드 검색으로 시드 노드를
 * 고르고, 거기서 1~2홉을 펼쳐 서브그래프를 돌려준다. 정규화는 canonical.ts를 재사용해
 * "React.js" 질의가 `tech-react`에 걸리게 한다.
 */
import { canonicalTech, normalizeName } from "../lib/graph/canonical";
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
} from "../lib/graph/types";
import {
  adjacency,
  degreeMap,
  nodeBrief,
  nodeDetail,
  nodeIndex,
  searchableText,
  type NodeBrief,
  type NodeDetail,
} from "./nodes";

/* ── 점수 상수 (exact > prefix > substring, 본문은 약하게) ─────────────── */
const SCORE_EXACT = 10;
const SCORE_PREFIX = 6;
const SCORE_SUBSTRING = 3;
const SCORE_BODY = 1.5;
/** 차수 가중치 상한 — 정확 일치(10)와 접두 일치(6)의 순서를 뒤집지 않을 만큼만 */
const DEGREE_BOOST_MAX = 2;
const DEGREE_BOOST_SATURATION = 50;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
/** seed 하나가 한 관계 종류에서 보여줄 이웃 수 */
const NEIGHBORS_PER_GROUP = 12;
/** 2홉을 펼칠 1홉 이웃 수 */
const SECOND_HOP_FROM = 20;
/** 2홉 경로 출력 상한 */
const SECOND_HOP_EDGES = 40;

export interface SearchToken {
  raw: string;
  /** 정규화 표기 ("React.js" → "react-js") */
  norm: string;
  /** canonical 기술명 ("react-js" → "react") */
  canon: string;
}

/**
 * 질의 토큰화. 공백/구두점으로 자르고, 여러 단어면 전체 구문도 토큰으로 더한다
 * ("knowledge graph" → "knowledge-graph" 노드에 정확 일치).
 */
export function tokenize(query: string): SearchToken[] {
  const pieces = query
    // "."은 자르지 않는다 — "React.js"는 한 토큰이어야 canonical 정규화가 먹는다.
    .split(/[\s,/|;:"'`()[\]{}<>!?]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);

  const raws = [...pieces];
  if (pieces.length > 1) raws.push(query.trim());

  const seen = new Set<string>();
  const tokens: SearchToken[] = [];
  for (const raw of raws) {
    const norm = normalizeName(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    tokens.push({ raw, norm, canon: canonicalTech(raw) });
  }
  return tokens;
}

/** 이름 하나에 대한 토큰 점수 */
function nameScore(name: string, token: SearchToken): number {
  const norm = normalizeName(name);
  if (!norm) return 0;
  const canon = canonicalTech(name);
  if (norm === token.norm || canon === token.canon || canon === token.norm) {
    return SCORE_EXACT;
  }
  if (norm.startsWith(token.norm) || token.norm.startsWith(norm)) {
    return SCORE_PREFIX;
  }
  if (norm.includes(token.norm)) return SCORE_SUBSTRING;
  return 0;
}

/**
 * 노드 점수. 토큰별 최고 점수를 합산하고 차수로 소폭 가산한다.
 * 0이면 검색 결과에 들지 않는다.
 */
export function scoreNode(
  node: GraphNode,
  tokens: SearchToken[],
  degree = 0,
): number {
  if (tokens.length === 0) return 0;
  const { names, bodies } = searchableText(node);
  const lowerBodies = bodies.map((body) => body.toLowerCase());

  let total = 0;
  let matched = false;
  for (const token of tokens) {
    let best = 0;
    for (const name of names) best = Math.max(best, nameScore(name, token));
    if (best === 0 && token.norm.length >= 2) {
      const needle = token.raw.trim().toLowerCase();
      if (lowerBodies.some((body) => body.includes(needle))) best = SCORE_BODY;
    }
    if (best > 0) {
      matched = true;
      total += best;
    }
  }
  if (!matched) return 0;

  const boost =
    (Math.min(degree, DEGREE_BOOST_SATURATION) / DEGREE_BOOST_SATURATION) *
    DEGREE_BOOST_MAX;
  return round(total + boost);
}

export interface Connection {
  kind: EdgeKind;
  /** seed 기준 방향 */
  direction: "out" | "in";
  nodes: NodeBrief[];
  /** 잘려나간 이웃 수 */
  more?: number;
}

export interface SeedResult {
  node: NodeDetail;
  score: number;
  degree: number;
  connections: Connection[];
}

export interface SearchResult {
  query: string;
  tokens: string[];
  hops: number;
  totalMatches: number;
  seeds: SeedResult[];
  /** 2홉에서 새로 닿은 경로 ("React -[USES]-> …" 형태의 3연) */
  secondHop?: Array<{ from: string; kind: EdgeKind; to: string }>;
  note?: string;
}

export interface SearchOptions {
  limit?: number;
  /** 1 또는 2 (기본 1) */
  hops?: number;
}

export function searchGraph(
  graph: KnowledgeGraph,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const tokens = tokenize(query);
  const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const hops = clamp(options.hops ?? 1, 1, 2);

  const degrees = degreeMap(graph);
  const index = nodeIndex(graph);
  const edgesByNode = adjacency(graph);

  const scored: Array<{ node: GraphNode; score: number }> = [];
  for (const node of graph.nodes) {
    const score = scoreNode(node, tokens, degrees.get(node.id) ?? 0);
    if (score > 0) scored.push({ node, score });
  }
  // 점수 내림차순, 동점이면 차수 → id 순으로 결정론적 정렬
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (degrees.get(b.node.id) ?? 0) - (degrees.get(a.node.id) ?? 0) ||
      a.node.id.localeCompare(b.node.id),
  );

  const seeds = scored.slice(0, limit);
  const visited = new Set(seeds.map((seed) => seed.node.id));

  const seedResults: SeedResult[] = seeds.map(({ node, score }) => {
    const edges = edgesByNode.get(node.id) ?? [];
    const groups = new Map<string, { kind: EdgeKind; direction: "out" | "in"; ids: string[] }>();
    for (const edge of edges) {
      const direction: "out" | "in" = edge.from === node.id ? "out" : "in";
      const otherId = direction === "out" ? edge.to : edge.from;
      if (otherId === node.id) continue;
      const key = `${edge.kind}:${direction}`;
      const group = groups.get(key);
      if (group) group.ids.push(otherId);
      else groups.set(key, { kind: edge.kind, direction, ids: [otherId] });
    }

    const connections: Connection[] = [];
    for (const group of groups.values()) {
      const unique = [...new Set(group.ids)].sort(
        (a, b) => (degrees.get(b) ?? 0) - (degrees.get(a) ?? 0) || a.localeCompare(b),
      );
      const shown = unique.slice(0, NEIGHBORS_PER_GROUP);
      for (const id of shown) visited.add(id);
      connections.push({
        kind: group.kind,
        direction: group.direction,
        nodes: shown
          .map((id) => index.get(id))
          .filter((n): n is GraphNode => Boolean(n))
          .map(nodeBrief),
        ...(unique.length > shown.length
          ? { more: unique.length - shown.length }
          : {}),
      });
    }
    connections.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.direction.localeCompare(b.direction),
    );

    return {
      node: nodeDetail(node),
      score,
      degree: degrees.get(node.id) ?? 0,
      connections,
    };
  });

  const result: SearchResult = {
    query,
    tokens: tokens.map((token) => token.norm),
    hops,
    totalMatches: scored.length,
    seeds: seedResults,
  };

  if (hops >= 2 && seedResults.length > 0) {
    result.secondHop = expandSecondHop(
      seeds.map((seed) => seed.node.id),
      visited,
      edgesByNode,
      index,
      degrees,
    );
  }

  if (seedResults.length === 0) {
    result.note =
      "일치하는 노드가 없습니다. 기술명·프로젝트명·개념(예: react, realtime)으로 다시 물어보세요.";
  }

  return result;
}

/** 1홉 이웃에서 한 걸음 더 — 아직 보지 못한 노드로 가는 경로만 라벨 3연으로 */
function expandSecondHop(
  seedIds: string[],
  visited: Set<string>,
  edgesByNode: Map<string, GraphEdge[]>,
  index: Map<string, GraphNode>,
  degrees: Map<string, number>,
): Array<{ from: string; kind: EdgeKind; to: string }> {
  const seeds = new Set(seedIds);
  const frontier = [...visited]
    .filter((id) => !seeds.has(id))
    .sort((a, b) => (degrees.get(b) ?? 0) - (degrees.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, SECOND_HOP_FROM);

  const seen = new Set(visited);
  const paths: Array<{ from: string; kind: EdgeKind; to: string }> = [];
  for (const id of frontier) {
    for (const edge of edgesByNode.get(id) ?? []) {
      const otherId = edge.from === id ? edge.to : edge.from;
      if (seen.has(otherId)) continue;
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (!from || !to) continue;
      seen.add(otherId);
      paths.push({ from: from.label, kind: edge.kind, to: to.label });
      if (paths.length >= SECOND_HOP_EDGES) return paths;
    }
  }
  return paths;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
