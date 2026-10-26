import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { bindToCommit, commitContextOf, isGitCommit, isSymptomOnly, isVerifyCommand, lineHashes, pendingEvents, recordPrompt, verifyOutcome, whyLine } from "../src/core/capture";
import { fileContext } from "../src/core/context";
import { addedLines, headSha } from "../src/core/git";
import { addRepo, indexCommitSha, syncRepo } from "../src/core/indexer";
import { redact } from "../src/core/redact";
import { search } from "../src/core/search";
import { agentSignal, parseTrailers, whyLines } from "../src/core/trailers";
import { handleHook, type HookInput } from "../src/hook/runner";
import { callTool } from "../src/mcp/tools";
import { addCommit, git, makeRepo, memoryDb, tempDir } from "./helpers";

test("parseTrailers: 마지막 문단의 Key: value만, 대소문자 무시, 반복 키, 본문 속 가짜 트레일러는 무시", () => {
  const body = [
    "본문 첫 문단. Why: 이건 본문이다",
    "",
    "Constraint: Auth service does not support token introspection",
    "Rejected: Extend token TTL to 24h | security policy violation",
    "rejected: Sessions in Redis | adds a dependency",
    "Tested: npm test, manual login flow",
    "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
  ].join("\n");
  const trailers = parseTrailers(body);
  assert.deepEqual(
    trailers.map((item) => item.key),
    ["constraint", "rejected", "rejected", "tested", "co-authored-by"],
  );
  assert.equal(agentSignal(trailers), "co-authored-by");
  assert.deepEqual(whyLines(trailers).length, 3);
  // 트레일러가 아닌 마지막 문단 → 없음. "Note: …" 한 줄도 믿지 않는다
  assert.deepEqual(parseTrailers("그냥 본문\n\n마지막 문단에 콜론: 있음 이지만 트레일러 아님"), []);
  assert.deepEqual(parseTrailers("본문\n\nNote: 이건 메모"), []);
  // QAC
  const qac = parseTrailers("Agent: cursor-ai\nMode: hitl\nWhat: add POST /auth/refresh\nWhy: sessions expired silently");
  assert.equal(agentSignal(qac), "agent");
  assert.deepEqual(whyLines(qac), ["what: add POST /auth/refresh", "why: sessions expired silently"]);
  assert.equal(agentSignal(parseTrailers("Signed-off-by: Someone <a@b.c>")), null);
});

test("redact: private 블록·붙여 넣기·토큰·password= 값을 지운다", () => {
  const text = [
    "배포해 줘 <private>내 비번은 hunter2</private> 끝",
    '<pasted_content id="x">\nsecret dump\n</pasted_content>',
    "key sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 here",
    "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "password=Sup3rSecret! token: abcd1234efgh api_key 'zzzz-yyyy'",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ].join("\n");
  const out = redact(text);
  assert.ok(!out.includes("hunter2") && !out.includes("secret dump"), out);
  assert.ok(!out.includes("sk-abc") && !out.includes("ghp_") && !out.includes("AKIAIOSFODNN7EXAMPLE"), out);
  assert.ok(!out.includes("Sup3rSecret") && !out.includes("abcd1234efgh") && !out.includes("zzzz-yyyy"), out);
  assert.ok(!out.includes("eyJhbGci"), out);
  assert.ok(out.includes("배포해 줘") && out.includes("[redacted]"), out);
  // 평범한 말은 그대로
  assert.equal(redact("검색이 느려서 p95를 20ms 아래로 내려 줘"), "검색이 느려서 p95를 20ms 아래로 내려 줘");
});

test("verify·commit 판정과 줄 해시", () => {
  assert.equal(isVerifyCommand("npm test"), true);
  assert.equal(isVerifyCommand("npm run e2e -- --json"), true);
  assert.equal(isVerifyCommand("pytest tests/"), true);
  assert.equal(isVerifyCommand("ls -la"), false);
  assert.equal(isGitCommit('git commit -m "x"'), true);
  assert.equal(isGitCommit("git add -A && git commit -q -F -"), true);
  assert.equal(isGitCommit("git -C /x commit -m y"), true);
  assert.equal(isGitCommit("git log --oneline"), false);
  assert.deepEqual(verifyOutcome({ stdout: "ok 1\n# pass 3\n", stderr: "" }), { ok: true, tail: "" });
  assert.equal(verifyOutcome({ stdout: "", stderr: "Error: boom" }).ok, false);
  assert.equal(verifyOutcome({ stdout: "3 passed, 1 failed", stderr: "" }).ok, false);
  assert.equal(verifyOutcome({ stdout: "x", stderr: "", interrupted: true }).ok, false);
  const hashes = lineHashes("const a = 1;\n  const a = 1;\n\n");
  assert.equal(hashes.length, 4);
  assert.equal(hashes[1], hashes[3], "공백 제거 해시는 들여쓰기와 무관");
  assert.notEqual(hashes[0], hashes[2]);
  assert.equal(isSymptomOnly("TypeError: x is not a function"), true);
  assert.equal(isSymptomOnly("안 돼요"), true);
  assert.equal(isSymptomOnly("검색이 느려서 p95를 20ms 아래로 내려 줘"), false);
});

/** 훅 입력 생성기 */
function event(repoPath: string, session: string, extra: Partial<HookInput>): HookInput {
  return { session_id: session, cwd: repoPath, ...extra };
}

test("세션 캡처 → git commit 뒤 커밋에 묶이고 [why]로 검색된다, dropped는 줄 해시로", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/search.ts": "export const q = 1;\n", "src/other.ts": "export const o = 1;\n" }, date: "2024-01-01T10:00:00+09:00" }], "cap");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-cap-home-") };
  const context = { db, env, me: ["me@example.com"] };
  const session = "cap-1";

  // 프롬프트 둘(하나는 슬래시 명령이라 버림, 하나는 비밀 포함), 편집 둘(하나는 커밋에 안 들어감), 검증 하나
  await handleHook(context, event(dir, session, { hook_event_name: "UserPromptSubmit", prompt: "/clear" }));
  await handleHook(context, event(dir, session, { hook_event_name: "UserPromptSubmit", prompt: "검색이 느려서 p95를 20ms 아래로 내려 줘 token=abcd1234" }));
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/search.ts"), old_string: "q = 1", new_string: "export const q = 2; // fast" } }));
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/other.ts"), old_string: "o = 1", new_string: "export const o = 99; // abandoned" } }));
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok\n", stderr: "" } }));
  assert.equal(pendingEvents(db, session, repo.id).length, 4);

  // 실제 커밋은 search.ts만 (other.ts의 편집은 되돌린 셈)
  addCommit(dir, { message: "perf(search): 재정렬 후보 질의 개선", files: { "src/search.ts": "export const q = 2; // fast\n" }, date: "2024-02-01T10:00:00+09:00" });
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -am "perf(search): 재정렬 후보 질의 개선"' }, tool_response: { stdout: "[main abc1234] perf(search)", stderr: "" } }));

  const sha = (await headSha(dir))!;
  const view = commitContextOf(db, repo.id, sha);
  assert.ok(view, "커밋 맥락이 없습니다");
  assert.deepEqual(view!.prompts, ["검색이 느려서 p95를 20ms 아래로 내려 줘 token=[redacted]"]);
  assert.deepEqual(view!.verify, ["npm test → pass"]);
  assert.deepEqual(view!.dropped, ["src/other.ts"]);
  assert.equal(pendingEvents(db, session, repo.id).length, 0, "묶인 뒤에는 대기 기록이 없다");

  // 커밋이 바로 색인됐고, 그때의 말로 검색된다 (제목에는 "느려서"가 없다)
  const hits = search(db, "느려서 p95").hits;
  assert.equal(hits[0]?.ref, sha, JSON.stringify(hits.map((hit) => hit.title)));
  assert.equal(hits[0]?.why, "검색이 느려서 p95를 20ms 아래로 내려 줘 token=[redacted]");
  assert.equal(whyLine(db, repo.id, sha), hits[0]?.why);

  // file_context의 why — 검증 신호가 있는 커밋
  const ctx = fileContext(db, repo.id, "src/search.ts");
  assert.equal(ctx.why?.sha, sha);
  assert.equal(ctx.why?.verified, true);
  assert.equal(ctx.why?.verify, "npm test → pass");
  // show_commit에도 why가 실린다
  const shown = (await callTool({ db, me: [], cwd: dir }, "show_commit", { sha: sha.slice(0, 10) })) as { why?: { prompts?: string[]; dropped?: string[] } };
  assert.deepEqual(shown.why?.dropped, ["src/other.ts"]);
  assert.equal(shown.why?.prompts?.length, 1);

  // 동기화해도 중복되지 않는다 (커밋은 이미 있음)
  const synced = await syncRepo(db, repo);
  assert.equal(synced.added, 0);
  assert.equal(commitContextOf(db, repo.id, sha)!.prompts.length, 1);

  // 서브에이전트의 프롬프트는 기록하지 않는다; 캡처를 끄면 아무것도
  await handleHook(context, event(dir, "cap-2", { hook_event_name: "UserPromptSubmit", prompt: "서브에이전트 말", agent_id: "sub" }));
  await handleHook({ ...context, env: { ...env, GRIMOIRE_CAPTURE: "0" } }, event(dir, "cap-2", { hook_event_name: "UserPromptSubmit", prompt: "꺼진 상태" }));
  assert.equal(pendingEvents(db, "cap-2", repo.id).length, 0);
});

test("트레일러가 있는 커밋: 색인 때 commit_context·agent_signal·[why]가 채워지고 옛 DB는 백필된다", async () => {
  const db = memoryDb();
  const dir = makeRepo(
    [
      {
        message:
          "feat(auth): 토큰 회전\n\n만료 직전에 refresh token을 새로 발급한다.\n\nConstraint: Auth service does not support token introspection\nRejected: Extend token TTL to 24h | security policy violation\nTested: npm test\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
        files: { "src/auth.ts": "export const rotate = 1;\n" },
        date: "2024-01-01T10:00:00+09:00",
      },
    ],
    "trailered",
  );
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const sha = (await headSha(dir))!;
  const view = commitContextOf(db, repo.id, sha)!;
  assert.deepEqual(view.trailers.map((item) => item.key), ["co-authored-by", "constraint", "rejected", "tested"]);
  assert.equal((db.prepare("SELECT agent_signal FROM commits WHERE sha = ?").get(sha) as { agent_signal: string }).agent_signal, "co-authored-by");
  // 트레일러의 말로 검색된다
  assert.equal(search(db, "token introspection").hits[0]?.ref, sha);
  assert.equal(search(db, "token introspection").hits[0]?.why, "Auth service does not support token introspection", "프롬프트가 없으면 Why/Constraint/What 트레일러가 한 줄 why");
  assert.equal(fileContext(db, repo.id, "src/auth.ts").why?.text, "Auth service does not support token introspection");
  assert.equal(fileContext(db, repo.id, "src/auth.ts").why?.verified, true, "Tested 트레일러는 검증 신호");

  // 백필: commit_context를 비우고 trailers_done을 내리면 다음 동기화가 다시 채운다
  db.prepare("DELETE FROM commit_context").run();
  db.prepare("UPDATE repos SET trailers_done = 0").run();
  await syncRepo(db, repo);
  assert.equal(commitContextOf(db, repo.id, sha)!.trailers.length, 4);

  // indexCommitSha: 아직 동기화 안 된 커밋 하나를 바로 넣는다
  addCommit(dir, { message: "fix: x\n\nWhy: because y", files: { "src/auth.ts": "export const rotate = 2;\n" }, date: "2024-02-01T10:00:00+09:00" });
  const next = (await headSha(dir))!;
  assert.deepEqual(await indexCommitSha(db, repo, next), ["src/auth.ts"]);
  assert.equal(whyLine(db, repo.id, next), "because y");
  assert.deepEqual(await addedLines(dir, next), ["export const rotate = 2;"]);
  assert.equal((await syncRepo(db, repo)).added, 0);
  void git;
});
