/**
 * ② MCP 서버 — `query_grimoire_graph`의 검색 로직 (SDK 비의존).
 *
 * 키워드 검색으로 시드 노드를 고르고 1~2홉을 펼쳐 서브그래프를 돌려준다.
 * 정규화는 canonical.ts를 재사용해 "React.js" 질의가 `tech-react`에 걸리게 한다.
 *
 * 5-a(PLANNING.md §6)부터는 **하이브리드**다 — 그래프 노드에 임베딩이 있고 질의도
 * 로컬 모델로 벡터화되면 키워드 순위와 코사인 순위를 RRF(k=60)로 섞는다.
 * 임베딩이 없거나 로컬 임베딩 모델에 닿지 못하면 예전과 완전히 같은 키워드 검색으로 내려간다
 * (KNOWLEDGE_GRAPH.md §5의 1단계를 JSON 안에서 하는 셈).
 */
import { canonicalTech, normalizeName } from "../lib/graph/canonical";
import {
  cosineSimilarity,
  embedTexts,
  resolveEmbedModel,
} from "../lib/graph/embeddings";
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

/** RRF 상수 — 정보검색 관례값. 클수록 상위 순위 차이를 완만하게 본다. */
export const RRF_K = 60;
/** 시맨틱 후보 풀 (limit의 몇 배까지 볼 것인가) */
const SEMANTIC_POOL_FACTOR = 4;
const SEMANTIC_POOL_MIN = 10;
const SEMANTIC_POOL_MAX = 50;
/** 이보다 안 닮은 노드는 후보로도 올리지 않는다 (엉뚱한 시드 방지) */
const SEMANTIC_MIN_SIMILARITY = 0.35;

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
  /** 키워드 점수 (시맨틱으로만 걸린 노드는 0) */
  score: number;
  degree: number;
  connections: Connection[];
  /** 질의 벡터와의 코사인 유사도 (하이브리드일 때만) */
  similarity?: number;
  /** 최종 정렬에 쓴 RRF 점수 (하이브리드일 때만) */
  fused?: number;
}

export interface SearchResult {
  query: string;
  tokens: string[];
  hops: number;
  totalMatches: number;
  seeds: SeedResult[];
  /** 2홉에서 새로 닿은 경로 ("React -[USES]-> …" 형태의 3연) */
  secondHop?: Array<{ from: string; kind: EdgeKind; to: string }>;
  /** 시맨틱 랭킹이 실제로 섞였는가 */
  hybrid?: boolean;
  /** 그때 쓴 임베딩 모델 */
  embeddingModel?: string;
  note?: string;
}

export interface SearchOptions {
  limit?: number;
  /** 1 또는 2 (기본 1) */
  hops?: number;
  /**
   * 시맨틱(임베딩) 랭킹 사용 여부. 기본 true.
   * 켜져 있어도 노드 임베딩이 없거나 질의 임베딩에 실패하면 조용히 키워드 검색이 된다.
   */
  semantic?: boolean;
  /** 질의 임베딩 주입 (테스트·다른 백엔드용). 기본은 로컬 Ollama */
  embedQuery?: (query: string) => Promise<number[] | null>;
}

export async function searchGraph(
  graph: KnowledgeGraph,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
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

  const semantic = await semanticRanking(graph, query, options, limit);
  const ranked = fuse(scored, semantic?.ranked ?? [], degrees, limit);

  const seeds = ranked.slice(0, limit);
  const visited = new Set(seeds.map((seed) => seed.node.id));

  const seedResults: SeedResult[] = seeds.map(({ node, score, similarity, fused }) => {
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
      ...(similarity !== undefined ? { similarity: round(similarity) } : {}),
      ...(fused !== undefined ? { fused: round5(fused) } : {}),
    };
  });

  const result: SearchResult = {
    query,
    tokens: tokens.map((token) => token.norm),
    hops,
    totalMatches: ranked.length,
    seeds: seedResults,
  };
  if (semantic) {
    result.hybrid = true;
    result.embeddingModel = semantic.model;
  }

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

/* ── 시맨틱 랭킹 + RRF 융합 ───────────────────────────────────────── */

interface SemanticHit {
  node: GraphNode;
  similarity: number;
}

interface SemanticRanking {
  model: string;
  ranked: SemanticHit[];
}

/**
 * 질의를 벡터로 만들어 임베딩이 있는 노드와의 코사인 유사도 순위를 낸다.
 *
 * 다음 중 하나라도 어긋나면 null — 호출부는 예전과 똑같은 키워드 검색을 한다:
 *   임베딩을 끈 경우 / 노드에 벡터가 없는 경우 / 로컬 임베딩 모델에 닿지 못한 경우.
 */
async function semanticRanking(
  graph: KnowledgeGraph,
  query: string,
  options: SearchOptions,
  limit: number,
): Promise<SemanticRanking | null> {
  if (options.semantic === false) return null;
  if (!query.trim()) return null;

  const embedded = graph.nodes.filter(
    (node) => Array.isArray(node.embedding) && node.embedding.length > 0,
  );
  if (embedded.length === 0) return null;

  const model = graph.embeddingModel || resolveEmbedModel();
  let vector: number[] | null = null;
  try {
    vector = options.embedQuery
      ? await options.embedQuery(query)
      : await defaultEmbedQuery(query, model);
  } catch {
    vector = null;
  }
  if (!vector || vector.length === 0) return null;

  const pool = clamp(
    limit * SEMANTIC_POOL_FACTOR,
    SEMANTIC_POOL_MIN,
    SEMANTIC_POOL_MAX,
  );
  const hits: SemanticHit[] = [];
  for (const node of embedded) {
    const similarity = cosineSimilarity(vector, node.embedding as number[]);
    if (similarity >= SEMANTIC_MIN_SIMILARITY) hits.push({ node, similarity });
  }
  hits.sort(
    (a, b) => b.similarity - a.similarity || a.node.id.localeCompare(b.node.id),
  );

  return { model, ranked: hits.slice(0, pool) };
}

/** 질의 임베딩 기본 구현 — 노드 벡터를 만든 것과 같은 로컬 모델을 쓴다. */
async function defaultEmbedQuery(
  query: string,
  model: string,
): Promise<number[] | null> {
  const result = await embedTexts([query], { model });
  return result.ok ? (result.vectors[0] ?? null) : null;
}

interface FusedCandidate {
  node: GraphNode;
  score: number;
  similarity?: number;
  fused?: number;
}

/**
 * RRF(Reciprocal Rank Fusion, k=60) — 점수 스케일이 다른 두 랭킹을 순위만으로 섞는다.
 *
 *   fused(node) = 1/(k + 키워드순위) + 1/(k + 코사인순위)     (없는 쪽은 0)
 *
 * 시맨틱 랭킹이 비어 있으면 키워드 순서를 그대로 돌려준다 — 예전 동작과 동일.
 */
function fuse(
  keyword: Array<{ node: GraphNode; score: number }>,
  semantic: SemanticHit[],
  degrees: Map<string, number>,
  limit: number,
): FusedCandidate[] {
  if (semantic.length === 0) return keyword;

  const candidates = new Map<string, FusedCandidate>();
  const bump = (node: GraphNode, rank: number, patch: Partial<FusedCandidate>) => {
    const existing = candidates.get(node.id) ?? { node, score: 0, fused: 0 };
    existing.fused = (existing.fused ?? 0) + 1 / (RRF_K + rank);
    candidates.set(node.id, { ...existing, ...patch, fused: existing.fused });
  };

  // 키워드 쪽은 후보 풀만큼만 융합에 참여시킨다 (꼬리 노드가 순위를 흔들지 않게).
  const keywordPool = clamp(
    limit * SEMANTIC_POOL_FACTOR,
    SEMANTIC_POOL_MIN,
    SEMANTIC_POOL_MAX,
  );
  keyword.slice(0, keywordPool).forEach(({ node, score }, index) => {
    bump(node, index + 1, { score });
  });
  semantic.forEach(({ node, similarity }, index) => {
    bump(node, index + 1, { similarity });
  });

  const fused = [...candidates.values()];
  fused.sort(
    (a, b) =>
      (b.fused ?? 0) - (a.fused ?? 0) ||
      b.score - a.score ||
      (degrees.get(b.node.id) ?? 0) - (degrees.get(a.node.id) ?? 0) ||
      a.node.id.localeCompare(b.node.id),
  );

  // 융합에서 잘린 키워드 꼬리는 뒤에 그대로 붙인다 (totalMatches 보존).
  const seen = new Set(fused.map((entry) => entry.node.id));
  for (const entry of keyword) {
    if (!seen.has(entry.node.id)) fused.push(entry);
  }
  return fused;
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

function round5(value: number): number {
  return Math.round(value * 100000) / 100000;
}
