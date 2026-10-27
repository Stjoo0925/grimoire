/**
 * Codex(OpenAI Codex CLI) 설정 — `~/.codex/config.toml`(또는 `$CODEX_HOME/config.toml`)의 `[mcp_servers.grimoire]`.
 *
 * TOML 파서를 의존성으로 들이지 않는다. 파일을 줄 단위로 훑어 grimoire 표(`mcp_servers.grimoire`와 그 하위 표)만 떼어 내고
 * 새 블록을 끝에 붙인다 — 다른 줄은 주석·순서·줄바꿈까지 글자 그대로 둔다.
 * 여러 줄 문자열·여러 줄 배열 안의 `[`는 표 머리로 읽지 않는다.
 * grimoire가 표가 아닌 꼴(인라인 표 `grimoire = { … }`, 점 키 `mcp_servers.grimoire.command = …`)로 적혀 있으면
 * 안전하게 고칠 수 없으니 건드리지 않고 멈춘다.
 *
 * 읽기 도구는 `[mcp_servers.grimoire.tools.<도구>] approval_mode = "approve"`로 승인을 묻지 않게 한다(Claude Code의 permissions.allow와 같은 범위).
 * Codex는 모르는 값이 있으면 설정 전체를 읽지 않으므로, 쓴 뒤 `codex mcp get`으로 다시 읽혀 보고 실패하면 되돌린다(install.ts).
 */
import { exec, execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import { windowsCommandLine } from "./update";

export interface CodexServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** grimoire 항목을 안전하게 고칠 수 없는 설정 (install.ts가 InstallError로 바꾼다) */
export class CodexConfigError extends Error {}

/** Codex 설정 파일 — CODEX_HOME이 있으면 그 아래, 없으면 ~/.codex */
export function codexConfigPath(options: { home?: string; env?: Env } = {}): string {
  const env = options.env ?? (options.home === undefined ? process.env : {});
  const dir = env.CODEX_HOME?.trim();
  return path.join(dir ? path.resolve(dir) : path.join(options.home ?? os.homedir(), ".codex"), "config.toml");
}

/** TOML 기본 문자열 — JSON 문자열 이스케이프(\" \\ \n \uXXXX …)는 TOML에서도 같은 뜻이다 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** 붙일 grimoire 블록 (끝 줄바꿈 없음) */
export function codexBlock(name: string, server: CodexServer, approved: readonly string[] = []): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${tomlString(server.command)}`, `args = [${server.args.map(tomlString).join(", ")}]`];
  const env = Object.entries(server.env ?? {});
  if (env.length > 0) {
    lines.push("", `[mcp_servers.${name}.env]`, ...env.map(([key, value]) => `${key} = ${tomlString(value)}`));
  }
  for (const tool of approved) lines.push("", `[mcp_servers.${name}.tools.${tool}]`, `approval_mode = "approve"`);
  return lines.join("\n");
}

interface TomlLine {
  text: string;
  kind: "header" | "key" | "other";
  /** 표 머리의 경로 ([a."b".c] → a, b, c). 읽지 못한 머리는 undefined */
  path?: string[];
  /** [[배열 표]] 머리인가 */
  array?: boolean;
  /** 키 줄의 점 키 경로 */
  key?: string[];
  /** 키 줄의 값 (여러 줄이면 이어 붙인다) */
  value?: string;
}

/** 점으로 이은 키(맨 키·"기본"·'리터럴')를 읽는다. 키가 없으면 null */
function parseKeyPath(text: string): { path: string[]; rest: string } | null {
  const path: string[] = [];
  let i = 0;
  const skip = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  };
  for (;;) {
    skip();
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const raw = text.slice(i, end + 1);
      try {
        path.push(JSON.parse(raw) as string);
      } catch {
        path.push(raw.slice(1, -1));
      }
      i = end + 1;
    } else if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      path.push(text.slice(i + 1, end));
      i = end + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!bare) return path.length > 0 ? { path, rest: text.slice(i) } : null;
      path.push(bare[0]);
      i += bare[0].length;
    }
    skip();
    if (text[i] !== ".") return { path, rest: text.slice(i) };
    i++;
  }
}

type Multi = '"""' | "'''" | null;

/** 값 조각을 훑어 여러 줄 문자열·괄호 깊이를 이어 간다. 주석(#)부터는 보지 않는다 */
function scanValue(text: string, multi: Multi, depth: number): { multi: Multi; depth: number } {
  let i = 0;
  while (i < text.length) {
    if (multi) {
      const end = text.indexOf(multi, i);
      if (end < 0) return { multi, depth };
      i = end + 3;
      // 닫는 따옴표 바로 뒤의 따옴표 한두 개는 문자열 내용이다 ("""a"""" 꼴)
      while (text[i] === multi[0]) i++;
      multi = null;
      continue;
    }
    const char = text[i];
    if (char === "#") break;
    if (char === '"' || char === "'") {
      const triple = char.repeat(3);
      if (text.startsWith(triple, i)) {
        multi = triple as Multi;
        i += 3;
        continue;
      }
      i++;
      while (i < text.length && text[i] !== char) i += char === '"' && text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    i++;
  }
  return { multi, depth };
}

/** 줄마다 표 머리·키·그 밖으로 나눈다. 여러 줄 문자열·배열이 이어지는 줄은 앞 키의 값으로 붙인다 */
function scanToml(lines: string[]): TomlLine[] {
  const out: TomlLine[] = [];
  let multi: Multi = null;
  let depth = 0;
  let owner: TomlLine | null = null;
  for (const text of lines) {
    if (multi || depth > 0) {
      out.push({ text, kind: "other" });
      if (owner) owner.value += "\n" + text;
      ({ multi, depth } = scanValue(text, multi, depth));
      if (!multi && depth === 0) owner = null;
      continue;
    }
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push({ text, kind: "other" });
      continue;
    }
    if (trimmed.startsWith("[")) {
      const array = trimmed.startsWith("[[");
      const parsed = parseKeyPath(trimmed.slice(array ? 2 : 1));
      const closed = parsed && parsed.rest.trimStart().startsWith(array ? "]]" : "]");
      out.push({ text, kind: "header", path: closed ? parsed.path : undefined, array });
      continue;
    }
    const parsed = parseKeyPath(trimmed);
    if (!parsed || !parsed.rest.startsWith("=")) {
      out.push({ text, kind: "other" });
      continue;
    }
    const entry: TomlLine = { text, kind: "key", key: parsed.path, value: parsed.rest.slice(1) };
    out.push(entry);
    ({ multi, depth } = scanValue(entry.value!, null, 0));
    owner = multi || depth > 0 ? entry : null;
  }
  return out;
}

const isServer = (name: string) => (path: readonly string[]) => path[0] === "mcp_servers" && path[1] === name;

export interface CodexPlan {
  file: string;
  /** 지금 파일 내용 (없으면 null) */
  raw: string | null;
  existing: null;
  text: string;
  unchanged: boolean;
  /** 붙인 블록 (dry-run 미리보기) */
  block: string;
}

/**
 * 기존 config.toml(raw, 없으면 null)에서 grimoire 표를 떼고 새 블록을 붙인 내용.
 * 다른 줄은 그대로, 줄바꿈 방식(CRLF/LF)도 기존 파일을 따른다.
 */
export function mergeCodexConfig(raw: string | null, name: string, server: CodexServer, approved: readonly string[] = []): string {
  const eol = raw?.includes("\r\n") ? "\r\n" : "\n";
  const ours = isServer(name);
  const kept: string[] = [];
  let section: string[] = [];
  let dropping = false;
  for (const line of scanToml((raw ?? "").split(/\r?\n/))) {
    if (line.kind === "header") {
      section = line.path ?? [];
      if (line.path && ours(line.path) && line.array) {
        throw new CodexConfigError(`mcp_servers.${name}가 배열 표([[…]])로 적혀 있어 건드리지 않았습니다`);
      }
      dropping = Boolean(line.path && ours(line.path));
    } else if (line.kind === "key" && !dropping && ours([...section, ...line.key!])) {
      // [mcp_servers] 아래 grimoire = { … } 또는 루트의 mcp_servers.grimoire.command = … 꼴
      throw new CodexConfigError(`mcp_servers.${name}가 표가 아닌 꼴(인라인 표·점 키)로 적혀 있어 건드리지 않았습니다`);
    }
    if (!dropping) kept.push(line.text);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const block = codexBlock(name, server, approved).split("\n");
  return [...kept, ...(kept.length > 0 ? [""] : []), ...block, ""].join(eol);
}

/** install이 쓸 계획 — planJson과 같은 꼴 (writeJson으로 쓴다) */
export function planCodexConfig(file: string, raw: string | null, name: string, server: CodexServer, approved: readonly string[] = []): CodexPlan {
  const text = mergeCodexConfig(raw, name, server, approved);
  return { file, raw, existing: null, text, unchanged: raw === text, block: codexBlock(name, server, approved) };
}

/** 값에서 문자열 토큰만 뽑는다 ("기본"·'리터럴'). doctor가 command·args·env를 읽는 데만 쓴다 */
function stringTokens(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|#[^\n]*/g;
  for (const match of value.matchAll(pattern)) {
    if (match[0].startsWith("#")) continue;
    if (match[2] !== undefined) tokens.push(match[2]);
    else {
      try {
        tokens.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        tokens.push(match[1]);
      }
    }
  }
  return tokens;
}

/** config.toml 내용에서 grimoire 항목을 읽는다 (doctor용). 없으면 null */
export function readCodexServer(raw: string, name: string): CodexServer | null {
  const ours = isServer(name);
  let section: string[] = [];
  let found = false;
  const server: { command?: string; args?: string[]; env?: Record<string, string> } = {};
  for (const line of scanToml(raw.split(/\r?\n/))) {
    if (line.kind === "header") {
      section = line.path ?? [];
      if (ours(section)) found = true;
      continue;
    }
    if (line.kind !== "key" || !ours(section)) continue;
    const full = [...section.slice(2), ...line.key!];
    const tokens = stringTokens(line.value ?? "");
    if (full.length === 1 && full[0] === "command") server.command = tokens[0];
    else if (full.length === 1 && full[0] === "args") server.args = tokens;
    else if (full.length === 2 && full[0] === "env" && tokens[0] !== undefined) (server.env ??= {})[full[1]] = tokens[0];
  }
  if (!found) return null;
  return { command: server.command ?? "", args: server.args ?? [], ...(server.env ? { env: server.env } : {}) };
}

/**
 * Codex가 지금 설정을 읽을 수 있는지 `codex mcp get <name> --json`으로 확인한다.
 * Codex가 설정을 못 읽었다고 하면 그 메시지를 담아 던지고, Codex가 없거나 다른 이유로 못 돌리면 false(확인 못 함).
 */
export async function verifyCodexConfig(name: string, runCommand: (command: string, args: string[]) => Promise<string> = runCodex): Promise<boolean> {
  try {
    await runCommand("codex", ["mcp", "get", name, "--json"]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to load configuration|config\.toml/i.test(message)) throw new CodexConfigError(message);
    return false;
  }
}

/** Windows의 codex는 npm이 만든 codex.cmd라 셸을 거쳐야 한다 — 인자는 검증한 한 줄로 넘긴다(update.ts와 같은 방식) */
function runCodex(command: string, args: string[]): Promise<string> {
  const options = { encoding: "utf8" as const, timeout: 30_000 };
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, stdout: string, stderr: string) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    };
    if (process.platform === "win32") {
      let line: string;
      try {
        line = windowsCommandLine(command, args);
      } catch (error) {
        reject(error as Error);
        return;
      }
      exec(line, options, done);
    } else {
      execFile(command, args, options, done);
    }
  });
}
