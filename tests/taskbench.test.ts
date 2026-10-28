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
  assert.equal(stats.noteInjections, 0);
  assert.deepEqual(hookStats(""), { calls: 0, injections: 0, chars: 0, noteInjections: 0, byEvent: {}, files: [], leaked: 0, errors: 0 });
});

test("hookStats: 파일에 묶인 노트(`Notes: #` 줄)가 든 주입만 노트 주입으로 센다", () => {
  const text = [
    line({ injected: true, chars: 90, text: 'src/a.ts\nNotes: #3 "CP949 사용자 정의 영역은 단말과 맞춘다" (2026-10-27)\nCo-changes: b.ts' }),
    line({ injected: true, chars: 40, text: "src/b.ts\nCo-changes: a.ts" }),
    line({ injected: true, chars: 30, text: "본문에 Notes: #1이 섞여도 줄 머리가 아니면 아님" }),
  ].join("\n");
  assert.equal(hookStats(text).noteInjections, 1);
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

test("pinnedClone: 그 clone의 worktree에서는 부모 이후 커밋이 어떤 ref로도 보이지 않고, 의존성은 원본에서 연결한다", async () => {
  const { pinnedClone, worktree } = await import("../e2e/taskbench.js");
  const { makeRepo, git, tempDir } = await import("./helpers.js");
  const fs = await import("node:fs");
  const repo = makeRepo(
    [
      { message: "feat: 시작", files: { "a.ts": "export const a = 1;\n", ".gitignore": "node_modules/\n" } },
      { message: "fix: 실제 고침", files: { "a.ts": "export const a = 2;\n" } },
    ],
    "pinned",
  );
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  git(repo, ["tag", "v1"]);
  const fix = git(repo, ["rev-parse", "HEAD"]).trim();
  const parent = git(repo, ["rev-parse", "HEAD~1"]).trim();

  const pinned = pinnedClone(repo, parent, path.join(tempDir("pinned-"), "clone"));
  const wt = worktree(pinned, parent, ["node_modules"], repo);
  const all = git(wt.dir, ["log", "--all", "--reflog", "--format=%H"]);
  assert.equal(all.includes(fix), false, "실제 fix 커밋이 보이면 안 됩니다");
  assert.equal(all.includes(parent), true);
  assert.equal(git(wt.dir, ["tag"]).trim(), "", "원본 태그도 따라오면 안 됩니다");
  assert.equal(fs.existsSync(path.join(wt.dir, "node_modules", "pkg")), true, "의존성은 원본에서 연결");
  wt.remove();
});

test("testCommand: {tests}를 그 사례의 테스트 파일로 바꾼다", async () => {
  const { testCommand } = await import("../e2e/taskbench.js");
  assert.equal(testCommand("cd backend && npx vitest run {tests}", ["backend/src/a.spec.ts", "backend/src/b c.spec.ts"]), 'cd backend && npx vitest run "backend/src/a.spec.ts" "backend/src/b c.spec.ts"');
  assert.equal(testCommand("npm test", ["x.test.ts"]), "npm test");
  // --under: 명령이 그 폴더에서 도니 경로도 그 폴더 기준 (끝 / 유무 무관)
  for (const under of ["backend/", "backend", "backend\\", "backend//"]) {
    assert.equal(testCommand("cd backend && npx vitest run {tests}", ["backend/src/a.spec.ts"], under), 'cd backend && npx vitest run "src/a.spec.ts"');
  }
});

test("cacheWriteCost: 모델별 총액을 가격 비율로 나눠 캐시 쓰기 몫만 뗀다", async () => {
  const { cacheWriteCost } = await import("../e2e/claude.js");
  // 입력 단가 $1/토큰으로 두면: 입력 10 + 쓰기 100×1.25 + 읽기 1000×0.1 + 출력 20×5 = 335
  assert.equal(cacheWriteCost([{ usage: { input: 10, cacheWrite: 100, cacheRead: 1000, output: 20 }, costUsd: 335 }]), 125);
  // 모델마다 단가가 달라도 각자 나눠 더한다
  assert.equal(
    cacheWriteCost([
      { usage: { input: 0, cacheWrite: 100, cacheRead: 0, output: 0 }, costUsd: 3 },
      { usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 1 },
    ]),
    3,
  );
  assert.equal(cacheWriteCost([{ usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0 }]), 0);
  assert.equal(cacheWriteCost([]), null);
});

test("summarize: 캐시 쓰기를 뺀 비용과 짝 비용비를 따로 내 — 콜드 캐시 한 회가 비용비를 뒤집지 않게", async () => {
  const { summarize, costNoWrite, hookStats: stats } = await import("../e2e/taskbench.js");
  const hook = { ...stats(""), injections: 1 };
  const row = (task: string, mode: "bare" | "grimoire", costUsd: number, cacheWriteUsd: number) => ({
    task, mode, seed: 1, pass: true, p2pBroken: false, costUsd, cacheWriteUsd, turns: 4, toolCalls: 3, stray: 0, missed: 0,
    revertedEdits: 0, churnRatio: 1, subtype: "success", seconds: 1, usage: null, grimoireToolCalls: 0, grimoireTools: {}, hook,
  });
  // 0.8.1 파일럿 모양: grimoire 첫 실행이 콜드 캐시라 두 배, 나머지는 같다
  const summary = summarize([
    row("a", "grimoire", 0.16, 0.1), row("a", "bare", 0.08, 0.02),
    row("b", "grimoire", 0.09, 0.02), row("b", "bare", 0.09, 0.02),
  ]);
  assert.equal(summary.paired.costRatioOk, 1.414);
  assert.equal(summary.paired.costRatioNoWriteOk, 1);
  assert.equal(summary.modes.grimoire.costNoWrite, 0.13);
  assert.equal(summary.modes.bare.costNoWritePerSolved, 0.065);
  assert.equal(costNoWrite({ costUsd: 0.1, cacheWriteUsd: null }), null);
  assert.equal(costNoWrite({ costUsd: 0.1, cacheWriteUsd: 0.2 }), 0);
  // notes를 돌리지 않았으면 notes 요약도 짝도 없다
  assert.equal("notes" in summary.modes, false);
  assert.equal("pairedNotes" in summary, false);
});

test("summarize notes: bare·grimoire 대비 짝을 따로 내고, 노트가 뜬 실행만 닿은 것으로 센다", async () => {
  const { summarize, hookStats: stats } = await import("../e2e/taskbench.js");
  const none = stats("");
  const row = (task: string, mode: "bare" | "grimoire" | "notes", costUsd: number, noteInjections = 0, pass = true) => ({
    task, mode, seed: 1, pass, p2pBroken: false, costUsd, cacheWriteUsd: 0, turns: 4, toolCalls: 3, stray: 0, missed: 0,
    revertedEdits: 0, churnRatio: 1, subtype: "success", seconds: 1, usage: null, grimoireToolCalls: 0, grimoireTools: {},
    hook: { ...none, injections: mode === "bare" ? 0 : 1, noteInjections },
  });
  const summary = summarize([
    row("a", "bare", 0.2), row("a", "grimoire", 0.2), row("a", "notes", 0.1, 1),
    row("b", "bare", 0.2), row("b", "grimoire", 0.2), row("b", "notes", 0.2, 0),
    row("c", "bare", 0.2), row("c", "grimoire", 0.2, 0, false), row("c", "notes", 0.2, 1),
  ]);
  assert.equal(summary.modes.notes.noteRuns, 2);
  assert.equal(summary.modes.grimoire.noteRuns, 0);
  assert.equal(summary.pairedNotes?.okPairs, 3);
  assert.equal(summary.pairedNotes?.costRatioInfluenced, 0.707);
  assert.equal(summary.pairedNotes?.costRatioUninfluenced, 1);
  // grimoire 대비: c는 grimoire가 못 풀어 _ok 짝에서 빠지고, pass 차이로만 보인다
  assert.equal(summary.pairedNotesVsGrimoire?.okPairs, 2);
  assert.equal(summary.pairedNotesVsGrimoire?.passDelta, 0.333);
  assert.equal(summary.paired.passDelta, -0.333);
});
