/**
 * 검색 — FTS5 키워드(bm25) + 선택적 로컬 임베딩, RRF 융합.
 *
 * 결과는 항상 **근거** 단위다: 커밋(레포·sha·날짜·작성자·변경 파일·링크) 또는 노트.
 * 해석은 호출한 쪽(AI 클라이언트)이 한다.
 */
import path from "node:path";

import { splitIdentifier } from "./code";
import { embedModel, type Env } from "./config";
import type { DB } from "./db";
import { cosine, embedTexts, fromBlob, hasEmbeddings, QUERY_PREFIX, type FetchLike } from "./embed";
import { commitWebUrl } from "./git";
import { canonicalTech } from "./tech/canonical";
import { expandKorean, isFiller } from "./terms";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 융합 전에 각 순위에서 볼 후보 수 = limit × 이 값 */
const POOL_FACTOR = 5;
/** 이보다 안 닮은 문서는 시맨틱 후보로 올리지 않는다 */
const SEMANTIC_MIN = 0.45;
export const RRF_K = 60;
/** 개념이 코드 파일 이름에 들어 있을 때 곱하는 가중치 */
const FILE_NAME_BONUS = 1.6;
/** 현재 작업 레포 결과에 곱하는 가중치 */
const CURRENT_REPO_BOOST = 1.5;
/** 이보다 많은 파일을 건드린 커밋은 "대량 커밋"으로 보고 순위를 낮춘다 */
const BULK_COMMIT_FILES = 40;
/** 재정렬 전에 bm25로 넉넉히 뽑아 둘 배수 */
const RERANK_FACTOR = 4;
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
/**
 * 질의 → 개념 묶음. 낱말 하나가 개념 하나이고, 그 변형(조사 뗀 꼴·영어 확장·기술 정규명)이 묶음 안에 든다.
 * "어느 파일에 있어" 같은 질문 군더더기(isFiller)는 개념에서 뺀다.
 */
export function queryConcepts(query: string): string[][] {
  const words = query
    .toLowerCase()
    .split(/[\s,;:!?()[\]{}<>"'`|]+/)
    .map((word) => word.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter((word) => word.length > 0);

  const concepts: string[][] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const stripped = stripParticle(word);
    if (isFiller(word) || (stripped && isFiller(stripped))) continue;
    const variants = new Set<string>([word]);
    if (stripped) variants.add(stripped);
    for (const english of [...expandKorean(word), ...(stripped ? expandKorean(stripped) : [])]) variants.add(english);
    const canon = canonicalTech(word);
    if (canon && canon !== word) variants.add(canon);
    const terms = [...variants]
      .map((term) => term.replace(/"/g, ""))
      .filter((term) => /[\p{L}\p{N}]/u.test(term));
    const key = terms.join("|");
    if (terms.length > 0 && !seen.has(key)) {
      seen.add(key);
      concepts.push(terms);
    }
  }
  return concepts;
}

/** 개념 묶음 하나 → FTS5 식 (FTS5 unicode61이 다시 쪼개므로 구문 접두 질의: "react.js" → "react js"*) */
function conceptExpression(terms: string[]): string {
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

export function buildMatchExpression(query: string): string | null {
  const concepts = queryConcepts(query);
  if (concepts.length === 0) return null;
  return [...new Set(concepts.flat())].map((term) => `"${term}"*`).join(" OR ");
}

/**
 * 키워드 후보 재정렬 — 질의 개념을 **얼마나 많이, 얼마나 드문 것으로** 덮었나.
 *
 * bm25만으로는 "선택·코드" 같은 흔한 낱말 여럿에 걸린 문서가, 결정적인 드문 낱말("충돌")
 * 하나에 걸린 문서를 이긴다(긴 문서는 길이 보정으로 더 밀린다). 개념마다 IDF²를 매겨(드문 개념이
 * 흔한 개념 여럿보다 무겁게) 덮은 개념의 합으로 다시 줄 세운다. 같으면 bm25 순서를 지킨다.
 * 코드 파일은 개념이 **파일 이름**에 들어 있으면 가산한다 — 위치 질문에서 가장 강한 신호다.
 * 테스트 파일과 수십 개 파일을 한꺼번에 건드린 커밋(초기 세팅·대량 이동)은 살짝 뒤로 보낸다 —
 * 무엇에든 걸리지만 핀포인트인 경우는 드물다.
 */
function rerankByCoverage(db: DB, concepts: string[][], candidates: Candidate[]): Candidate[] {
  if (concepts.length < 2 || candidates.length < 2) return candidates;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n || 1;
  const ids = candidates.map((candidate) => candidate.docId);
  const placeholders = ids.map(() => "?").join(", ");
  const score = new Map<number, number>(ids.map((id) => [id, 0]));

  // 코드 파일의 이름 낱말 ("services/api/rate-limit.ts" → rate, limit)
  const fileNames = new Map(
    (db.prepare(`SELECT id, ref FROM docs WHERE kind = 'file' AND id IN (${placeholders})`).all(...ids) as { id: number; ref: string }[]).map(
      (row) => [row.id, splitIdentifier(path.posix.basename(row.ref).replace(/\.[^.]+$/, "")).split(" ")],
    ),
  );

  for (const terms of concepts) {
    const expr = conceptExpression(terms);
    const df = (db.prepare("SELECT COUNT(*) AS n FROM docs_fts WHERE docs_fts MATCH ?").get(expr) as { n: number }).n;
    if (df === 0) continue;
    const weight = Math.log(1 + total / df) ** 2;
    const matched = db
      .prepare(`SELECT rowid AS id FROM docs_fts WHERE docs_fts MATCH ? AND rowid IN (${placeholders})`)
      .all(expr, ...ids) as { id: number }[];
    for (const row of matched) {
      const nameWords = fileNames.get(row.id);
      const inName = nameWords?.some((word) => terms.some((term) => word.startsWith(term.toLowerCase())));
      score.set(row.id, (score.get(row.id) ?? 0) + weight * (inName ? FILE_NAME_BONUS : 1));
    }
  }

  const testPenalty = new Set(
    (
      db
        .prepare(`SELECT id FROM docs WHERE kind = 'file' AND id IN (${placeholders}) AND (ref LIKE '%.test.%' OR ref LIKE '%.spec.%' OR ref LIKE '%/__tests__/%' OR ref LIKE 'test/%' OR ref LIKE 'tests/%' OR ref LIKE '%/test_%')`)
        .all(...ids) as { id: number }[]
    ).map((row) => row.id),
  );
  const bulk = new Set(
    (
      db
        .prepare(
          `SELECT d.id FROM docs d JOIN commits c ON c.repo_id = d.repo_id AND c.sha = d.ref
            WHERE d.kind = 'commit' AND d.id IN (${placeholders}) AND c.files_changed > ?`,
        )
        .all(...ids, BULK_COMMIT_FILES) as { id: number }[]
    ).map((row) => row.id),
  );
  const factor = (id: number) => (testPenalty.has(id) ? 0.85 : 1) * (bulk.has(id) ? 0.7 : 1);
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...candidates].sort((a, b) => {
    const sa = (score.get(a.docId) ?? 0) * factor(a.docId);
    const sb = (score.get(b.docId) ?? 0) * factor(b.docId);
    return sb - sa || (order.get(a.docId) ?? 0) - (order.get(b.docId) ?? 0);
  });
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
  kind?: "commit" | "note" | "file";
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  /**
   * 지금 작업 중인 레포(repos.id) — 그 레포의 결과를 앞으로 당긴다.
   * 개발 중 질문은 대개 현재 프로젝트에 대한 것이다. 다른 레포를 지우지는 않는다(repoId 필터와 다름).
   */
  preferRepoId?: number;
  /** false면 임베딩이 있어도 키워드만 */
  semantic?: boolean;
  env?: Env;
  fetchImpl?: FetchLike;
}

export interface SearchHit {
  kind: "commit" | "note" | "file";
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
  /** kind='file'일 때: 질의와 맞는 심볼 "이름:줄" (없으면 앞쪽 심볼) */
  symbols?: string[];
  /** kind='file'일 때: 파일 줄 수 */
  lines?: number;
  /** kind='file'일 때: 이 파일을 마지막으로 건드린 커밋 */
  lastCommit?: { sha: string; date: string; title: string } | null;
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
  const concepts = queryConcepts(query);
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
      .all(match, ...params, pool * RERANK_FACTOR) as Candidate[];
    keyword.push(...rerankByCoverage(db, concepts, rows).slice(0, pool));
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

  const fused = preferRepo(db, fuse(keyword, semantic), options.preferRepoId);
  const terms = queryTerms(query);
  const hits = fused.slice(0, limit).map((item) => toHit(db, item.docId, item.score, item.matchedBy, item.snippet, terms));
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
  // 작성자·기간은 이력에 대한 질문이다 — 시점·작성자가 없는 현재 코드 파일은 뺀다
  if (filters.since || filters.until || (filters.authors && filters.authors.length > 0)) {
    clauses.push("d.kind <> 'file'");
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

/** 현재 레포 결과의 점수를 키워 다시 줄 세운다 */
function preferRepo<T extends { docId: number; score: number }>(db: DB, items: T[], repoId: number | undefined): T[] {
  if (repoId === undefined || items.length === 0) return items;
  const ids = items.map((item) => item.docId);
  const inRepo = new Set(
    (
      db.prepare(`SELECT id FROM docs WHERE repo_id = ? AND id IN (${ids.map(() => "?").join(", ")})`).all(repoId, ...ids) as {
        id: number;
      }[]
    ).map((row) => row.id),
  );
  if (inRepo.size === 0) return items;
  return items
    .map((item) => (inRepo.has(item.docId) ? { ...item, score: item.score * CURRENT_REPO_BOOST } : item))
    .sort((a, b) => b.score - a.score);
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

/** 심볼 매칭에 쓰는 질의 낱말 (조사 제거·한영 확장 포함, 소문자) */
function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const raw of query.toLowerCase().split(/[\s,;:!?()[\]{}<>"'`|]+/)) {
    const word = raw.replace(/^[.\-/]+|[.\-/]+$/g, "");
    if (!word) continue;
    const stripped = stripParticle(word);
    for (const term of [word, stripped, ...expandKorean(word), ...(stripped ? expandKorean(stripped) : [])]) {
      if (term && term.length >= 3) out.add(term);
    }
  }
  return [...out];
}

const SYMBOLS_PER_FILE = 5;

function toHit(
  db: DB,
  docId: number,
  score: number,
  matchedBy: ("keyword" | "semantic")[],
  snippet: string | undefined,
  terms: string[] = [],
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
        kind: "commit" | "note" | "file";
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

  if (doc.kind === "file") {
    const file = db
      .prepare("SELECT lines, symbols FROM code_files WHERE repo_id = ? AND path = ?")
      .get(doc.repo_id, doc.ref) as { lines: number; symbols: string } | undefined;
    const all = file ? (JSON.parse(file.symbols) as { name: string; line: number }[]) : [];
    const matched = all.filter((symbol) => {
      const name = symbol.name.toLowerCase();
      return terms.some((term) => name.includes(term));
    });
    const picked = (matched.length > 0 ? matched : all).slice(0, SYMBOLS_PER_FILE);
    const last = db
      .prepare(
        `SELECT c.sha, c.authored_at AS date, c.subject AS title FROM commit_files f
           JOIN commits c ON c.repo_id = f.repo_id AND c.sha = f.sha
          WHERE f.repo_id = ? AND f.path = ? ORDER BY c.authored_at DESC LIMIT 1`,
      )
      .get(doc.repo_id, doc.ref) as { sha: string; date: string; title: string } | undefined;
    return {
      ...base,
      author: null,
      snippet: "",
      files: [doc.ref],
      filesChanged: null,
      url: null,
      symbols: picked.map((symbol) => `${symbol.name}:${symbol.line}`),
      lines: file?.lines,
      lastCommit: last ?? null,
    };
  }

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
