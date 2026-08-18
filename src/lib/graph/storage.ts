/**
 * ② 지식그래프 — 로컬 저장소.
 *
 * `data/graph/{login}.json`에 보관한다. `./data`가 유일한 진실이며
 * 나중에 MCP 서버·CLI가 같은 파일을 읽는다 (PLANNING.md §5 원칙 1).
 * Node fs를 쓰므로 서버에서만 import할 것.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { KnowledgeGraph } from "./types";

const GRAPH_DIR = path.join(process.cwd(), "data", "graph");

/** GitHub 로그인 규칙(영숫자 + 하이픈)만 통과시켜 경로 조작을 막는다. */
function safeLogin(login: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw new Error(`[graph] 유효하지 않은 login: ${login}`);
  }
  return login;
}

export function graphPath(login: string): string {
  return path.join(GRAPH_DIR, `${safeLogin(login)}.json`);
}

export async function saveGraph(graph: KnowledgeGraph): Promise<string> {
  const file = graphPath(graph.login);
  await fs.mkdir(GRAPH_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(graph, null, 2), "utf8");
  return file;
}

/** 저장된 그래프를 읽어온다. 없거나 깨졌으면 null. */
export async function loadGraph(
  login: string,
): Promise<KnowledgeGraph | null> {
  let raw: string;
  try {
    raw = await fs.readFile(graphPath(login), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as KnowledgeGraph;
  } catch {
    return null;
  }
}
