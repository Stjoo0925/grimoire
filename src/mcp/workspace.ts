/**
 * 작업 중인 프로젝트 자동 등록 — Claude Code·Cursor는 MCP 서버를 열려 있는 프로젝트 폴더에서 띄운다.
 *
 * 그 폴더가 git 레포이고 아직 등록 전이면 등록하고 **다른 레포보다 먼저** 동기화한다.
 *  - `GRIMOIRE_AUTO_ADD=0`이면 끈다. `=1`이면 아래의 임시 폴더 제외까지 무시하고 등록한다.
 *  - 홈 디렉터리·루트(`/`)가 레포인 경우(닷파일 관리 등)는 건너뛴다.
 *  - 임시 폴더(`/tmp`, macOS `/var/folders` 등) 안의 레포는 건너뛴다 — 다른 도구·세션이 만든 일회용 레포가
 *    실제 기억에 쌓이지 않게.
 *  - 바로 시작하지 않는다(begin). `claude mcp list` 같은 연결 확인은 서버를 띄웠다가 곧 끄는데,
 *    그때 등록만 되고 동기화는 못 끝난 빈 레포가 남기 때문이다. 첫 도구 호출이나 잠깐 뒤(server.ts)에 시작한다.
 * cwd가 레포가 아니면(전역 설정으로 홈·`/`에서 뜬 경우) 클라이언트가 roots를 지원할 때 그 작업 폴더를 대신 쓴다(server.ts).
 * 둘 다 없으면 add_repo나 `grimoire scan`으로 등록한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Env } from "../core/config";
import type { DB } from "../core/db";
import { repoRoot } from "../core/git";
import { indexCommitCode } from "../core/diffs";
import { addRepo, syncRepo, type RepoRow } from "../core/indexer";

export interface Workspace {
  /** 작업 레포의 최상위 경로 (해당 없으면 null). roots로 정할 때는 begin()이 풀린 뒤에 채워진다 */
  readonly root: string | null;
  /** 자동 등록이 꺼져 있는가 */
  disabled: boolean;
  /**
   * 등록·첫 동기화를 시작한다(여러 번 불러도 한 번만). 등록·첫 인덱싱이 끝나면 그 레포,
   * 꺼졌거나 해당 없으면 null. 이미 등록된 레포면 곧바로 풀리고 동기화는 뒤에서 계속된다.
   */
  begin(): Promise<RepoRow | null>;
  /**
   * 작업 레포를 다시 동기화한다 — 방금 만든 커밋·고친 파일도 검색되게. 바뀐 게 없으면 git 몇 번 부르고 끝난다.
   * 직전 동기화 뒤 REFRESH_INTERVAL_MS가 안 지났으면 건너뛰고, maxWaitMs 넘게 걸리면 기다리지 않는다(뒤에서 계속).
   */
  refresh?(repo: RepoRow, maxWaitMs: number): Promise<void>;
}

/** 작업 레포 재동기화 간격 — 검색마다 git을 부르지 않게 */
export const REFRESH_INTERVAL_MS = 15_000;

/** 뒤에서 도는 작업을 서버가 종료 때 기다리고 멈출 수 있게 (server.ts) */
export interface Background {
  /** 서버 종료 신호 — 한 요청의 취소가 아니라 프로세스가 끝날 때만 취소된다 */
  signal?: AbortSignal;
  /** 진행 중인 작업으로 등록한다 (끝나면 저절로 빠진다) */
  track?: (job: Promise<unknown>) => void;
}

/**
 * native는 Windows의 8.3 짧은 이름(C:\Users\RUNNER~1\…)까지 긴 이름으로 푼다 — git이 돌려주는 최상위 경로와 같은 꼴이 된다.
 * JS판 realpathSync는 심볼릭 링크만 풀고 짧은 이름은 그대로 둔다.
 */
function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** 일회용 레포가 생기는 임시 폴더들 (macOS는 /tmp → /private/tmp, $TMPDIR → /private/var/folders/…) */
function tempRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of [os.tmpdir(), "/tmp", "/var/tmp", "/var/folders"]) {
    roots.add(path.resolve(dir));
    roots.add(realpathOrSelf(dir));
  }
  return [...roots];
}

export function isTempPath(dir: string): boolean {
  const resolved = realpathOrSelf(dir);
  return tempRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

export async function resolveWorkspaceRoot(cwd: string, env: Env = process.env): Promise<string | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) return null;
  if (env.GRIMOIRE_AUTO_ADD !== "1" && isTempPath(resolved)) return null;
  return resolved;
}

/**
 * 클라이언트가 알려 준 작업 폴더(roots의 file:// URI) 중 처음으로 등록할 만한 레포.
 * 레포가 아니거나 홈·루트·임시 폴더면 건너뛴다 — cwd와 같은 기준(resolveWorkspaceRoot)이다.
 */
export async function rootFromRoots(uris: readonly string[], env: Env = process.env): Promise<string | null> {
  for (const uri of uris) {
    if (!uri.startsWith("file:")) continue;
    let dir: string;
    try {
      dir = fileURLToPath(uri);
    } catch {
      continue;
    }
    const root = await resolveWorkspaceRoot(dir, env);
    if (root) return root;
  }
  return null;
}

/**
 * root는 정해진 경로, 또는 begin() 때 한 번 부를 찾기 함수(roots 조회처럼 연결 뒤에야 알 수 있는 것)다.
 * 자동 등록이 꺼져 있으면 찾기 함수도 부르지 않는다.
 */
export function startWorkspace(
  db: DB,
  root: string | null | (() => Promise<string | null>),
  env: Env,
  log: (line: string) => void,
  background: Background = {},
): Workspace {
  const disabled = env.GRIMOIRE_AUTO_ADD === "0";
  const lookup = typeof root === "function" ? root : null;
  let current = typeof root === "function" ? null : root;
  let started: Promise<RepoRow | null> | null = null;
  let lastSync = 0;
  const { signal, track } = background;

  const sync = (repo: RepoRow) => {
    lastSync = Date.now();
    const job = syncRepo(db, repo, signal).then(
      (result) => {
        if (result.added > 0 || result.files > 0) log(`${repo.name}: 새 커밋 ${result.added}개, 바뀐 파일 ${result.files}개`);
        // 새 커밋의 diff 식별자는 뒤에서 채운다 — 검색은 기다리지 않는다
        if (result.added > 0) {
          const diff = indexCommitCode(db, repo, signal).catch((error) =>
            log(`${repo.name} diff 색인 실패 — ${error instanceof Error ? error.message : error}`),
          );
          track?.(diff);
        }
        return repo;
      },
      (error) => {
        log(`${repo.name} 동기화 실패 — ${error instanceof Error ? error.message : error}`);
        return repo;
      },
    );
    track?.(job);
    return job;
  };

  const run = async (): Promise<RepoRow | null> => {
    if (disabled) return null;
    if (lookup) current = await lookup().catch(() => null);
    const dir = current;
    if (!dir) return null;
    const known = db.prepare("SELECT * FROM repos WHERE path = ?").get(dir) as RepoRow | undefined;
    if (known) {
      void sync(known);
      return known;
    }
    return addRepo(db, dir, signal).then(
      (repo) => {
        log(`작업 중인 프로젝트를 등록합니다: ${repo.name} (${dir})`);
        return sync(repo);
      },
      (error) => {
        log(`작업 레포 자동 등록 실패 — ${error instanceof Error ? error.message : error}`);
        return null;
      },
    );
  };

  return {
    get root() {
      return current;
    },
    disabled,
    begin: () => (started ??= run()),
    refresh: async (repo, maxWaitMs) => {
      if (disabled || repo.path !== current || Date.now() - lastSync < REFRESH_INTERVAL_MS) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
      });
      try {
        await Promise.race([sync(repo).then(() => undefined), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 작업 레포별 기다림 상태 — 한 번 시간을 넘겼으면 첫 인덱싱이 끝날 때까지 다시 기다리지 않는다 */
interface WaitState {
  settled: boolean;
  value: RepoRow | null;
  gaveUp: boolean;
}
const waits = new WeakMap<Workspace, WaitState>();

/**
 * 시작시키고 기다린다 — 첫 인덱싱이 오래 걸려도 질의를 무한정 붙잡지 않는다.
 * 한 번 timeoutMs를 넘겼으면 그 뒤 호출은 기다리지 않고 곧바로 null이다(호출마다 15초씩 늦어지지 않게).
 * begin()이 실제로 풀리면 그때부터 다시 그 레포를 돌려준다.
 */
export async function waitForWorkspace(workspace: Workspace | undefined, timeoutMs: number): Promise<RepoRow | null> {
  if (!workspace) return null;
  let state = waits.get(workspace);
  const begun = workspace.begin();
  if (!state) {
    const created: WaitState = { settled: false, value: null, gaveUp: false };
    waits.set(workspace, created);
    begun.then(
      (value) => Object.assign(created, { settled: true, value }),
      () => Object.assign(created, { settled: true, value: null }),
    );
    state = created;
  }
  if (state.settled) return state.value;
  if (state.gaveUp) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      state.gaveUp = true;
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([begun, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
