/**
 * `grimoire update` — 최신 GitHub 릴리스 버전으로 설치본을 올린다.
 *
 * npm 설치본(node_modules 안):  npm install -g @stjoo0925/grimoire@<버전>
 * git clone 설치본:              git fetch --tags origin → git merge --ff-only <태그> → npm install → npm run build
 * clone에서 고친 파일이 있거나 fast-forward가 안 되면 건드리지 않고 멈춘다.
 * MCP 설정에는 dist/cli.js의 절대경로가 들어 있고 두 방식 모두 같은 자리를 갈아 끼우므로, 설정은 그대로 둬도 된다.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import { compareVersions, INSTALL_ROOT, isNpmInstall, PACKAGE_NAME, RELEASES_URL, refreshUpdateCache, VERSION } from "../core/update";

export type Exec = (command: string, args: string[], cwd: string) => Promise<string>;

export interface UpdateOptions {
  env?: Env;
  /** 설치 위치 (기본: 지금 돌고 있는 grimoire) */
  root?: string;
  /** 확인만 하고 설치는 하지 않음 */
  check?: boolean;
  dryRun?: boolean;
  current?: string;
  fetchImpl?: typeof fetch;
  exec?: Exec;
  log?: (line: string) => void;
}

const STEP_TIMEOUT_MS = 10 * 60 * 1000;

export function npmUpdateSteps(version: string): { command: string; args: string[] }[] {
  return [{ command: "npm", args: ["install", "-g", `${PACKAGE_NAME}@${version}`] }];
}

export function updateSteps(tag: string): { command: string; args: string[] }[] {
  return [
    { command: "git", args: ["fetch", "--tags", "origin"] },
    { command: "git", args: ["merge", "--ff-only", tag] },
    { command: "npm", args: ["install"] },
    { command: "npm", args: ["run", "build"] },
  ];
}

/** 종료 코드를 돌려준다 (0: 최신이거나 업데이트 완료, 1: 실패) */
export async function runUpdate(options: UpdateOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const exec = options.exec ?? defaultExec;
  const root = options.root ?? INSTALL_ROOT;
  const current = options.current ?? VERSION;

  // 사용자가 직접 부른 확인이므로 GRIMOIRE_UPDATE_CHECK=0이어도 묻는다
  const cache = await refreshUpdateCache({
    env: { ...(options.env ?? process.env), GRIMOIRE_UPDATE_CHECK: undefined },
    force: true,
    fetchImpl: options.fetchImpl,
  });
  if (!cache?.latest) {
    log(`최신 릴리스를 확인하지 못했습니다 (지금 ${current}). 네트워크를 확인하거나 ${RELEASES_URL}에서 직접 보세요.`);
    return 1;
  }
  if (compareVersions(cache.latest, current) <= 0) {
    log(`최신 버전입니다 (${current}).`);
    return 0;
  }
  const tag = cache.tag ?? `v${cache.latest}`;
  log(`새 버전 ${cache.latest}이 있습니다 (지금 ${current}).${cache.url ? `\n  ${cache.url}` : ""}`);
  if (options.check) {
    log("업데이트하려면: grimoire update");
    return 0;
  }

  const npm = isNpmInstall(root);
  if (!npm) {
    if (!fs.existsSync(path.join(root, ".git"))) {
      log(`${root}는 npm 설치본도 git clone도 아니라 자동으로 올릴 수 없습니다. npm install -g ${PACKAGE_NAME}로 다시 설치하세요.`);
      return 1;
    }
    const dirty = (await exec("git", ["status", "--porcelain", "--untracked-files=no"], root)).trim();
    if (dirty) {
      log(`${root}에 커밋하지 않은 변경이 있어 멈춥니다:\n${dirty}\n정리한 뒤 다시 실행하세요.`);
      return 1;
    }
  }

  // npm -g는 설치본 폴더 자체를 갈아 끼우므로 그 안에서 돌리지 않는다
  const cwd = npm ? os.homedir() : root;
  for (const step of npm ? npmUpdateSteps(cache.latest) : updateSteps(tag)) {
    const line = `${step.command} ${step.args.join(" ")}`;
    log(`${options.dryRun ? "(dry-run) " : ""}→ ${line}`);
    if (options.dryRun) continue;
    try {
      await exec(step.command, step.args, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`실패: ${line}\n${message}`);
      if (npm && /EACCES/.test(message)) log(`전역 설치 폴더에 쓸 권한이 없습니다. 처음 설치한 방식대로(예: sudo) '${line}'을 직접 실행하세요.`);
      if (step.args[0] === "merge") log(`로컬 브랜치가 ${tag}로 fast-forward되지 않습니다. 직접 'git checkout ${tag}' 후 'npm install && npm run build'를 실행하세요.`);
      return 1;
    }
  }
  if (options.dryRun) return 0;
  log(`\n${current} → ${cache.latest} 완료. MCP 클라이언트를 다시 시작하세요 (Claude Desktop은 ⌘Q로 완전히 종료).`);
  log("문제가 있으면: grimoire doctor");
  return 0;
}

function defaultExec(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      // Windows에서 npm은 npm.cmd라 셸을 거쳐야 한다
      { cwd, encoding: "utf8", timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}
