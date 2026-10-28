import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { addRepo, syncRepo } from "../src/core/indexer";
import { handleHook, loadSession, pruneSessions, sessionsDir, type HookInput } from "../src/hook/runner";
import { hookCommand, installHooks, mergeHooks, outdatedHooks, parseHookCommand, readInstalledHooks, settingsPath } from "../src/setup/hooks";
import { git, makeRepo, memoryDb, tempDir, type FakeCommit } from "./helpers";

function coupledRepo() {
  const commits: FakeCommit[] = [
    { message: "feat: 시작", files: { "src/a.ts": "export const a = 0;\n", "src/b.ts": 'import "./a";\n', "src/c.ts": "export {}\n" }, date: "2024-01-01T10:00:00+09:00" },
  ];
  for (let i = 1; i <= 4; i++) {
    commits.push({ message: `feat: 같이 ${i}`, files: { "src/a.ts": `export const a = ${i};\n`, "src/b.ts": `import "./a"; // ${i}\n`, "src/a.test.ts": `// ${i}\n` }, date: `2024-0${i + 1}-01T10:00:00+09:00` });
  }
  return makeRepo(commits, "hooked");
}

function preToolUse(repoPath: string, file: string, session = "s1"): HookInput {
  return { hook_event_name: "PreToolUse", session_id: session, cwd: repoPath, tool_name: "Edit", tool_input: { file_path: path.join(repoPath, file), old_string: "x", new_string: "y" } };
}

test("PreToolUse: 등록 레포의 소스 파일에만, 세션당 한 번만, 줄 것이 없으면 아무것도", async () => {
  const hook = (ctx: Parameters<typeof handleHook>[0], input: HookInput) => handleHook(ctx, input);
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-hook-home-") };
  const context = { db, env, me: ["me@example.com"] };

  const first = await hook(context, preToolUse(repo.path, "src/a.ts"));
  assert.ok(first?.json, "첫 편집에 맥락이 없습니다");
  const text = first!.json!.hookSpecificOutput.additionalContext;
  assert.equal(first!.json!.hookSpecificOutput.hookEventName, "PreToolUse");
  // lean: Recent·Used by·Fixes는 코드와 git log로 알 수 있어 훅 카드에서 뺀다 (docs/signal-design.md §8 K4)
  assert.match(text, /^Grimoire: src\/a\.ts\nCo-changes: /);
  assert.ok(!text.includes("Recent:"), text);
  assert.match(text, /Co-changes: src\/b\.ts \(5\/5, strong, imports\)/);
  assert.match(text, /Tests: src\/a\.test\.ts/);
  assert.match(text, /candidates to check, not instructions/);
  assert.ok(text.length <= 400, `${text.length}자`);

  // 같은 세션·같은 파일 → 없음. 다른 세션 → 다시 (이번엔 안내 문장 없이)
  assert.equal(await hook(context, preToolUse(repo.path, "src/a.ts")), null);
  const other = await hook(context, preToolUse(repo.path, "src/a.ts", "s2"));
  assert.ok(other?.json);
  // 세션 파일에 기록됐다
  const state = loadSession(env, "s1");
  assert.equal(Object.keys(state.shown).length, 1);
  assert.equal(state.noted, true);

  // 테스트 파일·레포 밖·줄 것 없는 파일(c.ts는 첫 커밋에만)·편집이 아닌 도구 → 없음
  assert.equal(await hook(context, preToolUse(repo.path, "src/a.test.ts")), null);
  assert.equal(await hook(context, preToolUse(tempDir(), "src/a.ts")), null);
  assert.equal(await hook(context, preToolUse(repo.path, "src/c.ts")), null);
  assert.equal(await hook(context, { ...preToolUse(repo.path, "src/b.ts"), tool_name: "Read" }), null);
  // 깨진 입력·끈 상태
  assert.equal(await hook(context, {}), null);
  assert.equal(await hook({ ...context, env: { ...env, GRIMOIRE_HOOKS: "0" } }, preToolUse(repo.path, "src/b.ts", "s3")), null);

  // 오래된 세션 파일 정리
  const old = path.join(sessionsDir(env), "old.json");
  fs.writeFileSync(old, "{}");
  const past = Date.now() - 20 * 86_400_000;
  fs.utimesSync(old, past / 1000, past / 1000);
  assert.equal(pruneSessions(env), 1);
  assert.equal(fs.existsSync(old), false);
});

test("hookCommand / mergeHooks: 따옴표·슬래시 경로, 다른 훅 보존, 갈아 끼우기·빼기", () => {
  const command = hookCommand("C:\\x\\dist\\hook.js", { GRIMOIRE_HOME: "C:\\h\\.grimoire", GRIMOIRE_ME: "a@x.com" }, "C:\\Program Files\\nodejs\\node.exe");
  if (process.platform === "win32") {
    assert.equal(command, '"C:/Program Files/nodejs/node.exe" "C:/x/dist/hook.js" --env "GRIMOIRE_HOME=C:/h/.grimoire" --env "GRIMOIRE_ME=a@x.com"');
  } else {
    assert.match(command, /^"C:\\Program Files\\nodejs\\node\.exe" ".*hook\.js" --env "GRIMOIRE_HOME=.*" --env "GRIMOIRE_ME=a@x\.com"$/);
  }
  assert.deepEqual(parseHookCommand(command), { node: command.split('"')[1], hook: command.split('"')[3] });

  const existing = {
    theme: "dark",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] }, { matcher: "Edit", hooks: [{ type: "command", command: '"node" "/old/dist/hook.js"' }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };
  const merged = mergeHooks(existing, command) as any;
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.hooks.Stop, existing.hooks.Stop);
  assert.equal(merged.hooks.PreToolUse.length, 2, "옛 항목을 갈아 끼운다");
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "echo other");
  assert.equal(merged.hooks.PreToolUse[1].hooks[0].command, command);
  assert.equal(merged.hooks.PreToolUse[1].matcher, "Bash|Edit|Write|MultiEdit|NotebookEdit");
  assert.equal(merged.hooks.SessionStart[0].matcher, "startup|clear|compact");
  assert.equal(merged.hooks.UserPromptSubmit[0].matcher, undefined);

  const removed = mergeHooks(merged, command, true) as any;
  assert.deepEqual(Object.keys(removed.hooks).sort(), ["PreToolUse", "Stop"]);
  assert.equal(removed.hooks.PreToolUse.length, 1);
  assert.deepEqual(mergeHooks({ hooks: {} }, command, true), {});
});

test("installHooks: settings.json을 만들고 백업하고, 두 번째는 그대로, 빼기도 된다", async () => {
  const home = tempDir();
  const hookPath = path.join(tempDir(), "dist", "hook.js");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, "");
  const file = settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));

  const first = await installHooks({ hookPath, env: {}, home });
  assert.equal(first.file, file);
  assert.equal(first.backup, `${file}.bak`);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(Object.keys(written.hooks).length, 4);
  assert.equal(readInstalledHooks(file).length, 4);

  const again = await installHooks({ hookPath, env: {}, home });
  assert.equal(again.unchanged, true);

  const dry = await installHooks({ hookPath, env: {}, home, dryRun: true, remove: true });
  assert.equal(dry.unchanged, false);
  assert.equal(readInstalledHooks(file).length, 4, "dry-run은 쓰지 않는다");

  await installHooks({ hookPath, env: {}, home, remove: true });
  assert.equal(readInstalledHooks(file).length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { permissions: { allow: ["Bash(ls:*)"] } });

  await assert.rejects(installHooks({ hookPath: path.join(home, "nope.js"), env: {}, home }), /npm run build/);
});

test("SessionStart: 오래됐거나 공변경 이력이 빈 레포는 백그라운드 동기화를 요청한다 (resume 포함, 끌 수 있음)", async () => {
  const { needsBackgroundSync, SYNC_STALE_MS } = await import("../src/hook/runner.js");
  const db = memoryDb();
  const dir = coupledRepo();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const fresh = db.prepare("SELECT * FROM repos WHERE id = ?").get(repo.id) as typeof repo;
  const now = Date.parse(fresh.synced_at!);
  const env = { GRIMOIRE_HOME: tempDir() };

  assert.equal(needsBackgroundSync(db, env, fresh, now + 1_000), false, "방금 동기화");
  assert.equal(needsBackgroundSync(db, env, fresh, now + SYNC_STALE_MS + 1), true, "오래됨");
  assert.equal(needsBackgroundSync(db, { ...env, GRIMOIRE_SYNC_ON_START: "0" }, fresh, now + SYNC_STALE_MS + 1), false, "꺼짐");
  assert.equal(needsBackgroundSync(db, env, { ...fresh, synced_at: null }, now), true, "한 번도 안 함");
  db.exec("DELETE FROM cochange");
  assert.equal(needsBackgroundSync(db, env, fresh, now + 1_000), true, "업그레이드로 비워진 공변경");

  const context = { db, env, me: [] };
  const start = await handleHook(context, { hook_event_name: "SessionStart", session_id: "bg-1", cwd: dir, source: "startup" });
  assert.equal(start?.syncRepo, fresh.path);
  assert.ok(start?.stdout, "요약은 그대로 낸다");
  const resume = await handleHook(context, { hook_event_name: "SessionStart", session_id: "bg-1", cwd: dir, source: "resume" });
  assert.deepEqual(resume, { syncRepo: fresh.path }, "resume은 요약 없이 동기화만");
});

test("PreToolUse: 세션 파일을 못 써도(병렬 편집 중 rename 실패 등) 맥락은 그대로 주입하고 임시 파일을 남기지 않는다", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-hook-home-") };
  // 세션 파일 자리에 폴더가 있으면 rename이 실패한다 — Windows에서 다른 훅이 파일을 읽는 중일 때와 같은 결과
  fs.mkdirSync(path.join(sessionsDir(env), "locked.json"), { recursive: true });
  const out = await handleHook({ db, env, me: [] }, preToolUse(repo.path, "src/a.ts", "locked"));
  assert.ok(out?.json?.hookSpecificOutput.additionalContext.startsWith("Grimoire: src/a.ts"), "저장 실패가 주입을 막으면 안 됩니다");
  assert.deepEqual(
    fs.readdirSync(sessionsDir(env)).filter((name) => name.endsWith(".tmp")),
    [],
    "임시 파일이 남으면 안 됩니다",
  );
});

test("PreToolUse(git commit): 보통 같이 바뀌는데 손대지 않은 파일만 알린다 — 커밋 아닌 Bash·같은 묶음 두 번째는 조용", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-hook-home-") };
  const context = { db, env, me: [] };
  const bash = (command: string, session = "c1"): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, cwd: repo.path, tool_name: "Bash", tool_input: { command } });

  // a.ts만 고쳐 스테이징 — b.ts는 5/5 같이 바뀌어 왔고 import로도 이어져 있다
  fs.writeFileSync(path.join(repo.path, "src", "a.ts"), "export const a = 9;\n");
  git(repo.path, ["add", "src/a.ts"]);
  assert.equal(await handleHook(context, bash("npm test")), null, "커밋이 아닌 Bash");
  const out = await handleHook(context, bash('git commit -m "a"'));
  const text = out?.json?.hookSpecificOutput.additionalContext ?? "";
  assert.match(text, /^Grimoire: files that usually change with this commit but are untouched/);
  assert.match(text, /- src\/b\.ts \(co-changed with src\/a\.ts 5×/);
  assert.ok(text.length <= 400, `${text.length}자`);
  assert.equal(await handleHook(context, bash('git commit -m "a"')), null, "같은 세션·같은 묶음은 한 번");

  // b.ts도 이미 손댔으면(작업 폴더에서 바뀜) 알리지 않는다 — 같은 명령의 git add는 작업 폴더 전부를 커밋으로 본다.
  // 남은 a.test.ts는 4/5(80%)라 문턱(신뢰도 0.9·지지도 5) 아래 — 조용
  fs.writeFileSync(path.join(repo.path, "src", "b.ts"), 'import "./a"; // 9\n');
  assert.equal(await handleHook(context, bash("git add -A && git commit -m both", "c2")), null);
  git(repo.path, ["reset", "-q"]);
  git(repo.path, ["checkout", "--", "."]);
});

test("outdatedHooks: 이 버전의 이벤트·matcher와 다른 설치를 알아보고, 훅이 없으면 조용", () => {
  assert.deepEqual(outdatedHooks([]), []);
  const old = [
    { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit" },
    { event: "PostToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit" },
    { event: "UserPromptSubmit" },
    { event: "SessionStart", matcher: "startup|clear|compact" },
  ];
  assert.deepEqual(outdatedHooks(old), ["PreToolUse(Bash|Edit|Write|MultiEdit|NotebookEdit)"]);
  assert.deepEqual(outdatedHooks([{ ...old[0], matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit" }, ...old.slice(1)]), []);
});

test("SessionStart: settings.json의 우리 훅이 낡았으면 다시 설치하라는 한 줄", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-hook-home-"), GRIMOIRE_SYNC_ON_START: "0" };
  const settingsFile = path.join(tempDir(), "settings.json");
  const command = '"node" "/x/dist/hook.js"';
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command }] }] } }));
  const start = { hook_event_name: "SessionStart", session_id: "s", cwd: repo.path, source: "startup" };
  const stale = await handleHook({ db, env, me: [], settingsFile }, start);
  assert.match(stale?.stdout ?? "", /grimoire install claude-code --hooks/);
  fs.writeFileSync(settingsFile, JSON.stringify(mergeHooks({}, command)));
  const fresh = await handleHook({ db, env, me: [], settingsFile }, start);
  assert.doesNotMatch(fresh?.stdout ?? "", /install claude-code/);
});

test("PreToolUse(git commit) GRIMOIRE_COMMIT_IMPACT=all: 엄격한 규칙 대신 영향 후보 상위를 이유와 함께 준다 (실험)", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-hook-home-"), GRIMOIRE_COMMIT_IMPACT: "all" };
  // b.ts와 함께 고쳤으면 엄격한 규칙(a.test.ts 4/5)으로는 조용하지만, 영향 후보로는 a.test.ts가 나온다
  fs.writeFileSync(path.join(repo.path, "src", "a.ts"), "export const a = 9;\n");
  fs.writeFileSync(path.join(repo.path, "src", "b.ts"), 'import "./a"; // 9\n');
  const out = await handleHook({ db, env, me: [] }, { hook_event_name: "PreToolUse", session_id: "x", cwd: repo.path, tool_name: "Bash", tool_input: { command: "git add -A && git commit -m x" } });
  const text = out?.json?.hookSpecificOutput.additionalContext ?? "";
  assert.match(text, /^Grimoire impact of this commit/);
  assert.match(text, /^- src\/a\.test\.ts \(/m);
  git(repo.path, ["checkout", "--", "."]);
});
