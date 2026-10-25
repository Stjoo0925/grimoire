/**
 * `grimoire install <client>` — MCP 클라이언트 설정을 자동으로 써 넣는다.
 *
 * 명령은 **지금 이 CLI를 돌리는 node의 절대경로**(`process.execPath`)로 적는다.
 *  - GUI 앱(Claude Desktop·Cursor)은 셸 PATH를 물려받지 않아 `node`만 적으면 못 찾는다.
 *  - better-sqlite3는 네이티브 모듈이라 빌드한 node와 같은 node로 돌려야 한다.
 * 기존 설정 파일은 다른 서버 항목을 그대로 두고 grimoire 항목만 넣거나 바꾼다.
 * 덮어쓰기 전에 `.bak`을 남기고, 임시 파일 + rename으로 쓴다.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";

export const SERVER_NAME = "grimoire";
export const CLIENTS = ["claude-code", "claude-desktop", "cursor"] as const;
export type ClientName = (typeof CLIENTS)[number];

/** 설정에 함께 옮겨 적는 환경 변수 — CLI와 MCP가 같은 DB·같은 "나"를 보게 한다. */
const FORWARDED_ENV = ["GRIMOIRE_HOME", "GRIMOIRE_ME", "OLLAMA_HOST", "OLLAMA_EMBED_MODEL"] as const;

export interface ServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function serverSpec(cliPath: string, env: Env = process.env, nodePath = process.execPath): ServerSpec {
  const forwarded: Record<string, string> = {};
  for (const key of FORWARDED_ENV) {
    const value = env[key]?.trim();
    if (value) forwarded[key] = key === "GRIMOIRE_HOME" ? path.resolve(value) : value;
  }
  return {
    command: nodePath,
    args: [path.resolve(cliPath), "mcp"],
    ...(Object.keys(forwarded).length > 0 ? { env: forwarded } : {}),
  };
}

/** 클라이언트별 JSON 설정 파일 경로. claude-code는 프로젝트 범위(.mcp.json)일 때만 파일을 쓴다. */
export function configPath(
  client: ClientName,
  options: { project?: string; platform?: NodeJS.Platform; home?: string; appData?: string } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  switch (client) {
    case "claude-desktop":
      if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") {
        return path.join(options.appData ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      }
      return path.join(home, ".config", "Claude", "claude_desktop_config.json");
    case "cursor":
      return options.project ? path.join(options.project, ".cursor", "mcp.json") : path.join(home, ".cursor", "mcp.json");
    case "claude-code":
      return options.project ? path.join(options.project, ".mcp.json") : null;
  }
}

/** 기존 설정 JSON에 grimoire 항목만 넣는다. 다른 키·다른 서버는 건드리지 않는다. */
export function mergeServer(existing: unknown, spec: ServerSpec): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};
  servers[SERVER_NAME] = spec;
  base.mcpServers = servers;
  return base;
}

export interface InstallResult {
  client: ClientName;
  /** 쓴 파일 (claude CLI로 등록했으면 null) */
  file: string | null;
  backup: string | null;
  /** 이미 같은 설정이었으면 true */
  unchanged: boolean;
  /** claude CLI로 등록했을 때 실행한 명령 */
  command?: string;
  /** 사용자가 할 일 (재시작 등) */
  next: string;
}

export interface InstallOptions {
  cliPath: string;
  env?: Env;
  /** 프로젝트 범위로 설치할 디렉터리 (claude-code: .mcp.json, cursor: .cursor/mcp.json) */
  project?: string;
  /** 파일을 쓰지 않고 무엇을 할지만 돌려준다 */
  dryRun?: boolean;
  home?: string;
}

export class InstallError extends Error {}

export async function install(client: ClientName, options: InstallOptions): Promise<InstallResult & { spec: ServerSpec }> {
  const spec = serverSpec(options.cliPath, options.env);
  if (!fs.existsSync(spec.args[0])) {
    throw new InstallError(`CLI 파일이 없습니다: ${spec.args[0]} — 먼저 'npm run build'를 하세요.`);
  }

  const next = NEXT_STEP[client];
  const file = configPath(client, { project: options.project, home: options.home });

  if (file === null) {
    // claude-code 사용자 범위: 설정 파일(~/.claude.json)을 직접 고치지 않고 공식 CLI에 맡긴다.
    const args = claudeAddArgs(spec);
    const command = ["claude", ...args].map(shellQuote).join(" ");
    if (options.dryRun) return { client, file: null, backup: null, unchanged: false, command, next, spec };
    if (!(await hasCommand("claude"))) {
      throw new InstallError(
        "claude 명령을 찾지 못했습니다. Claude Code를 설치한 뒤 다시 하거나, 아래 명령을 직접 실행하세요:\n  " +
          command +
          "\n또는 프로젝트 범위로 설치: grimoire install claude-code --project <레포 경로>",
      );
    }
    await run("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]).catch(() => undefined);
    await run("claude", args);
    return { client, file: null, backup: null, unchanged: false, command, next, spec };
  }

  let existing: unknown = {};
  let raw: string | null = null;
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, "utf8");
    if (raw.trim()) {
      try {
        existing = JSON.parse(raw);
      } catch {
        throw new InstallError(`설정 파일이 올바른 JSON이 아니라 건드리지 않았습니다: ${file}`);
      }
    }
  }

  const merged = mergeServer(existing, spec);
  const text = JSON.stringify(merged, null, 2) + "\n";
  const unchanged = raw !== null && JSON.stringify(existing) === JSON.stringify(merged);
  if (options.dryRun || unchanged) {
    return { client, file, backup: null, unchanged, next, spec };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // rename은 새 파일을 만드는 것이라 권한을 따로 옮겨야 한다 (설정 파일은 보통 600)
  const mode = raw !== null ? fs.statSync(file).mode & 0o777 : 0o600;
  let backup: string | null = null;
  if (raw !== null) {
    backup = `${file}.bak`;
    fs.writeFileSync(backup, raw, { mode });
    fs.chmodSync(backup, mode);
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
  return { client, file, backup, unchanged: false, next, spec };
}

const NEXT_STEP: Record<ClientName, string> = {
  "claude-code": "새 Claude Code 세션에서 /mcp로 grimoire가 연결됐는지 확인하세요.",
  "claude-desktop": "Claude Desktop을 완전히 종료(⌘Q)했다가 다시 여세요.",
  cursor: "Cursor 설정 → MCP에서 grimoire를 켜거나 Cursor를 다시 시작하세요.",
};

export function claudeAddArgs(spec: ServerSpec): string[] {
  const envArgs = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return ["mcp", "add", "--scope", "user", ...envArgs, SERVER_NAME, "--", spec.command, ...spec.args];
}

/** 이미 써 둔 설정 파일에서 grimoire 항목을 읽는다 (doctor용). 없으면 null. */
export function readInstalled(file: string): ServerSpec | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, ServerSpec> };
    return parsed.mcpServers?.[SERVER_NAME] ?? null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hasCommand(command: string): Promise<boolean> {
  return run(command, ["--version"]).then(
    () => true,
    () => false,
  );
}

export function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}
