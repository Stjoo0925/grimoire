/**
 * 검색 — FTS5 키워드(bm25) + 개념 커버리지 재정렬 + 현재 레포 우선.
 *
 * 결과는 항상 **근거** 단위다: 커밋(레포·sha·날짜·작성자·변경 파일·링크) 또는 노트.
 * 해석은 호출한 쪽(AI 클라이언트)이 한다.
 */
import path from "node:path";

import { whyLine } from "./capture";
import { parseNotePaths } from "./note-doc";
import { isIndexable, splitIdentifier } from "./code";
import type { DB } from "./db";
import { commitWebUrl } from "./git";
import { canonicalTech } from "./tech/canonical";
import { expandKorean, isFiller } from "./terms";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 재정렬 뒤 남겨 둘 후보 수 = limit × 이 값 */
const POOL_FACTOR = 5;
/**
 * 순위 → 점수 1/(K+순위). 현재 레포 가산(×CURRENT_REPO_BOOST)이 순위 몇 칸을 뛰어넘을지 정한다 —
 * K가 크면 점수 차가 작아 현재 레포 결과가 앞으로 많이 당겨진다.
 */
const RANK_K = 60;
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

  // 개념마다 맞는 문서를 한 번에 받아 문서 수(df)와 후보 매칭을 함께 얻는다.
  // "MATCH ? AND rowid IN (후보)"로 거르면 FTS5가 후보마다 식을 다시 풀어 질의당 수십~수백 ms가 든다
  // (npm run perf: 재정렬이 검색 시간의 86%) — 전체 매칭 목록을 받아 JS에서 겹치는 편이 훨씬 싸다.
  const matching = db.prepare("SELECT rowid AS id FROM docs_fts WHERE docs_fts MATCH ?");
  for (const terms of concepts) {
    const expr = conceptExpression(terms);
    const all = matching.all(`{title body paths}: (${expr})`) as { id: number }[];
    const df = all.length;
    if (df === 0) continue;
    const weight = Math.log(1 + total / df) ** 2;
    const matched = all.filter((row) => score.has(row.id));
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
  /** kind='file'일 때: 질의와 맞는 심볼 "이름:줄" (없으면 앞쪽 심볼) */
  symbols?: string[];
  /** kind='file'일 때: 파일 줄 수 */
  lines?: number;
  /** kind='file'일 때: 이 파일을 마지막으로 건드린 커밋 */
  lastCommit?: { sha: string; date: string; title: string } | null;
  /** kind='commit'일 때: 커밋 본문 전체 (snippet은 발췌) */
  body?: string;
  /** kind='commit'일 때: 같은 변경으로 접힌 다른 커밋 sha (squash 머지의 브랜치 원본 등) */
  also?: string[];
  /** kind='commit'일 때: diff에서 바뀐 선언 — 파일별 이름 (diffs.ts가 뒤에서 채운다, 아직이면 빈 배열) */
  touched?: { file: string; names: string[] }[];
  /** kind='commit'일 때: 커밋에 묶인 의도 한 줄 (세션 프롬프트·Why 트레일러, capture.ts) */
  why?: string;
  /** kind='note'일 때: 누가 남겼나 — me(터미널 grimoire note) | ai(MCP record_note). AI가 쓴 노트를 사람의 결정과 구분하게 */
  by?: "me" | "ai";
  /** kind='note'일 때: 이 노트를 대신한 노트 id — 옛 규칙이다 (notes.ts supersede) */
  supersededBy?: number;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

interface Candidate {
  docId: number;
  snippet?: string;
}

export function search(db: DB, query: string, options: SearchOptions = {}): SearchResult {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const pool = limit * POOL_FACTOR;
  const { where, params } = filterSql(options);

  const keyword: Candidate[] = [];
  const concepts = queryConcepts(query);
  const match = buildMatchExpression(query);
  if (match) {
    // ORDER BY bm25(…)로 쓰면 SQLite가 맞는 행 전부에 snippet()을 계산한 뒤 정렬한다. FTS5의 rank로 정렬하면
    // FTS5가 안에서 정렬해 LIMIT만큼만 꺼내므로 snippet은 남는 행에만 든다 (결과 같음, 이 질의 −34%).
    const candidates = (expression: string, weights: string, count: number) =>
      db
        .prepare(
          `SELECT d.id AS docId, snippet(docs_fts, 1, '[', ']', '…', 16) AS snippet
             FROM docs_fts f
             JOIN docs d ON d.id = f.rowid
             LEFT JOIN commits c ON d.kind = 'commit' AND c.repo_id = d.repo_id AND c.sha = d.ref
            WHERE docs_fts MATCH ? AND f.rank MATCH 'bm25(${weights})' ${where}
            ORDER BY f.rank
            LIMIT ?`,
        )
        .all(expression, ...params, count) as Candidate[];
    // 순위는 제목·본문·경로로만 매긴다. diff 이름(code 컬럼)을 순위에 섞으면 검색이 2~3배 느려지는데,
    // 89문항 평가(npm run eval)에서 정확도 이득은 아직 유의하지 않다 (식별자 전부: Acc@3 +6문항, p=0.07).
    const rows = candidates(`{title body paths}: (${match})`, "4.0, 1.0, 1.5, 0", pool * RERANK_FACTOR);
    keyword.push(...rerankByCoverage(db, concepts, rows).slice(0, pool));
    // 그래도 모자라면 diff에만 남은 이름으로 채운다 — 지금 코드에도 메시지에도 없는 "지워진 함수" 같은 질문
    if (keyword.length < limit) {
      const seen = new Set(keyword.map((candidate) => candidate.docId));
      for (const row of candidates(`code: (${match})`, "0, 0, 0, 1.0", limit * 2)) {
        if (keyword.length >= limit) break;
        if (!seen.has(row.docId)) keyword.push(row);
      }
    }
  }

  const ranked = preferRepo(
    db,
    keyword.map((candidate, rank) => ({ ...candidate, score: 1 / (RANK_K + rank + 1) })),
    options.preferRepoId,
  );
  const terms = queryTerms(query);
  const hits = foldDuplicates(db, ranked, limit).map((item) => {
    const hit = toHit(db, item.docId, item.score, item.snippet, terms);
    return hit && item.also.length > 0 ? { ...hit, also: item.also } : hit;
  });
  return {
    query,
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

/**
 * 같은 변경이 커밋 둘로 남은 것을 한 결과로 접는다 — squash 머지 커밋과 브랜치의 원본 커밋이 같은 제목으로
 * 1·2위를 함께 차지하면 자리만 먹는다. 같은 레포에서 제목(PR 번호 접미 "(#N)" 제거)과 변경 파일 집합이 같으면
 * 같은 변경으로 본다. 대표는 날짜가 늦은 쪽(대개 머지 커밋)이고 자리는 먼저 나온 쪽의 것, 접힌 sha는 also에 싣는다.
 * limit 전에 접으므로 빈자리는 다음 후보가 채운다.
 * 한계(의도): 제목과 파일 집합이 정확히 같을 때만 접으므로, 커밋 여러 개를 squash한 PR(파일 집합이 어느 단일 커밋과도 다름)은 접히지 않는다.
 * 파일 목록은 후보마다 group_concat으로 이어 붙인다 — 지금 규모에선 충분하고, 파일 수가 큰 커밋이 문제가 되면 해시로 바꿀 수 있다.
 */
function foldDuplicates<T extends { docId: number }>(db: DB, items: T[], limit: number): (T & { also: string[] })[] {
  const info = db.prepare(
    `SELECT d.kind, d.repo_id AS repoId, d.ref, d.at, c.subject,
            (SELECT group_concat(path, char(10)) FROM (SELECT path FROM commit_files f WHERE f.repo_id = d.repo_id AND f.sha = d.ref ORDER BY path)) AS files
       FROM docs d LEFT JOIN commits c ON d.kind = 'commit' AND c.repo_id = d.repo_id AND c.sha = d.ref
      WHERE d.id = ?`,
  );
  const out: (T & { also: string[]; at: string; ref: string })[] = [];
  const byKey = new Map<string, number>();
  for (const item of items) {
    if (out.length >= limit) break;
    const row = info.get(item.docId) as { kind: string; repoId: number; ref: string; at: string; subject: string | null; files: string | null } | undefined;
    const subject = row?.subject?.replace(/\s*\(#\d+\)\s*$/, "").trim();
    const key = row?.kind === "commit" && subject && row.files ? `${row.repoId}\0${subject}\0${row.files}` : null;
    const index = key === null ? undefined : byKey.get(key);
    if (row && index !== undefined) {
      const kept = out[index];
      // 늦은 쪽을 대표로, 자리는 그대로 (날짜는 작성 시각대가 달라 문자열로 비교하지 않는다)
      if (Date.parse(row.at) > Date.parse(kept.at)) out[index] = { ...item, also: [kept.ref, ...kept.also], at: row.at, ref: row.ref };
      else kept.also.push(row.ref);
      continue;
    }
    if (key !== null) byKey.set(key, out.length);
    out.push({ ...item, also: [], at: row?.at ?? "", ref: row?.ref ?? "" });
  }
  return out.map(({ at: _at, ref: _ref, ...rest }) => rest as unknown as T & { also: string[] });
}

/** 변경 파일 중 답에 쓸 만한 것 — 잠금 파일·문서·설정보다 소스를 앞에 */
const TEST_FILE = /(\.(test|spec)\.[^/]+$|(^|\/)(__tests__|tests?)\/|(^|\/)test_[^/]+$)/;
const LOW_VALUE_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|CHANGELOG\.md)$|\.(md|lock|snap|svg|png|jpe?g|gif|ico|webp)$/i;

/**
 * 커밋의 변경 파일을 근거로 보여 줄 순서로 — 경로에 질의 낱말이 든 파일, 소스 파일, 나머지, 잠금 파일·문서·이미지 순.
 * (줄 수는 색인하지 않으므로 "많이 바뀐 파일" 순서는 쓸 수 없다. 대신 질문과의 관련성으로 고른다.)
 */
export function rankFiles(paths: string[], terms: string[]): string[] {
  const score = (file: string) => {
    const lower = file.toLowerCase();
    const words = splitIdentifier(file);
    let value = 0;
    if (terms.some((term) => term.length >= 2 && (lower.includes(term) || words.includes(term)))) value += 4;
    if (isIndexable(file, 0)) value += TEST_FILE.test(file) ? 1 : 2;
    if (LOW_VALUE_FILE.test(file)) value -= 2;
    return value;
  };
  return paths
    .map((file, index) => ({ file, index, value: score(file) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((item) => item.file);
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
    const note = db.prepare("SELECT source, paths, superseded_by FROM notes WHERE id = ?").get(Number(doc.ref)) as
      | { source: string; paths: string | null; superseded_by: number | null }
      | undefined;
    return {
      ...base,
      by: note?.source === "cli" ? "me" : "ai",
      ...(note?.superseded_by ? { supersededBy: note.superseded_by } : {}),
      author: null,
      snippet: snippet ?? doc.body.slice(0, 240),
      // 노트가 묶인 파일 (notes.ts)
      files: parseNotePaths(note?.paths).map((item) => item.path),
      filesChanged: null,
      url: null,
    };
  }

  const commit = db
    .prepare("SELECT author_name, author_email, files_changed, body, symbols FROM commits WHERE repo_id = ? AND sha = ?")
    .get(doc.repo_id, doc.ref) as
    | { author_name: string; author_email: string; files_changed: number; body: string; symbols: string | null }
    | undefined;
  const files = rankFiles(
    (db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ? LIMIT 400").all(doc.repo_id, doc.ref) as { path: string }[]).map(
      (row) => row.path,
    ),
    terms,
  ).slice(0, FILES_PER_HIT);

  const why = doc.repo_id === null ? undefined : whyLine(db, doc.repo_id, doc.ref);
  return {
    ...base,
    author: commit ? `${commit.author_name} <${commit.author_email}>` : null,
    // 레포 이름은 검색용으로 본문 앞에 붙여 둔 것이라 발췌에서는 빼고 커밋 본문을 쓴다
    snippet: snippet && snippet.includes("[") ? snippet : (commit?.body ?? "").slice(0, 240),
    files,
    filesChanged: commit?.files_changed ?? null,
    url: commitWebUrl(doc.remote, doc.ref),
    body: commit?.body ?? "",
    touched: touchedSymbols(commit?.symbols ?? null, terms),
    ...(why ? { why } : {}),
  };
}

/** commits.symbols(JSON) → 파일별 바뀐 선언, 질문과 맞는 파일·소스 파일부터 */
function touchedSymbols(json: string | null, terms: string[]): { file: string; names: string[] }[] {
  if (!json) return [];
  try {
    const items = JSON.parse(json) as { file: string; names: string[] }[];
    const order = rankFiles(items.map((item) => item.file), terms);
    return [...items].sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
  } catch {
    return [];
  }
}
