/**
 * ② MCP 서버 — 도구 3종의 정의와 실행 (SDK 배선과 분리).
 *
 *   query_grimoire_graph  — 키워드로 서브그래프 질의
 *   get_project_history   — 책 한 권(레포)의 기술·개념·문제·커밋 이력
 *   record_new_learning   — 새로 배운 것을 그래프에 기록 (유일한 쓰기 경로)
 *
 * stdio/HTTP 어느 전송이든 여기 있는 같은 구현을 부른다.
 */
import path from "node:path";

import {
  loadGraphOrThrow,
  loadSnapshotOrNull,
  type McpContext,
} from "./context";
import { recordLearning } from "./learning";
import { buildProjectHistory, resolveProject } from "./project";
import { searchGraph } from "./search";
import { writeGraphAtomic } from "./storage";

export const TOOLS = [
  {
    name: "query_grimoire_graph",
    description:
      "개발자의 과거 커밋·기술 스택·문제해결 이력 지식그래프를 키워드로 검색해 연관 서브그래프를 돌려줍니다. " +
      "기술명(react, next.js), 개념(realtime, 인증), 프로젝트명 모두 됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색할 기술/개념/프로젝트 키워드" },
        limit: { type: "number", description: "시드 노드 수 (기본 8, 최대 25)" },
        hops: { type: "number", description: "펼칠 홉 수 1~2 (기본 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_project_history",
    description:
      "특정 프로젝트(레포)의 이력을 조회합니다 — 메타(주 언어·공개 여부·날짜), 사용 기술, 개념, " +
      "해결한 문제, 개발 시기, 그리고 커밋 통계와 최근 커밋 메시지.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "레포 이름 또는 owner/repo (부분 일치 가능)",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "record_new_learning",
    description:
      "대화 중 새로 알게 된 기술·개념을 지식그래프에 기록합니다. 이미 있으면 메모만 갱신하고 " +
      "already known으로 알려줍니다. 기록한 노드는 그래프를 다시 구워도 보존됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "기술 또는 개념 이름" },
        kind: {
          type: "string",
          enum: ["tech", "concept"],
          description: "tech = 프레임워크/라이브러리/도구, concept = 도메인 개념",
        },
        note: { type: "string", description: "남길 메모 (선택)" },
        relatedProject: {
          type: "string",
          description: "연결할 프로젝트 이름 (선택)",
        },
      },
      required: ["name", "kind"],
    },
  },
] as const;

/** 도구 이름 → 실행. 결과는 JSON 텍스트로 감싸 돌려준다. */
export async function callTool(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "query_grimoire_graph":
      return queryGraph(context, args);
    case "get_project_history":
      return projectHistory(context, args);
    case "record_new_learning":
      return newLearning(context, args);
    default:
      throw new Error(`[mcp] 알 수 없는 도구입니다: ${name}`);
  }
}

async function queryGraph(context: McpContext, args: Record<string, unknown>) {
  const query = requireString(args.query, "query");
  const graph = await loadGraphOrThrow(context);
  return {
    login: context.login,
    graphBuiltAt: graph.builtAt,
    ...searchGraph(graph, query, {
      limit: optionalNumber(args.limit),
      hops: optionalNumber(args.hops),
    }),
  };
}

async function projectHistory(context: McpContext, args: Record<string, unknown>) {
  const query = requireString(args.project, "project");
  const graph = await loadGraphOrThrow(context);
  const { match, candidates } = resolveProject(graph, query);
  if (!match) {
    const names = graph.nodes
      .filter((node) => node.kind === "project")
      .map((node) => node.label)
      .sort()
      .slice(0, 20);
    return {
      login: context.login,
      found: false,
      message: `"${query}"에 해당하는 프로젝트를 찾지 못했습니다.`,
      someProjects: names,
    };
  }
  const snapshot = await loadSnapshotOrNull(context);
  return {
    login: context.login,
    found: true,
    ...buildProjectHistory(graph, match, snapshot, candidates),
  };
}

async function newLearning(context: McpContext, args: Record<string, unknown>) {
  const name = requireString(args.name, "name");
  const kind = requireString(args.kind, "kind");
  if (kind !== "tech" && kind !== "concept") {
    throw new Error('[mcp] kind는 "tech" 또는 "concept" 이어야 합니다.');
  }
  const graph = await loadGraphOrThrow(context);
  const result = recordLearning(graph, {
    name,
    kind,
    note: optionalString(args.note),
    relatedProject: optionalString(args.relatedProject),
  });
  const file = await writeGraphAtomic(context.dataDir, result.graph);
  return {
    login: context.login,
    nodeId: result.nodeId,
    label: result.label,
    alreadyKnown: result.alreadyKnown,
    addedEdges: result.addedEdges,
    linkedProject: result.linkedProject,
    period: result.period,
    messages: result.messages,
    savedTo: path.basename(file),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[mcp] ${field}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
