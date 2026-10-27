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
