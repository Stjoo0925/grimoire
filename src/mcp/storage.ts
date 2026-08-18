/**
 * ② MCP 서버 — 파일 입출력.
 *
 * 웹앱과 같은 `./data`를 읽는다(PLANNING.md §5 원칙 1). 다만 MCP는 클라이언트가 띄우는
 * 프로세스라 cwd를 믿을 수 없으므로 데이터 디렉터리를 명시적으로 받는다.
 * 쓰기는 임시 파일 + rename으로 원자적으로 한다 — 중간에 죽어도 그래프가 깨지지 않는다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CollectionSnapshot } from "../lib/collector/types";
import type { KnowledgeGraph } from "../lib/graph/types";
import { graphDir, graphFile, snapshotFile } from "./paths";

/** data/graph 안에 그래프가 있는 login 목록 */
export async function listGraphLogins(dataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(graphDir(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.basename(entry, ".json"))
    .sort();
}

export async function readGraph(
  dataDir: string,
  login: string,
): Promise<KnowledgeGraph | null> {
  return readJson<KnowledgeGraph>(graphFile(dataDir, login));
}

export async function readSnapshot(
  dataDir: string,
  login: string,
): Promise<CollectionSnapshot | null> {
  return readJson<CollectionSnapshot>(snapshotFile(dataDir, login));
}

/** 임시 파일에 쓰고 rename — 같은 디렉터리라 원자적이다. */
export async function writeGraphAtomic(
  dataDir: string,
  graph: KnowledgeGraph,
): Promise<string> {
  const file = graphFile(dataDir, graph.login);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(graph, null, 2), "utf8");
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return file;
}

async function readJson<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
