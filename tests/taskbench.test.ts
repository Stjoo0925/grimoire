import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { grimoireToolStats, hookStats, influenced } from "../e2e/taskbench";

const line = (fields: Record<string, unknown>) => JSON.stringify({ event: "PreToolUse", tool: "Edit", file: null, enabled: true, injected: false, chars: 0, ...fields });

test("hookStats: 켜진 훅의 호출·주입·글자 수·이벤트별·파일을 세고, 꺼진 훅의 주입은 누수로 센다", () => {
  const root = path.resolve(path.sep, "wt", "repo");
  const text = [
    line({ file: path.join(root, "src", "a.ts"), injected: true, chars: 120 }),
    line({ file: path.join(root, "src", "a.ts") }), // 같은 세션 두 번째 — 조용
    line({ file: path.join(root, "src", "b.ts"), injected: true, chars: 80 }),
    line({ event: "PostToolUse", tool: "Bash", injected: true, chars: 300 }), // 막혔을 때 2단계
    line({ event: "SessionStart", tool: null, injected: true, chars: 200 }),
    line({ event: "UserPromptSubmit", tool: null }),
    line({ enabled: false }), // 사용자 전역 훅 — 꺼진 채 불림, 정상
    line({ enabled: false, injected: true, chars: 50 }), // 꺼졌어야 할 훅이 넣음 — 누수
    line({ error: "boom" }),
    "{ 깨진 줄",
    "",
  ].join("\n");
  const stats = hookStats(text, root);
  assert.equal(stats.calls, 7);
  assert.equal(stats.injections, 4);
  assert.equal(stats.chars, 700);
  assert.deepEqual(stats.byEvent, { PreToolUse: 2, PostToolUse: 1, SessionStart: 1 });
  assert.deepEqual(stats.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(stats.leaked, 1);
  assert.equal(stats.errors, 1);
  assert.deepEqual(hookStats(""), { calls: 0, injections: 0, chars: 0, byEvent: {}, files: [], leaked: 0, errors: 0 });
});

test("grimoireToolStats·influenced: grimoire MCP 도구만 세고, 훅 주입이나 도구 호출이 있으면 닿은 실행", () => {
  const tools = grimoireToolStats([
    { name: "Read" },
    { name: "mcp__grimoire__file_context" },
    { name: "mcp__grimoire__search_memory" },
    { name: "mcp__grimoire__file_context" },
    { name: "mcp__other__x" },
  ]);
  assert.deepEqual(tools, { total: 3, byTool: { file_context: 2, search_memory: 1 } });
  const none = hookStats("");
  assert.equal(influenced({ hook: none, grimoireToolCalls: 0 }), false);
  assert.equal(influenced({ hook: none, grimoireToolCalls: 1 }), true);
  assert.equal(influenced({ hook: { ...none, injections: 1 }, grimoireToolCalls: 0 }), true);
});

test("worktree --link: 원본 레포의 의존성 폴더를 연결하고, 지울 때 원본은 그대로 둔다", async () => {
  const { worktree } = await import("../e2e/taskbench.js");
  const { makeRepo, git } = await import("./helpers.js");
  const fs = await import("node:fs");
  const repo = makeRepo([{ message: "feat: 시작", files: { "backend/src/a.ts": "export const a = 1;\n", ".gitignore": "node_modules/\n" } }], "linked");
  // 원본 레포에만 있는(커밋 안 된) 무거운 의존성 폴더
  const deps = path.join(repo, "backend", "node_modules", "pkg");
  fs.mkdirSync(deps, { recursive: true });
  fs.writeFileSync(path.join(deps, "index.js"), "module.exports = 1;\n");
  const sha = git(repo, ["rev-parse", "HEAD"]).trim();

  const wt = worktree(repo, sha, ["backend/node_modules", "not/there"]);
  const linked = path.join(wt.dir, "backend", "node_modules", "pkg", "index.js");
  assert.equal(fs.readFileSync(linked, "utf8"), "module.exports = 1;\n", "작업 폴더에서 원본 의존성이 보여야 합니다");
  assert.equal(fs.existsSync(path.join(wt.dir, "not", "there")), false, "원본에 없는 경로는 연결하지 않는다");

  wt.remove();
  assert.equal(fs.existsSync(wt.dir), false, "작업 폴더는 지워져야 합니다");
  assert.equal(fs.readFileSync(path.join(deps, "index.js"), "utf8"), "module.exports = 1;\n", "원본 의존성은 그대로여야 합니다");
});

test("testCommand: {tests}를 그 사례의 테스트 파일로 바꾼다", async () => {
  const { testCommand } = await import("../e2e/taskbench.js");
  assert.equal(testCommand("cd backend && npx vitest run {tests}", ["backend/src/a.spec.ts", "backend/src/b c.spec.ts"]), 'cd backend && npx vitest run "backend/src/a.spec.ts" "backend/src/b c.spec.ts"');
  assert.equal(testCommand("npm test", ["x.test.ts"]), "npm test");
});
