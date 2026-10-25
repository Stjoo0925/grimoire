/**
 * 경로와 환경 설정.
 *
 * 상태는 전부 `GRIMOIRE_HOME`(기본 `~/.grimoire`) 아래 SQLite 파일 하나에 있다.
 * 외부 API는 없다 — 임베딩을 켜면 로컬 Ollama에만 닿는다.
 */
import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export function grimoireHome(env: Env = process.env): string {
  const configured = env.GRIMOIRE_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".grimoire");
}

export function dbPath(env: Env = process.env): string {
  return path.join(grimoireHome(env), "grimoire.db");
}

export function ollamaHost(env: Env = process.env): string {
  return (env.OLLAMA_HOST?.trim() || DEFAULT_OLLAMA_HOST).replace(/\/$/, "");
}

export function embedModel(env: Env = process.env): string {
  return env.OLLAMA_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
}
