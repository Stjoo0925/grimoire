import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { addRepo, listRepos, syncRepo, type RepoRow } from "../src/core/indexer";
import { search } from "../src/core/search";
import { callTool, emptyHint } from "../src/mcp/tools";
import { chooseRoot, isTempPath, resolveWorkspaceRoot, rootFromRoots, startWorkspace, waitForWorkspace, type Workspace } from "../src/mcp/workspace";
import { git, makeRepo, memoryDb, tempDir } from "./helpers";

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
  // macOS는 /tmp가 /private/tmp의 링크라 실제 경로로 와도 임시로 본다 (리눅스에는 /private가 없다)
  if (process.platform === "darwin") assert.equal(isTempPath("/private/tmp/claude-501/scratchpad/ci"), true);
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

test("rootFromRoots: file:// 중 등록할 만한 레포 — 다른 스킴·레포 아님·임시 폴더는 건너뛴다", async () => {
  const dir = project("app", "feat: 결제 웹훅 서명 검증");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
  const force = { GRIMOIRE_AUTO_ADD: "1" };
  const uris = ["https://example.com/app", pathToFileURL(plain).href, pathToFileURL(path.join(dir, "src")).href];
  assert.equal(await rootFromRoots(uris, force), fs.realpathSync(dir));
  // 기본값: 임시 폴더 안의 레포는 cwd와 마찬가지로 건너뛴다
  assert.equal(await rootFromRoots(uris, {}), null);
  assert.equal(await rootFromRoots(["file://%zz", "not a uri"], force), null);
  assert.equal(await rootFromRoots([], force), null);
});

test("rootFromRoots: 서로 다른 레포가 둘이면 고르지 않고(null), 한 레포의 워크트리 여럿은 그 레포", async () => {
  const force = { GRIMOIRE_AUTO_ADD: "1" };
  const a = fs.realpathSync(project("alpha", "feat: a"));
  const b = fs.realpathSync(project("beta", "feat: b"));
  // 데스크톱 앱처럼 여러 세션의 폴더가 한꺼번에 오면 "처음 것"이 이 세션의 레포라는 보장이 없다
  const two = await chooseRoot([pathToFileURL(a).href, pathToFileURL(b).href], force);
  assert.equal(two.target, null);
  assert.match(two.reason, /레포 2개/);
  assert.equal(await rootFromRoots([pathToFileURL(a).href, pathToFileURL(path.join(b, "src")).href], force), null);

  const outside = path.join(tempDir("grimoire-roots-wt-"), "feature");
  git(a, ["worktree", "add", "-q", "-b", "feature", outside]);
  const nested = path.join(a, ".claude", "worktrees", "s1");
  git(a, ["worktree", "add", "-q", "-b", "s1", nested]);
  // 워크트리 하나만 오면 작업 레포는 본 레포, 작업 트리는 그 워크트리(하위 폴더여도 최상위로)
  assert.deepEqual((await chooseRoot([pathToFileURL(path.join(outside, "src")).href], force)).target, { root: a, folder: outside });
  // 한 레포의 작업 트리가 여럿이면 레포는 하나 — 작업 트리는 어느 쪽인지 고르지 않고 본 레포
  assert.equal(await rootFromRoots([pathToFileURL(outside).href, pathToFileURL(nested).href, pathToFileURL(a).href], force), a);
  assert.deepEqual((await chooseRoot([pathToFileURL(outside).href, pathToFileURL(nested).href], force)).target, { root: a, folder: a });
  // 같은 작업 트리를 두 번(하위 폴더로) 알려 줘도 그 작업 트리
  assert.deepEqual((await chooseRoot([pathToFileURL(nested).href, pathToFileURL(path.join(nested, "src")).href], force)).target, { root: a, folder: nested });
});

test("startWorkspace.reset: roots로 정한 레포를 잊고 다시 찾는다 — 늦게 끝난 옛 찾기는 새 상태를 덮지 않는다. 정해진 경로는 그대로", async () => {
  const a = fs.realpathSync(project("alpha", "feat: 결제 웹훅 서명 검증"));
  const b = fs.realpathSync(project("beta", "feat: 장바구니 합계"));
  let answer: string = a;
  const db = memoryDb();
  const workspace = startWorkspace(db, async () => ({ root: answer, folder: answer }), {}, quiet);
  assert.equal((await waitForWorkspace(workspace, 15_000))?.path, a);
  assert.equal(workspace.folder, a);

  answer = b;
  workspace.reset?.();
  assert.equal(workspace.root, null);
  assert.equal((await waitForWorkspace(workspace, 15_000))?.path, b);
  assert.equal(workspace.root, b);
  assert.equal(listRepos(db).length, 2); // 옛 레포의 등록·동기화는 그대로 남는다

  // reset 전에 시작한 찾기가 늦게 풀리면 버린다
  let release: (value: string) => void = () => undefined;
  const slow = startWorkspace(memoryDb(), () => new Promise<string>((resolve) => (release = resolve)), {}, quiet);
  const stale = slow.begin();
  slow.reset?.();
  release(a);
  assert.equal(await stale, null);
  assert.equal(slow.root, null);

  // 정해진 경로(cwd)는 reset해도 바뀌지 않는다
  const fixed = startWorkspace(memoryDb(), a, {}, quiet);
  const first = await fixed.begin();
  fixed.reset?.();
  assert.equal(fixed.root, a);
  assert.equal(await fixed.begin(), first);
});

test("impact(경로 없음): 작업 폴더(context.cwd)가 레포의 워크트리면 그 워크트리의 커밋 안 된 변경을 읽는다", async () => {
  const main = fs.realpathSync(
    makeRepo(
      [
        { message: "feat: 시작", files: { "src/a.ts": "export const a = 0;\n", "src/b.ts": "export const b = 0;\n" } },
        { message: "feat: 같이 1", files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" } },
      ],
      "impactwt",
    ),
  );
  const worktree = path.join(tempDir("grimoire-impact-wt-"), "session");
  git(main, ["worktree", "add", "-q", "-b", "session", worktree]);
  fs.writeFileSync(path.join(worktree, "src", "a.ts"), "export const a = 2;\n");
  const db = memoryDb();
  await syncRepo(db, await addRepo(db, main));
  // 데스크톱 앱처럼 서버 cwd가 레포 밖이면 server.ts가 roots에서 고른 작업 트리를 context.cwd로 넘긴다
  const fromWorktree = (await callTool({ db, me: [], cwd: worktree }, "impact", { repo: "impactwt" })) as { changed: string[] };
  assert.deepEqual(fromWorktree.changed, ["src/a.ts"]);
  // 본 레포 기준(예전 동작)이면 본 레포에는 변경이 없다
  const fromMain = (await callTool({ db, me: [], cwd: tempDir() }, "impact", { repo: "impactwt" })) as { changed: string[] };
  assert.deepEqual(fromMain.changed, []);
});

test("startWorkspace(찾기 함수): begin 때 한 번만 부르고, 찾은 레포를 등록한다. 꺼져 있으면 부르지 않는다", async () => {
  const dir = project("app", "feat: 결제 웹훅 서명 검증");
  const root = fs.realpathSync(dir);
  let calls = 0;
  const lookup = async () => {
    calls++;
    return root;
  };

  const db = memoryDb();
  const workspace = startWorkspace(db, lookup, {}, quiet);
  assert.equal(workspace.root, null); // 연결 뒤에야 알 수 있다
  assert.equal(calls, 0);
  const repo = await workspace.begin();
  await workspace.begin();
  assert.equal(calls, 1);
  assert.equal(repo?.path, root);
  assert.equal(workspace.root, root);
  assert.equal(listRepos(db).length, 1);

  const off = startWorkspace(memoryDb(), lookup, { GRIMOIRE_AUTO_ADD: "0" }, quiet);
  assert.equal(await off.begin(), null);
  assert.equal(calls, 1);

  // 찾기가 실패하거나 못 찾으면 작업 레포 없이 간다
  const failing = startWorkspace(memoryDb(), () => Promise.reject(new Error("roots 실패")), {}, quiet);
  assert.equal(await failing.begin(), null);
  assert.equal(failing.root, null);
  const none = startWorkspace(memoryDb(), async () => null, {}, quiet);
  assert.equal(await none.begin(), null);
});

test("add_repo 진행: 레포마다 done/total을 늘려 가며 알리고 마지막에 완료", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-progress-"));
  for (const name of ["api", "web"]) {
    const dir = project(name, `feat: ${name} 시작`);
    fs.renameSync(dir, path.join(parent, name));
  }
  const events: [number, number, string][] = [];
  const context = { db: memoryDb(), me: [], cwd: parent };
  const result = (await callTool(context, "add_repo", { path: parent, scan: true }, undefined, (done, total, message) => events.push([done, total, message]))) as {
    added: unknown[];
  };
  assert.equal(result.added.length, 2);
  assert.deepEqual(
    events.map(([done, total]) => [done, total]),
    [
      [0, 2],
      [1, 2],
      [2, 2],
    ],
  );
  assert.match(events[0][2], /(api|web) 인덱싱 중 \(1\/2\)/);
  assert.equal(events[2][2], "인덱싱 완료");
  // 진행을 원하지 않는 호출은 그대로 동작한다
  const plain = (await callTool({ db: memoryDb(), me: [], cwd: parent }, "add_repo", { path: path.join(parent, "api") })) as { added: unknown[] };
  assert.equal(plain.added.length, 1);
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

test("waitForWorkspace: 한 번 시간을 넘기면 첫 인덱싱이 끝날 때까지 다시 기다리지 않는다", async () => {
  let release: (repo: RepoRow) => void = () => undefined;
  const pending = new Promise<RepoRow>((resolve) => (release = resolve));
  const workspace: Workspace = { root: "/x", disabled: false, begin: () => pending };

  let started = Date.now();
  assert.equal(await waitForWorkspace(workspace, 100), null);
  assert.ok(Date.now() - started >= 90);
  started = Date.now();
  assert.equal(await waitForWorkspace(workspace, 5_000), null);
  assert.ok(Date.now() - started < 50, `두 번째 호출이 ${Date.now() - started}ms 기다렸습니다`);

  const repo = { id: 1, path: "/x", name: "x", remote_url: null, added_at: "", synced_at: null };
  release(repo);
  await pending;
  assert.equal(await waitForWorkspace(workspace, 5_000), repo);
});

test("progressOf: 보낸 진행 알림이 다 나간 뒤에야 settled가 끝난다 (응답보다 마지막 알림이 늦게 가지 않게)", async () => {
  const { progressOf } = await import("../src/mcp/server.js");
  const sent: number[] = [];
  // 알림 전송이 늦게 끝나는 전송 계층 — 마지막 알림이 가장 늦다
  const notify = (notification: { method: string; params?: Record<string, unknown> }) =>
    new Promise<void>((resolve) => setTimeout(() => {
      sent.push(notification.params?.progress as number);
      resolve();
    }, notification.params?.progress === 2 ? 30 : 5));
  assert.equal(progressOf({ notify }), undefined, "progressToken이 없으면 알리지 않는다");
  const progress = progressOf({ _meta: { progressToken: "t" }, notify })!;
  progress.report(0, 2, "a");
  progress.report(1, 2, "b");
  progress.report(2, 2, "완료");
  await progress.settled();
  assert.deepEqual([...sent].sort(), [0, 1, 2], "settled 뒤에는 세 알림이 모두 나가 있어야 합니다");
});
