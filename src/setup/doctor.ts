/**
 * `grimoire doctor` — 연결이 안 될 때 원인을 한 번에 보여 준다.
 *
 * 각 점검은 독립적이다. 앞의 점검이 실패해도(예: 오래된 Node라 SQLite를 못 엶) 나머지는 계속 돈다.
 */
import fs from "node:fs";
import path from "node:path";

import { dbPath, grimoireHome, type Env } from "../core/config";
import { needsCochangeBackfill } from "../core/context";
import { loadSqlite, MIN_NODE, openDb } from "../core/db";
import { runGit } from "../core/git";
import { myEmails } from "../core/identity";
import { listRepos, worktreeRegistrations } from "../core/indexer";
import { compareVersions, RELEASES_URL, refreshUpdateCache, updateCheckEnabled, VERSION } from "../core/update";
import { hookCommandEnv, parseHookCommand, readInstalledHooks, settingsPath } from "./hooks";
import { CLIENTS, configPath, hasCommand, readInstalled, run, SERVER_NAME, staleDesktopConfigs } from "./install";

export type Level = "ok" | "warn" | "fail";

export interface Check {
  level: Level;
  title: string;
  detail?: string;
  /** 고치는 방법 */
  fix?: string;
}

export interface DoctorOptions {
  cliPath: string;
  env?: Env;
  home?: string;
  /** 업데이트 확인에 쓰는 fetch (테스트 주입용) */
  fetchImpl?: typeof fetch;
  /** 외부 명령 실행 (테스트에서 claude CLI 대신) */
  runCommand?: typeof run;
}

export async function doctor(options: DoctorOptions): Promise<Check[]> {
  const env = options.env ?? process.env;
  const checks: Check[] = [];

  // 0. Grimoire 버전 (GitHub 릴리스 기준)
  checks.push(await versionCheck(env, options.fetchImpl));

  // 1. Node와 내장 SQLite(node:sqlite) — 검색이 FTS5에 기대므로 가상 테이블까지 만들어 본다
  checks.push(
    compareVersions(process.versions.node, MIN_NODE) >= 0
      ? { level: "ok", title: `Node ${process.version}`, detail: process.execPath }
      : { level: "fail", title: `Node ${process.version} — ${MIN_NODE} 이상이 필요합니다`, detail: process.execPath },
  );
  let sqliteOk = false;
  try {
    const probe = new (loadSqlite().DatabaseSync)(":memory:");
    try {
      probe.exec("CREATE VIRTUAL TABLE probe USING fts5(text)");
      const { version } = probe.prepare("SELECT sqlite_version() AS version").get() as { version: string };
      sqliteOk = true;
      checks.push({ level: "ok", title: "SQLite (node:sqlite, FTS5)", detail: `SQLite ${version}` });
    } finally {
      probe.close();
    }
  } catch (error) {
    checks.push({
      level: "fail",
      title: "SQLite를 열지 못했습니다",
      detail: error instanceof Error ? error.message : String(error),
      fix: `Node ${MIN_NODE} 이상을 설치하고 'grimoire install'을 다시 하세요`,
    });
  }

  // 2. git
  try {
    const version = (await runGit(process.cwd(), ["--version"])).trim();
    checks.push({ level: "ok", title: version });
  } catch {
    checks.push({ level: "fail", title: "git을 찾지 못했습니다", fix: "git을 설치하세요 (macOS: xcode-select --install)" });
  }

  // 3. DB와 레포
  const file = dbPath(env);
  if (sqliteOk) {
    try {
      const db = openDb(file);
      try {
        const repos = listRepos(db);
        const commits = (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number }).n;
        checks.push({ level: "ok", title: "데이터베이스", detail: `${file} (커밋 ${commits}개)` });
        if (repos.length === 0) {
          checks.push({
            level: "warn",
            title: "등록된 레포가 없습니다 — 연결돼도 검색 결과가 비어 있습니다",
            fix: "grimoire scan <폴더>  또는  grimoire add <레포>",
          });
        } else {
          const missing = repos.filter((repo) => !fs.existsSync(repo.path));
          checks.push({ level: "ok", title: `레포 ${repos.length}개 등록` });
          if (missing.length > 0) {
            checks.push({
              level: "warn",
              title: `경로가 사라진 레포 ${missing.length}개`,
              detail: missing.map((repo) => repo.path).join(", "),
              fix: missing.map((repo) => `grimoire remove ${repo.name}`).join("  /  "),
            });
          }
          const neverSynced = repos.filter((repo) => !repo.synced_at);
          if (neverSynced.length > 0) {
            checks.push({ level: "warn", title: `한 번도 동기화되지 않은 레포 ${neverSynced.length}개`, fix: "grimoire sync" });
          }
          // 업그레이드(마이그레이션)가 공변경 표를 비운 뒤 아직 sync가 안 돈 레포 — 그동안 편집 직전 훅은 아무 맥락도 못 준다
          const stale = repos.filter((repo) => repo.synced_at && needsCochangeBackfill(db, repo.id));
          if (stale.length > 0) {
            checks.push({
              level: "warn",
              title: `공변경 이력을 다시 계산해야 하는 레포 ${stale.length}개 — 그때까지 편집 직전 맥락이 비어 있습니다`,
              detail: stale.map((repo) => repo.name).join(", "),
              fix: "grimoire sync",
            });
          }
          // 예전 버전은 git worktree(Claude Code의 .claude/worktrees/<세션>)를 따로 등록했다 — 같은 커밋이 겹쳐 색인된다
          const worktrees = await worktreeRegistrations(db);
          if (worktrees.length > 0) {
            checks.push({
              level: "warn",
              title: `다른 레포의 git worktree가 따로 등록돼 있습니다 (${worktrees.length}개) — 같은 커밋이 검색에 겹쳐 나옵니다`,
              detail: worktrees.map((item) => `${item.repo.name} → 본 레포 ${item.main}${item.mainRegistered ? "" : " (미등록)"}`).join("\n    "),
              fix: worktrees
                .map((item) => (item.mainRegistered ? `grimoire remove ${item.repo.name}` : `grimoire remove ${item.repo.name} && grimoire add "${item.main}"`))
                .join("  /  "),
            });
          }
        }
      } finally {
        db.close();
      }
    } catch (error) {
      checks.push({
        level: "fail",
        title: "데이터베이스를 열지 못했습니다",
        detail: `${file}: ${error instanceof Error ? error.message : error}`,
        fix: `${grimoireHome(env)} 폴더 권한을 확인하거나 GRIMOIRE_HOME을 다른 곳으로 지정하세요`,
      });
    }
  }

  // 4. "나"
  const me = await myEmails(env);
  checks.push(
    me.length > 0
      ? { level: "ok", title: "내 이메일", detail: me.join(", ") }
      : {
          level: "warn",
          title: "내 이메일을 모릅니다 — author: \"me\" 필터가 안 됩니다",
          fix: 'git config --global user.email "me@example.com"  또는  GRIMOIRE_ME 설정',
        },
  );

  // 5. 클라이언트 설정
  checks.push(...(await clientChecks(options, env)));
  return checks;
}

async function versionCheck(env: Env, fetchImpl?: typeof fetch): Promise<Check> {
  const title = `Grimoire ${VERSION}`;
  if (!updateCheckEnabled(env)) return { level: "ok", title, detail: "업데이트 확인 꺼짐 (GRIMOIRE_UPDATE_CHECK=0)" };
  const cache = await refreshUpdateCache({ env, force: true, fetchImpl });
  if (!cache?.latest) return { level: "ok", title, detail: `최신 릴리스를 확인하지 못했습니다 — ${RELEASES_URL}` };
  if (compareVersions(cache.latest, VERSION) > 0) {
    return { level: "warn", title: `${title} — 새 버전 ${cache.latest}이 있습니다`, detail: cache.url, fix: "grimoire update" };
  }
  return { level: "ok", title: `${title} (최신)` };
}

async function clientChecks(options: DoctorOptions, env: Env): Promise<Check[]> {
  const checks: Check[] = [];
  let anyInstalled = false;

  for (const client of CLIENTS) {
    const file = configPath(client, { home: options.home, env });
    if (!file) continue;
    const spec = fs.existsSync(file) ? readInstalled(file) : null;
    if (!spec) {
      // 앱이 설정 위치를 옮겼는데(Windows 3.1623+ 등) 예전 위치에만 등록돼 있으면 앱은 grimoire를 못 본다
      const stale = client === "claude-desktop" ? staleDesktopConfigs({ home: options.home, env }).filter((other) => readInstalled(other)) : [];
      if (stale.length > 0) {
        anyInstalled = true;
        checks.push({
          level: "warn",
          title: "claude-desktop: 앱이 읽지 않는 옛 설정 파일에만 등록돼 있습니다",
          detail: `${stale.join(", ")}\n앱이 읽는 파일: ${file}`,
          fix: "grimoire install claude-desktop",
        });
      }
      continue;
    }
    anyInstalled = true;
    checks.push(specCheck(client, file, spec, options.cliPath, env));
  }

  const exec = options.runCommand ?? run;
  if (await hasCommand("claude", exec)) {
    try {
      const listed = await exec("claude", ["mcp", "get", SERVER_NAME]);
      anyInstalled = true;
      const wrongNode = !listed.includes(process.execPath);
      // `claude mcp get`의 "Environment:" 아래 "GRIMOIRE_HOME=…" 줄 — 없으면 기본 폴더
      const mcpHome = dataHome(/^\s*GRIMOIRE_HOME=(.+?)\s*$/m.exec(listed)?.[1]);
      checks.push(
        wrongNode
          ? { level: "warn", title: "claude-code: 다른 node로 등록돼 있습니다", detail: listed.trim(), fix: "grimoire install claude-code" }
          : !samePath(mcpHome, grimoireHome(env))
            ? { level: "warn", title: "claude-code: CLI와 다른 데이터 폴더를 봅니다", detail: `MCP: ${mcpHome} / CLI: ${grimoireHome(env)}`, fix: "grimoire install claude-code" }
            : { level: "ok", title: "claude-code: 등록됨" },
      );
    } catch {
      // 등록 안 됨 — 아래 공통 안내로
    }
  }

  if (!anyInstalled) {
    checks.push({
      level: "warn",
      title: "어떤 MCP 클라이언트에도 아직 등록하지 않았습니다",
      fix: `grimoire install ${CLIENTS.join(" | ")}`,
    });
  }

  // Claude Code 훅 — 설치돼 있으면 node·hook.js 경로가 살아 있는지
  const hooks = readInstalledHooks(settingsPath(options.home));
  if (hooks.length > 0) {
    const parsed = parseHookCommand(hooks[0].command);
    if (!parsed || !fs.existsSync(parsed.node) || !fs.existsSync(parsed.hook)) {
      checks.push({
        level: "fail",
        title: "claude-code 훅: 실행 파일이나 hook.js를 찾을 수 없습니다",
        detail: hooks[0].command,
        fix: "grimoire install claude-code --hooks",
      });
    } else if (path.resolve(parsed.node) !== path.resolve(process.execPath)) {
      checks.push({ level: "warn", title: "claude-code 훅: 지금과 다른 node로 등록돼 있습니다", detail: parsed.node, fix: "grimoire install claude-code --hooks" });
    } else if (options.cliPath && !samePath(path.dirname(parsed.hook), path.dirname(options.cliPath))) {
      // 다른 설치(예: 개발 중인 워크트리 빌드)의 hook.js — grimoire를 올려도 훅은 그 빌드로 계속 돈다
      checks.push({
        level: "warn",
        title: "claude-code 훅: 지금 CLI와 다른 위치의 grimoire를 가리킵니다 — 업데이트가 훅에 닿지 않습니다",
        detail: `훅: ${parsed.hook} / CLI: ${options.cliPath}`,
        fix: "grimoire install claude-code --hooks",
      });
    } else {
      checks.push({ level: "ok", title: `claude-code 훅: ${hooks.map((hook) => hook.event).join(", ")}`, detail: parsed.hook });
      // 훅은 설치 때 적힌 GRIMOIRE_HOME(없으면 기본 폴더)을 본다 — CLI와 다르면 훅이 쌓은 기억을 CLI·MCP가 못 본다
      const hookHome = dataHome(hookCommandEnv(hooks[0].command).GRIMOIRE_HOME);
      if (!samePath(hookHome, grimoireHome(env))) {
        checks.push({
          level: "warn",
          title: "claude-code 훅: CLI와 다른 데이터 폴더를 봅니다",
          detail: `훅: ${hookHome} / CLI: ${grimoireHome(env)}`,
          fix: "grimoire install claude-code --hooks",
        });
      }
      // 훅은 작업을 막지 않으려고 오류를 hook.log에만 남긴다 — 여기서 보여 주지 않으면 아무도 모른다. 훅의 폴더에서 읽는다
      const recent = recentHookErrors(hookHome);
      if (recent.count > 0) {
        checks.push({
          level: "warn",
          title: `claude-code 훅: 최근 ${HOOK_ERROR_DAYS}일 오류 ${recent.count}건 — 훅이 맥락을 못 건넸을 수 있습니다`,
          detail: recent.last ?? undefined,
          fix: `${path.join(hookHome, "hook.log")}를 확인하세요`,
        });
      }
    }
  } else {
    checks.push({
      level: "ok",
      title: "claude-code 훅: 없음 (선택) — 편집 직전 맥락 주입·세션 캡처를 쓰려면",
      fix: "grimoire install claude-code --hooks",
    });
  }
  return checks;
}

function specCheck(
  client: string,
  file: string,
  spec: { command?: string; args?: string[]; env?: Record<string, string> },
  cliPath: string,
  env: Env,
): Check {
  const fix = `grimoire install ${client}`;
  if (!spec.command || !fs.existsSync(spec.command)) {
    return {
      level: "fail",
      title: `${client}: 실행 파일을 찾을 수 없습니다 ('${spec.command}')`,
      detail: `${file} — GUI 앱은 셸 PATH를 모르므로 node 절대경로가 필요합니다`,
      fix,
    };
  }
  const script = spec.args?.[0];
  if (!script || !fs.existsSync(script)) {
    return { level: "fail", title: `${client}: CLI 경로가 없습니다 ('${script}')`, detail: file, fix: `npm run build 후 ${fix}` };
  }
  if (spec.command !== process.execPath) {
    return {
      level: "warn",
      title: `${client}: 지금과 다른 node로 등록돼 있습니다 — 그 node가 오래되면 시작에 실패합니다`,
      detail: `${spec.command} (지금: ${process.execPath})`,
      fix,
    };
  }
  const mcpHome = dataHome(spec.env?.GRIMOIRE_HOME);
  if (!samePath(mcpHome, grimoireHome(env))) {
    return {
      level: "warn",
      title: `${client}: CLI와 다른 데이터 폴더를 봅니다`,
      detail: `MCP: ${mcpHome} / CLI: ${grimoireHome(env)}`,
      fix,
    };
  }
  if (cliPath && script !== cliPath) {
    return { level: "warn", title: `${client}: 다른 위치의 grimoire를 가리킵니다`, detail: script, fix };
  }
  return { level: "ok", title: `${client}: 등록됨`, detail: file };
}

/** 클라이언트 설정에 적힌 GRIMOIRE_HOME(없으면 기본 폴더)을 절대경로로 */
function dataHome(configured: string | undefined): string {
  return path.resolve(configured?.trim() ? configured.trim() : grimoireHome({}));
}

/** 같은 경로인가 — 설정에는 /로 적히고, Windows는 대소문자를 가리지 않는다 */
function samePath(a: string, b: string): boolean {
  const norm = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  return norm(a) === norm(b);
}

export const HOOK_ERROR_DAYS = 7;

/** hook.log에서 최근 며칠의 오류 줄 수와 마지막 줄 (줄 머리가 ISO 시각) */
export function recentHookErrors(home: string, now = Date.now()): { count: number; last: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, "hook.log"), "utf8");
  } catch {
    return { count: 0, last: null };
  }
  const since = now - HOOK_ERROR_DAYS * 86_400_000;
  const lines = text.split("\n").filter((line) => {
    const at = Date.parse(line.slice(0, 24));
    return Number.isFinite(at) && at >= since;
  });
  const last = lines.at(-1) ?? null;
  return { count: lines.length, last: last && last.length > 200 ? `${last.slice(0, 199)}…` : last };
}

const ICON: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${ICON[check.level]} ${check.title}`);
    if (check.detail) lines.push(`    ${check.detail}`);
    if (check.fix) lines.push(`    → ${check.fix}`);
  }
  const fails = checks.filter((check) => check.level === "fail").length;
  const warns = checks.filter((check) => check.level === "warn").length;
  lines.push("", fails > 0 ? `문제 ${fails}개, 주의 ${warns}개` : warns > 0 ? `동작 가능, 주의 ${warns}개` : "모두 정상");
  return lines.join("\n");
}
