import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { openDb } from "../src/core/db";
import { callTool, emptyHint } from "../src/mcp/tools";
import { doctor, formatChecks } from "../src/setup/doctor";
import {
  claudeSettingsPath,
  configPath,
  install,
  InstallError,
  mergePermissions,
  mergeServer,
  readOnlyPermissions,
  serverSpec,
  staleDesktopConfigs,
} from "../src/setup/install";
import { makeRepo, memoryDb, tempDir } from "./helpers";

/** 설치 대상이 될 가짜 CLI 파일 */
function fakeCli(): string {
  const file = path.join(tempDir(), "dist", "cli.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

test("serverSpec: node 절대경로와 필요한 환경 변수만 적는다", () => {
  const spec = serverSpec("dist/cli.js", { GRIMOIRE_ME: "a@x.com", GRIMOIRE_HOME: "rel/home", PATH: "/bin" }, "/opt/node");
  assert.equal(spec.command, "/opt/node");
  assert.deepEqual(spec.args, [path.resolve("dist/cli.js"), "mcp"]);
  assert.deepEqual(spec.env, { GRIMOIRE_HOME: path.resolve("rel/home"), GRIMOIRE_ME: "a@x.com" });
  assert.equal(serverSpec("x", {}, "/n").env, undefined);
  // 기동 동기화를 끈 설정도 GUI 클라이언트까지 간다
  assert.deepEqual(serverSpec("x", { GRIMOIRE_SYNC_ON_START: "0", GRIMOIRE_AUTO_ADD: "0" }, "/n").env, { GRIMOIRE_AUTO_ADD: "0", GRIMOIRE_SYNC_ON_START: "0" });
});

test("configPath: 플랫폼별 위치", () => {
  // 기대값도 path.join으로 만든다 — Windows에서는 구분자가 \
  assert.equal(
    configPath("claude-desktop", { platform: "darwin", home: "/h" }),
    path.join("/h", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  );
  assert.equal(
    configPath("claude-desktop", { platform: "linux", home: "/h" }),
    path.join("/h", ".config", "Claude", "claude_desktop_config.json"),
  );
  // home을 넘기면 실제 %APPDATA%가 아니라 그 home 아래를 본다 (테스트가 진짜 설정을 덮어쓰지 않게)
  assert.equal(
    configPath("claude-desktop", { platform: "win32", home: "/h" }),
    path.join("/h", "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
  );
  assert.equal(
    configPath("claude-desktop", { platform: "win32", home: "/h", env: { APPDATA: "/ad" } }),
    path.join("/ad", "Claude", "claude_desktop_config.json"),
  );
  // CLAUDE_USER_DATA_DIR은 모든 OS에서 우선
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.equal(
      configPath("claude-desktop", { platform, home: "/h", env: { CLAUDE_USER_DATA_DIR: "/u" } }),
      path.join(path.resolve("/u"), "claude_desktop_config.json"),
    );
  }
  assert.equal(configPath("cursor", { home: "/h" }), path.join("/h", ".cursor", "mcp.json"));
  assert.equal(configPath("cursor", { home: "/h", project: "/p" }), path.join("/p", ".cursor", "mcp.json"));
  assert.equal(configPath("claude-code", { home: "/h" }), null); // 사용자 범위는 claude CLI에 맡긴다
  assert.equal(configPath("claude-code", { home: "/h", project: "/p" }), path.join("/p", ".mcp.json"));
});

/** Windows 데이터 폴더 하나를 "쓰는 중"으로 만든다 (앱이 남기는 Local State) */
function liveDir(dir: string, configFile = false): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, configFile ? "claude_desktop_config.json" : "Local State"), "{}");
  return path.join(dir, "claude_desktop_config.json");
}

test("configPath(win32): 실제로 쓰는 폴더를 Claude-Data → MSIX LocalCache → %APPDATA% 순으로 고른다", () => {
  const home = tempDir();
  const local = path.join(home, "AppData", "Local");
  const roaming = path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  const desktop = () => configPath("claude-desktop", { platform: "win32", home });
  assert.equal(desktop(), roaming);

  // 3.1623 전 MSIX: 앱은 가상화된 LocalCache를 읽는다. 빈 Claude-Data 폴더는 무시
  fs.mkdirSync(path.join(local, "Claude-Data", "claude_pzs8sxrjxfjjc"), { recursive: true });
  const msix = liveDir(path.join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude"));
  fs.mkdirSync(path.join(local, "Packages", "Microsoft.Something_123"), { recursive: true }); // Claude 패키지가 아님
  assert.equal(desktop(), msix);

  // 3.1623+: 데이터가 Claude-Data로 옮겨 가면 그쪽 (설정 파일이 아직 없어도 Local State가 있으면)
  const moved = liveDir(path.join(local, "Claude-Data", "claude_pzs8sxrjxfjjc"));
  assert.equal(desktop(), moved);

  // 다른 패키지 패밀리(AnthropicPBC.Claude_…)도 찾는다
  const other = tempDir();
  const pbc = liveDir(path.join(other, "AppData", "Local", "Claude-Data", "anthropicpbc.claude_fnn82j28hfe8t"), true);
  assert.equal(configPath("claude-desktop", { platform: "win32", home: other }), pbc);

  // 옛 위치에만 등록된 설정은 stale로 짚는다 (doctor용)
  liveDir(path.dirname(roaming), true);
  assert.deepEqual(staleDesktopConfigs({ platform: "win32", home }).sort(), [roaming]);
  assert.deepEqual(staleDesktopConfigs({ platform: "darwin", home }), []);
});

test("doctor: 앱이 읽지 않는 옛 Desktop 설정에만 등록돼 있으면 알린다", async () => {
  if (process.platform !== "win32") return; // doctor는 지금 플랫폼의 경로를 본다
  const home = tempDir();
  const cliPath = fakeCli();
  const old = path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ mcpServers: { grimoire: { command: process.execPath, args: [cliPath, "mcp"] } } }));
  liveDir(path.join(home, "AppData", "Local", "Claude-Data", "claude_pkg"));

  const offline = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const env = { GRIMOIRE_HOME: path.join(home, ".grimoire"), GRIMOIRE_ME: "me@example.com" };
  const checks = await doctor({ cliPath, env, home, fetchImpl: offline });
  assert.ok(checks.some((c) => c.level === "warn" && c.title.includes("옛 설정 파일")), formatChecks(checks));

  await install("claude-desktop", { cliPath, env, home });
  const fixed = await doctor({ cliPath, env, home, fetchImpl: offline });
  assert.ok(fixed.some((c) => c.level === "ok" && c.title === "claude-desktop: 등록됨"), formatChecks(fixed));
  assert.ok(!fixed.some((c) => c.title.includes("옛 설정 파일")));
});

test("install claude-desktop: Claude-Data 설정의 다른 키(preferences 등)를 보존한다", async () => {
  if (process.platform !== "win32") return; // configPath가 플랫폼을 따로 받지 않는 경로
  const home = tempDir();
  const file = path.join(home, "AppData", "Local", "Claude-Data", "claude_pkg", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ coworkUserFilesPath: "C:\\x", preferences: { theme: "dark" } }));
  const result = await install("claude-desktop", { cliPath: fakeCli(), env: {}, home });
  assert.equal(result.file, file);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(written).sort(), ["coworkUserFilesPath", "mcpServers", "preferences"]);
  assert.deepEqual(written.preferences, { theme: "dark" });
  assert.equal(written.mcpServers.grimoire.command, process.execPath);
});

test("mergeServer: 다른 서버와 다른 키는 그대로 둔다", () => {
  const merged = mergeServer(
    { theme: "dark", mcpServers: { other: { command: "x" }, grimoire: { command: "old" } } },
    { command: "/n", args: ["c", "mcp"] },
  );
  assert.deepEqual(merged, {
    theme: "dark",
    mcpServers: { other: { command: "x" }, grimoire: { command: "/n", args: ["c", "mcp"] } },
  });
  assert.deepEqual(mergeServer(null, { command: "/n", args: [] }), { mcpServers: { grimoire: { command: "/n", args: [] } } });
});

test("install: 설정 파일을 만들고, 백업하고, 두 번째는 그대로 둔다", async () => {
  const home = tempDir();
  const cliPath = fakeCli();
  const project = tempDir();

  // 프로젝트 범위 claude-code(.mcp.json) — 새 파일
  const first = await install("claude-code", { cliPath, project, env: {}, home });
  assert.equal(first.file, path.join(project, ".mcp.json"));
  assert.equal(first.backup, null);
  const written = JSON.parse(fs.readFileSync(first.file!, "utf8"));
  assert.equal(written.mcpServers.grimoire.command, process.execPath);

  const again = await install("claude-code", { cliPath, project, env: {}, home });
  assert.equal(again.unchanged, true);

  // 기존 설정이 있는 cursor — 다른 서버 보존 + .bak
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({ mcpServers: { other: { command: "x" } } }), { mode: 0o600 });
  const cursor = await install("cursor", { cliPath, env: {}, home });
  assert.equal(cursor.backup, `${cursorFile}.bak`);
  // 권한 보존 (rename으로 갈아 끼워도 600 유지) — Windows에는 POSIX 권한이 없어 건너뛴다
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(cursorFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(cursor.backup!).mode & 0o777, 0o600);
  }
  const merged = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["grimoire", "other"]);

  // dry-run은 아무것도 쓰지 않는다
  const desktopFile = configPath("claude-desktop", { home })!;
  await install("claude-desktop", { cliPath, env: {}, home, dryRun: true });
  assert.equal(fs.existsSync(desktopFile), false);
});

test("install: 깨진 JSON·빌드 안 된 CLI는 건드리지 않고 멈춘다", async () => {
  const home = tempDir();
  const file = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ broken");
  await assert.rejects(install("cursor", { cliPath: fakeCli(), env: {}, home }), InstallError);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  await assert.rejects(install("cursor", { cliPath: path.join(home, "nope.js"), env: {}, home }), /npm run build/);
});

test("readOnlyPermissions: 읽기 도구만 Claude Code 규칙 이름으로", () => {
  assert.deepEqual(readOnlyPermissions(), [
    "mcp__grimoire__search_memory",
    "mcp__grimoire__show_commit",
    "mcp__grimoire__get_repo_overview",
    "mcp__grimoire__list_repos",
  ]);
});

test("mergePermissions: 빠진 규칙만 더하고 다른 설정·규칙은 그대로 둔다", () => {
  const merged = mergePermissions(
    { theme: "dark", permissions: { defaultMode: "auto", allow: ["Bash(git:*)", "mcp__grimoire__list_repos"], deny: ["x"] } },
    ["mcp__grimoire__search_memory", "mcp__grimoire__list_repos"],
  );
  assert.deepEqual(merged, {
    theme: "dark",
    permissions: { defaultMode: "auto", allow: ["Bash(git:*)", "mcp__grimoire__list_repos", "mcp__grimoire__search_memory"], deny: ["x"] },
  });
  assert.deepEqual(mergePermissions(null, ["a"]), { permissions: { allow: ["a"] } });
});

test("claudeSettingsPath: ~/.claude 아래, CLAUDE_CONFIG_DIR이 있으면 그 아래", () => {
  assert.equal(claudeSettingsPath({ home: "/h" }), path.join("/h", ".claude", "settings.json"));
  assert.equal(claudeSettingsPath({ home: "/h", env: { CLAUDE_CONFIG_DIR: "/c" } }), path.join(path.resolve("/c"), "settings.json"));
});

test("install claude-code(사용자 범위): claude CLI로 등록하고 settings.json에 읽기 권한을 더한다", async () => {
  const home = tempDir();
  const cliPath = fakeCli();
  const calls: string[][] = [];
  const runCommand = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return "";
  };
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode: "auto", allow: ["Bash(git:*)"] }, theme: "dark" }));

  // dry-run은 claude도 부르지 않고 파일도 그대로
  const dry = await install("claude-code", { cliPath, env: {}, home, dryRun: true, runCommand });
  assert.equal(dry.permissions?.added.length, 4);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).permissions.allow.length, 1);

  const first = await install("claude-code", { cliPath, env: {}, home, runCommand });
  assert.ok(calls.some((call) => call.slice(0, 5).join(" ") === "claude mcp add --scope user"), JSON.stringify(calls));
  assert.equal(first.permissions?.file, settingsFile);
  assert.equal(first.permissions?.backup, `${settingsFile}.bak`);
  const written = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(written.theme, "dark");
  assert.equal(written.permissions.defaultMode, "auto");
  assert.deepEqual(written.permissions.allow, ["Bash(git:*)", ...readOnlyPermissions()]);

  // 두 번째는 더할 것이 없다 — 파일도 다시 쓰지 않는다
  fs.rmSync(`${settingsFile}.bak`);
  const again = await install("claude-code", { cliPath, env: {}, home, runCommand });
  assert.deepEqual(again.permissions?.added, []);
  assert.equal(again.permissions?.backup, null);
  assert.equal(fs.existsSync(`${settingsFile}.bak`), false);
});

test("install claude-code(사용자 범위): settings.json이 깨져 있으면 claude 등록도 하지 않는다", async () => {
  const home = tempDir();
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, "{ broken");
  const calls: string[][] = [];
  const runCommand = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return "";
  };
  await assert.rejects(install("claude-code", { cliPath: fakeCli(), env: {}, home, runCommand }), InstallError);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), "{ broken");

  // settings.json이 없으면 새로 만든다
  const fresh = tempDir();
  const created = await install("claude-code", { cliPath: fakeCli(), env: {}, home: fresh, runCommand });
  assert.equal(created.permissions?.backup, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, ".claude", "settings.json"), "utf8")), {
    permissions: { allow: readOnlyPermissions() },
  });
});

test("doctor: README식 'node' 설정과 빈 DB를 짚어 낸다", async () => {
  const home = tempDir();
  const cliPath = fakeCli();
  const file = configPath("claude-desktop", { home })!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { grimoire: { command: "node", args: [cliPath, "mcp"] } } }));

  const offline = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const env = { GRIMOIRE_HOME: path.join(home, ".grimoire"), GRIMOIRE_ME: "me@example.com" };
  const checks = await doctor({ cliPath, env, home, fetchImpl: offline });
  const text = formatChecks(checks);

  assert.ok(checks.some((c) => c.level === "fail" && c.title.includes("실행 파일을 찾을 수 없습니다")), text);
  assert.ok(checks.some((c) => c.level === "warn" && c.title.includes("등록된 레포가 없습니다")), text);
  assert.ok(checks.some((c) => c.level === "ok" && c.title.startsWith("SQLite")), text);
  assert.match(text, /문제 1개/);

  // install로 고치면 실패가 사라진다
  await install("claude-desktop", { cliPath, env, home });
  const fixed = await doctor({ cliPath, env, home, fetchImpl: offline });
  assert.ok(!fixed.some((c) => c.level === "fail"), formatChecks(fixed));
  assert.ok(fixed.some((c) => c.level === "ok" && c.title === "claude-desktop: 등록됨"));
});

test("빈 DB 안내와 add_repo: 안내를 보고 대화 중에 등록할 수 있다", async () => {
  const db = memoryDb();
  const repoDir = makeRepo([{ message: "feat: 결제 웹훅 서명 검증", files: { "src/pay.ts": "x" } }], "pay");
  const context = { db, me: ["me@example.com"], cwd: repoDir };

  const hint = emptyHint(context);
  assert.match(hint ?? "", /지금 작업 디렉터리/);
  const empty = (await callTool(context, "search_memory", { query: "웹훅" })) as { hits: unknown[]; hint?: string };
  assert.equal(empty.hits.length, 0);
  assert.equal(empty.hint, hint);
  assert.match(emptyHint({ ...context, cwd: "/" }) ?? "", /사용자에게 어떤 폴더/);

  const added = (await callTool(context, "add_repo", { path: "." })) as { added: { added: number }[] };
  assert.equal(added.added[0].added, 1);
  const found = (await callTool(context, "search_memory", { query: "웹훅" })) as { hits: unknown[]; hint?: string };
  assert.equal(found.hits.length, 1);
  assert.equal(found.hint, undefined);

  // scan: 폴더 아래 레포 전부, 이미 있는 레포는 새 커밋만
  const parent = path.dirname(repoDir);
  const scanned = (await callTool(context, "add_repo", { path: parent, scan: true })) as { added: { added: number }[] };
  assert.equal(scanned.added.length, 1);
  assert.equal(scanned.added[0].added, 0);

  await assert.rejects(callTool(context, "add_repo", { path: "/definitely/not/here" }), /경로가 없습니다/);
  await assert.rejects(callTool(context, "add_repo", { path: tempDir() }), /git 레포가 아닙니다/);

  // 루트·홈 전체 스캔은 MCP로는 하지 않는다 (터미널의 grimoire scan으로 안내)
  await assert.rejects(callTool(context, "add_repo", { path: "/", scan: true }), /전체를 스캔하지는 않습니다/);
  await assert.rejects(callTool(context, "add_repo", { path: "~", scan: true }), /grimoire scan/);
});

test("DB 파일은 나만 읽을 수 있게 만든다 (이전 버전의 0644도 고친다)", { skip: process.platform === "win32" }, () => {
  const home = path.join(tempDir(), "new-home");
  const file = path.join(home, "grimoire.db");
  openDb(file).close();
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.chmodSync(file, 0o644);
  const db = openDb(file);
  db.exec("CREATE TABLE IF NOT EXISTS t (x)");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}-wal`).mode & 0o777, 0o600, "WAL도 DB 파일 권한을 따른다");
  db.close();
});
