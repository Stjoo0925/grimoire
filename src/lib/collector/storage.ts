/**
 * ① 수집기(Collector) — 로컬 "소장" 저장소.
 *
 * 수집 결과를 `data/{login}.json`에 그대로 보관한다(PLANNING.md §3 "수집 후 로컬 저장").
 * Node fs를 쓰므로 서버(서버 컴포넌트 / 서버 액션)에서만 import할 것.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CollectionSnapshot } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");

/** GitHub 로그인 규칙(영숫자 + 하이픈)만 통과시켜 경로 조작을 막는다. */
function safeLogin(login: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw new Error(`[collector] 유효하지 않은 login: ${login}`);
  }
  return login;
}

export function snapshotPath(login: string): string {
  return path.join(DATA_DIR, `${safeLogin(login)}.json`);
}

/** 수집 결과를 소장한다 (같은 login이면 덮어쓴다). */
export async function saveSnapshot(
  snapshot: CollectionSnapshot,
): Promise<string> {
  const file = snapshotPath(snapshot.login);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");
  return file;
}

/** 소장된 수집 결과를 꺼낸다. 없으면 null. */
export async function loadSnapshot(
  login: string,
): Promise<CollectionSnapshot | null> {
  let raw: string;
  try {
    raw = await fs.readFile(snapshotPath(login), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as CollectionSnapshot;
  } catch {
    // 손상된 스냅샷은 없는 것으로 취급 — 다시 수집하면 덮어쓴다.
    return null;
  }
}
