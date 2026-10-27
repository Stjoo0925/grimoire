/**
 * `grimoire install <client>` — MCP 클라이언트 설정을 자동으로 써 넣는다.
 *
 * 명령은 **지금 이 CLI를 돌리는 node의 절대경로**(`process.execPath`)로 적는다.
 *  - GUI 앱(Claude Desktop·Cursor)은 셸 PATH를 물려받지 않아 `node`만 적으면 못 찾는다.
 *  - SQLite는 node 내장(node:sqlite)이라, 등록한 node가 지원 버전 이상이기만 하면 된다.
 * 기존 설정 파일은 다른 서버 항목을 그대로 두고 grimoire 항목만 넣거나 바꾼다.
 * 덮어쓰기 전에 `.bak`을 남기고, 임시 파일 + rename으로 쓴다.
 *
 * claude-code 사용자 범위는 읽기 전용 도구(readOnlyHint)를 `~/.claude/settings.json`의 `permissions.allow`에도 더한다.
 * 검색할 때마다 승인 창이 뜨지 않게 — 쓰기 도구(add_repo·record_note)는 넣지 않는다.
 * codex는 JSON이 아니라 `~/.codex/config.toml`이다(codex.ts). 같은 읽기 도구를 approval_mode = "approve"로 둔다.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import { TOOLS } from "../mcp/tools";
import { CodexConfigError, codexConfigPath, planCodexConfig, readCodexServer, verifyCodexConfig } from "./codex";

export const SERVER_NAME = "grimoire";
export const CLIENTS = ["claude-code", "claude-desktop", "cursor", "codex"] as const;
export type ClientName = (typeof CLIENTS)[number];

/** 설정에 함께 옮겨 적는 환경 변수 — CLI와 MCP·훅이 같은 DB·같은 "나"·같은 자동 등록·기동 동기화·업데이트·캡처 설정을 보게 한다. */
export const FORWARDED_ENV = ["GRIMOIRE_HOME", "GRIMOIRE_ME", "GRIMOIRE_AUTO_ADD", "GRIMOIRE_SYNC_ON_START", "GRIMOIRE_UPDATE_CHECK", "GRIMOIRE_CAPTURE", "GRIMOIRE_COCHANGE_MAX_FILES"] as const;

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

export interface ConfigPathOptions {
  project?: string;
  platform?: NodeJS.Platform;
  home?: string;
  /** CLAUDE_USER_DATA_DIR·APPDATA·LOCALAPPDATA를 읽을 환경. home을 따로 넘기고 env는 안 넘기면 빈 환경 (테스트가 진짜 설정을 보지 않게) */
  env?: Env;
}

/** 클라이언트별 설정 파일 경로. claude-code는 프로젝트 범위(.mcp.json)일 때만 파일을 쓴다. codex는 TOML이다. */
export function configPath(client: ClientName, options: ConfigPathOptions = {}): string | null {
  const home = options.home ?? os.homedir();
  switch (client) {
    case "codex":
      return codexConfigPath({ home: options.home, env: options.env });
    case "claude-desktop":
      return path.join(desktopDataDir(options), "claude_desktop_config.json");
    case "cursor":
      return options.project ? path.join(options.project, ".cursor", "mcp.json") : path.join(home, ".cursor", "mcp.json");
    case "claude-code":
      return options.project ? path.join(options.project, ".mcp.json") : null;
  }
}

/**
 * Claude Desktop의 데이터 폴더 (claude_desktop_config.json이 있는 곳).
 *
 *  - 모든 OS: `CLAUDE_USER_DATA_DIR`로 옮겼으면 그곳
 *  - macOS: `~/Library/Application Support/Claude` (3.x에서도 그대로)
 *  - Windows는 설치 방식·버전마다 다르다. 앞에서부터 **실제로 쓰고 있는 폴더**를 고른다.
 *    1. `%LOCALAPPDATA%\Claude-Data\<패키지 패밀리, 소문자>` — 스토어/MSIX 3.1623+ (claude_pzs8sxrjxfjjc, anthropicpbc.claude_fnn82j28hfe8t)
 *    2. `%LOCALAPPDATA%\Packages\<패키지 패밀리>\LocalCache\Roaming\Claude` — 그 전 MSIX (앱이 보는 %APPDATA%의 가상화 사본)
 *    3. `%APPDATA%\Claude` — 일반 설치. 아무 흔적이 없을 때도 여기
 *    Claude-Data 폴더가 비어 있는 채로 LocalCache를 쓰는 설치도 있어, 폴더가 있다는 것만으로는 고르지 않는다.
 *  - Linux: `~/.config/Claude`
 */
export function desktopDataDir(options: ConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? (options.home === undefined ? process.env : {});
  const custom = env.CLAUDE_USER_DATA_DIR?.trim();
  if (custom) return path.resolve(custom);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  if (platform !== "win32") return path.join(home, ".config", "Claude");

  const candidates = windowsDataDirs(home, env);
  return candidates.find(isLiveDataDir) ?? candidates[candidates.length - 1];
}

/** Windows에서 Claude Desktop 데이터 폴더가 될 수 있는 곳, 우선순위 순. 마지막은 항상 %APPDATA%\Claude */
function windowsDataDirs(home: string, env: Env): string[] {
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return [
    ...packageDirs(path.join(localAppData, "Claude-Data"), (name) => path.join(localAppData, "Claude-Data", name)),
    ...packageDirs(path.join(localAppData, "Packages"), (name) => path.join(localAppData, "Packages", name, "LocalCache", "Roaming", "Claude")),
    path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude"),
  ];
}

/** 앱이 읽지 않는 옛 위치의 Desktop 설정 파일들 (doctor가 "엉뚱한 곳에 등록됨"을 짚는 데 쓴다) */
export function staleDesktopConfigs(options: ConfigPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return [];
  const env = options.env ?? (options.home === undefined ? process.env : {});
  if (env.CLAUDE_USER_DATA_DIR?.trim()) return [];
  const live = configPath("claude-desktop", options);
  return windowsDataDirs(options.home ?? os.homedir(), env)
    .map((dir) => path.join(dir, "claude_desktop_config.json"))
    .filter((file) => file !== live && fs.existsSync(file));
}

/** Claude 패키지 패밀리로 보이는 하위 폴더들 (Claude_…, AnthropicPBC.Claude_… — 대소문자 무관), 최근에 바뀐 순 */
function packageDirs(root: string, toDataDir: (name: string) => string): string[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /(^|\.)claude_/i.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .map((name) => toDataDir(name))
    .map((dir) => ({ dir, mtime: fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? -1 }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((item) => item.dir);
}

/** 앱이 실제로 쓰는 데이터 폴더인지 — 옮겨 간 뒤의 옛 폴더에는 표시 파일(.user-data-left.*)만 남는다 */
function isLiveDataDir(dir: string): boolean {
  return ["claude_desktop_config.json", "config.json", "Local State"].some((name) => fs.existsSync(path.join(dir, name)));
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

/** 확인 없이 불러도 되는 읽기 도구(readOnlyHint) 이름 */
export function readOnlyTools(): string[] {
  return TOOLS.filter((tool) => "annotations" in tool && "readOnlyHint" in tool.annotations && tool.annotations.readOnlyHint).map((tool) => tool.name);
}

/** Claude Code 권한 규칙 이름 — 확인 없이 불러도 되는 읽기 도구만 */
export function readOnlyPermissions(): string[] {
  return readOnlyTools().map((name) => `mcp__${SERVER_NAME}__${name}`);
}

/** Claude Code 사용자 설정 파일. CLAUDE_CONFIG_DIR을 쓰면 그 아래 */
export function claudeSettingsPath(options: { env?: Env; home?: string } = {}): string {
  const dir = options.env?.CLAUDE_CONFIG_DIR?.trim();
  return path.join(dir ? path.resolve(dir) : path.join(options.home ?? os.homedir(), ".claude"), "settings.json");
}

/** 기존 settings.json의 permissions.allow에 빠진 규칙만 더한다. 다른 키·다른 규칙·순서는 그대로 둔다. */
export function mergePermissions(existing: unknown, rules: string[]): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const permissions =
    base.permissions && typeof base.permissions === "object" && !Array.isArray(base.permissions)
      ? { ...(base.permissions as Record<string, unknown>) }
      : {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
  permissions.allow = allow;
  base.permissions = permissions;
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
  /** claude-code 사용자 범위: settings.json에 더한 권한 규칙 (dry-run이면 더할 규칙) */
  permissions?: { file: string; added: string[]; backup: string | null };
  /** codex: 승인 없이 부르게 한 읽기 도구 */
  approved?: string[];
  /** codex: 설정 파일에 붙이는 블록 (dry-run 미리보기) */
  preview?: string;
  /** codex: 쓴 설정을 Codex가 다시 읽어 확인했는가 (codex 명령이 없으면 false) */
  verified?: boolean;
}

export interface InstallOptions {
  cliPath: string;
  env?: Env;
  /** 프로젝트 범위로 설치할 디렉터리 (claude-code: .mcp.json, cursor: .cursor/mcp.json) */
  project?: string;
  /** 파일을 쓰지 않고 무엇을 할지만 돌려준다 */
  dryRun?: boolean;
  home?: string;
  /** 외부 명령 실행 (테스트에서 claude CLI 대신) */
  runCommand?: typeof run;
}

export class InstallError extends Error {}

export async function install(client: ClientName, options: InstallOptions): Promise<InstallResult & { spec: ServerSpec }> {
  const spec = serverSpec(options.cliPath, options.env);
  if (!fs.existsSync(spec.args[0])) {
    throw new InstallError(`CLI 파일이 없습니다: ${spec.args[0]} — 먼저 'npm run build'를 하세요.`);
  }

  const next = NEXT_STEP[client];
  if (client === "codex") return installCodex(spec, options, next);
  const file = configPath(client, { project: options.project, home: options.home, env: options.env });

  if (file === null) {
    // claude-code 사용자 범위: 설정 파일(~/.claude.json)을 직접 고치지 않고 공식 CLI에 맡긴다.
    const args = claudeAddArgs(spec);
    const command = ["claude", ...args].map(shellQuote).join(" ");
    // 권한은 claude 등록 전에 읽어 둔다 — settings.json이 깨져 있으면 아무것도 하지 않고 멈추게
    const settingsFile = claudeSettingsPath({ env: options.env, home: options.home });
    const rules = readOnlyPermissions();
    const settings = planJson(settingsFile, (existing) => mergePermissions(existing, rules));
    const before = settings.existing as { permissions?: { allow?: unknown } };
    const had = Array.isArray(before?.permissions?.allow) ? (before.permissions.allow as unknown[]) : [];
    const added = rules.filter((rule) => !had.includes(rule));
    if (options.dryRun) {
      return { client, file: null, backup: null, unchanged: false, command, next, spec, permissions: { file: settingsFile, added, backup: null } };
    }
    const exec = options.runCommand ?? run;
    if (!(await hasCommand("claude", exec))) {
      throw new InstallError(
        "claude 명령을 찾지 못했습니다. Claude Code를 설치한 뒤 다시 하거나, 아래 명령을 직접 실행하세요:\n  " +
          command +
          "\n또는 프로젝트 범위로 설치: grimoire install claude-code --project <레포 경로>",
      );
    }
    await exec("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]).catch(() => undefined);
    await exec("claude", args);
    const backup = settings.unchanged ? null : writeJson(settings);
    return { client, file: null, backup: null, unchanged: false, command, next, spec, permissions: { file: settingsFile, added, backup } };
  }

  const plan = planJson(file, (existing) => mergeServer(existing, spec));
  if (options.dryRun || plan.unchanged) {
    return { client, file, backup: null, unchanged: plan.unchanged, next, spec };
  }
  return { client, file, backup: writeJson(plan), unchanged: false, next, spec };
}

/**
 * codex: config.toml에서 grimoire 표만 바꾸고, 읽기 도구는 승인 없이 부르게 한다.
 * 쓴 뒤 Codex가 그 설정을 못 읽으면(버전이 달라 모르는 키 등) 원래 내용으로 되돌리고 멈춘다 — Codex 전체가 안 뜨는 일을 막는다.
 */
async function installCodex(spec: ServerSpec, options: InstallOptions, next: string): Promise<InstallResult & { spec: ServerSpec }> {
  if (options.project) {
    throw new InstallError("codex는 사용자 설정(~/.codex/config.toml)에만 등록합니다 — --project 없이 실행하세요.");
  }
  const file = codexConfigPath({ home: options.home, env: options.env });
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const approved = readOnlyTools();
  let plan;
  try {
    plan = planCodexConfig(file, raw, SERVER_NAME, spec, approved);
  } catch (error) {
    if (error instanceof CodexConfigError) throw new InstallError(`${error.message}: ${file}\n직접 고치거나 그 항목을 지운 뒤 다시 하세요.`);
    throw error;
  }
  const base = { client: "codex" as const, file, next, spec, approved, preview: plan.block };
  if (options.dryRun || plan.unchanged) return { ...base, backup: null, unchanged: plan.unchanged };

  const backup = writeJson(plan);
  let verified: boolean;
  try {
    verified = await verifyCodexConfig(SERVER_NAME, options.runCommand);
  } catch (error) {
    // 되돌린다 — 원래 없던 파일이면 지운다
    if (raw === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, raw);
    const reason = error instanceof Error ? error.message : String(error);
    throw new InstallError(`Codex가 바뀐 설정을 읽지 못해 되돌렸습니다: ${file}\n${reason}`);
  }
  return { ...base, backup, unchanged: false, verified };
}

export interface JsonPlan {
  file: string;
  /** 지금 파일 내용 (없으면 null) */
  raw: string | null;
  existing: unknown;
  text: string;
  unchanged: boolean;
}

/** 설정 JSON을 읽어 바꿀 내용을 만든다. 깨진 JSON이면 건드리지 않고 멈춘다. */
export function planJson(file: string, merge: (existing: unknown) => Record<string, unknown>): JsonPlan {
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
  const merged = merge(existing);
  const unchanged = raw !== null && JSON.stringify(existing) === JSON.stringify(merged);
  return { file, raw, existing, text: JSON.stringify(merged, null, 2) + "\n", unchanged };
}

/** 계획대로 쓴다. 기존 파일이 있으면 `.bak`을 남기고 그 경로를 돌려준다. */
export function writeJson({ file, raw, text }: JsonPlan): string | null {
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
  return backup;
}

const NEXT_STEP: Record<ClientName, string> = {
  "claude-code": "새 Claude Code 세션에서 /mcp로 grimoire가 연결됐는지 확인하세요.",
  "claude-desktop": "Claude Desktop을 완전히 종료(⌘Q)했다가 다시 여세요.",
  cursor: "Cursor 설정 → MCP에서 grimoire를 켜거나 Cursor를 다시 시작하세요.",
  codex: "새 Codex 세션에서 /mcp로 grimoire가 연결됐는지 확인하세요 (터미널: codex mcp list).",
};

export function claudeAddArgs(spec: ServerSpec): string[] {
  const envArgs = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return ["mcp", "add", "--scope", "user", ...envArgs, SERVER_NAME, "--", spec.command, ...spec.args];
}

/** 이미 써 둔 설정 파일에서 grimoire 항목을 읽는다 (doctor용). 없으면 null. */
export function readInstalled(file: string): ServerSpec | null {
  if (file.endsWith(".toml")) {
    try {
      return readCodexServer(fs.readFileSync(file, "utf8"), SERVER_NAME);
    } catch {
      return null;
    }
  }
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

export function hasCommand(command: string, exec: typeof run = run): Promise<boolean> {
  return exec(command, ["--version"]).then(
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
