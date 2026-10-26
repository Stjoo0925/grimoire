import assert from "node:assert/strict";
import { test } from "node:test";

import { extractSymbols, headerComment, isIndexable, splitIdentifier } from "../src/core/code";
import { DiffParser } from "../src/core/diffs";
import { addRepo, syncRepo } from "../src/core/indexer";
import { buildMatchExpression, search } from "../src/core/search";
import { addCommit, git, makeRepo, memoryDb } from "./helpers";

test("extractSymbols: 언어별 선언과 라우트를 줄 번호와 함께", () => {
  const ts = [
    'import x from "y";',
    "export interface SwipeChoices {",
    "}",
    "export function resolveConflict(a, b) {",
    "  return a;",
    "}",
    "export const rateLimit = async (req) => {};",
    "class Store {}",
    'router.post("/api/invite", handler);',
  ].join("\n");
  assert.deepEqual(extractSymbols(ts), [
    { name: "SwipeChoices", line: 2 },
    { name: "resolveConflict", line: 4 },
    { name: "rateLimit", line: 7 },
    { name: "Store", line: 8 },
    { name: "POST /api/invite", line: 9 },
  ]);
  assert.deepEqual(extractSymbols("def resize(img):\n    pass\nclass Cache:\n  pass"), [
    { name: "resize", line: 1 },
    { name: "Cache", line: 3 },
  ]);
  assert.deepEqual(extractSymbols("func (s *Server) Handle() {}\ntype Config struct {}"), [
    { name: "Handle", line: 1 },
    { name: "Config", line: 2 },
  ]);
});

test("extractSymbols: 공백만 긴 줄에서 정규식이 폭주하지 않고, 수정자 붙은 선언은 그대로 뽑는다", () => {
  // 예전 Java·Kotlin 패턴은 공백 399자 줄 하나에 ~10ms(O(n³) 백트래킹)였다 — 400줄이면 4초
  for (const tail of ["", "x", "{"]) {
    const content = Array.from({ length: 400 }, () => " ".repeat(399) + tail).join("\n");
    const started = performance.now();
    assert.deepEqual(extractSymbols(content), []);
    const ms = performance.now() - started;
    assert.ok(ms < 200, `공백 줄 400개(${JSON.stringify(tail)})에 ${Math.round(ms)}ms`);
  }
  assert.deepEqual(
    extractSymbols(
      [
        "public final class OrderService {",
        "  private static  final class Inner {}",
        "data class Point(val x: Int)",
        "    override suspend fun load() {}",
        "fun main() {}",
        "internal object Registry",
        "export default async function* stream() {}",
        "function * gen() {}",
      ].join("\n"),
    ),
    [
      { name: "OrderService", line: 1 },
      { name: "Inner", line: 2 },
      { name: "Point", line: 3 },
      { name: "load", line: 4 },
      { name: "Registry", line: 6 },
      { name: "stream", line: 7 },
      { name: "gen", line: 8 },
    ],
  );
});

test("splitIdentifier / headerComment / isIndexable", () => {
  assert.equal(splitIdentifier("requireFirestoreRateLimit"), "require firestore rate limit");
  assert.equal(splitIdentifier("services/api/conflict-resolver.ts"), "services api conflict resolver ts");
  assert.equal(splitIdentifier("HTTPServer_v2"), "http server v2");
  assert.equal(headerComment("/**\n * 초대 코드 발급\n * 6자리\n */\nexport const a = 1;"), "초대 코드 발급 6자리");
  assert.equal(headerComment("// 결제 웹훅\n// 서명 검증\nimport x"), "결제 웹훅 서명 검증");
  assert.equal(headerComment('"use client";\nimport x'), "");
  assert.equal(isIndexable("src/a.ts", 100), true);
  assert.equal(isIndexable("node_modules/a/index.js", 100), false);
  assert.equal(isIndexable("README.md", 100), false);
  assert.equal(isIndexable("src/big.ts", 10_000_000), false);
});

test("한국어 질의가 영어 식별자에 닿는다 (사전 확장)", () => {
  const expr = buildMatchExpression("요청 횟수 제한하는 부분")!;
  for (const term of ["request", "rate", "limit"]) assert.match(expr, new RegExp(`"${term}"\\*`));
});

test("현재 코드 색인: 파일·심볼:줄로 핀포인트, 바뀐 파일만 다시 읽고 지운 파일은 뺀다", async () => {
  const db = memoryDb();
  const dir = makeRepo(
    [
      {
        message: "feat: 선택 충돌 정리",
        files: {
          "src/lib/conflict-resolver.ts": "export interface Choices {}\nexport function resolveConflict() {}\n",
          "src/lib/rate-limit.ts": "export async function requireRateLimit() {}\n",
          "README.md": "# docs",
        },
      },
    ],
    "couple",
  );
  const repo = await addRepo(db, dir);
  const first = await syncRepo(db, repo);
  assert.equal(first.files, 2); // README.md는 소스가 아님

  const conflict = await search(db, "두 사람 선택이 충돌할 때", { kind: "file" });
  assert.equal(conflict.hits[0]?.ref, "src/lib/conflict-resolver.ts");
  assert.ok(conflict.hits[0]?.symbols?.includes("resolveConflict:2"), String(conflict.hits[0]?.symbols));
  assert.equal(conflict.hits[0]?.lastCommit?.title, "feat: 선택 충돌 정리");

  const limit = await search(db, "요청 횟수 제한", { kind: "file" });
  assert.equal(limit.hits[0]?.ref, "src/lib/rate-limit.ts");

  // 바뀐 파일만 다시 읽는다
  assert.equal((await syncRepo(db, repo)).files, 0);
  addCommit(dir, { message: "refactor: 리졸버 정리", files: { "src/lib/conflict-resolver.ts": "export function mergeChoices() {}\n" } });
  assert.equal((await syncRepo(db, repo)).files, 1);
  const renamed = await search(db, "merge choices", { kind: "file" });
  assert.deepEqual(renamed.hits[0]?.symbols, ["mergeChoices:1"]);

  // 지운 파일은 색인에서 빠진다
  git(dir, ["rm", "-q", "src/lib/rate-limit.ts"]);
  git(dir, ["commit", "-q", "-m", "chore: 제거"], { GIT_AUTHOR_NAME: "me", GIT_AUTHOR_EMAIL: "me@example.com", GIT_COMMITTER_NAME: "me", GIT_COMMITTER_EMAIL: "me@example.com" });
  await syncRepo(db, repo);
  assert.equal((await search(db, "rate limit", { kind: "file" })).hits.length, 0);
});

test("DiffParser: 바뀐 줄·hunk 머리의 선언 이름을 커밋별로, 소스 파일만", () => {
  const parser = new DiffParser();
  const lines = [
    "\x1eaaa",
    "",
    "diff --git a/src/rate-limit.ts b/src/rate-limit.ts",
    "--- a/src/rate-limit.ts",
    "+++ b/src/rate-limit.ts",
    "@@ -10,0 +11,3 @@ export function requireRateLimit(req) {",
    "+export function resetBucket(key: string) {",
    "++++ not a header, just content",
    "-const oldLimiter = () => 1;",
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "+function fromLockfile() {}",
    "\x1ebbb",
    "",
    "diff --git a/gone.py b/gone.py",
    "--- a/gone.py",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-def legacy_handler():",
  ];
  for (const line of lines) parser.line(line);
  parser.flush();
  assert.deepEqual(
    parser.done.map((item) => item.symbols),
    [[{ file: "src/rate-limit.ts", names: ["requireRateLimit", "resetBucket", "oldLimiter"] }], [{ file: "gone.py", names: ["legacy_handler"] }]],
  );
  assert.match(parser.done[0].words, /\breset\b.*\bbucket\b/);
  assert.doesNotMatch(parser.done[0].words, /lockfile/);
});
