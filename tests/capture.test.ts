import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { bindToCommit, commitContextOf, commitDir, isGitCommit, isSymptomOnly, isVerifyCommand, lineHashes, pendingEvents, recordPrompt, verifyOutcome, whyLine } from "../src/core/capture";
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

test("redact: 접두가 붙은 환경 변수 이름·연결 문자열·서비스별 토큰도 지운다", () => {
  for (const [input, secret] of [
    ["OPENAI_API_KEY=abcd1234efgh npm test", "abcd1234efgh"],
    ["GITHUB_TOKEN=abcd1234 gh pr list", "abcd1234"],
    ["DB_PASSWORD=hunter22 npm run e2e", "hunter22"],
    ["export my-service-secret: 's3cr3tval'", "s3cr3tval"],
    ["DATABASE_URL=postgres://app:s3cretpw@db:5432/x npm test", "s3cretpw"],
    ["git clone https://user:ghtokenvalue@example.com/r.git", "ghtokenvalue"],
    [["sk", "live", "51HabcdefghijklmnopqrstuVWX"].join("_"), "51Habcdefghijklmnopqrstu"],
    ["glpat-abcdefghij1234567890", "abcdefghij1234567890"],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["hf_abcdefghijklmnopqrstuvwxyzABCD", "abcdefghijklmnopqrstuvwxyzABCD"],
    ["https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX", "XXXXXXXXXXXXXXXXXXXXXXXX"],
  ] as const) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `${input} → ${out}`);
  }
  // 키 이름과 주변은 남는다, 비밀 아닌 말은 그대로
  assert.equal(redact("OPENAI_API_KEY=abcd1234efgh npm test"), "OPENAI_API_KEY=[redacted] npm test");
  assert.equal(redact("DATABASE_URL=postgres://app:s3cretpw@db:5432/x"), "DATABASE_URL=postgres://app:[redacted]@db:5432/x");
  assert.equal(redact("author: Kim, see https://example.com/a:b and user@example.com"), "author: Kim, see https://example.com/a:b and user@example.com");
  assert.equal(redact("MYTOKEN=abcd1234 GITHUB_TOKEN_FILE=/run/x"), "MYTOKEN=abcd1234 GITHUB_TOKEN_FILE=/run/x", "낱말 안의 키워드·다른 이름은 그대로");
  // 공백으로 띄운 평범한 말은 그대로 — 프롬프트의 "왜"가 망가지지 않게 (실제 DB에서 "Token Reduction"이 지워졌다)
  for (const prose of ["refresh token rotation을 고쳐", "fix the auth middleware", "Token Reduction≠Cost Reduction", "secret manager 연동"]) {
    assert.equal(redact(prose), prose, prose);
  }
  // 공백 꼴이라도 비밀처럼 보이면 지운다
  assert.equal(redact("--token abcd1234efgh"), "--token [redacted]");
  assert.equal(redact("--password hunter22"), "--password [redacted]");
  assert.equal(redact("--api-key ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "--api-key [redacted]");
  // 긴 입력에서도 선형 — 훅 안에서 돈다
  const started = Date.now();
  redact(`${"ab-cd-".repeat(10_000)}token`);
  assert.ok(Date.now() - started < 200, `${Date.now() - started}ms`);
});

test("verify·commit 판정과 줄 해시", () => {
  assert.equal(isVerifyCommand("npm test"), true);
  assert.equal(isVerifyCommand("npm run e2e -- --json"), true);
  assert.equal(isVerifyCommand("pytest tests/"), true);
  assert.equal(isVerifyCommand("ls -la"), false);
  // 흔한 검증 명령 — 전엔 놓쳤다
  for (const command of ["node --test tests/a.test.js", "pnpm vitest run", "pnpm exec jest", "yarn vitest", "bunx vitest", "tsc --noEmit", "vitest run", "jest --ci", "deno test", "./gradlew test", "cd backend && npx vitest run src/a.spec.ts", "CI=1 npm test", "uv run pytest -q", "php artisan test", "cargo nextest run", "npm run test:unit 2>&1 | tail -20"]) {
    assert.equal(isVerifyCommand(command), true, command);
  }
  // 명령 맨 앞이 아닌 낱말 — 전엔 검증으로 잡혀 커밋에 가짜 "verified … → pass"가 붙었다
  for (const command of ['git commit -m "fix vitest config"', 'git commit -m "pytest 경고 정리"', "echo npm test", 'grep -r "npm test" README.md', "git log --grep=pytest", "cat docs/npm-test.md", "npm install vitest"]) {
    assert.equal(isVerifyCommand(command), false, command);
  }
  assert.equal(isGitCommit('git commit -m "x"'), true);
  assert.equal(isGitCommit("git add -A && git commit -q -F -"), true);
  assert.equal(isGitCommit("git -C /x commit -m y"), true);
  assert.equal(isGitCommit("git log --oneline"), false);
  assert.deepEqual(verifyOutcome({ stdout: "ok 1\n# pass 3\n", stderr: "" }), { ok: true, tail: "" });
  assert.equal(verifyOutcome({ stdout: "x", stderr: "", interrupted: true }).ok, false);
  // 실패: 각 도구가 실제로 찍는 요약 꼴
  for (const [name, stdout] of [
    ["node:test", "ℹ tests 5\nℹ pass 3\nℹ fail 2\n"],
    ["TAP", "not ok 3 - parses trailers\n"],
    ["jest", "Tests:       1 failed, 4 passed, 5 total\n"],
    ["vitest", " Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 10 passed (12)\n"],
    ["vitest file", " FAIL  src/a.test.ts > adds\n"],
    ["mocha", "  3 passing (20ms)\n  1 failing\n"],
    ["pytest", "==================== 1 failed, 2 passed in 0.12s ====================\n"],
    ["pytest FAILED", "FAILED tests/test_a.py::test_x - AssertionError\n"],
    ["go", "--- FAIL: TestRotate (0.00s)\nFAIL\n"],
    ["cargo", "test result: FAILED. 3 passed; 1 failed\n"],
    ["tsc", "src/a.ts(3,5): error TS2345: Argument of type 'x'\n"],
    ["npm", "npm ERR! code ELIFECYCLE\n"],
    ["npm 10", "npm error code 1\n"],
    ["eslint", "✖ 3 problems (3 errors, 0 warnings)\n"],
    ["exit code", "Command failed. Exit code 1\n"],
    // 요약을 찍기 전에 죽은 경우 (stderr 규칙을 뺀 뒤 통과로 잘못 잡히던 것)
    ["python traceback", "Traceback (most recent call last):\n  File \"x.py\", line 1\nImportError: no module\n"],
    ["node 모듈 없음", "Error: Cannot find module './missing'\nRequire stack:\n"],
    ["node 오류 코드", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\n"],
    ["vite", "error during build:\n[vite]: Rollup failed to resolve import\n"],
    ["webpack", "ERROR in ./src/a.ts 3:5\n"],
    ["esbuild", "✘ [ERROR] Could not resolve \"x\"\nBuild failed with 1 error\n"],
  ] as const) {
    assert.equal(verifyOutcome({ stdout, stderr: "" }).ok, false, name);
  }
  assert.equal(verifyOutcome({ stdout: "", stderr: "npm error code 1\n" }).ok, false, "stderr의 실패 요약도 본다");
  assert.match(verifyOutcome({ stdout: "ℹ fail 1\n", stderr: "" }).tail, /fail 1/);
  // 통과: 도그푸딩에서 실패로 잘못 잡힌 꼴들
  for (const [name, stdout, stderr] of [
    ["git CRLF 경고(stderr)", "ℹ tests 86\nℹ pass 85\nℹ fail 0\n", "warning: in the working copy of 'a.ts', LF will be replaced by CRLF the next time Git touches it\n"],
    ["검증 명령과 함께 출력된 소스 줄", '0\n538:   ${row.error ? `  ${row.error.slice(0, 80)}` : ""}\nconst failedWords = /FAIL|failed|error/;\n', ""],
    ["npm warn", "ℹ fail 0\n", "npm warn deprecated foo@1.0.0\n"],
    ["0 failed", "Tests:       0 failed, 5 passed, 5 total\n", ""],
    ["테스트 이름에 든 실패 수", "✔ retries after 2 failed attempts (3ms)\nℹ fail 0\n", ""],
    ["exit code 0", "Process finished with exit code 0\n", ""],
  ] as const) {
    assert.equal(verifyOutcome({ stdout, stderr }).ok, true, name);
  }
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
  const made = (await headSha(dir))!.slice(0, 7);
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -am "perf(search): 재정렬 후보 질의 개선"' }, tool_response: { stdout: `[main ${made}] perf(search)`, stderr: "" } }));

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

test("SessionStart 요약과 막혔을 때 2단계 — 각각 600자·1200자 안에서 한 번만", async () => {
  const db = memoryDb();
  const dir = makeRepo(
    [
      { message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n", "tests/a.test.ts": "// t\n" }, date: "2024-01-01T10:00:00+09:00" },
      { message: "fix(a): 경계값 처리\n\nRejected: 음수 입력 금지 | 호출부가 음수를 쓴다\nTested: npm test", files: { "src/a.ts": "export const a = 2;\n" }, date: "2024-02-01T10:00:00+09:00" },
    ],
    "start",
  );
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-start-home-") };
  const context = { db, env, me: ["me@example.com"] };

  const start = await handleHook(context, event(dir, "st-1", { hook_event_name: "SessionStart", source: "startup" }));
  assert.ok(start?.stdout, "요약이 없습니다");
  assert.match(start!.stdout!, /^Grimoire: start — recent commits \(me\)\n/);
  assert.match(start!.stdout!, /fix\(a\): 경계값 처리/);
  assert.match(start!.stdout!, /file_context before editing/);
  assert.ok(start!.stdout!.length <= 600);
  assert.equal(await handleHook(context, event(dir, "st-1", { hook_event_name: "SessionStart", source: "resume" })), null);
  assert.equal(await handleHook(context, event(tempDir(), "st-1", { hook_event_name: "SessionStart", source: "startup" })), null, "등록 레포 밖");

  // 편집 뒤 첫 실패한 검증 → 2단계 한 번. 두 번째 실패엔 없음
  const session = "st-2";
  await handleHook(context, event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/a.ts"), old_string: "2", new_string: "3" } }));
  const fail = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ tests 3\nℹ pass 2\nℹ fail 1\n", stderr: "" } } as const;
  const first = await handleHook(context, event(dir, session, fail));
  assert.ok(first?.json, "2단계 맥락이 없습니다");
  const text = first!.json!.hookSpecificOutput.additionalContext;
  assert.equal(first!.json!.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(text, /first failing check/);
  assert.match(text, /src\/a\.ts:/);
  assert.match(text, /rejected: 음수 입력 금지/);
  assert.match(text, /verified: /);
  assert.ok(text.length <= 1200, `${text.length}자`);
  assert.equal(await handleHook(context, event(dir, session, fail)), null, "두 번째 실패에는 다시 내지 않는다");
  // 통과한 검증은 기록만
  assert.equal(await handleHook(context, event(dir, "st-3", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok", stderr: "" } })), null);
  assert.equal(pendingEvents(db, "st-3", repo.id).length, 1);
});

test("막혔을 때 2단계: 꼬리표만 있는 커밋은 빈 항목으로 내지 않고, 줄 것이 없으면 아무것도 내지 않는다", async () => {
  const noise = "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
  const db = memoryDb();
  const dir = makeRepo(
    [
      { message: `feat: 시작${noise}`, files: { "src/a.ts": "export const a = 0;\n", "src/b.ts": "export const b = 0;\n" }, date: "2024-01-01T10:00:00+09:00" },
      { message: "fix(a): 경계값\n\nRejected: 음수 금지 | 호출부가 음수를 쓴다", files: { "src/a.ts": "export const a = 1;\n" }, date: "2024-02-01T10:00:00+09:00" },
      { message: `feat(a): 정리${noise}`, files: { "src/a.ts": "export const a = 2;\n" }, date: "2024-03-01T10:00:00+09:00" },
      { message: `feat(b): 정리${noise}`, files: { "src/b.ts": "export const b = 1;\n" }, date: "2024-03-02T10:00:00+09:00" },
    ],
    "struggle",
  );
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = { db, env: { GRIMOIRE_HOME: tempDir("grimoire-struggle-home-") }, me: ["me@example.com"] };
  const fail = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ fail 1\n", stderr: "" } } as const;
  const edit = (file: string) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, file), old_string: "1", new_string: "9" } }) as const;

  // a.ts: 최신 커밋(feat(a): 정리)은 Co-Authored-By뿐 → 빠지고, Rejected가 있는 fix(a)만 나온다
  await handleHook(context, event(dir, "s-a", edit("src/a.ts")));
  const out = await handleHook(context, event(dir, "s-a", fail));
  const text = out?.json?.hookSpecificOutput.additionalContext ?? "";
  assert.match(text, /rejected: 음수 금지/);
  assert.equal(text.match(/^[0-9a-f]{10} /gm)?.length, 1, `커밋 항목은 하나여야 합니다:\n${text}`);
  assert.ok(!/^[0-9a-f]{10} src\/a\.ts:\n(?![ ]{2})/m.test(text), `내용 없는 머리줄:\n${text}`);

  // b.ts: 커밋들이 전부 꼬리표뿐 → 2단계 맥락 자체가 없다 (예전엔 "sha src/b.ts:" 머리줄만 찍혔다)
  await handleHook(context, event(dir, "s-b", edit("src/b.ts")));
  assert.equal(await handleHook(context, event(dir, "s-b", fail)), null);

  // 오탐 없음: 통과한 검증(출력에 "error" 낱말·git 경고가 섞여도)은 2단계를 발화시키지 않는다
  await handleHook(context, event(dir, "s-c", edit("src/a.ts")));
  const passing = { ...fail, tool_response: { stdout: "const x = row.error;\nℹ fail 0\n", stderr: "warning: LF will be replaced by CRLF\n" } };
  assert.equal(await handleHook(context, event(dir, "s-c", passing)), null);
  assert.deepEqual(pendingEvents(db, "s-c", repo.id).filter((e) => e.kind === "verify").map((e) => e.text), ["npm test → pass"]);

  // 백그라운드로 띄운 검증은 결과를 모른다 — "→ pass"로 적지 않는다
  await handleHook(context, event(dir, "s-d", edit("src/a.ts")));
  const background = { ...fail, tool_input: { command: "npm test", run_in_background: true }, tool_response: { stdout: "Command running in background with ID: b1", stderr: "", backgroundTaskId: "b1" } };
  assert.equal(await handleHook(context, event(dir, "s-d", background)), null);
  assert.deepEqual(pendingEvents(db, "s-d", repo.id).filter((e) => e.kind === "verify"), []);
});

test("commitDir: git -C <경로> commit이면 그 폴더(따옴표·상대경로), 아니면 cwd", () => {
  const cwd = path.resolve(path.sep, "work", "repo");
  assert.equal(commitDir('git commit -m "x"', cwd), cwd);
  assert.equal(commitDir("git -C ../wt commit -m x", cwd), path.resolve(cwd, "../wt"));
  assert.equal(commitDir('git add -A && git -C "C:/a b/wt" commit -q -F -', cwd), path.resolve(cwd, "C:/a b/wt"));
  assert.equal(commitDir("git -C '/tmp/x y' commit", cwd), path.resolve(cwd, "/tmp/x y"));
  assert.equal(commitDir("git -C other log && git commit -m y", cwd), cwd, "-C가 다른 명령에 붙은 것은 무시");
  assert.equal(isGitCommit('git -C "C:/a b/wt" commit -m x'), true);
  // git 전역 옵션·앞의 환경 변수가 붙어도 커밋이다 — 전엔 놓쳐 세션 기록이 묶이지 않았다
  for (const command of ["git -c user.name=a -c user.email=b commit -m x", "git --no-pager commit -m x", 'git -C "a b" -c core.hooksPath=/dev/null commit -m x', "GIT_AUTHOR_NAME=x git commit -m y", "git commit --amend --no-edit"]) {
    assert.equal(isGitCommit(command), true, command);
  }
  for (const command of ["git commit-tree abc", "git log --grep=commit", "echo git commit"]) {
    assert.equal(isGitCommit(command), false, command);
  }
  assert.equal(commitDir("git -c a=b -C ../wt commit -m x", cwd), path.resolve(cwd, "../wt"), "-c가 앞에 있어도 -C를 따른다");
  assert.equal(commitDir("git -C a -C b commit", cwd), path.resolve(cwd, "a", "b"), "-C 여럿은 git처럼 이어 붙인다");
});

test("verifyRecord: 검증 명령과 실패 출력의 비밀을 저장 전에 지운다", async () => {
  const { verifyRecord } = await import("../src/core/capture.js");
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const passed = verifyRecord(`OPENAI_API_KEY=${secret} npm test`, { ok: true, tail: "" });
  assert.ok(!passed.includes(secret) && passed.endsWith("→ pass"), passed);
  const failed = verifyRecord("npm test -- --token=abcd1234efgh", { ok: false, tail: `Error: request failed Authorization: Bearer abcdefghijklmnopqrstuv\nℹ fail 1` });
  assert.ok(!failed.includes("abcd1234efgh") && !failed.includes("abcdefghijklmnopqrstuv"), failed);
  assert.match(failed, /→ fail :: /);
  // 200자에서 잘리는 자리에 걸친 토큰도 남지 않는다 (자르기 전에 지운다)
  const long = verifyRecord(`${"x".repeat(185)} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 npm test`, { ok: true, tail: "" });
  assert.ok(!long.includes("ghp_ABCDEF"), long);
  // 검증 조각만 — 긴 cd 경로·파이프 뒤 꼬리·앞의 환경 변수는 남기지 않는다
  const where = `cd "${"C:/very/long/path/".repeat(12)}" && CI=1 npm run typecheck 2>&1 | grep -c error && npm test 2>&1 | tail -5`;
  assert.equal(verifyRecord(where, { ok: true, tail: "" }), "npm run typecheck 2>&1 && npm test 2>&1 → pass");
});

test("git -C <다른 레포> commit: 세션 기록을 남의 레포 커밋에 묶지 않는다", async () => {
  const db = memoryDb();
  const a = makeRepo([{ message: "feat: A 시작", files: { "src/a.ts": "1\n" } }], "own-a");
  const b = makeRepo([{ message: "feat: B 시작", files: { "src/b.ts": "1\n" } }], "own-b");
  const repoA = await addRepo(db, a);
  await syncRepo(db, repoA);
  await syncRepo(db, await addRepo(db, b));
  const context = { db, env: { GRIMOIRE_HOME: tempDir() }, me: [] };
  await handleHook(context, event(a, "s-other", { hook_event_name: "UserPromptSubmit", prompt: "A의 경계값을 고치자" }));
  addCommit(b, { message: "fix(b): B 고침", files: { "src/b.ts": "2\n" } });
  const commit = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `git -C "${b}" commit -am "fix(b): B 고침"` }, tool_response: { stdout: "[main 1234567] fix(b): B 고침\n", stderr: "" } } as const;
  await handleHook(context, event(a, "s-other", commit));
  const bHead = (await headSha(b))!;
  assert.equal(commitContextOf(db, repoA.id, bHead), null, "A 레포에 B의 sha로 묶이면 안 됩니다");
  assert.deepEqual(pendingEvents(db, "s-other", repoA.id).map((e) => e.kind), ["prompt"], "A의 세션 기록은 A의 다음 커밋을 기다린다");
});

test("reRedactStored(마이그레이션 8): 옛 버전이 저장한 프롬프트·검증의 비밀을 지우고 검색 문서의 [why]도 고친다", async () => {
  const { reRedactStored, refreshWhy } = await import("../src/core/capture.js");
  const db = memoryDb();
  const dir = makeRepo([{ message: "fix(pay): 결제 재시도", files: { "src/pay.ts": "1\n" } }], "reredact");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const sha = (await headSha(dir))!;
  // 0.7.x가 저장한 그대로 — 접두 붙은 이름의 값은 지워지지 않았다
  const leaked = "OPENAI_API_KEY=abcd1234leak 로 결제 재시도 테스트";
  db.prepare("INSERT INTO commit_context (repo_id, sha, kind, text, ord) VALUES (?, ?, 'prompt', ?, 0)").run(repo.id, sha, leaked);
  db.prepare("INSERT INTO commit_context (repo_id, sha, kind, text, ord) VALUES (?, ?, 'verify', ?, 0)").run(repo.id, sha, "DB_PASSWORD=hunter22 npm test → pass");
  db.prepare("INSERT INTO session_events (session_id, repo_id, at, kind, text) VALUES ('old', ?, ?, 'prompt', ?)").run(repo.id, new Date().toISOString(), leaked);
  refreshWhy(db, repo.id, sha);
  assert.ok(search(db, "abcd1234leak").hits.length > 0, "준비: 검색 문서에 새어 있어야 합니다");

  assert.equal(reRedactStored(db), 3);
  const texts = (db.prepare("SELECT text FROM commit_context UNION ALL SELECT text FROM session_events").all() as { text: string }[]).map((row) => row.text).join("\n");
  assert.ok(!texts.includes("abcd1234leak") && !texts.includes("hunter22"), texts);
  assert.equal(search(db, "abcd1234leak").hits.length, 0, "검색 문서의 [why]에서도 사라져야 합니다");
  assert.ok(search(db, "결제 재시도 테스트").hits.length > 0, "나머지 말은 그대로 검색된다");
  assert.equal(reRedactStored(db), 0, "두 번째는 바꿀 것이 없다");
});

test("recordPrompt: 슬래시 명령은 뒤에 사용자의 말이 있을 때만 그 말을 남긴다, 경로로 시작하는 말은 그대로", async () => {
  const db = memoryDb();
  const texts = () => (db.prepare("SELECT text FROM session_events WHERE session_id = 'slash' ORDER BY id").all() as { text: string }[]).map((row) => row.text);
  for (const prompt of ["/clear", "/model claude-opus-5-5", "/loop 5m /foo", "/review 123", "/goal 완성도를 계속 올려라", "/src/a.ts 이 파일의 경계값을 고쳐", "/plugin:skill 결제 재시도 로직 정리해 줘"]) {
    recordPrompt(db, "slash", null, prompt);
  }
  assert.deepEqual(texts(), ["완성도를 계속 올려라", "/src/a.ts 이 파일의 경계값을 고쳐", "결제 재시도 로직 정리해 줘"]);
});

test("나눠 커밋하기: 이번 커밋에 없지만 아직 작업 폴더에 변경이 남은 파일은 '버림'이 아니라 다음 커밋으로 넘긴다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" }, date: "2024-01-01T10:00:00+09:00" }], "split");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = { db, env: { GRIMOIRE_HOME: tempDir("grimoire-split-home-") }, me: [] };
  const session = "split-1";
  const editEvent = (file: string, text: string) => event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, file), old_string: "1", new_string: text } });
  const commitEvent = async (message: string) => event(dir, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `git commit -m "${message}"` }, tool_response: { stdout: `[main ${(await headSha(dir))!.slice(0, 7)}] ${message}`, stderr: "" } });

  // a·b 둘 다 실제로 고치고, a만 먼저 커밋 — b는 작업 폴더에 변경이 남아 있다
  await handleHook(context, event(dir, session, { hook_event_name: "UserPromptSubmit", prompt: "a와 b의 경계값을 둘 다 고쳐" }));
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 2;\n");
  await handleHook(context, editEvent("src/a.ts", "export const a = 2;"));
  fs.writeFileSync(path.join(dir, "src/b.ts"), "export const b = 2;\n");
  await handleHook(context, editEvent("src/b.ts", "export const b = 2;"));
  git(dir, ["add", "src/a.ts"]);
  git(dir, ["-c", "user.email=me@example.com", "-c", "user.name=me", "commit", "-q", "-m", "fix(a): 경계값"]);
  await handleHook(context, await commitEvent("fix(a): 경계값"));
  const first = (await headSha(dir))!;
  assert.deepEqual(commitContextOf(db, repo.id, first)?.dropped ?? [], [], "아직 커밋 전인 b를 '버림'으로 적으면 안 됩니다");
  assert.deepEqual(pendingEvents(db, session, repo.id).map((e) => e.path), ["src/b.ts"], "b의 편집은 다음 커밋을 기다린다");

  // b를 커밋하면 그 편집이 이 커밋의 세션 기록이 된다(넘겨진 편집이 소진됨)
  git(dir, ["-c", "user.email=me@example.com", "-c", "user.name=me", "commit", "-q", "-am", "fix(b): 경계값"]);
  await handleHook(context, await commitEvent("fix(b): 경계값"));
  assert.deepEqual(pendingEvents(db, session, repo.id), []);
});

test("commitSucceeded: 요약 줄이 있으면 성공 — pre-commit 경고나 뒤쪽 git push 실패에 속지 않는다", async () => {
  const { commitSucceeded } = await import("../src/core/capture.js");
  // 커밋은 됐다
  assert.equal(commitSucceeded({ stdout: "[main 1a2b3c4] fix(a): 경계값\n 1 file changed\n", stderr: "error: failed to push some refs to 'origin'\n" }), true, "&& git push 실패");
  assert.equal(commitSucceeded({ stdout: "✖ eslint found 2 warnings\nerror: unused var (warning only)\n[feat/x 9f8e7d6] feat: 추가\n", stderr: "" }), true, "pre-commit 경고");
  assert.equal(commitSucceeded({ stdout: "[main (root-commit) abcdef1] 시작\n", stderr: "" }), true);
  assert.equal(commitSucceeded({ stdout: "[detached HEAD 1234567] wip\n", stderr: "" }), true);
  // 커밋이 안 됐다
  assert.equal(commitSucceeded({ stdout: "On branch main\nnothing to commit, working tree clean\n", stderr: "" }), false);
  assert.equal(commitSucceeded({ stdout: "", stderr: "husky - pre-commit hook exited with code 1 (error)\nerror: lint failed\n" }), false);
  assert.equal(commitSucceeded({ stdout: "[main 1a2b3c4] x\n", stderr: "", interrupted: true }), false);
  // -q로 요약 줄이 없으면 실패 낱말로 짐작
  assert.equal(commitSucceeded({ stdout: "", stderr: "" }), true);
});

test("cd ../다른레포 && git commit: git이 찍은 새 sha가 세션 폴더의 HEAD와 다르면 묶지 않는다", async () => {
  const db = memoryDb();
  const a = makeRepo([{ message: "feat: A 시작", files: { "src/a.ts": "1\n" } }], "cd-a");
  const b = makeRepo([{ message: "feat: B 시작", files: { "src/b.ts": "1\n" } }], "cd-b");
  const repoA = await addRepo(db, a);
  await syncRepo(db, repoA);
  const context = { db, env: { GRIMOIRE_HOME: tempDir() }, me: [] };
  await handleHook(context, event(a, "s-cd", { hook_event_name: "UserPromptSubmit", prompt: "A의 경계값을 고치자" }));
  const aHead = (await headSha(a))!;
  addCommit(b, { message: "fix(b): B 고침", files: { "src/b.ts": "2\n" } });
  const bShort = (await headSha(b))!.slice(0, 7);
  const commit = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `cd "${b}" && git commit -am "fix(b): B 고침"` }, tool_response: { stdout: `[main ${bShort}] fix(b): B 고침\n`, stderr: "" } } as const;
  await handleHook(context, event(a, "s-cd", commit));
  assert.equal(commitContextOf(db, repoA.id, aHead), null, "A의 옛 HEAD에 세션 기록이 붙으면 안 됩니다");
  assert.deepEqual(pendingEvents(db, "s-cd", repoA.id).map((e) => e.kind), ["prompt"], "A의 세션 기록은 A의 다음 커밋을 기다린다");
});

test("git commit -q(요약 줄 없음): HEAD가 방금 만든 커밋일 때만 묶는다 — 오래된 HEAD면 커밋할 것이 없었거나 다른 곳에서 커밋한 것", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "1\n" }, date: "2024-01-01T10:00:00+09:00" }], "quiet");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = { db, env: { GRIMOIRE_HOME: tempDir() }, me: [] };
  const quiet = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -q -am "fix(a): 경계값"' }, tool_response: { stdout: "", stderr: "" } } as const;
  await handleHook(context, event(dir, "s-q", { hook_event_name: "UserPromptSubmit", prompt: "a의 경계값을 고치자" }));

  // 커밋이 안 만들어졌다(HEAD는 2024년 커밋 그대로) — 묶지 않는다
  const old = (await headSha(dir))!;
  await handleHook(context, event(dir, "s-q", quiet));
  assert.equal(commitContextOf(db, repo.id, old), null, "오래된 HEAD에 묶으면 안 됩니다");

  // 방금 커밋했다 — 묶는다
  addCommit(dir, { message: "fix(a): 경계값", files: { "src/a.ts": "2\n" }, date: new Date().toISOString() });
  const fresh = (await headSha(dir))!;
  await handleHook(context, event(dir, "s-q", quiet));
  assert.deepEqual(commitContextOf(db, repo.id, fresh)?.prompts, ["a의 경계값을 고치자"]);
});

test("검증 실패와 커밋이 한 명령에 있으면(npm test; git commit) 2단계 맥락을 내면서도 커밋에 세션 기록을 묶는다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "fix(a): 처음 경계값", files: { "src/a.ts": "1\n", "src/b.ts": "1\n" }, date: "2024-01-01T10:00:00+09:00" }], "mixed");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = { db, env: { GRIMOIRE_HOME: tempDir() }, me: [] };
  // 지난 커밋에 '왜'를 남겨 두면 2단계 맥락이 생긴다
  recordPrompt(db, "old", repo.id, "음수가 들어오면 깨져서 a의 경계값을 처음 고쳤다");
  bindToCommit(db, { sessionId: "old", repoId: repo.id, sha: (await headSha(dir))!, files: ["src/a.ts", "src/b.ts"], addedHashes: new Set() });

  await handleHook(context, event(dir, "s-mix", { hook_event_name: "UserPromptSubmit", prompt: "a의 경계값을 다시 고치자" }));
  await handleHook(context, event(dir, "s-mix", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/a.ts"), old_string: "1", new_string: "2" } }));
  addCommit(dir, { message: "fix(a): 경계값 다시", files: { "src/a.ts": "2\n" }, date: new Date().toISOString() });
  const made = (await headSha(dir))!;
  const mixed = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: 'npm test; git commit -am "fix(a): 경계값 다시"' }, tool_response: { stdout: `ℹ tests 3\nℹ fail 1\n[main ${made.slice(0, 7)}] fix(a): 경계값 다시\n`, stderr: "" } } as const;
  const out = await handleHook(context, event(dir, "s-mix", mixed));
  assert.ok(out?.json?.hookSpecificOutput.additionalContext.includes("first failing check"), "2단계 맥락은 그대로 나온다");
  assert.deepEqual(commitContextOf(db, repo.id, made)?.prompts, ["a의 경계값을 다시 고치자"], "같은 명령의 커밋에도 묶여야 합니다");
});
