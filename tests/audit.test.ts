/**
 * docs/feature-audit.md의 발견 — "조용히 잃던 기억"을 멈추거나 알린다.
 *   F1 첫 프롬프트 보존 · F3 절단 표시/오류 · F5 remove 확인과 export · F10 revert는 사소하지 않다
 *   F4 묶기 출처 · F7 왜 후보 수 · F11 질의 확장 표시 · F13 doctor의 me 점검 · F2 커밋 없는 프롬프트 · F18 버린 편집 알림
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { bindToCommit, commitContextOf, foldQuietSessions, keepHeadAndTail, pruneEvents, PROMPT_MAX, PROMPTS_HEAD, PROMPTS_PER_COMMIT, promptText, recordEvent, SESSION_TTL_DAYS } from "../src/core/capture";
import { fileContext, formatFileContext } from "../src/core/context";
import { headSha } from "../src/core/git";
import { addRepo, exportRepoMemory, removeRepo, repoMemorySize, syncRepo } from "../src/core/indexer";
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
  assert.match(start?.stdout ?? "", /1 prompt\(s\) from sessions in the last 14d never reached a commit — kept and searchable \(search_memory kind "session"\)/);
  assert.doesNotMatch(start?.stdout ?? "", /expires/, "지우지 않으니 기한을 말하지 않는다");

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

test("이름이 같은 레포 등록이 둘이면 이름으로 고르지 않는다 — 경로로만 하나를 고르고, doctor도 경로로 권한다", async () => {
  const { matchRepos, findRepo, repoArg, listRepos } = await import("../src/core/indexer.js");
  const { doctor } = await import("../src/setup/doctor.js");
  const { openDb } = await import("../src/core/db.js");
  const home = tempDir();
  const env = { GRIMOIRE_HOME: path.join(home, ".grimoire"), GRIMOIRE_ME: "me@example.com" };
  const live = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n" } }], "twin");
  const gone = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n" } }], "twin");
  const db = openDb(path.join(env.GRIMOIRE_HOME, "grimoire.db"));
  try {
    const a = await addRepo(db, live);
    const b = await addRepo(db, gone);
    assert.equal(a.name, b.name, "같은 이름으로 등록된다");
    assert.equal(matchRepos(db, "twin").length, 2, "이름이 같으면 둘 다 돌려준다");
    assert.equal(findRepo(db, "twin"), null);
    assert.equal(findRepo(db, gone)?.id, b.id, "경로는 정확히 하나");
    assert.equal(repoArg(b, listRepos(db)), `"${gone}"`);
    await assert.rejects(callTool({ db, me: [], cwd: process.cwd() }, "get_repo_overview", { repo: "twin" }), (error: Error) => error.message.includes(`twin (${gone})`) && error.message.includes(`twin (${live})`));
  } finally {
    db.close();
  }
  fs.rmSync(gone, { recursive: true, force: true });
  const offline = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const checks = await doctor({ cliPath: path.join(home, "cli.js"), env, home, fetchImpl: offline, runCommand: () => Promise.reject(new Error("no")) });
  const missing = checks.find((check) => check.title.includes("경로가 사라진 레포"));
  assert.equal(missing?.fix, `grimoire remove "${gone}"`, "이름이 겹치면 경로로 지우라고 권한다");
});

test("F2: 커밋에 끝내 묶이지 않은 프롬프트는 TTL 뒤에도 남고, 묶인 프롬프트·편집·검증·표식은 지금처럼 지운다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n" } }], "keep");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const sha = (await headSha(dir))!;
  const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const texts = () => (db.prepare("SELECT kind, text FROM session_events ORDER BY at, id").all() as { kind: string; text: string }[]).map((row) => `${row.kind}:${row.text}`);

  // 세션 a: 프롬프트 → 편집 → 커밋 → 프롬프트(커밋 없이 끝남), 모두 TTL보다 오래됐다
  recordEvent(db, { sessionId: "a", repoId: repo.id, kind: "prompt", text: "묶일 프롬프트" }, old(30));
  recordEvent(db, { sessionId: "a", repoId: repo.id, kind: "edit", text: "src/a.ts", path: "src/a.ts", lineHashes: ["x"] }, old(30));
  recordEvent(db, { sessionId: "a", repoId: repo.id, kind: "verify", text: "npm test → pass" }, old(30));
  recordEvent(db, { sessionId: "a", repoId: repo.id, kind: "commit", text: sha }, old(29));
  recordEvent(db, { sessionId: "a", repoId: repo.id, kind: "prompt", text: "Redis로 옮기지 않기로 했다 — 인스턴스가 하나다" }, old(28));
  // 세션 b: 레포 밖(repo_id NULL)에서 한 말, 커밋 없음
  recordEvent(db, { sessionId: "b", repoId: null, kind: "prompt", text: "레포 밖에서 정한 것: 배포는 금요일에 하지 않는다" }, old(40));
  // 세션 c: 레포 밖 프롬프트가 다른 레포 커밋에 묶였다(pendingEvents는 레포 밖 프롬프트를 같은 세션의 커밋에 묶는다)
  recordEvent(db, { sessionId: "c", repoId: null, kind: "prompt", text: "레포 밖이지만 커밋에 묶인 말" }, old(40));
  recordEvent(db, { sessionId: "c", repoId: repo.id, kind: "commit", text: sha }, old(39));

  const removed = pruneEvents(db);
  assert.equal(removed, 6);
  assert.deepEqual(texts(), ["prompt:레포 밖에서 정한 것: 배포는 금요일에 하지 않는다", "prompt:Redis로 옮기지 않기로 했다 — 인스턴스가 하나다"]);
  assert.equal(pruneEvents(db, Date.now() + 365 * 86_400_000), 0, "1년 뒤에도 지우지 않는다");
  // 남은 프롬프트의 세션이 다시 이어져 커밋하면 그 커밋에 묶인다 — 앞선 표식이 지워졌어도
  bindToCommit(db, { sessionId: "a", repoId: repo.id, sha, files: [], addedHashes: new Set() });
  assert.deepEqual(commitContextOf(db, repo.id, sha)!.prompts, ["Redis로 옮기지 않기로 했다 — 인스턴스가 하나다"]);
  assert.equal(pruneEvents(db, Date.now() + (SESSION_TTL_DAYS + 1) * 86_400_000), 2, "묶인 뒤에는 TTL대로 지운다 (프롬프트와 새 표식)");
});

test("F2: 조용해진 세션의 묶이지 않은 프롬프트는 kind=session 문서로 찾히고, 카드·file_context에는 안 나오며, 세션이 나중에 커밋하면 문서가 사라진다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 캐시", files: { "src/cache.ts": "export const cache = 1;\n" } }], "unbound");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  recordEvent(db, { sessionId: "quiet-1", repoId: repo.id, kind: "prompt", text: "src/cache.ts 캐시를 Redis로 옮길지 조사했는데 하지 않기로 했다" }, ago(30));
  recordEvent(db, { sessionId: "quiet-1", repoId: repo.id, kind: "prompt", text: "이유는 인스턴스가 하나라 네트워크 왕복이 더 비싸서" }, ago(29));
  recordEvent(db, { sessionId: "outside", repoId: null, kind: "prompt", text: "Redis 클러스터는 다음 분기에 다시 보자" }, ago(30));
  recordEvent(db, { sessionId: "live", repoId: repo.id, kind: "prompt", text: "지금 Redis 얘기 중인 세션" }, ago(1));

  assert.equal(foldQuietSessions(db), 2, "조용한 두 세션만 접는다 — 지금 도는 세션은 아니다");
  assert.equal(foldQuietSessions(db), 0, "이미 같으면 다시 쓰지 않는다");
  const hits = search(db, "Redis", { kind: "session" }).hits;
  assert.deepEqual(hits.map((hit) => hit.ref).sort(), ["outside", "quiet-1"]);
  const inRepo = hits.find((hit) => hit.ref === "quiet-1")!;
  assert.equal(inRepo.repo, repo.name);
  assert.equal(inRepo.title, "src/cache.ts 캐시를 Redis로 옮길지 조사했는데 하지 않기로 했다");
  assert.match(inRepo.body ?? "", /네트워크 왕복/);
  assert.equal(hits.find((hit) => hit.ref === "outside")!.repo, null);
  const slim = slimSearch(search(db, "Redis"), []) as { hits: { session?: string; unbound?: string; by?: string; date?: string }[] };
  const shown = slim.hits.find((hit) => hit.session === "quiet-1")!;
  assert.equal(shown.unbound, "prompts never bound to a commit");
  assert.equal(shown.by, "me");
  assert.match(shown.date ?? "", /^\d{4}-\d\d-\d\d$/);
  assert.ok(search(db, "Redis", { authors: ["me@example.com"] }).hits.some((hit) => hit.kind === "session"), "사용자가 친 말이라 author: me를 통과한다");
  // 파일 카드·file_context의 "왜"는 커밋에 묶인 것만 — 본문에 경로가 있어도 세션 문서는 파일에 묶이지 않는다
  const card = formatFileContext(fileContext(db, repo.id, "src/cache.ts"), { lean: true });
  assert.doesNotMatch(card, /Redis/);
  assert.doesNotMatch(JSON.stringify(slimFileContext(fileContext(db, repo.id, "src/cache.ts"), [])), /Redis/);

  // remove 전 크기와 export에 들어간다
  assert.equal(repoMemorySize(db, repo.id).prompts, 3, "조용한 세션 둘 + 아직 커밋 전인 세션 하나");
  const exported = exportRepoMemory(db, repo);
  assert.deepEqual(exported.sessions.find((item) => item.sessionId === "quiet-1")!.prompts.map((item) => item.text.slice(0, 12)), ["src/cache.ts", "이유는 인스턴스가 하나"]);

  // 세션이 다시 이어져 커밋하면 프롬프트는 그 커밋에 묶이고 "커밋 없는" 문서는 사라진다
  const sha = (await headSha(dir))!;
  bindToCommit(db, { sessionId: "quiet-1", repoId: repo.id, sha, files: ["src/cache.ts"], addedHashes: new Set() });
  assert.ok(commitContextOf(db, repo.id, sha)!.prompts.some((text) => text.includes("하지 않기로 했다")));
  assert.deepEqual(search(db, "Redis", { kind: "session" }).hits.map((hit) => hit.ref), ["outside"]);

  removeRepo(db, repo);
  assert.deepEqual(search(db, "Redis", { kind: "session" }).hits.map((hit) => hit.ref), ["outside"], "레포 밖 세션 문서는 레포 삭제와 무관하다");
});
