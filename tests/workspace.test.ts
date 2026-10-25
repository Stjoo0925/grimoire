import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { addRepo, listRepos, syncRepo } from "../src/core/indexer";
import { search } from "../src/core/search";
import { callTool, emptyHint } from "../src/mcp/tools";
import { isTempPath, resolveWorkspaceRoot, startWorkspace, waitForWorkspace } from "../src/mcp/workspace";
import { makeRepo, memoryDb } from "./helpers";

const quiet = () => undefined;

function project(name: string, subject: string): string {
  return makeRepo([{ message: subject, files: { "src/pay/webhook.ts": "export function verifySignature() {}\n" } }], name);
}

test("resolveWorkspaceRoot: 하위 폴더 → 레포 최상위, 레포 아님·홈·임시 폴더는 null", async () => {
  const dir = project("app", "feat: 결제 웹훅 서명 검증"); // 테스트 레포는 임시 폴더에 생긴다
  const force = { GRIMOIRE_AUTO_ADD: "1" };
  assert.equal(await resolveWorkspaceRoot(path.join(dir, "src"), force), fs.realpathSync(dir));
  // 기본값: 임시 폴더 안의 일회용 레포는 자동 등록하지 않는다
  assert.equal(await resolveWorkspaceRoot(path.join(dir, "src"), {}), null);
  assert.equal(await resolveWorkspaceRoot(fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-")), force), null);
  assert.equal(await resolveWorkspaceRoot("/", force), null);
});

test("isTempPath: 시스템 임시 폴더와 /tmp·/var/folders, 심볼릭 링크까지", () => {
  assert.equal(isTempPath(os.tmpdir()), true);
  assert.equal(isTempPath(path.join(os.tmpdir(), "x", "y")), true);
  assert.equal(isTempPath("/tmp/scratchpad/ci"), true);
  assert.equal(isTempPath("/private/tmp/claude-501/scratchpad/ci"), true);
  assert.equal(isTempPath(path.join(os.homedir(), "work-dir", "app")), false);
  assert.equal(isTempPath("/tmpfoo/app"), false); // 접두만 같은 다른 폴더
});

test("startWorkspace: begin 전에는 아무것도 쓰지 않고, 새 레포는 등록·첫 인덱싱 뒤 풀리고, 끄면 null", async () => {
  const db = memoryDb();
  const dir = project("app", "feat: 결제 웹훅 서명 검증");
  const root = fs.realpathSync(dir);

  const fresh = startWorkspace(db, root, {}, quiet);
  assert.equal(listRepos(db).length, 0); // 연결 확인처럼 곧 끝나는 실행이면 여기서 끝난다
  const repo = await fresh.begin();
  assert.equal(await fresh.begin(), repo); // 여러 번 불러도 한 번만
  assert.equal(repo?.path, root);
  const commits = (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number }).n;
  assert.equal(commits, 1); // ready가 풀렸을 때 이미 인덱싱돼 있다

  const again = startWorkspace(db, root, {}, quiet);
  assert.equal((await again.begin())?.id, repo?.id);
  assert.equal(listRepos(db).length, 1);

  const off = startWorkspace(memoryDb(), root, { GRIMOIRE_AUTO_ADD: "0" }, quiet);
  assert.equal(await off.begin(), null);
  assert.equal(off.disabled, true);

  assert.equal(await waitForWorkspace(undefined, 10), null);
});

test("syncRepo: 같은 레포를 동시에 돌려도 행이 중복되지 않는다", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, project("app", "feat: 결제 웹훅 서명 검증"));
  const results = await Promise.all([syncRepo(db, repo), syncRepo(db, repo), syncRepo(db, repo)]);
  assert.deepEqual(results.map((result) => result.added), [1, 0, 0]);
  const files = (db.prepare("SELECT COUNT(*) AS n FROM commit_files").get() as { n: number }).n;
  assert.equal(files, 1);
});

test("preferRepoId: 같은 내용이면 현재 레포 결과가 앞에 온다 (다른 레포도 남는다)", async () => {
  const db = memoryDb();
  const a = await addRepo(db, project("alpha", "feat: 결제 웹훅 서명 검증"));
  const b = await addRepo(db, project("beta", "feat: 결제 웹훅 서명 검증"));
  await syncRepo(db, a);
  await syncRepo(db, b);

  for (const current of [a, b]) {
    const result = await search(db, "웹훅 서명", { preferRepoId: current.id, kind: "commit" });
    assert.equal(result.hits[0].repo, current.name);
    assert.equal(result.hits.length, 2);
  }
});

test("MCP: 작업 레포가 current로 표시되고, 자동 등록을 끈 채 빠져 있으면 hint로 알린다", async () => {
  const db = memoryDb();
  const other = await addRepo(db, project("other", "feat: 다른 레포"));
  await syncRepo(db, other);
  const root = fs.realpathSync(project("app", "feat: 결제 웹훅 서명 검증"));

  // 끈 상태: 등록되지 않고, 안내가 나온다
  const offContext = { db, me: ["me@example.com"], cwd: root, workspace: startWorkspace(db, root, { GRIMOIRE_AUTO_ADD: "0" }, quiet) };
  assert.match(emptyHint(offContext) ?? "", /등록돼 있지 않아 검색에서 빠집니다/);
  const off = (await callTool(offContext, "search_memory", { query: "웹훅" })) as { hits: unknown[]; hint?: string; current?: string };
  assert.equal(off.current, undefined);
  assert.match(off.hint ?? "", /add_repo/);

  // 켠 상태: 첫 질의 전에 등록·인덱싱되고 current로 표시된다
  const onContext = { db, me: ["me@example.com"], cwd: root, workspace: startWorkspace(db, root, {}, quiet) };
  const on = (await callTool(onContext, "search_memory", { query: "웹훅 서명" })) as {
    hits: { repo?: string }[];
    hint?: string;
    current?: string;
  };
  assert.equal(on.current, "app");
  assert.equal(on.hits[0].repo, "app");
  assert.equal(on.hint, undefined);
  const listed = (await callTool(onContext, "list_repos")) as { current?: string; repos: unknown[] };
  assert.equal(listed.current, "app");
  assert.equal(listed.repos.length, 2);
});
