import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { codexConfigPath, mergeCodexConfig, readCodexServer, verifyCodexConfig } from "../src/setup/codex";
import { configPath, install, InstallError, readInstalled, readOnlyTools } from "../src/setup/install";
import { tempDir } from "./helpers";

const SERVER = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\work\\grimoire\\dist\\cli.js", "mcp"] };

function fakeCli(): string {
  const file = path.join(tempDir(), "dist", "cli.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

/** codex 명령 대신 — 설정을 읽었다고 답한다 */
const codexOk = async () => "{}";

test("codexConfigPath: CODEX_HOME이 있으면 그 아래, 없으면 ~/.codex", () => {
  assert.equal(codexConfigPath({ home: "/h", env: {} }), path.join("/h", ".codex", "config.toml"));
  assert.equal(codexConfigPath({ home: "/h", env: { CODEX_HOME: "/c" } }), path.join(path.resolve("/c"), "config.toml"));
  assert.equal(configPath("codex", { home: "/h", env: {} }), path.join("/h", ".codex", "config.toml"));
});

test("mergeCodexConfig: 빈 파일이면 블록만, 백슬래시 경로·env·읽기 도구 승인을 적고 다시 읽힌다", () => {
  const text = mergeCodexConfig(null, "grimoire", { ...SERVER, env: { GRIMOIRE_HOME: "D:\\g" } }, ["search_memory"]);
  assert.equal(
    text,
    [
      "[mcp_servers.grimoire]",
      'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
      'args = ["C:\\\\work\\\\grimoire\\\\dist\\\\cli.js", "mcp"]',
      "",
      "[mcp_servers.grimoire.env]",
      'GRIMOIRE_HOME = "D:\\\\g"',
      "",
      "[mcp_servers.grimoire.tools.search_memory]",
      'approval_mode = "approve"',
      "",
    ].join("\n"),
  );
  assert.deepEqual(readCodexServer(text, "grimoire"), { ...SERVER, env: { GRIMOIRE_HOME: "D:\\g" } });
});

test("mergeCodexConfig: 옛 grimoire 표(하위 표까지)만 바꾸고 나머지는 글자 그대로 둔다", () => {
  const before = [
    "# 내 설정",
    'model = "gpt-5"',
    'notes = """',
    "[mcp_servers.grimoire]",
    'this is just text"""',
    "",
    "[mcp_servers.other]",
    'command = "x"',
    "args = [",
    '  "[not a header]",',
    "  [1, 2],",
    "]",
    "",
    "[mcp_servers.grimoire]",
    'command = "old-node"',
    'args = ["old.js", "mcp"]',
    "",
    "[mcp_servers.grimoire.env]",
    'GRIMOIRE_HOME = "/old"',
    "",
    '[mcp_servers."grimoire".tools.list_repos]',
    'approval_mode = "prompt"',
    "",
    "[profiles.fast] # 뒤에 오는 표도 남는다",
    'model = "gpt-5-mini"',
    "",
  ].join("\r\n");
  const after = mergeCodexConfig(before, "grimoire", SERVER, ["list_repos"]);
  const kept = before.split("\r\n[mcp_servers.grimoire]\r\ncommand")[0];
  assert.ok(after.startsWith(kept), "grimoire 앞의 줄(여러 줄 문자열·배열 포함)은 그대로");
  assert.ok(after.includes('\r\n[profiles.fast] # 뒤에 오는 표도 남는다\r\nmodel = "gpt-5-mini"\r\n'), "뒤의 표도 그대로");
  assert.ok(!after.includes("old-node") && !after.includes("/old") && !after.includes('"prompt"'), "옛 항목은 남지 않는다");
  assert.ok(!/(^|[^\r])\n/.test(after), "CRLF 파일은 CRLF로");
  // 여러 줄 문자열 안의 "[mcp_servers.grimoire]" 글자는 내용이라 남고, 실제 표 머리는 새 블록 하나뿐
  assert.equal(after.slice(kept.length).match(/^\[mcp_servers\.grimoire\]/gm)?.length, 1);
  assert.deepEqual(readCodexServer(after, "grimoire"), SERVER);
  // 같은 내용이면 바뀌지 않는다
  assert.equal(mergeCodexConfig(after, "grimoire", SERVER, ["list_repos"]), after);
});

test("mergeCodexConfig: grimoire가 인라인 표·점 키·배열 표로 적혀 있으면 건드리지 않는다", () => {
  for (const raw of [
    '[mcp_servers]\ngrimoire = { command = "node", args = [] }\n',
    'mcp_servers.grimoire.command = "node"\n',
    "[[mcp_servers.grimoire]]\n",
  ]) {
    assert.throws(() => mergeCodexConfig(raw, "grimoire", SERVER), /건드리지 않았습니다/, raw);
  }
  // 이름만 비슷한 다른 서버는 상관없다
  assert.doesNotThrow(() => mergeCodexConfig('[mcp_servers]\ngrimoire-old = { command = "x" }\n', "grimoire", SERVER));
});

test("verifyCodexConfig: Codex가 설정을 못 읽었다고 하면 던지고, codex가 없으면 확인 못 함(false)", async () => {
  assert.equal(await verifyCodexConfig("grimoire", codexOk), true);
  const broken = async () => {
    throw new Error("Error: failed to load configuration\nunknown variant `approve`");
  };
  await assert.rejects(verifyCodexConfig("grimoire", broken), /failed to load configuration/);
  const missing = async () => {
    throw new Error("spawn codex ENOENT");
  };
  assert.equal(await verifyCodexConfig("grimoire", missing), false);
});

test("install codex: config.toml에 등록·백업·두 번째는 그대로, doctor가 읽을 수 있다", async () => {
  const home = tempDir();
  const cliPath = fakeCli();
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');

  const first = await install("codex", { cliPath, env: { GRIMOIRE_HOME: "/data/g" }, home, runCommand: codexOk });
  assert.equal(first.file, file);
  assert.equal(first.backup, `${file}.bak`);
  assert.equal(first.verified, true);
  assert.deepEqual(first.approved, readOnlyTools());
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.grimoire]\n'));
  for (const tool of readOnlyTools()) assert.ok(text.includes(`[mcp_servers.grimoire.tools.${tool}]\napproval_mode = "approve"`), tool);
  assert.ok(!text.includes("tools.add_repo") && !text.includes("tools.record_note"), "쓰기 도구는 승인을 묻는다");

  const installed = readInstalled(file);
  assert.equal(installed?.command, process.execPath);
  assert.deepEqual(installed?.args, [path.resolve(cliPath), "mcp"]);
  assert.equal(installed?.env?.GRIMOIRE_HOME, path.resolve("/data/g"));

  const again = await install("codex", { cliPath, env: { GRIMOIRE_HOME: "/data/g" }, home, runCommand: codexOk });
  assert.equal(again.unchanged, true);

  // dry-run은 쓰지 않고 붙일 블록을 보여 준다
  const fresh = tempDir();
  const dry = await install("codex", { cliPath, env: {}, home: fresh, dryRun: true, runCommand: codexOk });
  assert.match(dry.preview ?? "", /^\[mcp_servers\.grimoire\]/);
  assert.equal(fs.existsSync(path.join(fresh, ".codex", "config.toml")), false);

  await assert.rejects(install("codex", { cliPath, env: {}, home, project: home, runCommand: codexOk }), /--project 없이/);
});

test("install codex: Codex가 바뀐 설정을 못 읽으면 원래대로 되돌린다 (없던 파일은 지운다)", async () => {
  const cliPath = fakeCli();
  const rejecting = async () => {
    throw new Error("failed to load configuration: unknown field `approval_mode`");
  };

  const home = tempDir();
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = 'model = "gpt-5"\r\n';
  fs.writeFileSync(file, original);
  await assert.rejects(install("codex", { cliPath, env: {}, home, runCommand: rejecting }), (error: unknown) => {
    assert.ok(error instanceof InstallError);
    assert.match(error.message, /되돌렸습니다[\s\S]*approval_mode/);
    return true;
  });
  assert.equal(fs.readFileSync(file, "utf8"), original);

  const empty = tempDir();
  await assert.rejects(install("codex", { cliPath, env: {}, home: empty, runCommand: rejecting }), InstallError);
  assert.equal(fs.existsSync(path.join(empty, ".codex", "config.toml")), false);

  // grimoire가 인라인 표로 적혀 있으면 파일을 건드리지 않고 멈춘다
  const inline = tempDir();
  const inlineFile = path.join(inline, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(inlineFile), { recursive: true });
  fs.writeFileSync(inlineFile, '[mcp_servers]\ngrimoire = { command = "node" }\n');
  await assert.rejects(install("codex", { cliPath, env: {}, home: inline, runCommand: codexOk }), /직접 고치거나/);
  assert.equal(fs.readFileSync(inlineFile, "utf8"), '[mcp_servers]\ngrimoire = { command = "node" }\n');
});
