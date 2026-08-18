/**
 * ② MCP 서버 — `get_project_history`의 조회 로직 (순수, SDK 비의존).
 *
 * 그래프(마법서의 연결망) + 스냅샷(커밋 = 페이지)을 합쳐 한 권의 이력을 만든다.
 * 스냅샷이 없으면 그래프만으로 답하고 그 사실을 note로 밝힌다.
 */
import type { CollectionSnapshot, Commit } from "../lib/collector/types";
import { normalizeName } from "../lib/graph/canonical";
import type {
  KnowledgeGraph,
  ProjectNode,
  UsesEdge,
} from "../lib/graph/types";
import { nodeBrief, nodeDetail, nodeIndex, type NodeBrief, type NodeDetail } from "./nodes";

/** 최근 커밋 메시지 표시 상한 */
export const RECENT_COMMIT_LIMIT = 20;

export interface ProjectMatch {
  project: ProjectNode;
  /** 어떻게 걸렸는가 */
  how: "exact" | "prefix" | "substring";
}

/**
 * 프로젝트 노드 해석 (퍼지: 정규화 후 정확 → 접두 → 부분 문자열).
 * 후보가 여럿이면 stars → 최근 push 순으로 대표를 고르고 나머지는 candidates로 돌려준다.
 */
export function resolveProject(
  graph: KnowledgeGraph,
  query: string,
): { match: ProjectMatch | null; candidates: ProjectNode[] } {
  const needle = normalizeName(query);
  const projects = graph.nodes.filter(
    (node): node is ProjectNode => node.kind === "project",
  );
  if (!needle) return { match: null, candidates: [] };

  const hits: ProjectMatch[] = [];
  for (const project of projects) {
    const name = normalizeName(project.name);
    const full = normalizeName(project.fullName);
    // fullName은 "mage/spellbook" → "magespellbook"이 되므로 소유자 분리 표기도 본다.
    const owner = normalizeName(project.fullName.split("/")[0] ?? "");
    const fullSlashed = owner ? `${owner}-${name}` : name;

    if (name === needle || full === needle || fullSlashed === needle) {
      hits.push({ project, how: "exact" });
    } else if (name.startsWith(needle) || fullSlashed.startsWith(needle)) {
      hits.push({ project, how: "prefix" });
    } else if (name.includes(needle) || fullSlashed.includes(needle)) {
      hits.push({ project, how: "substring" });
    }
  }
  if (hits.length === 0) return { match: null, candidates: [] };

  const rank = { exact: 0, prefix: 1, substring: 2 } as const;
  hits.sort(
    (a, b) =>
      rank[a.how] - rank[b.how] ||
      b.project.stars - a.project.stars ||
      b.project.lastPushedAt.localeCompare(a.project.lastPushedAt) ||
      a.project.name.localeCompare(b.project.name),
  );

  return {
    match: hits[0],
    candidates: hits.slice(1, 6).map((hit) => hit.project),
  };
}

export interface CommitStats {
  count: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  /** 최신순, 최대 RECENT_COMMIT_LIMIT개. 메시지 첫 줄만 */
  recentMessages: Array<{ date: string; message: string }>;
}

export interface ProjectHistory {
  project: NodeDetail;
  matchedBy: ProjectMatch["how"];
  /** 같은 이름으로 걸린 다른 책들 */
  otherCandidates?: string[];
  tech: Array<NodeBrief & { source?: UsesEdge["source"]; weight?: number }>;
  concepts: NodeBrief[];
  problems: NodeBrief[];
  periods: string[];
  commits: CommitStats | null;
  notes: string[];
}

export function buildProjectHistory(
  graph: KnowledgeGraph,
  match: ProjectMatch,
  snapshot: CollectionSnapshot | null,
  candidates: ProjectNode[] = [],
): ProjectHistory {
  const index = nodeIndex(graph);
  const project = match.project;
  const notes: string[] = [];

  const tech: ProjectHistory["tech"] = [];
  const concepts: NodeBrief[] = [];
  const problems: NodeBrief[] = [];
  const periods: string[] = [];

  for (const edge of graph.edges) {
    if (edge.kind === "USES" && edge.from === project.id) {
      const node = index.get(edge.to);
      if (!node) continue;
      const uses = edge as UsesEdge;
      tech.push({ ...nodeBrief(node), source: uses.source, weight: uses.weight });
    } else if (edge.kind === "ABOUT" && edge.from === project.id) {
      const node = index.get(edge.to);
      if (node) concepts.push(nodeBrief(node));
    } else if (edge.kind === "SOLVED" && edge.from === project.id) {
      const node = index.get(edge.to);
      if (node) problems.push(nodeBrief(node));
    } else if (edge.kind === "DEVELOPED" && edge.to === project.id) {
      const node = index.get(edge.from);
      if (node) periods.push(node.label);
    }
  }

  tech.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.label.localeCompare(b.label));
  concepts.sort((a, b) => a.label.localeCompare(b.label));
  problems.sort((a, b) => a.label.localeCompare(b.label));
  periods.sort();

  const history: ProjectHistory = {
    project: nodeDetail(project),
    matchedBy: match.how,
    tech,
    concepts,
    problems,
    periods,
    commits: null,
    notes,
  };

  if (candidates.length > 0) {
    history.otherCandidates = candidates.map((candidate) => candidate.fullName);
  }

  if (snapshot) {
    history.commits = commitStats(snapshot.commits, project.fullName);
    const repo = snapshot.repos.find((r) => r.fullName === project.fullName);
    if (repo) {
      if (repo.description) history.project.description = repo.description;
      history.project.createdAt = repo.createdAt;
    }
  } else {
    notes.push(
      "수집 스냅샷(data/{login}.json)이 없어 커밋 통계 없이 그래프만으로 답했습니다.",
    );
  }

  if (match.how !== "exact") {
    notes.push(`이름이 정확히 일치하지 않아 "${project.fullName}"로 해석했습니다.`);
  }

  return history;
}

export function commitStats(commits: Commit[], repoFullName: string): CommitStats {
  const mine = commits
    .filter((commit) => commit.repoFullName === repoFullName)
    .sort((a, b) => a.authoredAt.localeCompare(b.authoredAt));

  return {
    count: mine.length,
    firstCommitAt: mine.at(0)?.authoredAt ?? null,
    lastCommitAt: mine.at(-1)?.authoredAt ?? null,
    recentMessages: mine
      .slice(-RECENT_COMMIT_LIMIT)
      .reverse()
      .map((commit) => ({
        date: commit.authoredAt.slice(0, 10),
        message: firstLine(commit.message),
      })),
  };
}

function firstLine(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
