/**
 * 검색 — FTS5 키워드(bm25) + 선택적 로컬 임베딩, RRF 융합.
 *
 * 결과는 항상 **근거** 단위다: 커밋(레포·sha·날짜·작성자·변경 파일·링크) 또는 노트.
 * 해석은 호출한 쪽(AI 클라이언트)이 한다.
 */
import { embedModel, type Env } from "./config";
import type { DB } from "./db";
import { cosine, embedTexts, fromBlob, hasEmbeddings, QUERY_PREFIX, type FetchLike } from "./embed";
import { commitWebUrl } from "./git";
import { canonicalTech } from "./tech/canonical";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 융합 전에 각 순위에서 볼 후보 수 = limit × 이 값 */
const POOL_FACTOR = 5;
/** 이보다 안 닮은 문서는 시맨틱 후보로 올리지 않는다 */
const SEMANTIC_MIN = 0.45;
export const RRF_K = 60;
/** 결과에 붙이는 변경 파일 수 */
const FILES_PER_HIT = 8;

const PARTICLES_2 = ["으로서", "으로써", "으로", "에서", "에게", "부터", "까지", "이라", "라고", "처럼", "보다", "한테"];
const PARTICLES_1 = ["을", "를", "이", "가", "은", "는", "의", "에", "와", "과", "도", "만", "로", "랑", "께"];

/** "인증을" → "인증". 한글로 끝나고 남는 글자가 2자 이상일 때만 뗀다. */
export function stripParticle(word: string): string | null {
  if (!/[가-힣]$/.test(word)) return null;
  for (const p of PARTICLES_2) {
    // 긴 조사가 맞았는데 남는 글자가 모자라면 1자 조사로 넘어가지 않는다 ("락으로" → "락으" 방지)
    if (word.endsWith(p)) return word.length >= p.length + 2 ? word.slice(0, -p.length) : null;
  }
  for (const p of PARTICLES_1) {
    if (word.length >= 3 && word.endsWith(p)) return word.slice(0, -p.length);
  }
  return null;
}

/**
 * 질의 → FTS5 MATCH 식. 토큰마다 원형·조사 뗀 형태·기술 정규명을 접두 일치로 OR한다.
 * 사용자 입력은 따옴표로 감싸 FTS 연산자로 해석되지 않게 한다.
 */
export function buildMatchExpression(query: string): string | null {
  const words = query
    .toLowerCase()
    .split(/[\s,;:!?()[\]{}<>"'`|]+/)
    .map((word) => word.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter((word) => word.length > 0);

  const terms = new Set<string>();
  for (const word of words) {
    terms.add(word);
    const stripped = stripParticle(word);
    if (stripped) terms.add(stripped);
    const canon = canonicalTech(word);
    if (canon && canon !== word) terms.add(canon);
  }
  const parts = [...terms]
    // FTS5 unicode61 토크나이저가 다시 쪼갤 것이므로 구문 접두 질의로 넣는다 ("react.js" → "react js"*)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term}"*`);
  return parts.length > 0 ? parts.join(" OR ") : null;
}

export interface SearchFilters {
  /** repos.id */
  repoId?: number;
  /** 작성자 이메일 목록 (소문자). 비면 전체 */
  authors?: string[];
  /** ISO 날짜 이상 */
  since?: string;
  /** ISO 날짜 미만 */
  until?: string;
  kind?: "commit" | "note";
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  /** false면 임베딩이 있어도 키워드만 */
  semantic?: boolean;
  env?: Env;
  fetchImpl?: FetchLike;
}

export interface SearchHit {
  kind: "commit" | "note";
  repo: string | null;
  repoPath: string | null;
  /** 커밋 sha 또는 note id */
  ref: string;
  date: string;
  author: string | null;
  title: string;
  /** 본문 발췌 (키워드 매칭부를 [ ]로 표시) */
  snippet: string;
  files: string[];
  filesChanged: number | null;
  url: string | null;
  score: number;
  matchedBy: ("keyword" | "semantic")[];
}

export interface SearchResult {
  query: string;
  mode: "hybrid" | "keyword";
  /** 시맨틱이 안 된 이유 (모델 없음 등) */
  semanticNote?: string;
  hits: SearchHit[];
}

interface Candidate {
  docId: number;
  snippet?: string;
}

export async function search(db: DB, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const pool = limit * POOL_FACTOR;
  const { where, params } = filterSql(options);

  const keyword: Candidate[] = [];
  const match = buildMatchExpression(query);
  if (match) {
    const rows = db
      .prepare(
        `SELECT d.id AS docId, snippet(docs_fts, 1, '[', ']', '…', 16) AS snippet
           FROM docs_fts f
           JOIN docs d ON d.id = f.rowid
           LEFT JOIN commits c ON d.kind = 'commit' AND c.repo_id = d.repo_id AND c.sha = d.ref
          WHERE docs_fts MATCH ? ${where}
          ORDER BY bm25(docs_fts, 4.0, 1.0, 1.5)
          LIMIT ?`,
      )
      .all(match, ...params, pool) as Candidate[];
    keyword.push(...rows);
  }

  let semantic: Candidate[] = [];
  let semanticNote: string | undefined;
  const model = embedModel(options.env ?? process.env);
  if (options.semantic !== false) {
    if (!hasEmbeddings(db, model)) {
      semanticNote = "임베딩이 없어 키워드 검색만 했습니다 (grimoire embed로 켤 수 있음).";
    } else {
      const embedded = await embedTexts([QUERY_PREFIX + query], options);
      if (!embedded.ok) {
        semanticNote = `로컬 임베딩 모델에 닿지 못해 키워드 검색만 했습니다 (${embedded.reason}).`;
      } else {
        semantic = semanticCandidates(db, embedded.vectors[0], model, where, params, pool);
      }
    }
  }

  const fused = fuse(keyword, semantic);
  const hits = fused.slice(0, limit).map((item) => toHit(db, item.docId, item.score, item.matchedBy, item.snippet));
  return {
    query,
    mode: semantic.length > 0 ? "hybrid" : "keyword",
    semanticNote,
    hits: hits.filter((hit): hit is SearchHit => hit !== null),
  };
}

function filterSql(filters: SearchFilters): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.repoId !== undefined) {
    clauses.push("d.repo_id = ?");
    params.push(filters.repoId);
  }
  if (filters.kind) {
    clauses.push("d.kind = ?");
    params.push(filters.kind);
  }
  if (filters.since) {
    clauses.push("d.at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push("d.at < ?");
    params.push(filters.until);
  }
  if (filters.authors && filters.authors.length > 0) {
    // 노트는 내가 쓴 것이므로 작성자 필터를 통과시킨다
    clauses.push(`(d.kind = 'note' OR c.author_email IN (${filters.authors.map(() => "?").join(", ")}))`);
    params.push(...filters.authors);
  }
  return { where: clauses.map((clause) => `AND ${clause}`).join(" "), params };
}

function semanticCandidates(
  db: DB,
  queryVector: Float32Array,
  model: string,
  where: string,
  params: (string | number)[],
  pool: number,
): Candidate[] {
  const rows = db
    .prepare(
      `SELECT d.id AS docId, e.vector AS vector
         FROM embeddings e
         JOIN docs d ON d.id = e.doc_id
         LEFT JOIN commits c ON d.kind = 'commit' AND c.repo_id = d.repo_id AND c.sha = d.ref
        WHERE e.model = ? ${where}`,
    )
    .all(model, ...params) as { docId: number; vector: Buffer }[];

  return rows
    .map((row) => ({ docId: row.docId, similarity: cosine(queryVector, fromBlob(row.vector)) }))
    .filter((row) => row.similarity >= SEMANTIC_MIN)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, pool)
    .map((row) => ({ docId: row.docId }));
}

/** Reciprocal Rank Fusion — 순위만 쓰므로 bm25와 코사인의 척도 차이를 신경 쓰지 않는다. */
export function fuse(
  keyword: Candidate[],
  semantic: Candidate[],
): { docId: number; score: number; matchedBy: ("keyword" | "semantic")[]; snippet?: string }[] {
  const merged = new Map<number, { docId: number; score: number; matchedBy: ("keyword" | "semantic")[]; snippet?: string }>();
  const add = (list: Candidate[], source: "keyword" | "semantic") => {
    list.forEach((candidate, rank) => {
      const entry = merged.get(candidate.docId) ?? { docId: candidate.docId, score: 0, matchedBy: [] };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.matchedBy.push(source);
      entry.snippet ??= candidate.snippet;
      merged.set(candidate.docId, entry);
    });
  };
  add(keyword, "keyword");
  add(semantic, "semantic");
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function toHit(
  db: DB,
  docId: number,
  score: number,
  matchedBy: ("keyword" | "semantic")[],
  snippet: string | undefined,
): SearchHit | null {
  const doc = db
    .prepare(
      `SELECT d.kind, d.ref, d.at, d.repo_id, r.name AS repo, r.path AS repoPath, r.remote_url AS remote,
              f.title, f.body
         FROM docs d
         JOIN docs_fts f ON f.rowid = d.id
         LEFT JOIN repos r ON r.id = d.repo_id
        WHERE d.id = ?`,
    )
    .get(docId) as
    | {
        kind: "commit" | "note";
        ref: string;
        at: string;
        repo_id: number | null;
        repo: string | null;
        repoPath: string | null;
        remote: string | null;
        title: string;
        body: string;
      }
    | undefined;
  if (!doc) return null;

  const base = {
    kind: doc.kind,
    repo: doc.repo,
    repoPath: doc.repoPath,
    ref: doc.ref,
    date: doc.at,
    title: doc.title,
    score: Number(score.toFixed(5)),
    matchedBy,
  };

  if (doc.kind === "note") {
    return {
      ...base,
      author: null,
      snippet: snippet ?? doc.body.slice(0, 240),
      files: [],
      filesChanged: null,
      url: null,
    };
  }

  const commit = db
    .prepare("SELECT author_name, author_email, files_changed, body FROM commits WHERE repo_id = ? AND sha = ?")
    .get(doc.repo_id, doc.ref) as
    | { author_name: string; author_email: string; files_changed: number; body: string }
    | undefined;
  const files = (
    db
      .prepare(
        `SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?
          ORDER BY COALESCE(insertions, 0) + COALESCE(deletions, 0) DESC LIMIT ?`,
      )
      .all(doc.repo_id, doc.ref, FILES_PER_HIT) as { path: string }[]
  ).map((row) => row.path);

  return {
    ...base,
    author: commit ? `${commit.author_name} <${commit.author_email}>` : null,
    // 레포 이름은 검색용으로 본문 앞에 붙여 둔 것이라 발췌에서는 빼고 커밋 본문을 쓴다
    snippet: snippet && snippet.includes("[") ? snippet : (commit?.body ?? "").slice(0, 240),
    files,
    filesChanged: commit?.files_changed ?? null,
    url: commitWebUrl(doc.remote, doc.ref),
  };
}
