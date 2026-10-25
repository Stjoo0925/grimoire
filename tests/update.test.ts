import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { compareVersions, pendingUpdate, readUpdateCache, refreshUpdateCache, VERSION } from "../src/core/update";
import { callTool } from "../src/mcp/tools";
import { runUpdate, type Exec } from "../src/setup/update";
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
