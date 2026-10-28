/**
 * `grimoire update` — 최신 GitHub 릴리스 버전으로 설치본을 올린다.
 *
 * npm 설치본(node_modules 안):  npm install -g @stjoo0925/grimoire@<버전>
 * git clone 설치본:              git fetch --tags origin → git merge --ff-only <태그> → npm install → npm run build
 * clone에서 고친 파일이 있거나 fast-forward가 안 되면 건드리지 않고 멈춘다.
 * MCP 설정에는 dist/cli.js의 절대경로가 들어 있고 두 방식 모두 같은 자리를 갈아 끼우므로, 설정은 그대로 둬도 된다.
 */
import { exec as execShell, execFile } from "node:child_process";
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

/**
 * --prefer-online: 로컬 npm 캐시의 패키지 정보를 믿지 않고 레지스트리에 다시 묻는다. 새 버전이 막 나온 직후에는 캐시가 아직
 * 옛 버전 목록을 들고 있어, 레지스트리에 있는 버전도 ETARGET("No matching version")으로 실패했다(0.10.0 배포 때 실제로 겪음).
 */
export function npmUpdateSteps(version: string): { command: string; args: string[] }[] {
  return [{ command: "npm", args: ["install", "-g", "--prefer-online", `${PACKAGE_NAME}@${version}`] }];
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

/** cmd.exe가 특별히 읽지 않는 글자만 — 공백·따옴표·`&|<>^%!()` 같은 셸 문법은 없다 */
const SAFE_SHELL_ARG = /^[\w@+=:,./\\-]+$/;

/**
 * Windows 셸(cmd.exe)에 넘길 명령 한 줄. 인자를 따옴표로 감싸 이스케이프하는 대신, 셸 문법이 될 수 있는 글자가 하나라도 있으면
 * 거절한다 — cmd.exe의 따옴표·`%`·`^` 규칙은 까다로워 이스케이프를 믿기 어렵다. 업데이트가 넘기는 인자는
 * `install`·`-g`·`@stjoo0925/grimoire@0.7.0`·`run`·`build`뿐이고, 버전은 이미 `1.2.3` 꼴로 검증된 것이다(core/update.ts).
 */
export function windowsCommandLine(command: string, args: string[]): string {
  for (const part of [command, ...args]) {
    if (!SAFE_SHELL_ARG.test(part)) throw new Error(`셸로 넘기기에 안전하지 않은 인자라 실행하지 않았습니다: ${JSON.stringify(part)}`);
  }
  return [command, ...args].join(" ");
}

/** 셸을 거쳐야 하는 명령인가 — Windows의 npm은 npm.cmd(배치 파일)라 셸 없이는 띄울 수 없다. git은 git.exe라 필요 없다 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && command === "npm";
}

function defaultExec(command: string, args: string[], cwd: string): Promise<string> {
  const options = { cwd, encoding: "utf8" as const, timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 };
  const done = (resolve: (value: string) => void, reject: (error: Error) => void) => (error: Error | null, stdout: string, stderr: string) => {
    if (error) reject(new Error(stderr.trim() || error.message));
    else resolve(stdout);
  };
  return new Promise((resolve, reject) => {
    if (needsShell(command)) {
      // 인자 배열과 shell: true를 함께 주면 Node 24가 DEP0190(인자를 이스케이프 없이 이어 붙임)을 경고한다.
      // 검증한 한 줄을 직접 만들어 셸에 넘긴다
      let line: string;
      try {
        line = windowsCommandLine(command, args);
      } catch (error) {
        reject(error as Error);
        return;
      }
      execShell(line, options, done(resolve, reject));
      return;
    }
    execFile(command, args, options, done(resolve, reject));
  });
}
