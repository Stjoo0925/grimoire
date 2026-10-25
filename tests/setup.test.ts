import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { callTool, emptyHint } from "../src/mcp/tools";
import { doctor, formatChecks } from "../src/setup/doctor";
import { configPath, install, InstallError, mergeServer, serverSpec } from "../src/setup/install";
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
});

test("configPath: 플랫폼별 위치", () => {
  assert.equal(
    configPath("claude-desktop", { platform: "darwin", home: "/h" }),
    "/h/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(configPath("claude-desktop", { platform: "linux", home: "/h" }), "/h/.config/Claude/claude_desktop_config.json");
  assert.equal(configPath("cursor", { home: "/h" }), "/h/.cursor/mcp.json");
  assert.equal(configPath("cursor", { home: "/h", project: "/p" }), "/p/.cursor/mcp.json");
  assert.equal(configPath("claude-code", { home: "/h" }), null); // 사용자 범위는 claude CLI에 맡긴다
  assert.equal(configPath("claude-code", { home: "/h", project: "/p" }), "/p/.mcp.json");
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
  // 권한 보존 (rename으로 갈아 끼워도 600 유지)
  assert.equal(fs.statSync(cursorFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(cursor.backup!).mode & 0o777, 0o600);
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
  assert.ok(checks.some((c) => c.level === "warn" && c.title.includes("Ollama")), text);
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
});
