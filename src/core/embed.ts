/**
 * 선택적 시맨틱 검색 — 로컬 Ollama 임베딩.
 *
 * `POST {host}/api/embed`만 부른다. 외부 API는 없다.
 * nomic-embed-text는 문서/질의에 접두어를 붙여야 품질이 나온다.
 */
import { embedModel, ollamaHost, type Env } from "./config";
import type { DB } from "./db";

const BATCH = 64;
const TIMEOUT_MS = 60_000;
/** 문서 하나에서 임베딩할 최대 글자 수 */
const DOC_CHARS = 1500;

export const DOC_PREFIX = "search_document: ";
export const QUERY_PREFIX = "search_query: ";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface EmbedOptions {
  env?: Env;
  fetchImpl?: FetchLike;
}

export type EmbedResult =
  | { ok: true; model: string; vectors: Float32Array[] }
  | { ok: false; model: string; reason: string };

export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<EmbedResult> {
  const env = options.env ?? process.env;
  const model = embedModel(env);
  const host = ollamaHost(env);
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    try {
      const res = await doFetch(`${host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, model, reason: `Ollama ${res.status}` };
      const parsed = parseEmbedResponse(await res.json(), batch.length);
      if (!parsed) return { ok: false, model, reason: "임베딩 응답 형식 오류" };
      vectors.push(...parsed);
    } catch (error) {
      return { ok: false, model, reason: error instanceof Error ? error.message : "연결 실패" };
    }
  }
  return { ok: true, model, vectors };
}

export function parseEmbedResponse(raw: unknown, expected: number): Float32Array[] | null {
  const embeddings = (raw as { embeddings?: unknown } | null)?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== expected) return null;
  const vectors: Float32Array[] = [];
  for (const entry of embeddings) {
    if (!Array.isArray(entry) || entry.length === 0) return null;
    if (!entry.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
    vectors.push(Float32Array.from(entry as number[]));
  }
  return vectors;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export interface EmbedPendingResult {
  ok: boolean;
  model: string;
  embedded: number;
  remaining: number;
  reason?: string;
}

/**
 * 임베딩이 없는 문서(의미 있는 커밋 + 노트)를 채운다.
 * 배치마다 커밋하므로 중간에 끊겨도 다음 실행이 이어서 한다.
 */
export async function embedPending(db: DB, options: EmbedOptions & { limit?: number } = {}): Promise<EmbedPendingResult> {
  const model = embedModel(options.env ?? process.env);
  const pending = db
    .prepare(
      `SELECT d.id, f.title, f.body, f.paths
         FROM docs d
         JOIN docs_fts f ON f.rowid = d.id
         LEFT JOIN commits c ON d.kind = 'commit' AND c.repo_id = d.repo_id AND c.sha = d.ref
        WHERE (d.kind <> 'commit' OR c.meaningful = 1)
          AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.doc_id = d.id AND e.model = ?)
        ORDER BY d.at DESC
        LIMIT ?`,
    )
    .all(model, options.limit ?? 1_000_000) as { id: number; title: string; body: string; paths: string }[];

  const insert = db.prepare("INSERT OR REPLACE INTO embeddings (doc_id, model, vector) VALUES (?, ?, ?)");
  let embedded = 0;
  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH);
    const texts = batch.map((doc) =>
      (DOC_PREFIX + [doc.title, doc.body, doc.paths.split(" ").slice(0, 20).join(" ")].filter(Boolean).join("\n")).slice(
        0,
        DOC_CHARS,
      ),
    );
    const result = await embedTexts(texts, options);
    if (!result.ok) {
      return { ok: false, model, embedded, remaining: pending.length - embedded, reason: result.reason };
    }
    db.transaction(() => {
      batch.forEach((doc, i) => insert.run(doc.id, model, toBlob(result.vectors[i])));
    })();
    embedded += batch.length;
  }
  return { ok: true, model, embedded, remaining: 0 };
}

export function hasEmbeddings(db: DB, model: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM embeddings WHERE model = ? LIMIT 1").get(model));
}
