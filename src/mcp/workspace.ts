/**
 * 작업 중인 프로젝트 자동 등록 — Claude Code·Cursor는 MCP 서버를 열려 있는 프로젝트 폴더에서 띄운다.
 *
 * 그 폴더가 git 레포이고 아직 등록 전이면 등록하고 **다른 레포보다 먼저** 동기화한다.
 * `GRIMOIRE_AUTO_ADD=0`이면 끈다. 홈 디렉터리·루트(`/`)가 레포인 경우(닷파일 관리 등)는 건너뛴다.
 * Claude Desktop은 cwd가 `/`라 해당이 없다 — add_repo나 `grimoire scan`으로 등록한다.
 */
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import type { DB } from "../core/db";
import { repoRoot } from "../core/git";
import { addRepo, syncRepo, type RepoRow } from "../core/indexer";

export interface Workspace {
  /** cwd가 속한 레포의 최상위 경로 (git 레포가 아니면 null) */
  root: string | null;
  /** 등록·첫 인덱싱이 끝나면 그 레포 (자동 등록이 꺼졌거나 해당 없으면 null) */
  ready: Promise<RepoRow | null>;
  /** 자동 등록이 꺼져 있는가 */
  disabled: boolean;
}

export async function resolveWorkspaceRoot(cwd: string): Promise<string | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) return null;
  return resolved;
}

/**
 * 작업 레포를 등록하고 첫 동기화를 시작한다.
 * 이미 등록된 레포면 ready는 곧바로 풀리고(동기화는 뒤에서 계속), 새 레포면 첫 인덱싱이 끝나야 풀린다.
 */
export function startWorkspace(db: DB, root: string | null, env: Env, log: (line: string) => void): Workspace {
  const disabled = env.GRIMOIRE_AUTO_ADD === "0";
  if (!root || disabled) return { root, ready: Promise.resolve(null), disabled };

  const known = db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as RepoRow | undefined;
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

  if (known) {
    void sync(known);
    return { root, ready: Promise.resolve(known), disabled };
  }
  const ready = addRepo(db, root).then(
    (repo) => {
      log(`작업 중인 프로젝트를 등록합니다: ${repo.name} (${root})`);
      return sync(repo);
    },
    (error) => {
      log(`작업 레포 자동 등록 실패 — ${error instanceof Error ? error.message : error}`);
      return null;
    },
  );
  return { root, ready, disabled };
}

/** 첫 인덱싱이 오래 걸려도 질의를 무한정 붙잡지 않는다 */
export async function waitForWorkspace(workspace: Workspace | undefined, timeoutMs: number): Promise<RepoRow | null> {
  if (!workspace) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([workspace.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
