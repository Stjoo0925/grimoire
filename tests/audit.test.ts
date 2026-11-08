/**
 * docs/feature-audit.md의 발견 — "조용히 잃던 기억"을 멈추거나 알린다.
 *   F1 첫 프롬프트 보존 · F3 절단 표시/오류 · F5 remove 확인과 export · F10 revert는 사소하지 않다
 *   F4 묶기 출처 · F7 왜 후보 수 · F11 질의 확장 표시 · F13 doctor의 me 점검 · F2 커밋 없는 프롬프트 · F18 버린 편집 알림
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { bindToCommit, commitContextOf, keepHeadAndTail, PROMPT_MAX, PROMPTS_HEAD, PROMPTS_PER_COMMIT, promptText, recordEvent } from "../src/core/capture";
import { fileContext, formatFileContext } from "../src/core/context";
import { headSha } from "../src/core/git";
import { addRepo, exportRepoMemory, repoMemorySize, syncRepo } from "../src/core/indexer";
import { isMeaningfulSubject } from "../src/core/meaningful";
import { addNote, NOTE_MAX, notesForFile, TAGS_MAX } from "../src/core/notes";
import { search } from "../src/core/search";
import { handleHook, type HookInput } from "../src/hook/runner";
import { slimFileContext, slimSearch } from "../src/mcp/format";
import { callTool } from "../src/mcp/tools";
import { addCommit, git, makeRepo, memoryDb, tempDir } from "./helpers";

function event(repoPath: string, session: string, extra: Partial<HookInput>): HookInput {
  return { session_id: session, cwd: repoPath, ...extra };
}

test("F1·F3: 커밋당 프롬프트는 처음 것부터 남기고, 잘렸으면 truncated로 적는다; 긴 프롬프트도 잘렸다고 표시한다", async () => {
  assert.deepEqual(keepHeadAndTail([1, 2, 3, 4, 5], 2, 4), [1, 2, 4, 5]);
  assert.deepEqual(keepHeadAndTail([1, 2, 3], 2, 4), [1, 2, 3]);

  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n" } }], "head");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const sha = (await headSha(dir))!;
  const total = PROMPTS_PER_COMMIT + 5;
  for (let i = 0; i < total; i++) recordEvent(db, { sessionId: "s1", repoId: repo.id, kind: "prompt", text: `프롬프트 ${i}: 이 작업의 의도는 ${i}번째 설명이다` });
  bindToCommit(db, { sessionId: "s1", repoId: repo.id, sha, files: ["src/a.ts"], addedHashes: new Set() });
  const view = commitContextOf(db, repo.id, sha)!;
  assert.equal(view.prompts.length, PROMPTS_PER_COMMIT);
  for (let i = 0; i < PROMPTS_HEAD; i++) assert.ok(view.prompts.some((text) => text.startsWith(`프롬프트 ${i}:`)), `첫 프롬프트 ${i}이 사라졌습니다`);
  assert.ok(view.prompts.some((text) => text.startsWith(`프롬프트 ${total - 1}:`)), "마지막 프롬프트도 남는다");
  assert.equal(view.truncated, `prompts ${total} → ${PROMPTS_PER_COMMIT}`);
  const shown = (await callTool({ db, me: [], cwd: dir }, "show_commit", { sha: sha.slice(0, 10) })) as { why?: { truncated?: string } };
  assert.equal(shown.why?.truncated, `prompts ${total} → ${PROMPTS_PER_COMMIT}`);

  const long = promptText("가".repeat(PROMPT_MAX + 50))!;
  assert.ok(long.endsWith(`[truncated ${PROMPT_MAX}/${PROMPT_MAX + 50}]`), long.slice(-40));
  assert.equal(promptText("짧은 말"), "짧은 말");
});

test("F3: 노트는 상한을 넘으면 자르지 않고 오류, 태그는 자르되 몇 개 버렸는지 알린다", async () => {
  const db = memoryDb();
  assert.throws(() => addNote(db, { text: "x".repeat(NOTE_MAX + 1), source: "cli" }), /나눠/);
  const note = addNote(db, { text: "태그 많음", tags: Array.from({ length: TAGS_MAX + 3 }, (_, i) => `t${i}`), source: "cli" });
  assert.equal(note.tagsDropped, 3);
  const recorded = (await callTool({ db, me: [], cwd: process.cwd() }, "record_note", { text: "태그 많음 2", tags: Array.from({ length: TAGS_MAX + 2 }, (_, i) => `u${i}`) })) as { tagsDropped?: number };
  assert.equal(recorded.tagsDropped, 2);
  const fine = (await callTool({ db, me: [], cwd: process.cwd() }, "record_note", { text: "태그 적음", tags: ["a"] })) as { tagsDropped?: number };
  assert.equal(fine.tagsDropped, undefined);
});

test("F5: 레포를 지우면 사라지는 기억의 크기를 알고, export로 노트·커밋 맥락을 꺼낸다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작\n\nWhy: 측정 때문", files: { "src/a.ts": "export const a = 1;\n" } }], "mem");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  addNote(db, { text: "결정: a는 동기", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const size = repoMemorySize(db, repo.id);
  assert.equal(size.notes, 1);
  assert.ok(size.context >= 1, "Why 트레일러가 commit_context에 있다");
  const exported = exportRepoMemory(db, repo);
  assert.equal(exported.repo.name, repo.name);
  assert.equal(exported.notes[0].text, "결정: a는 동기");
  assert.deepEqual((exported.notes[0].paths as { path: string }[]).map((item) => item.path), ["src/a.ts"]);
  assert.equal(exported.commits.length, 1);
  assert.ok(exported.commits[0].context.some((item) => item.kind === "trailer:why" && item.text === "측정 때문"));
});

test("F10: revert 커밋은 사소하지 않다", () => {
  assert.equal(isMeaningfulSubject("revert: 캐시 TTL 1시간"), true);
  assert.equal(isMeaningfulSubject('Revert "feat: 캐시"'), true);
  assert.equal(isMeaningfulSubject("chore: bump"), false);
});

test("F4: 추정으로 묶은 파일(auto)은 사람이 준 것(given)·본문의 것(text)과 구별돼 저장되고 카드에 표시된다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "src/c.ts": "export const c = 1;\n" } }], "how");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const note = addNote(db, { text: "결정: src/b.ts는 그대로", repoId: repo.id, paths: ["src/a.ts"], autoPaths: ["src/c.ts", "src/a.ts"], source: "mcp" });
  const stored = JSON.parse(note.paths) as { path: string; how: string }[];
  assert.deepEqual(
    stored.map((item) => [item.path, item.how]),
    [
      ["src/a.ts", "given"],
      ["src/b.ts", "text"],
      ["src/c.ts", "auto"],
    ],
    "같은 파일은 더 확실한 출처가 남는다 (given > text > auto)",
  );
  assert.equal(notesForFile(db, repo.id, "src/c.ts")[0].how, "auto");
  assert.equal(notesForFile(db, repo.id, "src/a.ts")[0].how, "given");
  assert.match(formatFileContext(fileContext(db, repo.id, "src/c.ts"), { lean: true }), /auto-bound/);
  assert.doesNotMatch(formatFileContext(fileContext(db, repo.id, "src/a.ts"), { lean: true }), /auto-bound/);
  const slim = slimFileContext(fileContext(db, repo.id, "src/c.ts"), []) as { notes?: string[] };
  assert.match(slim.notes![0], /\(auto-bound\)$/);

  // record_note가 paths 없이 작업 폴더의 바뀐 파일에 묶으면 auto로 저장된다
  fs.writeFileSync(path.join(dir, "src/b.ts"), "export const b = 2;\n");
  const recorded = (await callTool({ db, me: [], cwd: dir }, "record_note", { text: "자동 묶기 노트", repo: repo.name })) as { autoBound?: boolean; paths?: string[] };
  assert.equal(recorded.autoBound, true);
  assert.deepEqual(recorded.paths, ["src/b.ts"]);
  assert.equal(notesForFile(db, repo.id, "src/b.ts")[0].how, "auto");
  git(dir, ["checkout", "--", "."]);
});

test("F7: 의도가 붙은 최근 커밋이 여럿이면 카드의 Why에 몇 개 중 하나인지 보인다", async () => {
  const db = memoryDb();
  const dir = makeRepo(
    [
      { message: "feat: 시작\n\nWhy: 첫 이유", files: { "src/a.ts": "export const a = 1;\n" }, date: "2024-01-01T10:00:00+09:00" },
      { message: "fix: 둘째\n\nWhy: 둘째 이유", files: { "src/a.ts": "export const a = 2;\n" }, date: "2024-02-01T10:00:00+09:00" },
    ],
    "whys",
  );
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = fileContext(db, repo.id, "src/a.ts");
  assert.equal(context.why?.candidates, 2);
  assert.match(formatFileContext(context), /Why \([0-9a-f]{10}, 1 of 2\)/);
  const slim = slimFileContext(context, []) as { why?: string };
  assert.match(slim.why!, /\(1 of 2\)/);
});

test("F11: detail=full일 때만 질의 낱말이 어떤 변형으로 확장됐는지 보인다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "fix: resolve merge conflict in lock", files: { "src/lock.ts": "export const lock = 1;\n" } }], "exp");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const result = search(db, "충돌을");
  assert.ok(result.expanded?.["충돌을"]?.includes("conflict"), JSON.stringify(result.expanded));
  assert.equal((slimSearch(result, []) as { expanded?: unknown }).expanded, undefined, "기본 응답에는 없다");
  assert.ok((slimSearch(result, [], "full") as { expanded?: Record<string, string[]> }).expanded?.["충돌을"]);
});

test("F13: doctor는 내 이메일이 레포의 주요 작성자에 없으면 알린다", async () => {
  const { doctor } = await import("../src/setup/doctor.js");
  const { openDb } = await import("../src/core/db.js");
  const home = tempDir();
  const env = { GRIMOIRE_HOME: path.join(home, ".grimoire"), GRIMOIRE_ME: "me@example.com" };
  const commits = Array.from({ length: 21 }, (_, i) => ({ message: `feat: ${i}`, files: { [`src/f${i}.ts`]: `export const f${i} = 1;\n` }, email: "work@corp.example" }));
  const dir = makeRepo(commits, "corp");
  const db = openDb(path.join(env.GRIMOIRE_HOME, "grimoire.db"));
  try {
    const repo = await addRepo(db, dir);
    await syncRepo(db, repo);
  } finally {
    db.close();
  }
  const offline = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const checks = await doctor({ cliPath: path.join(home, "cli.js"), env, home, fetchImpl: offline, runCommand: () => Promise.reject(new Error("no")) });
  const warn = checks.find((check) => check.title.includes("내 이메일이 커밋 작성자에 없는 레포"));
  assert.ok(warn, checks.map((check) => check.title).join("\n"));
  assert.match(warn!.detail ?? "", /corp: work@corp\.example/);
});

test("F2·F18: 커밋에 묶이지 않은 이전 세션의 프롬프트를 SessionStart가 알리고, 커밋에서 빠진 편집은 커밋 뒤에 알린다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" } }], "orphan");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = { db, env: { GRIMOIRE_HOME: tempDir("grimoire-orphan-home-") }, me: [] };

  // 이전 세션(이틀 전, 조용함): 프롬프트만 있고 커밋이 없다. 지금 돌고 있는 다른 세션(live-1)의 프롬프트는 세지 않는다
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  recordEvent(db, { sessionId: "old-1", repoId: repo.id, kind: "prompt", text: "캐시를 Redis로 옮길지 조사했는데 하지 않기로 했다" }, twoDaysAgo);
  await handleHook(context, event(dir, "live-1", { hook_event_name: "UserPromptSubmit", prompt: "지금 작업 중인 다른 세션의 말" }));
  const start = await handleHook(context, { hook_event_name: "SessionStart", session_id: "new-1", cwd: dir, source: "startup" });
  assert.match(start?.stdout ?? "", /1 prompt\(s\) from earlier sessions were never bound to a commit \(oldest expires in 12d\)/);

  // 이번 세션: a·b를 고치고 a만 커밋 — b는 되돌렸다(작업 폴더에 변경이 없다)
  const session = "new-1";
  await handleHook(context, event(dir, session, { hook_event_name: "UserPromptSubmit", prompt: "a와 b를 고쳐 봐" }));
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 2;\n");
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/a.ts"), old_string: "1", new_string: "export const a = 2;" } }));
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/b.ts"), old_string: "1", new_string: "export const b = 99; // abandoned" } }));
  git(dir, ["-c", "user.email=me@example.com", "-c", "user.name=me", "commit", "-q", "-am", "fix(a): 경계값"]);
  const made = (await headSha(dir))!.slice(0, 7);
  const out = await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -am "fix(a)"' }, tool_response: { stdout: `[main ${made}] fix(a)`, stderr: "" } }));
  const text = out?.json?.hookSpecificOutput.additionalContext ?? "";
  assert.match(text, /^Grimoire: edited but left out of this commit: src\/b\.ts — if that was a dead end, record_note keeps the why/);
  assert.equal(out?.json?.hookSpecificOutput.hookEventName, "PostToolUse");
});
