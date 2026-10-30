/**
 * 레포 규칙 (rules.ts) — docs/rules-research.md §5의 성공 기준을 하나씩 고정한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { openDb } from "../src/core/db";
import { addRepo, syncRepo } from "../src/core/indexer";
import { addNote, notesForFile } from "../src/core/notes";
import { blameStats, isRuleFile, parseBlame, parseRules, unitsRemovedBy, unitsTouchedBy } from "../src/core/rules";
import { search } from "../src/core/search";
import { slimSearch } from "../src/mcp/format";
import { callTool, TOOLS } from "../src/mcp/tools";
import { handleHook, type HookInput } from "../src/hook/runner";
import { addCommit, git, makeRepo, memoryDb, tempDir } from "./helpers";

const CLAUDE_V1 = [
  "# Project rules",
  "",
  "## Commits",
  "- 커밋 제목은 한국어로 쓴다",
  "- 머지와 배포는 사용자가 말할 때만 한다",
  "",
  "## Code",
  "Default export는 쓰지 않는다. 이름 있는 export만.",
  "",
].join("\n");

/** c1 규칙 도입 → c2 문단 수정(fix) → c3 공백만 바꿈(style) → c4 .claude/rules 추가 → c5 chore로 규칙 추가 */
function ruledRepo() {
  const dir = makeRepo(
    [
      {
        message: "feat: 커밋·코드 규칙을 정한다",
        files: { "CLAUDE.md": CLAUDE_V1, "src/a.ts": "export const a = 1;\n", "docs/rules.md": "- 이건 규칙 파일이 아니다 그냥 문서\n", "claude.md.bak": "- 백업 파일도 아니다 아니다\n" },
        date: "2026-01-01T10:00:00+09:00",
      },
      {
        message: "fix: default export 때문에 import 이름이 갈라졌다",
        files: { "CLAUDE.md": CLAUDE_V1.replace("이름 있는 export만.", "이름 있는 export만 쓴다.") },
        date: "2026-02-01T10:00:00+09:00",
      },
      {
        message: "style: 공백 정리",
        files: { "CLAUDE.md": CLAUDE_V1.replace("이름 있는 export만.", "이름 있는 export만 쓴다.").replace("커밋 제목은 한국어로", "커밋 제목은  한국어로") },
        date: "2026-03-01T10:00:00+09:00",
      },
      {
        message: "feat: 테스트 규칙",
        files: { ".claude/rules/tests.md": '---\npaths:\n  - "**/*.test.ts"\n---\n\n- 테스트는 실제 git 레포로 만든다 (모킹 금지)\n' },
        date: "2026-04-01T10:00:00+09:00",
      },
    ],
    "ruled",
  );
  return dir;
}

const sha = (dir: string, rev: string) => git(dir, ["rev-parse", rev]).trim();

test("isRuleFile: 클라이언트가 실제로 읽는 위치만, 이름만 비슷한 파일은 아니다", () => {
  for (const file of [
    "CLAUDE.md",
    "pkg/api/CLAUDE.md",
    "AGENTS.md",
    ".claude/rules/style.md",
    ".claude/rules/deep/x.md",
    ".cursor/rules/react.mdc",
    ".cursorrules",
    ".windsurfrules",
    ".windsurf/rules/a.md",
    ".github/copilot-instructions.md",
    ".github/instructions/ts.instructions.md",
    ".kiro/steering/tech.md",
  ]) {
    assert.ok(isRuleFile(file), file);
  }
  for (const file of ["claude.md", "CLAUDE.md.bak", "docs/rules.md", "README.md", ".claude/settings.json", ".github/instructions/ts.md", "src/CLAUDE.ts", ".claude/rules"]) {
    assert.ok(!isRuleFile(file), file);
  }
  assert.ok(!isRuleFile("CLAUDE.md", 300 * 1024), "200KB 넘는 파일은 아니다");
});

test("parseRules: 목록 항목·문단이 단위, 제목은 맥락, 하위 항목·이어진 줄은 같은 단위, 코드 블록은 앞 단위에", () => {
  const parsed = parseRules(
    [
      "---",
      "globs: src/**/*.ts, tests/**",
      "alwaysApply: false",
      "---",
      "# Rules",
      "## Style",
      "- 들여쓰기는 두 칸으로 한다",
      "  - 탭은 쓰지 않는다 절대로",
      "  이어지는 설명 줄도 같은 단위",
      "1. 번호 목록도 단위가 된다",
      "",
      "문단 하나는 단위 하나가 된다.",
      "다음 줄도 같은 문단이다.",
      "```ts",
      "export const x = 1;",
      "```",
      "",
      "- TODO",
      "### Deep",
      "- 깊은 제목 아래의 규칙 하나",
    ].join("\r\n"),
  );
  assert.equal(parsed.scope, "src/**/*.ts, tests/**");
  assert.deepEqual(
    parsed.units.map((unit) => [unit.line, unit.endLine, unit.heading, unit.text.split("\n")[0]]),
    [
      [7, 9, "Rules > Style", "들여쓰기는 두 칸으로 한다"],
      [10, 10, "Rules > Style", "번호 목록도 단위가 된다"],
      [12, 16, "Rules > Style", "문단 하나는 단위 하나가 된다."],
      [20, 20, "Rules > Style > Deep", "깊은 제목 아래의 규칙 하나"],
    ],
  );
  assert.ok(parsed.units[0].text.includes("탭은 쓰지 않는다"), "하위 항목은 같은 단위");
  assert.ok(!parsed.units[2].text.includes("export const"), "코드 블록 내용은 본문에 넣지 않는다");
});

test("parseRules 반례: 빈 파일·프런트매터만·코드 블록만·닫히지 않은 프런트매터·아주 긴 줄", () => {
  assert.deepEqual(parseRules(""), { scope: "", units: [] });
  assert.deepEqual(parseRules("---\npaths: a/**\n---\n"), { scope: "a/**", units: [] });
  assert.deepEqual(parseRules("```\n- 코드 블록 안의 목록은 규칙이 아니다\n```\n").units, []);
  // 닫는 ---가 없으면 프런트매터가 아니다 — 첫 줄 "---"는 8자 미만이라 버려지고 나머지는 문단
  const open = parseRules("---\npaths: x\n- 규칙 하나 여기에 있다\n");
  assert.equal(open.scope, "");
  assert.ok(open.units.some((unit) => unit.text.includes("규칙 하나")));
  const long = parseRules(`- ${"가".repeat(5000)}\n`);
  assert.equal(long.units[0].text.length, 2000);
  // 단위 수 상한
  assert.equal(parseRules(Array.from({ length: 400 }, (_, i) => `- 규칙 번호 ${i} 입니다`).join("\n")).units.length, 300);
});

test("isRuleWorthCommit: 이유를 담지 않은 제목만 뺀다 — docs:·ci:·chore:는 규칙 파일을 바꾸는 흔한 접두라 남긴다", async () => {
  const { isRuleWorthCommit } = await import("../src/core/rules.js");
  for (const subject of ["ci: security hardening for GitHub Actions workflows that call Claude (#1867)", "docs: clarify agent mode only works with workflow_dispatch", "chore: 규칙 추가", "refactor: unify action", "feat: 커밋 규칙"]) {
    assert.ok(isRuleWorthCommit(subject), subject);
  }
  for (const subject of ["Update CLAUDE.md", "update AGENTS.md", "Merge pull request #12 from x/y", "style: 공백 정리", "chore: release v1.2.0", "chore(deps): bump x", "Initial commit", "fix typo", "오타", "wip"]) {
    assert.ok(!isRuleWorthCommit(subject), subject);
  }
});

test("parseBlame: 같은 커밋의 둘째 묶음은 committer-time을 앞에서 받는다", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const out = [
    `${a} 1 1 1`,
    "committer-time 100",
    "summary one",
    "filename X",
    "\tline one",
    `${b} 2 2 1`,
    "committer-time 200",
    "filename X",
    "\tline two",
    `${a} 3 3`,
    "filename X",
    "\tline three",
  ].join("\n");
  const lines = parseBlame(out);
  assert.deepEqual([...lines.entries()], [
    [1, { sha: a, time: 100 }],
    [2, { sha: b, time: 200 }],
    [3, { sha: a, time: 100 }],
  ]);
});

test("unitsTouchedBy·unitsRemovedBy: 겹치는 규칙만, 짧은 낱말로는 걸지 않는다", () => {
  const { units } = parseRules(CLAUDE_V1);
  const [korean, merge, exports] = units;
  assert.deepEqual(unitsTouchedBy(units, "- 머지와 배포는 사용자가 말할 때만 한다\n"), [merge]);
  assert.deepEqual(unitsTouchedBy(units, "말할 때만"), [], "8자 미만의 조각은 단위 안에 있어도 걸지 않는다");
  assert.deepEqual(unitsTouchedBy(units, "사용자가 말할 때만 한다"), [merge], "단위 안의 긴 조각");
  assert.deepEqual(unitsTouchedBy(units, "- 커밋 제목은 한국어로 쓴다\n- 머지와 배포는 사용자가 말할 때만 한다"), [korean, merge], "두 단위에 걸친 편집");
  assert.deepEqual(unitsTouchedBy(units, "## Commits"), [], "제목만 고치면 규칙이 아니다");
  assert.deepEqual(unitsTouchedBy(units, "the"), []);
  // 실제 레포에서 놓친 꼴: 목록 기호로 시작해 줄 중간에서 끝나는 편집
  assert.deepEqual(unitsTouchedBy(units, "- 머지와 배포는 사용자가"), [merge]);
  assert.deepEqual(unitsTouchedBy(units, "* 커밋 제목은 한국어로"), [korean], "다른 목록 기호여도");
  assert.deepEqual(unitsRemovedBy(units, CLAUDE_V1.replace("Default export는 쓰지 않는다. 이름 있는 export만.\n", "")), [exports]);
  assert.deepEqual(unitsRemovedBy(units, CLAUDE_V1.replace(/\n/g, "\r\n")), [], "줄 끝만 바뀌면 사라진 규칙은 없다");
});

test("규칙 색인: 출처는 지금 글자를 쓴 커밋(줄들 중 가장 이른 것), 최근 변경은 가장 늦은 것, 공백만 바꾼 커밋은 건너뛴다 (§5-1)", async () => {
  const db = memoryDb();
  const dir = ruledRepo();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const [c1, c2] = [sha(dir, "HEAD~3"), sha(dir, "HEAD~2")];
  const label = (value: string) => (value === c1 ? "c1" : value === c2 ? "c2" : value);
  const rows = db.prepare("SELECT path, line, end_line, heading, text, origin_sha, last_sha FROM rules WHERE repo_id = ? ORDER BY path, line").all(repo.id) as {
    path: string;
    line: number;
    heading: string;
    text: string;
    origin_sha: string;
    last_sha: string;
  }[];
  assert.deepEqual(
    rows.map((row) => [row.path, row.line, row.heading, label(row.origin_sha), label(row.last_sha)]),
    [
      [".claude/rules/tests.md", 6, "", sha(dir, "HEAD"), sha(dir, "HEAD")],
      ["CLAUDE.md", 4, "Project rules > Commits", "c1", "c1"],
      ["CLAUDE.md", 5, "Project rules > Commits", "c1", "c1"],
      // 한 줄짜리 규칙을 c2가 고쳐 썼다 — 지금 글자를 쓴 커밋은 c2다. 그 앞(c1)까지 거슬러 가지 않는다(rules.ts blameLines)
      ["CLAUDE.md", 8, "Project rules > Code", "c2", "c2"],
    ],
  );
  const files = db.prepare("SELECT path, scope FROM rule_files WHERE repo_id = ? ORDER BY path").all(repo.id) as { path: string; scope: string }[];
  assert.deepEqual(files, [
    { path: ".claude/rules/tests.md", scope: "**/*.test.ts" },
    { path: "CLAUDE.md", scope: "" },
  ], "docs/rules.md·claude.md.bak은 규칙 파일이 아니다");
});

test("규칙 검색: 규칙의 낱말로 찾으면 상위 3개 안에, 들여온 커밋·바꾼 커밋과 함께 (§5-2)", async () => {
  const db = memoryDb();
  const dir = ruledRepo();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const [c1, c2] = [sha(dir, "HEAD~3"), sha(dir, "HEAD~2")];

  const top = search(db, "default export", { limit: 3 }).hits;
  const hit = top.find((item) => item.kind === "rule");
  assert.ok(hit, `규칙이 상위 3개에 없습니다: ${top.map((item) => `${item.kind}:${item.ref}`).join(", ")}`);
  assert.equal(hit.ref, "CLAUDE.md:8");
  assert.equal(hit.rule?.origin?.sha, c2);
  assert.match(hit.rule!.origin!.subject, /import 이름이 갈라졌다/);
  assert.equal(hit.rule?.changed, null, "출처와 최근 변경이 같으면 changed는 없다");
  assert.equal(search(db, "머지와 배포", { kind: "rule" }).hits[0].rule?.origin?.sha, c1);

  // 들여온 커밋의 말로 물어도 걸린다
  assert.ok(search(db, "커밋 규칙을 정한다", { kind: "rule" }).hits.length >= 3);
  // MCP 결과 꼴
  const slim = slimSearch(search(db, "모킹", { kind: "rule" }), []) as unknown as { hits: Record<string, string>[] };
  assert.deepEqual(Object.keys(slim.hits[0]).sort(), ["added", "repo", "rule", "scope", "text"]);
  assert.equal(slim.hits[0].rule, ".claude/rules/tests.md:6");
  assert.equal(slim.hits[0].scope, "**/*.test.ts");
  assert.match(slim.hits[0].added, /^[0-9a-f]{10} 2026-04-01 feat: 테스트 규칙$/);
  // kind=rule은 도구 스키마에도, 인자로도
  assert.ok((TOOLS.find((tool) => tool.name === "search_memory")!.inputSchema.properties.kind.enum as readonly string[]).includes("rule"));
  const viaTool = (await callTool({ db, me: [], cwd: dir }, "search_memory", { query: "모킹", kind: "rule" })) as { hits: { rule?: string }[] };
  assert.equal(viaTool.hits[0].rule, ".claude/rules/tests.md:6");
});

test("규칙 색인은 규칙 파일이 바뀐 동기화에서만 blame한다 (§5-3), 지운 규칙 파일은 색인에서도 빠진다", async () => {
  const db = memoryDb();
  const dir = ruledRepo();
  const repo = await addRepo(db, dir);
  const before = blameStats.calls;
  await syncRepo(db, repo);
  assert.equal(blameStats.calls - before, 2, "규칙 파일 둘만 blame (docs/rules.md·claude.md.bak은 아님)");

  const idle = blameStats.calls;
  await syncRepo(db, repo);
  assert.equal(blameStats.calls, idle, "바뀐 것 없는 재동기화는 blame 0번");
  addCommit(dir, { message: "feat: 코드만 바꿈", files: { "src/a.ts": "export const a = 2;\n" } });
  await syncRepo(db, repo);
  assert.equal(blameStats.calls, idle, "트리가 바뀌어도 규칙 파일 blob이 그대로면 blame 0번");
  addCommit(dir, { message: "feat: 규칙 하나 더", files: { "CLAUDE.md": `${CLAUDE_V1}- 로그는 stderr로만 쓴다\n` } });
  await syncRepo(db, repo);
  assert.equal(blameStats.calls, idle + 1, "바뀐 규칙 파일 하나만");

  fs.rmSync(path.join(dir, ".claude"), { recursive: true });
  addCommit(dir, { message: "feat: 테스트 규칙을 뺀다", files: {} });
  await syncRepo(db, repo);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM rules WHERE repo_id = ? AND path LIKE '.claude/%'").get(repo.id) as { n: number }).n, 0);
  assert.equal(search(db, "모킹", { kind: "rule" }).hits.length, 0, "지운 규칙 파일의 검색 문서도 빠진다");
  // grimoire는 규칙 파일을 쓰지 않는다 (§5-5)
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
});

function editRule(repoPath: string, oldString: string, session = "r1", file = "CLAUDE.md"): HookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: session,
    cwd: repoPath,
    tool_name: "Edit",
    tool_input: { file_path: path.join(repoPath, file), old_string: oldString, new_string: "x" },
  };
}

test("훅: 규칙 파일을 고치기 직전, 바꾸는 규칙의 출처 커밋을 한 줄로 — 규칙이 아닌 곳·이유 없는 출처·같은 세션 두 번째는 조용하다 (§5-4)", async () => {
  const db = memoryDb();
  const dir = ruledRepo();
  // 반례: 이 커밋의 날짜(addCommit 기본 2024-03-01)는 부모보다 이르다 — rebase·cherry-pick 뒤와 같다. 출처는 날짜가 아니라 이력 순서로 고른다
  addCommit(dir, { message: "Update CLAUDE.md", files: { "CLAUDE.md": `${CLAUDE_V1.replace("이름 있는 export만.", "이름 있는 export만 쓴다.")}- 로그는 stderr로만 쓴다\n` } });
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const env = { GRIMOIRE_HOME: tempDir("grimoire-rule-hook-") };
  const context = { db, env, me: [] };
  const c1 = sha(dir, "HEAD~4");

  const out = await handleHook(context, editRule(repo.path, "- 머지와 배포는 사용자가 말할 때만 한다"));
  const text = out!.json!.hookSpecificOutput.additionalContext;
  assert.equal(
    text,
    `Grimoire: CLAUDE.md — the rules you're changing came from:\nL5 "머지와 배포는 사용자가 말할 때만 한다" ← ${c1.slice(0, 10)} 2026-01-01 "feat: 커밋·코드 규칙을 정한다"`,
  );
  assert.equal(await handleHook(context, editRule(repo.path, "- 머지와 배포는 사용자가 말할 때만 한다")), null, "같은 세션·같은 규칙은 한 번");
  assert.ok(await handleHook(context, editRule(repo.path, "- 머지와 배포는 사용자가 말할 때만 한다", "r2")), "다른 세션은 다시");
  assert.equal(await handleHook(context, editRule(repo.path, "## Commits", "r3")), null, "규칙이 아닌 곳");
  assert.equal(await handleHook(context, editRule(repo.path, "- 로그는 stderr로만 쓴다", "r4")), null, "출처 제목이 이유를 담지 않으면(GitHub 웹 편집기 기본값) 말하지 않는다");

  // Write: 새 내용에서 사라지는 규칙만
  const write = await handleHook(context, {
    ...editRule(repo.path, "", "r5"),
    tool_name: "Write",
    tool_input: { file_path: path.join(repo.path, "CLAUDE.md"), content: CLAUDE_V1.replace("## Code\nDefault export는 쓰지 않는다. 이름 있는 export만.\n", "") },
  });
  const written = write!.json!.hookSpecificOutput.additionalContext;
  assert.match(written, /^Grimoire: CLAUDE\.md — the rules you're changing came from:\nL8 "Default export는 쓰지 않는다\. 이름 있는 export만 쓴다\." ← [0-9a-f]{10} 2026-02-01 "fix: default export 때문에/);
  assert.ok(!written.includes("L4") && !written.includes("L5"), "남는 규칙은 말하지 않는다");
  // MultiEdit
  const multi = await handleHook(context, {
    ...editRule(repo.path, "", "r6"),
    tool_name: "MultiEdit",
    tool_input: { file_path: path.join(repo.path, "CLAUDE.md"), edits: [{ old_string: "커밋 제목은 한국어로 쓴다", new_string: "x" }] },
  });
  // 마지막 chore 커밋이 공백을 되돌렸지만(-w로 건너뜀) 출처는 c1 그대로다
  assert.match(multi!.json!.hookSpecificOutput.additionalContext, new RegExp(`\nL4 "커밋 제목은 한국어로 쓴다" ← ${c1.slice(0, 10)} 2026-01-01 `));
  // 규칙 파일이 아닌 .md는 지금처럼 아무것도
  assert.equal(await handleHook(context, editRule(repo.path, "- 이건 규칙 파일이 아니다 그냥 문서", "r7", "docs/rules.md")), null);
});

test("규칙 파일에 묶인 노트: 본문에 경로만 적어도 묶이고, 규칙 파일이 바뀌면 stale, 그 파일을 고치기 직전에 보인다 (§5-6)", async () => {
  const db = memoryDb();
  const dir = ruledRepo();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const note = addNote(db, { text: "결정: CLAUDE.md의 배포 규칙은 릴리스 PR 머지로만\n사람이 머지한다", repoId: repo.id, source: "cli" });
  assert.deepEqual(JSON.parse(note.paths).map((item: { path: string; blob: string | null }) => [item.path, typeof item.blob]), [["CLAUDE.md", "string"]]);
  assert.equal(notesForFile(db, repo.id, "CLAUDE.md")[0].stale, false);

  const env = { GRIMOIRE_HOME: tempDir("grimoire-rule-note-") };
  const shown = await handleHook({ db, env, me: [] }, editRule(repo.path, "## Commits", "n1"));
  assert.equal(
    shown!.json!.hookSpecificOutput.additionalContext,
    `Grimoire: CLAUDE.md\nNotes on this file (update any this change makes wrong): #${note.id} "결정: CLAUDE.md의 배포 규칙은 릴리스 PR 머지로만"`,
  );

  addCommit(dir, { message: "feat: 배포 규칙을 바꾼다", files: { "CLAUDE.md": CLAUDE_V1.replace("사용자가 말할 때만", "CI가 초록일 때") } });
  await syncRepo(db, repo);
  assert.equal(notesForFile(db, repo.id, "CLAUDE.md")[0].stale, true, "규칙이 바뀌면 그 규칙에 대한 노트는 오래됐다고 표시된다");
});

test("업그레이드: 스키마 12 DB가 열리고, 트리가 그대로여도 다음 동기화가 규칙을 채운다 (§5-8)", async () => {
  const file = path.join(tempDir("grimoire-upgrade-"), "grimoire.db");
  const dir = ruledRepo();
  let db = openDb(file);
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  // 0.11.x 상태로 되돌린다 — 규칙 표와 칸이 없고 user_version 12
  db.exec(
    "DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE kind = 'rule'); DELETE FROM docs WHERE kind = 'rule'; DROP TABLE rules; DROP TABLE rule_files; ALTER TABLE repos DROP COLUMN rules_version;",
  );
  db.pragma("user_version = 12");
  db.close();

  db = openDb(file);
  assert.equal(db.pragma("user_version"), 13);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM rules").get() as { n: number }).n, 0);
  const result = await syncRepo(db, repo);
  assert.equal(result.added, 0, "새 커밋은 없다 — 트리도 그대로");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM rules").get() as { n: number }).n, 4);
  assert.equal(search(db, "모킹", { kind: "rule" }).hits.length, 1);
  db.close();
});
