import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { compareVersions, pendingUpdate, readUpdateCache, refreshUpdateCache, VERSION } from "../src/core/update";
import { callTool } from "../src/mcp/tools";
import { needsShell, runUpdate, windowsCommandLine, type Exec } from "../src/setup/update";
import { addCommit, git, makeRepo, memoryDb, tempDir } from "./helpers";

/** GitHub releases/latest 응답을 흉내 내는 fetch — 호출 수를 센다 */
function fakeRelease(tag: string | null) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    if (!tag) throw new Error("offline");
    return new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}` }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const envAt = (home: string) => ({ GRIMOIRE_HOME: home });

test("compareVersions: 숫자 단위로 비교하고 v·prerelease는 무시", () => {
  assert.equal(compareVersions("0.10.0", "0.9.1"), 1);
  assert.equal(compareVersions("v1.2.0", "1.2"), 0);
  assert.equal(compareVersions("1.0.0-beta", "1.0.1"), -1);
  assert.ok(VERSION.match(/^\d+\.\d+\.\d+/), `설치본 버전: ${VERSION}`);
});

test("refreshUpdateCache: 하루 한 번만 묻고, 실패해도 알던 버전은 남긴다", async () => {
  const env = envAt(tempDir());
  const release = fakeRelease("v9.0.0");
  const now = new Date("2026-10-25T00:00:00Z");

  await refreshUpdateCache({ env, fetchImpl: release.impl, now });
  assert.equal(readUpdateCache(env)?.latest, "9.0.0");
  await refreshUpdateCache({ env, fetchImpl: release.impl, now: new Date("2026-10-25T20:00:00Z") });
  assert.equal(release.calls.length, 1, "하루 안에는 다시 묻지 않습니다");

  const offline = fakeRelease(null);
  await refreshUpdateCache({ env, fetchImpl: offline.impl, now: new Date("2026-10-26T01:00:00Z") });
  assert.equal(offline.calls.length, 1);
  assert.equal(readUpdateCache(env)?.latest, "9.0.0", "실패해도 이전 최신 버전 유지");
  assert.deepEqual(pendingUpdate(env, "0.2.0")?.latest, "9.0.0");
  assert.equal(pendingUpdate(env, "9.0.0"), null, "같은 버전이면 알리지 않음");
});

test("GRIMOIRE_UPDATE_CHECK=0이면 묻지도 알리지도 않는다", async () => {
  const home = tempDir();
  const release = fakeRelease("v9.0.0");
  await refreshUpdateCache({ env: envAt(home), fetchImpl: release.impl });
  const off = { ...envAt(home), GRIMOIRE_UPDATE_CHECK: "0" };
  assert.equal(await refreshUpdateCache({ env: off, fetchImpl: release.impl, force: true }), null);
  assert.equal(release.calls.length, 1);
  assert.equal(pendingUpdate(off, "0.2.0"), null);
});

test("버전 형식이 틀린 응답·캐시는 버린다 — npm·git 인자로 옵션이나 셸 명령이 들어가지 않게", async () => {
  const home = tempDir();
  const env = envAt(home);
  await refreshUpdateCache({ env, fetchImpl: fakeRelease("v9.0.0").impl });
  for (const tag of ["--upload-pack=touch /tmp/x", "v9.1.0 & calc", "v9.1.0;rm -rf ~", "latest"]) {
    await refreshUpdateCache({ env, fetchImpl: fakeRelease(tag).impl, force: true });
    assert.equal(readUpdateCache(env)?.latest, "9.0.0", tag);
  }
  assert.equal(readUpdateCache(env)?.url, "https://github.com/Stjoo0925/grimoire/releases", "다른 곳 링크는 기본 링크로");

  // 누가 캐시 파일을 고쳐 놓아도 알림·업데이트에 쓰이지 않는다
  const file = path.join(home, "update.json");
  fs.writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), latest: "9.9.9&calc", tag: "v9.9.9&calc" }));
  assert.equal(readUpdateCache(env)?.latest, undefined);
  assert.equal(pendingUpdate(env, "0.2.0"), null);
  fs.writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), latest: "9.9.9", tag: "--exec=x" }));
  assert.equal(pendingUpdate(env, "0.2.0"), null, "버전과 맞지 않는 태그");
  fs.writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), latest: "9.9.9", tag: "v9.9.9" }));
  assert.equal(pendingUpdate(env, "0.2.0")?.tag, "v9.9.9");
});

test("MCP: 업데이트 안내가 레포 안내와 함께 hint로 실린다", async () => {
  let pending: string | undefined = "Grimoire 9.0.0이 나왔습니다";
  const context = {
    db: memoryDb(),
    me: [],
    cwd: tempDir(),
    updateHint: () => {
      const hint = pending;
      pending = undefined; // 서버처럼 세션에 한 번만
      return hint;
    },
  };
  const first = (await callTool(context, "list_repos")) as { hint?: string };
  assert.match(first.hint ?? "", /레포가 없습니다.*9\.0\.0/);
  const second = (await callTool(context, "list_repos")) as { hint?: string };
  assert.doesNotMatch(second.hint ?? "", /9\.0\.0/);
});

/** 0.2.0 → v0.3.0 태그가 있는 원격과, 0.2.0에 머문 clone */
function installedClone(): { clone: string } {
  const upstream = makeRepo([{ files: { "package.json": '{"name":"grimoire","version":"0.2.0"}' }, message: "0.2.0" }], "upstream");
  const clone = path.join(tempDir(), "grimoire");
  git(path.dirname(clone), ["clone", "-q", upstream, clone]);
  addCommit(upstream, { files: { "package.json": '{"name":"grimoire","version":"0.3.0"}' }, message: "0.3.0" });
  git(upstream, ["tag", "v0.3.0"]);
  return { clone };
}

function recordingExec(): { exec: Exec; npm: string[] } {
  const npm: string[] = [];
  const exec: Exec = async (command, args, cwd) => {
    if (command === "npm") {
      npm.push(args.join(" "));
      return "";
    }
    return git(cwd, args);
  };
  return { exec, npm };
}

test("grimoire update: 태그로 fast-forward하고 npm install·build를 돌린다", async () => {
  const { clone } = installedClone();
  const { exec, npm } = recordingExec();
  const log: string[] = [];
  const code = await runUpdate({
    env: envAt(tempDir()),
    root: clone,
    current: "0.2.0",
    fetchImpl: fakeRelease("v0.3.0").impl,
    exec,
    log: (line) => log.push(line),
  });
  assert.equal(code, 0, log.join("\n"));
  assert.match(fs.readFileSync(path.join(clone, "package.json"), "utf8"), /0\.3\.0/);
  assert.deepEqual(npm, ["install", "run build"]);
  assert.match(log.join("\n"), /다시 시작하세요/);
});

test("grimoire update: npm 설치본이면 npm install -g로 그 버전을 깐다", async () => {
  const root = path.join(tempDir(), "lib", "node_modules", "@stjoo0925", "grimoire");
  fs.mkdirSync(root, { recursive: true });
  const { exec, npm } = recordingExec();
  const code = await runUpdate({
    env: envAt(tempDir()),
    root,
    current: "0.2.0",
    fetchImpl: fakeRelease("v0.3.0").impl,
    exec,
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(npm, ["install -g @stjoo0925/grimoire@0.3.0"]);
});

test("grimoire update: --check·최신·로컬 변경이면 설치본을 건드리지 않는다", async () => {
  const { clone } = installedClone();
  const { exec, npm } = recordingExec();
  const base = { env: envAt(tempDir()), root: clone, exec, log: () => {} };

  assert.equal(await runUpdate({ ...base, current: "0.2.0", check: true, fetchImpl: fakeRelease("v0.3.0").impl }), 0);
  assert.equal(await runUpdate({ ...base, current: "0.3.0", fetchImpl: fakeRelease("v0.3.0").impl }), 0);
  const neverChecked = envAt(tempDir());
  assert.equal(await runUpdate({ ...base, env: neverChecked, current: "0.2.0", fetchImpl: fakeRelease(null).impl }), 1, "확인 실패");

  fs.writeFileSync(path.join(clone, "package.json"), '{"name":"grimoire","version":"0.2.0-local"}');
  assert.equal(await runUpdate({ ...base, current: "0.2.0", fetchImpl: fakeRelease("v0.3.0").impl }), 1, "로컬 변경");
  assert.match(fs.readFileSync(path.join(clone, "package.json"), "utf8"), /0\.2\.0-local/);
  assert.deepEqual(npm, []);
});

test("Windows 셸 명령 한 줄: 업데이트 인자는 그대로 잇고, 셸 문법이 될 글자는 거절한다 (DEP0190 없이)", () => {
  assert.equal(windowsCommandLine("npm", ["install", "-g", "@stjoo0925/grimoire@0.7.0"]), "npm install -g @stjoo0925/grimoire@0.7.0");
  assert.equal(windowsCommandLine("npm", ["install", "-g", "@stjoo0925/grimoire@1.0.0-rc.1"]), "npm install -g @stjoo0925/grimoire@1.0.0-rc.1");
  assert.equal(windowsCommandLine("npm", ["run", "build"]), "npm run build");
  for (const bad of ["0.7.0&calc", "0.7.0|x", "a b", '"x"', "%PATH%", "x^y", "!x!", "(x)", "x>y", "x<y", "x\ny", ""]) {
    assert.throws(() => windowsCommandLine("npm", ["install", bad]), /안전하지 않은 인자/, JSON.stringify(bad));
  }
  assert.equal(needsShell("npm", "win32"), true);
  assert.equal(needsShell("git", "win32"), false, "git.exe는 셸 없이");
  assert.equal(needsShell("npm", "linux"), false);
  assert.equal(needsShell("npm", "darwin"), false);
});

test("기본 실행기: 실제로 npm을 띄워도 DEP0190 경고가 나오지 않는다", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    process.on("warning", (w) => { if (w.code === "DEP0190") { console.log("DEP0190"); } });
    const { runUpdate } = require(${JSON.stringify(path.resolve(__dirname, "..", "src", "setup", "update.js"))});
    const root = ${JSON.stringify(path.join(tempDir(), "lib", "node_modules", "@stjoo0925", "grimoire"))};
    require("node:fs").mkdirSync(root, { recursive: true });
    const fetchImpl = async () => new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://github.com/Stjoo0925/grimoire/releases/tag/v9.9.9" }), { status: 200 });
    runUpdate({ env: { GRIMOIRE_HOME: ${JSON.stringify(tempDir())} }, root, current: "0.0.1", fetchImpl, dryRun: false, log: () => {} }).then((code) => console.log("code", code));
  `;
  // npm install -g를 정말 돌리지 않게 npm 대신 'npm --version'이 되도록 PATH 앞에 가짜 npm을 둔다
  const bin = tempDir();
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "npm.cmd"), "@echo fake-npm %*\r\n");
  else {
    fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\necho fake-npm "$@"\n');
    fs.chmodSync(path.join(bin, "npm"), 0o755);
  }
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    timeout: 60_000,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.ok(!out.includes("DEP0190"), out);
  assert.match(result.stdout, /code 0/, out);
});
