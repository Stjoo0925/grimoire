/**
 * ② MCP 서버 — 실행 컨텍스트(데이터 디렉터리 + login) 해석.
 *
 * 그래프는 호출 때마다 다시 읽는다 — 웹앱이 그래프를 다시 구워도 MCP를 재시작할 필요가 없다.
 */
import type { CollectionSnapshot } from "../lib/collector/types";
import type { KnowledgeGraph } from "../lib/graph/types";
import { dataDirCandidates, pickLogin, type McpEnv } from "./paths";
import { listGraphLogins, readGraph, readSnapshot } from "./storage";

export interface McpContext {
  dataDir: string;
  login: string;
}

/**
 * 데이터 디렉터리 후보를 순서대로 훑어 그래프가 있는 곳을 고르고, login을 정한다.
 * (GRIMOIRE_LOGIN → 후보가 하나뿐이면 그것 → 아니면 한국어 안내와 함께 실패)
 */
export async function resolveContext(
  env: McpEnv,
  moduleDir: string,
  cwd: string,
): Promise<McpContext> {
  const candidates = dataDirCandidates(env, moduleDir, cwd);
  for (const dataDir of candidates) {
    const logins = await listGraphLogins(dataDir);
    if (logins.length === 0) continue;
    return { dataDir, login: pickLogin(logins, env.GRIMOIRE_LOGIN) };
  }
  throw new Error(
    "[mcp] 그래프 JSON을 찾지 못했습니다. 찾아본 곳: " +
      candidates.map((dir) => `${dir}/graph`).join(", ") +
      ". 웹앱(npm run dev)에서 수집 → 그래프 생성을 먼저 실행하거나 " +
      "GRIMOIRE_DATA_DIR로 데이터 디렉터리를 지정하세요.",
  );
}

export async function loadGraphOrThrow(
  context: McpContext,
): Promise<KnowledgeGraph> {
  const graph = await readGraph(context.dataDir, context.login);
  if (!graph) {
    throw new Error(
      `[mcp] ${context.login}의 그래프를 읽지 못했습니다 (${context.dataDir}/graph/${context.login}.json). ` +
        "웹앱에서 그래프를 다시 생성해 보세요.",
    );
  }
  return graph;
}

export async function loadSnapshotOrNull(
  context: McpContext,
): Promise<CollectionSnapshot | null> {
  return readSnapshot(context.dataDir, context.login);
}
