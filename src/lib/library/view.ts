/**
 * ③ 인터랙티브 도서관 — 서재 뷰모델 (순수 로직).
 *
 * 스냅샷(레포·커밋)과 지식그래프(연결망)를 합쳐, 클라이언트로 넘길 만큼만
 * 납작하게 줄인 "책" 목록을 만든다. 커밋 1850개를 통째로 브라우저에 보내지 않고
 * 책마다 분기 집계 + 최근 메시지 몇 줄로 압축한다.
 */
import type { CollectionSnapshot, Commit } from "../collector/types";
import {
  projectId,
  type KnowledgeGraph,
  type UsesEdge,
  type ConceptNode,
  type ProblemNode,
  type TechNode,
} from "../graph/types";
import { languageColor } from "./colors";
import {
  relatedProjectMap,
  RELATED_LIMIT,
  type RelatedProject,
} from "./relatedness";

/** 책 상세에 싣는 최근 커밋 줄 수 */
export const RECENT_COMMIT_LINES = 15;
/** 집필 연혁 막대 최대 칸 수 (분기 기준 = 약 8년) */
export const MAX_QUARTERS = 32;

export interface QuarterBucket {
  /** "2024-Q1" */
  key: string;
  year: number;
  quarter: number;
  count: number;
}

export interface CommitLine {
  /** YYYY-MM-DD */
  date: string;
  message: string;
}

export interface TechRef {
  id: string;
  label: string;
  category?: string;
  /** USES 엣지 근거 (static/llm/topics/mcp) */
  source?: UsesEdge["source"];
}

export interface NodeRef {
  id: string;
  label: string;
  /** Concept 요약 · Problem 해결 요약 */
  detail?: string;
}

/** 서가에 꽂히는 마법서 한 권 */
export interface BookView {
  /** 그래프 Project 노드 id (그래프가 없어도 같은 규칙으로 만든다) */
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  primaryLanguage: string | null;
  spineColor: string;
  topics: string[];
  stars: number;
  isPrivate: boolean;
  isFork: boolean;
  /** ISO */
  createdAt: string;
  pushedAt: string;
  htmlUrl: string;
  commitCount: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  /** 집필이 가장 활발했던 해 (연도별 층 배치 기준) */
  activeYear: number;
  quarters: QuarterBucket[];
  recentCommits: CommitLine[];
  tech: TechRef[];
  concepts: NodeRef[];
  problems: NodeRef[];
  /** "2024-Q1" 라벨들 */
  periods: string[];
  /** 이 책을 뽑았을 때 함께 빛날 책들 */
  relatedIds: string[];
}

export interface LibraryData {
  books: BookView[];
  /** 그래프가 없으면 연결·발광이 비어 있다 */
  hasGraph: boolean;
  totalCommits: number;
}

function quarterOf(iso: string): { year: number; quarter: number } | null {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1) return null;
  return { year, quarter: Math.floor((month - 1) / 3) + 1 };
}

function firstLine(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  return line.length > 100 ? `${line.slice(0, 97)}…` : line;
}

/** 커밋을 분기별로 접는다 (커밋이 있는 첫 분기 ~ 마지막 분기 사이는 0도 채운다) */
export function quarterBuckets(commits: Commit[]): QuarterBucket[] {
  const counts = new Map<string, QuarterBucket>();
  for (const commit of commits) {
    const q = quarterOf(commit.authoredAt);
    if (!q) continue;
    const key = `${q.year}-Q${q.quarter}`;
    const bucket = counts.get(key);
    if (bucket) bucket.count += 1;
    else counts.set(key, { key, year: q.year, quarter: q.quarter, count: 1 });
  }
  if (counts.size === 0) return [];

  const sorted = [...counts.values()].sort(
    (a, b) => a.year - b.year || a.quarter - b.quarter,
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const filled: QuarterBucket[] = [];
  let year = first.year;
  let quarter = first.quarter;
  while (year < last.year || (year === last.year && quarter <= last.quarter)) {
    const key = `${year}-Q${quarter}`;
    filled.push(counts.get(key) ?? { key, year, quarter, count: 0 });
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
  }
  // 너무 길면 최근 쪽을 남긴다
  return filled.slice(-MAX_QUARTERS);
}

/** 집필이 가장 활발했던 해 (동률이면 이른 해). 커밋이 없으면 생성 연도 */
export function dominantYear(
  quarters: QuarterBucket[],
  createdAt: string,
): number {
  const byYear = new Map<number, number>();
  for (const bucket of quarters) {
    byYear.set(bucket.year, (byYear.get(bucket.year) ?? 0) + bucket.count);
  }
  let best: { year: number; count: number } | null = null;
  for (const [year, count] of byYear) {
    if (count === 0) continue;
    if (!best || count > best.count || (count === best.count && year < best.year)) {
      best = { year, count };
    }
  }
  if (best) return best.year;
  const fallback = Number(createdAt.slice(0, 4));
  return Number.isFinite(fallback) ? fallback : 0;
}

interface GraphFacets {
  tech: TechRef[];
  concepts: NodeRef[];
  problems: NodeRef[];
  periods: string[];
}

/** 프로젝트 id → 그래프에서 뽑은 연결 정보 */
function graphFacets(graph: KnowledgeGraph): Map<string, GraphFacets> {
  const index = new Map(graph.nodes.map((node) => [node.id, node]));
  const map = new Map<string, GraphFacets>();
  const facet = (id: string): GraphFacets => {
    const found = map.get(id);
    if (found) return found;
    const fresh: GraphFacets = { tech: [], concepts: [], problems: [], periods: [] };
    map.set(id, fresh);
    return fresh;
  };

  for (const node of graph.nodes) {
    if (node.kind === "project") facet(node.id);
  }

  for (const edge of graph.edges) {
    if (edge.kind === "USES") {
      const node = index.get(edge.to);
      if (!node || !map.has(edge.from)) continue;
      facet(edge.from).tech.push({
        id: node.id,
        label: node.label,
        category: node.kind === "tech" ? (node as TechNode).category : undefined,
        source: (edge as UsesEdge).source,
      });
    } else if (edge.kind === "ABOUT") {
      const node = index.get(edge.to);
      if (!node || !map.has(edge.from)) continue;
      facet(edge.from).concepts.push({
        id: node.id,
        label: node.label,
        detail: node.kind === "concept" ? (node as ConceptNode).summary : undefined,
      });
    } else if (edge.kind === "SOLVED") {
      const node = index.get(edge.to);
      if (!node || !map.has(edge.from)) continue;
      facet(edge.from).problems.push({
        id: node.id,
        label: node.label,
        detail:
          node.kind === "problem" ? (node as ProblemNode).solutionSummary : undefined,
      });
    } else if (edge.kind === "DEVELOPED") {
      const node = index.get(edge.from);
      if (!node || !map.has(edge.to)) continue;
      facet(edge.to).periods.push(node.label);
    }
  }

  for (const value of map.values()) {
    value.tech.sort((a, b) => a.label.localeCompare(b.label));
    value.concepts.sort((a, b) => a.label.localeCompare(b.label));
    value.problems.sort((a, b) => a.label.localeCompare(b.label));
    value.periods = [...new Set(value.periods)].sort();
  }
  return map;
}

/** 스냅샷 + 그래프 → 서재 뷰모델 */
export function buildLibrary(
  snapshot: CollectionSnapshot,
  graph: KnowledgeGraph | null,
): LibraryData {
  const commitsByRepo = new Map<string, Commit[]>();
  for (const commit of snapshot.commits) {
    const list = commitsByRepo.get(commit.repoFullName);
    if (list) list.push(commit);
    else commitsByRepo.set(commit.repoFullName, [commit]);
  }

  const facets = graph ? graphFacets(graph) : new Map<string, GraphFacets>();
  const related: Map<string, RelatedProject[]> = graph
    ? relatedProjectMap(graph, RELATED_LIMIT)
    : new Map();

  const books: BookView[] = snapshot.repos.map((repo) => {
    const commits = (commitsByRepo.get(repo.fullName) ?? [])
      .slice()
      .sort((a, b) => a.authoredAt.localeCompare(b.authoredAt));
    const quarters = quarterBuckets(commits);
    const id = projectId(repo.fullName);
    const facet = facets.get(id);

    return {
      id,
      name: repo.name,
      fullName: repo.fullName,
      description: repo.description,
      primaryLanguage: repo.primaryLanguage,
      spineColor: languageColor(repo.primaryLanguage),
      topics: repo.topics ?? [],
      stars: repo.stars,
      isPrivate: repo.isPrivate,
      isFork: repo.isFork,
      createdAt: repo.createdAt,
      pushedAt: repo.pushedAt,
      htmlUrl: repo.htmlUrl,
      commitCount: commits.length,
      firstCommitAt: commits.at(0)?.authoredAt ?? null,
      lastCommitAt: commits.at(-1)?.authoredAt ?? null,
      activeYear: dominantYear(quarters, repo.createdAt),
      quarters,
      recentCommits: commits
        .slice(-RECENT_COMMIT_LINES)
        .reverse()
        .map((commit) => ({
          date: commit.authoredAt.slice(0, 10),
          message: firstLine(commit.message),
        })),
      tech: facet?.tech ?? [],
      concepts: facet?.concepts ?? [],
      problems: facet?.problems ?? [],
      periods: facet?.periods ?? [],
      relatedIds: (related.get(id) ?? []).map((entry) => entry.id),
    };
  });

  return {
    books,
    hasGraph: graph !== null,
    totalCommits: snapshot.commits.length,
  };
}
