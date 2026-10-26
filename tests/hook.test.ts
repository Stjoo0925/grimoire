import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { addRepo, syncRepo } from "../src/core/indexer";
import { handleHook, loadSession, pruneSessions, sessionsDir, type HookInput } from "../src/hook/runner";
import { hookCommand, installHooks, mergeHooks, parseHookCommand, readInstalledHooks, settingsPath } from "../src/setup/hooks";
import { makeRepo, memoryDb, tempDir, type FakeCommit } from "./helpers";

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
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-hook-home-") };
  const context = { db, env, me: ["me@example.com"] };

  const first = handleHook(context, preToolUse(repo.path, "src/a.ts"));
  assert.ok(first?.json, "첫 편집에 맥락이 없습니다");
  const text = first!.json!.hookSpecificOutput.additionalContext;
  assert.equal(first!.json!.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(text, /^Grimoire: src\/a\.ts\nRecent: /);
  assert.match(text, /Co-changes: src\/b\.ts \(5\/5, strong, imports\)/);
  assert.match(text, /Tests: src\/a\.test\.ts/);
  assert.match(text, /candidates to check, not instructions/);
  assert.ok(text.length <= 400, `${text.length}자`);

  // 같은 세션·같은 파일 → 없음. 다른 세션 → 다시 (이번엔 안내 문장 없이)
  assert.equal(handleHook(context, preToolUse(repo.path, "src/a.ts")), null);
  const other = handleHook(context, preToolUse(repo.path, "src/a.ts", "s2"));
  assert.ok(other?.json);
  // 세션 파일에 기록됐다
  const state = loadSession(env, "s1");
  assert.equal(Object.keys(state.shown).length, 1);
  assert.equal(state.noted, true);

  // 테스트 파일·레포 밖·줄 것 없는 파일(c.ts는 첫 커밋에만)·편집이 아닌 도구 → 없음
  assert.equal(handleHook(context, preToolUse(repo.path, "src/a.test.ts")), null);
  assert.equal(handleHook(context, preToolUse(tempDir(), "src/a.ts")), null);
  assert.equal(handleHook(context, preToolUse(repo.path, "src/c.ts")), null);
  assert.equal(handleHook(context, { ...preToolUse(repo.path, "src/b.ts"), tool_name: "Read" }), null);
  // 깨진 입력·끈 상태
  assert.equal(handleHook(context, {}), null);
  assert.equal(handleHook({ ...context, env: { ...env, GRIMOIRE_HOOKS: "0" } }, preToolUse(repo.path, "src/b.ts", "s3")), null);

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
  assert.equal(merged.hooks.PreToolUse[1].matcher, "Edit|Write|MultiEdit|NotebookEdit");
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
