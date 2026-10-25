/**
 * 업데이트 확인 — 기준은 GitHub 릴리스(Stjoo0925/grimoire)다. npm에도 같은 버전으로 배포한다.
 *
 * 하루 한 번만 최신 릴리스를 묻고 결과를 `GRIMOIRE_HOME/update.json`에 둔다.
 * 알림(MCP hint·CLI·doctor)은 이 캐시만 읽으므로 네트워크를 기다리지 않는다.
 * Grimoire가 외부로 나가는 유일한 요청이다 — 보내는 것은 버전 조회 하나뿐이고,
 * `GRIMOIRE_UPDATE_CHECK=0`이면 아예 묻지 않는다.
 */
import fs from "node:fs";
import path from "node:path";

import { grimoireHome, type Env } from "./config";

export const RELEASE_REPO = "Stjoo0925/grimoire";
/** npm 패키지 이름 — 릴리스마다 GitHub 태그와 같은 버전으로 배포한다 */
export const PACKAGE_NAME = "@stjoo0925/grimoire";
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3_000;

/** 설치 위치 (package.json이 있는 폴더) — dist/·.test-out/ 어디서 돌든 위로 올라가 찾는다 */
export const INSTALL_ROOT = findInstallRoot(__dirname);
export const VERSION = readVersion(INSTALL_ROOT);

/** npm으로 깐 설치본인지 (아니면 git clone) */
export function isNpmInstall(root: string): boolean {
  return root.split(path.sep).includes("node_modules");
}

function findInstallRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === PACKAGE_NAME) return dir;
    } catch {
      // 없으면 위로
    }
    if (path.dirname(dir) === dir) return from;
  }
}

function readVersion(root: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface UpdateCache {
  /** 마지막으로 물어본 시각 (실패해도 기록 — 하루 한 번만 묻는다) */
  checkedAt: string;
  /** 최신 릴리스 버전 (v 없이) */
  latest?: string;
  /** 릴리스 태그 (예: v0.3.0) */
  tag?: string;
  url?: string;
}

export interface UpdateStatus {
  current: string;
  latest: string;
  tag: string;
  url: string;
}

export function updateCheckEnabled(env: Env = process.env): boolean {
  return env.GRIMOIRE_UPDATE_CHECK !== "0";
}

function cachePath(env: Env): string {
  return path.join(grimoireHome(env), "update.json");
}

export function readUpdateCache(env: Env = process.env): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(env), "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

/** "0.10.0" > "0.9.1". 앞의 v와 -prerelease는 무시한다. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.replace(/^v/, "").split("-")[0].split(".").map((part) => Number(part) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export interface RefreshOptions {
  env?: Env;
  /** 하루가 안 지났어도 다시 묻기 (doctor·update) */
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
}

/**
 * 캐시가 하루 넘었으면 최신 릴리스를 물어 캐시를 갱신한다. 꺼져 있으면 아무것도 하지 않는다.
 * 실패해도 던지지 않는다 — 이전에 알던 최신 버전은 남겨 둔다.
 */
export async function refreshUpdateCache(options: RefreshOptions = {}): Promise<UpdateCache | null> {
  const env = options.env ?? process.env;
  if (!updateCheckEnabled(env)) return null;
  const now = options.now ?? new Date();
  const cached = readUpdateCache(env);
  if (!options.force && cached && now.getTime() - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS) return cached;

  const next: UpdateCache = { ...cached, checkedAt: now.toISOString() };
  try {
    const res = await (options.fetchImpl ?? fetch)(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `grimoire/${VERSION}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: string; html_url?: string };
      if (body.tag_name) {
        next.tag = body.tag_name;
        next.latest = body.tag_name.replace(/^v/, "");
        next.url = body.html_url ?? RELEASES_URL;
      }
    }
  } catch {
    // 오프라인·타임아웃 — 다음 날 다시 묻는다
  }
  try {
    fs.mkdirSync(grimoireHome(env), { recursive: true });
    fs.writeFileSync(cachePath(env), JSON.stringify(next, null, 2));
  } catch {
    // 캐시를 못 써도 기능에는 지장 없다
  }
  return next;
}

/** 캐시 기준으로 새 버전이 있으면 그 정보. 없거나 꺼져 있으면 null. */
export function pendingUpdate(env: Env = process.env, current = VERSION): UpdateStatus | null {
  if (!updateCheckEnabled(env)) return null;
  const cached = readUpdateCache(env);
  if (!cached?.latest || compareVersions(cached.latest, current) <= 0) return null;
  return { current, latest: cached.latest, tag: cached.tag ?? `v${cached.latest}`, url: cached.url ?? RELEASES_URL };
}

/** AI가 사용자에게 전할 업데이트 안내 한 줄 */
export function updateHint(status: UpdateStatus): string {
  return `Grimoire ${status.latest}이 나왔습니다(지금 ${status.current}). 답을 마친 뒤 사용자에게 알려 주세요: 터미널에서 'grimoire update' 후 클라이언트 재시작.`;
}
