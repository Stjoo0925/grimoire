/**
 * ② 지식그래프 — 로컬 임베딩 (PLANNING.md §6 5-a, KNOWLEDGE_GRAPH.md §5).
 *
 * 노드 텍스트(`이름 (타입/분류): 요약`)를 로컬 Ollama의 임베딩 모델로 벡터화해
 * 그래프 JSON에 함께 보관한다. 검색(mcp/search.ts)이 키워드 랭킹과 코사인 랭킹을
 * RRF로 섞어 "동시성 문제" 같은 표현이 정확 단어 없이도 걸리게 한다.
 *
 * 원칙:
 *  - 외부 API 없음. 부르는 곳은 이 컴퓨터(또는 compose의 ollama 컨테이너)뿐이다 (PLANNING.md §7).
 *  - 임베딩은 **선택적 보강**이다. 모델이 없거나 데몬이 꺼져 있으면 조용히 실패하고
 *    그래프는 임베딩 없이 저장된다 — 어떤 경우에도 그래프 생성을 깨뜨리지 않는다.
 */
import { resolveOllamaHost } from "../settings";
import type { GraphNode, KnowledgeGraph } from "./types";

/** 기본 임베딩 모델 — 약 300MB, 768차원 */
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
/** 한 번의 요청에 넣는 텍스트 수 */
export const EMBED_BATCH_SIZE = 64;
/** 배치 하나당 대기 상한 (CPU 임베딩도 감안) */
export const EMBED_TIMEOUT_MS = 30_000;
/** 저장 크기 절반으로 — 5자리면 코사인 순위가 바뀌지 않는다 */
export const EMBED_PRECISION = 5;

export type Env = Record<string, string | undefined>;

/** 최소한의 fetch 시그니처 — 테스트에서 스텁을 주입한다 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
}>;

export interface EmbedOptions {
  host?: string;
  model?: string;
  env?: Env;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  batchSize?: number;
}

export type EmbedResult =
  | { ok: true; model: string; vectors: number[][] }
  | { ok: false; model: string; vectors: null; reason: string };

/** 임베딩 모델 해석 — env.OLLAMA_EMBED_MODEL → 기본값 */
export function resolveEmbedModel(env: Env = process.env): string {
  const fromEnv = env.OLLAMA_EMBED_MODEL?.trim();
  return fromEnv || DEFAULT_EMBED_MODEL;
}

/**
 * 텍스트들을 벡터로. `POST {host}/api/embed` (Ollama 배치 임베딩)를
 * 64개씩 나눠 호출한다. 한 배치라도 실패하면 전체가 실패다(부분 임베딩은 만들지 않는다).
 */
export async function embedTexts(
  texts: string[],
  options: EmbedOptions = {},
): Promise<EmbedResult> {
  const env = options.env ?? process.env;
  const model = options.model ?? resolveEmbedModel(env);
  const host = (options.host ?? resolveOllamaHost(env)).replace(/\/$/, "");
  const doFetch = (options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS;
  const batchSize = Math.max(1, options.batchSize ?? EMBED_BATCH_SIZE);

  if (texts.length === 0) return { ok: true, model, vectors: [] };
  if (typeof doFetch !== "function") {
    return { ok: false, model, vectors: null, reason: "fetch 사용 불가" };
  }

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    try {
      const res = await doFetch(`${host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return {
          ok: false,
          model,
          vectors: null,
          reason: `Ollama ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
        };
      }
      const parsed = parseEmbedResponse(await res.json(), batch.length);
      if (!parsed) {
        return { ok: false, model, vectors: null, reason: "임베딩 응답 형식 오류" };
      }
      vectors.push(...parsed);
    } catch (error) {
      return {
        ok: false,
        model,
        vectors: null,
        reason: error instanceof Error ? error.message : "연결 실패",
      };
    }
  }
  return { ok: true, model, vectors };
}

/** `/api/embed` 응답 → 벡터 배열. 개수·형태가 어긋나면 null. */
export function parseEmbedResponse(
  raw: unknown,
  expected: number,
): number[][] | null {
  const record = raw as { embeddings?: unknown; error?: unknown } | null;
  if (!record || typeof record !== "object") return null;
  if (typeof record.error === "string" && record.error) return null;
  const embeddings = record.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== expected) return null;

  const vectors: number[][] = [];
  for (const entry of embeddings) {
    if (!Array.isArray(entry) || entry.length === 0) return null;
    const vector: number[] = [];
    for (const value of entry) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      vector.push(value);
    }
    vectors.push(vector);
  }
  return vectors;
}

/* ── 노드 → 임베딩 텍스트 ─────────────────────────────────────────── */

/** Period(2024-Q1)는 의미 검색 대상이 아니다 — 나머지 네 종류만 벡터화한다. */
export function isEmbeddable(node: GraphNode): boolean {
  return node.kind !== "period";
}

/**
 * 노드 한 줄 텍스트.
 *   `라벨 (종류/분류): 요약`
 * 예) `React (tech/frontend)`, `동시성 제어 (concept/backend): 낙관적 락으로 …`
 */
export function nodeEmbeddingText(node: GraphNode): string {
  const label = node.label;
  let category: string | null = null;
  let detail: string | null = null;

  switch (node.kind) {
    case "tech":
      category = node.category;
      break;
    case "concept":
      category = node.domain;
      detail = node.summary ?? null;
      break;
    case "problem":
      detail = node.solutionSummary ?? node.description ?? null;
      break;
    case "project":
      category = node.primaryLang;
      break;
    default:
      break;
  }

  const head = `${label} (${node.kind}${category ? `/${category}` : ""})`;
  const tail = detail?.trim();
  return tail ? `${head}: ${tail}` : head;
}

/* ── 벡터 유틸 ────────────────────────────────────────────────────── */

/** 코사인 유사도. 길이가 다르거나 영벡터면 0. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** JSON 크기를 줄이려고 소수점 5자리로 자른다 (768차 기준 절반 이하). */
export function roundVector(vector: number[], digits = EMBED_PRECISION): number[] {
  const factor = 10 ** digits;
  return vector.map((value) => Math.round(value * factor) / factor);
}

/* ── 그래프 전체 임베딩 ───────────────────────────────────────────── */

export interface AttachOptions extends EmbedOptions {
  /**
   * 직전 그래프. 같은 id의 노드가 **같은 임베딩 텍스트**로 남아 있고
   * 그때 쓴 모델이 지금과 같으면 벡터를 그대로 물려받는다 (재빌드 비용 절감).
   */
  previous?: KnowledgeGraph | null;
}

export interface AttachOutcome {
  /** 임베딩이 하나라도 붙었는가 */
  ok: boolean;
  /** 실제로 붙은 모델. 실패하면 null */
  model: string | null;
  /** 새로 계산한 노드 수 */
  embedded: number;
  /** 직전 그래프에서 물려받은 노드 수 */
  reused: number;
  /** 실패 사유 (로그용) */
  reason?: string;
}

/**
 * 그래프의 모든 임베딩 대상 노드에 벡터를 붙인다 (제자리 수정).
 *
 * 닿지 않으면 `ok:false`로 돌아오고 노드에는 아무것도 붙지 않는다 —
 * 호출부는 그대로 그래프를 저장하면 된다(임베딩 없는 정상 그래프).
 */
export async function attachEmbeddings(
  graph: KnowledgeGraph,
  options: AttachOptions = {},
): Promise<AttachOutcome> {
  const env = options.env ?? process.env;
  const model = options.model ?? resolveEmbedModel(env);

  const targets = graph.nodes.filter(isEmbeddable);
  if (targets.length === 0) {
    graph.embeddingModel = null;
    return { ok: false, model: null, embedded: 0, reused: 0, reason: "대상 노드 없음" };
  }

  // 직전 그래프에서 물려받기 — 같은 모델 + 같은 텍스트일 때만.
  const inherited = new Map<string, number[]>();
  if (options.previous && options.previous.embeddingModel === model) {
    for (const node of options.previous.nodes) {
      if (!Array.isArray(node.embedding) || node.embedding.length === 0) continue;
      inherited.set(`${node.id} ${nodeEmbeddingText(node)}`, node.embedding);
    }
  }

  const pending: GraphNode[] = [];
  const reusedNodes: Array<{ node: GraphNode; vector: number[] }> = [];
  for (const node of targets) {
    const vector = inherited.get(`${node.id} ${nodeEmbeddingText(node)}`);
    if (vector) reusedNodes.push({ node, vector });
    else pending.push(node);
  }

  let vectors: number[][] = [];
  if (pending.length > 0) {
    const result = await embedTexts(pending.map(nodeEmbeddingText), {
      ...options,
      model,
      env,
    });
    if (!result.ok) {
      graph.embeddingModel = null;
      return {
        ok: false,
        model: null,
        embedded: 0,
        reused: 0,
        reason: result.reason,
      };
    }
    vectors = result.vectors;
  }

  for (const { node, vector } of reusedNodes) node.embedding = vector;
  pending.forEach((node, index) => {
    const vector = vectors[index];
    if (vector) node.embedding = roundVector(vector);
  });
  graph.embeddingModel = model;

  return {
    ok: true,
    model,
    embedded: pending.length,
    reused: reusedNodes.length,
  };
}
