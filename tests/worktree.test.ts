import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { commitContextOf } from "../src/core/capture";
import { headSha, mainRepoRoot, worktreeRoots } from "../src/core/git";
import { addRepo, listRepos, resolveRepoFile, syncRepo, worktreeRegistrations } from "../src/core/indexer";
import { handleHook, type HookInput } from "../src/hook/runner";
import { callTool } from "../src/mcp/tools";
import { resolveWorkspaceRoot } from "../src/mcp/workspace";
import { addCommit, git, makeRepo, memoryDb, tempDir, type FakeCommit } from "./helpers";

/** a.ts와 b.ts가 늘 같이 바뀌는 레포 + 레포 밖 워크트리 + 레포 안 .claude/worktrees 워크트리 */
function repoWithWorktrees() {
  const commits: FakeCommit[] = [{ message: "feat: 시작", files: { "src/a.ts": "export const a = 0;\n", "src/b.ts": "export const b = 0;\n" }, date: "2024-01-01T10:00:00+09:00" }];
  for (let i = 1; i <= 3; i++) {
    commits.push({ message: `feat: 같이 ${i}`, files: { "src/a.ts": `export const a = ${i};\n`, "src/b.ts": `export const b = ${i};\n` }, date: `2024-0${i + 1}-01T10:00:00+09:00` });
  }
  const main = makeRepo(commits, "wtmain");
  const outside = path.join(tempDir("grimoire-wt-"), "outside");
  git(main, ["worktree", "add", "-q", "-b", "feature", outside]);
  const nested = path.join(main, ".claude", "worktrees", "session-1");
  git(main, ["worktree", "add", "-q", "-b", "session-1", nested]);
  return { main, outside, nested };
}

test("worktreeRoots·mainRepoRoot: 추가 작업 트리는 본 레포로 올라가고, 본 레포·레포 밖은 그대로", async () => {
  const { main, outside, nested } = repoWithWorktrees();
  assert.deepEqual(await worktreeRoots(outside), { top: outside, main });
  assert.deepEqual(await worktreeRoots(path.join(nested, "src")), { top: nested, main });
  assert.deepEqual(await worktreeRoots(main), { top: main, main });
  assert.equal(await mainRepoRoot(outside), main);
  assert.equal(await mainRepoRoot(tempDir()), null);
});

test("addRepo·자동 등록: 워크트리에서 등록해도 본 레포 하나만 생긴다", async () => {
  const { main, outside, nested } = repoWithWorktrees();
  const db = memoryDb();
  const a = await addRepo(db, outside);
  const b = await addRepo(db, nested);
  const c = await addRepo(db, main);
  assert.equal(a.path, main);
  assert.equal(new Set([a.id, b.id, c.id]).size, 1);
  assert.equal(listRepos(db).length, 1);
  // Claude Code가 워크트리에서 MCP 서버를 띄워도 작업 레포는 본 레포 (임시 폴더라 GRIMOIRE_AUTO_ADD=1)
  assert.equal(await resolveWorkspaceRoot(path.join(outside, "src"), { GRIMOIRE_AUTO_ADD: "1" }), main);
  assert.equal(await resolveWorkspaceRoot(nested, { GRIMOIRE_AUTO_ADD: "1" }), main);
});

test("resolveRepoFile·file_context·훅: 레포 밖 워크트리의 파일도 본 레포의 기억으로 푼다", async () => {
  const { main, outside, nested } = repoWithWorktrees();
  const db = memoryDb();
  const repo = await addRepo(db, main);
  await syncRepo(db, repo);

  const short = async (file: string) => {
    const found = await resolveRepoFile(db, file);
    return found && { id: found.repo.id, relative: found.relative };
  };
  assert.deepEqual(await short(path.join(outside, "src", "a.ts")), { id: repo.id, relative: "src/a.ts" });
  assert.deepEqual(await short(path.join(nested, "src", "a.ts")), { id: repo.id, relative: "src/a.ts" });
  // 아직 없는 파일(새로 만들 파일)도 가장 가까운 폴더로
  assert.equal((await resolveRepoFile(db, path.join(outside, "src", "new", "c.ts")))?.relative, "src/new/c.ts");
  assert.equal(await resolveRepoFile(db, path.join(tempDir(), "x.ts")), null);

  const tool = (await callTool({ db, me: [], cwd: outside }, "file_context", { path: path.join(outside, "src", "a.ts") })) as { file: string; cochanges?: string[] };
  assert.equal(tool.file, "src/a.ts");
  assert.deepEqual(tool.cochanges, ["src/b.ts 4/4 strong"]);

  const env = { GRIMOIRE_HOME: tempDir("grimoire-wt-home-") };
  const out = await handleHook({ db, env, me: [] }, {
    hook_event_name: "PreToolUse",
    session_id: "wt-1",
    cwd: outside,
    tool_name: "Edit",
    tool_input: { file_path: path.join(outside, "src", "a.ts"), old_string: "1", new_string: "2" },
  } as HookInput);
  assert.match(out?.json?.hookSpecificOutput.additionalContext ?? "", /^Grimoire: src\/a\.ts\n[\s\S]*Co-changes: src\/b\.ts \(4\/4, strong\)/);
});

test("캡처: 워크트리에서 만든 커밋은 그 워크트리의 HEAD에 묶인다 (본 레포 폴더의 HEAD가 아니라)", async () => {
  const { main, outside } = repoWithWorktrees();
  const db = memoryDb();
  const repo = await addRepo(db, main);
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-wt-cap-") };
  const context = { db, env, me: [] };
  const base = { session_id: "wt-cap", cwd: outside };
  await handleHook(context, { ...base, hook_event_name: "UserPromptSubmit", prompt: "워크트리에서 a를 5로 바꾸는 이유는 경계값 때문" } as HookInput);
  await handleHook(context, {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path.join(outside, "src", "a.ts"), old_string: "3", new_string: "export const a = 5;" },
  } as HookInput);

  addCommit(outside, { message: "fix(a): 경계값", files: { "src/a.ts": "export const a = 5;\n" }, date: "2024-06-01T10:00:00+09:00" });
  const worktreeHead = (await headSha(outside))!;
  const mainHead = (await headSha(main))!;
  assert.notEqual(worktreeHead, mainHead);
  await handleHook(context, {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -am "fix(a): 경계값"' },
    tool_response: { stdout: "[feature abc1234] fix(a)", stderr: "" },
  } as HookInput);

  assert.deepEqual(commitContextOf(db, repo.id, worktreeHead)?.prompts, ["워크트리에서 a를 5로 바꾸는 이유는 경계값 때문"]);
  assert.equal(commitContextOf(db, repo.id, mainHead), null, "본 레포 폴더의 HEAD에 묶이면 안 됩니다");
});

test("worktreeRegistrations: 예전 버전이 따로 등록한 워크트리를 찾아낸다", async () => {
  const { main, nested } = repoWithWorktrees();
  const db = memoryDb();
  await addRepo(db, main);
  // 예전 버전처럼 워크트리를 그 자리에서 등록해 둔다
  db.prepare("INSERT INTO repos (path, name, remote_url, added_at) VALUES (?, ?, NULL, ?)").run(nested, "session-1", new Date().toISOString());
  const found = await worktreeRegistrations(db);
  assert.equal(found.length, 1);
  assert.equal(found[0].repo.name, "session-1");
  assert.equal(found[0].main, main);
  assert.equal(found[0].mainRegistered, true);
  fs.rmSync(nested, { recursive: true, force: true });
  assert.deepEqual(await worktreeRegistrations(db), [], "경로가 사라진 레포는 doctor의 다른 점검이 다룬다");
});

test("resolveRepoFile: git 없이 .git 파일로 푼다 — 상대경로 gitdir도, 서브모듈은 아니다", async () => {
  const db = memoryDb();
  const main = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "1\n" } }], "gitfile-main");
  const repo = await addRepo(db, main);
  const parent = path.dirname(main);
  // git 2.48+ worktree.useRelativePaths: gitdir이 작업 트리 기준 상대경로
  const relative = path.join(parent, "gitfile-wt");
  fs.mkdirSync(path.join(relative, "src"), { recursive: true });
  fs.writeFileSync(path.join(relative, ".git"), `gitdir: ../${path.basename(main)}/.git/worktrees/gitfile-wt\n`);
  const found = await resolveRepoFile(db, path.join(relative, "src", "a.ts"));
  assert.equal(found?.repo.id, repo.id);
  assert.equal(found?.relative, "src/a.ts");
  // 서브모듈은 .git/modules/x를 가리킨다 — 추가 작업 트리가 아니다
  const sub = path.join(parent, "gitfile-sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, ".git"), `gitdir: ${main}/.git/modules/sub\n`);
  assert.equal(await resolveRepoFile(db, path.join(sub, "x.ts")), null);
});
