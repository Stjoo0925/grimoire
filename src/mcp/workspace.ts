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
 * Claude Desktop은 cwd가 `/`라 해당이 없다 — add_repo나 `grimoire scan`으로 등록한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import type { DB } from "../core/db";
import { repoRoot } from "../core/git";
import { addRepo, syncRepo, type RepoRow } from "../core/indexer";

export interface Workspace {
  /** cwd가 속한 레포의 최상위 경로 (해당 없으면 null) */
  root: string | null;
  /** 자동 등록이 꺼져 있는가 */
  disabled: boolean;
  /**
   * 등록·첫 동기화를 시작한다(여러 번 불러도 한 번만). 등록·첫 인덱싱이 끝나면 그 레포,
   * 꺼졌거나 해당 없으면 null. 이미 등록된 레포면 곧바로 풀리고 동기화는 뒤에서 계속된다.
   */
  begin(): Promise<RepoRow | null>;
}

function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
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

export function startWorkspace(db: DB, root: string | null, env: Env, log: (line: string) => void): Workspace {
  const disabled = env.GRIMOIRE_AUTO_ADD === "0";
  let started: Promise<RepoRow | null> | null = null;

  const sync = (repo: RepoRow) =>
    syncRepo(db, repo).then(
      (result) => {
        if (result.added > 0 || result.files > 0) log(`${repo.name}: 새 커밋 ${result.added}개, 바뀐 파일 ${result.files}개`);
        return repo;
      },
      (error) => {
        log(`${repo.name} 동기화 실패 — ${error instanceof Error ? error.message : error}`);
        return repo;
      },
    );

  const run = (): Promise<RepoRow | null> => {
    if (!root || disabled) return Promise.resolve(null);
    const known = db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as RepoRow | undefined;
    if (known) {
      void sync(known);
      return Promise.resolve(known);
    }
    return addRepo(db, root).then(
      (repo) => {
        log(`작업 중인 프로젝트를 등록합니다: ${repo.name} (${root})`);
        return sync(repo);
      },
      (error) => {
        log(`작업 레포 자동 등록 실패 — ${error instanceof Error ? error.message : error}`);
        return null;
      },
    );
  };

  return {
    root,
    disabled,
    begin: () => (started ??= run()),
  };
}

/** 시작시키고 기다린다 — 첫 인덱싱이 오래 걸려도 질의를 무한정 붙잡지 않는다 */
export async function waitForWorkspace(workspace: Workspace | undefined, timeoutMs: number): Promise<RepoRow | null> {
  if (!workspace) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([workspace.begin(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
