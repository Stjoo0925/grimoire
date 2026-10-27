import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  cochangeOf,
  evaluateCochange,
  extractImports,
  fileContext,
  formatFileContext,
  isCochangeCommit,
  namedTests,
  rebuildCochange,
  HOOK_BUDGET,
} from "../src/core/context";
import { addRepo, relativeToRepo, syncRepo } from "../src/core/indexer";
import { callTool } from "../src/mcp/tools";
import { addCommit, makeRepo, memoryDb, type FakeCommit } from "./helpers";

/** search.ts와 db.ts가 늘 같이 바뀌고, search.test.ts도 따라 바뀌는 레포 */
function coupledRepo() {
  const search = (n: number) => `import { open } from "./db";\nexport function search${n}() { return open(); }\n`;
  const commits: FakeCommit[] = [
    {
      message: "feat: 프로젝트 시작",
      files: { "src/db.ts": "export function open() {}\n", "src/search.ts": search(0), "src/cli.ts": 'import { search0 } from "./search";\n' },
      date: "2024-01-01T10:00:00+09:00",
    },
  ];
  for (let i = 1; i <= 5; i++) {
    commits.push({
      message: i % 2 ? `feat(search): 개선 ${i}` : `fix(search): 버그 ${i} 수정`,
      files: { "src/search.ts": search(i), "src/db.ts": `export function open() { return ${i}; }\n`, "tests/search.test.ts": `// ${i}\n` },
      date: `2024-0${i + 1}-01T10:00:00+09:00`,
    });
  }
  // 혼자 바뀌는 파일 하나, 대량 커밋 하나(제외돼야 함)
  commits.push({ message: "docs: readme", files: { "README.md": "# hi\n" }, date: "2024-07-02T10:00:00+09:00" });
  const bulk: Record<string, string> = { "src/search.ts": search(9) };
  for (let i = 0; i < 12; i++) bulk[`src/gen/${i}.ts`] = `export const g${i} = ${i};\n`;
  commits.push({ message: "refactor: 대량 이동", files: bulk, date: "2024-07-03T10:00:00+09:00" });
  return makeRepo(commits, "coupled");
}

test("isCochangeCommit: 머지·대량·단일 파일 커밋은 거래가 아니다", () => {
  assert.equal(isCochangeCommit("feat: a", ["a", "b"], true), true);
  assert.equal(isCochangeCommit("feat: a", ["a"], true), false);
  assert.equal(isCochangeCommit("Merge branch 'x'", ["a", "b"], true), false);
  assert.equal(isCochangeCommit("feat: a", Array.from({ length: 11 }, (_, i) => `f${i}`), true), false);
  assert.equal(isCochangeCommit("chore: x", ["a", "b"], false), false);
});

test("extractImports: 상대 import만 레포 안 경로로 푼다", () => {
  const known = new Set(["src/core/db.ts", "src/core/index.ts", "src/mcp/tools.ts", "pkg/__init__.py", "pkg/util.py", "pkg/sub/__init__.py", "pkg/sub/mod.py"]);
  const ts = extractImports(
    "src/mcp/tools.ts",
    `import { openDb } from "../core/db";\nimport x from "../core";\nimport fs from "node:fs";\nconst y = require("../core/db.js");\nimport("./tools");\n`,
    known,
  );
  assert.deepEqual(ts.sort(), ["src/core/db.ts", "src/core/index.ts"]);
  // `from . import x`는 같은 패키지(pkg/sub), `from ..util`·`from pkg.util`은 둘 다 pkg/util.py
  const py = extractImports("pkg/sub/mod.py", "from ..util import f\nfrom . import x\nimport os\nfrom pkg.util import g\n", known);
  assert.deepEqual(py.sort(), ["pkg/sub/__init__.py", "pkg/util.py"]);
  assert.deepEqual(extractImports("README.md", 'import "./x"', known), []);
});

test("공변경: 증분 집계 → 신뢰도 필터·최근순, 테스트 파일은 tests로, 대량 커밋은 제외", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);

  const related = cochangeOf(db, repo.id, "src/search.ts");
  // db.ts와 search.test.ts가 5/5(첫 커밋은 search.ts와 db.ts·cli.ts 3개라 db.ts는 6/6)
  const db_ = related.find((item) => item.path === "src/db.ts");
  assert.ok(db_, "db.ts가 공변경에 없음");
  assert.equal(db_!.support, 6);
  assert.equal(db_!.strong, true);
  assert.equal(db_!.imports, true, "import 이웃 표시");
  assert.ok(!related.some((item) => item.path.startsWith("src/gen/")), "대량 커밋의 파일이 섞였습니다");
  // cli.ts는 첫 커밋에만 같이 바뀌어 1/6 — 지지도·신뢰도 문턱 아래
  assert.ok(!related.some((item) => item.path === "src/cli.ts"));

  const context = fileContext(db, repo.id, "src/search.ts");
  assert.equal(context.worth, true);
  assert.deepEqual(context.related.map((item) => item.path), ["src/db.ts"]);
  assert.equal(context.tests[0]?.path, "tests/search.test.ts");
  assert.equal(context.tests[0]?.by, "name");
  assert.equal(context.recent.length, 3);
  assert.equal(context.why, null);

  // 혼자 바뀐 파일 — 줄 것이 없다
  const alone = fileContext(db, repo.id, "README.md");
  assert.equal(alone.worth, false);
  assert.equal(formatFileContext(alone), "");

  // 새 커밋이 들어오면 증분으로 더해진다 (다시 만들지 않고)
  addCommit(repo.path, { message: "feat: 또 하나", files: { "src/search.ts": "export const z = 1;\n", "src/db.ts": "export const q = 1;\n" }, date: "2024-08-01T10:00:00+09:00" });
  await syncRepo(db, repo);
  assert.equal(cochangeOf(db, repo.id, "src/search.ts").find((item) => item.path === "src/db.ts")?.support, 7);

  // 다시 만들어도 같다
  rebuildCochange(db, repo.id);
  assert.equal(cochangeOf(db, repo.id, "src/search.ts").find((item) => item.path === "src/db.ts")?.support, 7);
});

test("namedTests: foo.ts ↔ foo.test.ts / test_foo.py / foo_test.go", async () => {
  const db = memoryDb();
  const repo = await addRepo(
    db,
    makeRepo(
      [
        {
          message: "feat: 테스트 짝",
          files: {
            "src/a.ts": "export const a = 1;\n",
            "src/a.test.ts": "// t\n",
            "lib/b.py": "x = 1\n",
            "tests/test_b.py": "# t\n",
            "pkg/c.go": "package pkg\n",
            "pkg/c_test.go": "package pkg\n",
            "src/index.ts": "export {}\n",
          },
          date: "2024-01-01T10:00:00+09:00",
        },
      ],
      "named",
    ),
  );
  await syncRepo(db, repo);
  assert.deepEqual(namedTests(db, repo.id, "src/a.ts"), ["src/a.test.ts"]);
  assert.deepEqual(namedTests(db, repo.id, "lib/b.py"), ["tests/test_b.py"]);
  assert.deepEqual(namedTests(db, repo.id, "pkg/c.go"), ["pkg/c_test.go"]);
  assert.deepEqual(namedTests(db, repo.id, "src/index.ts"), []);
  assert.deepEqual(namedTests(db, repo.id, "src/a.test.ts"), []);
});

test("formatFileContext: Key: value 한 줄 한 사실, 예산을 넘으면 뒤에서부터 뺀다", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const text = formatFileContext(fileContext(db, repo.id, "src/search.ts"), { me: ["me@example.com"], first: true });
  const lines = text.split("\n");
  assert.equal(lines[0], "Grimoire: src/search.ts");
  assert.match(lines[1], /^Recent: [0-9a-f]{10} \d\d-\d\d me "/);
  assert.ok(lines.some((line) => line.startsWith("Co-changes: src/db.ts (6/6, strong, imports)")), text);
  assert.ok(lines.some((line) => line === "Tests: tests/search.test.ts"), text);
  assert.ok(lines.at(-1)!.startsWith("These are candidates"), text);
  assert.ok(text.length <= HOOK_BUDGET, `${text.length}자`);
  assert.ok(!text.includes("#") && !text.includes("|"), "마크다운 없음");
  // 예산을 아주 작게 주면 머리·Recent만 남는다
  const tiny = formatFileContext(fileContext(db, repo.id, "src/search.ts"), { budget: 120 });
  assert.equal(tiny.split("\n").length, 2);
});

test("file_context 도구: 상대·절대 경로, worth=false면 recent만", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const context = { db, me: ["me@example.com"], cwd: repo.path };
  const result = (await callTool(context, "file_context", { path: "src/search.ts", repo: "coupled" })) as Record<string, unknown>;
  assert.deepEqual(result.cochanges, ["src/db.ts 6/6 strong imports"]);
  assert.deepEqual(result.tests, ["tests/search.test.ts"]);
  assert.ok(JSON.stringify(result).length < 600, `${JSON.stringify(result).length}자`);
  const absolute = (await callTool(context, "file_context", { path: `${repo.path}/README.md` })) as Record<string, unknown>;
  assert.equal(absolute.worth, false);
  assert.equal(absolute.file, "README.md");
});

test("evaluateCochange: 시간 분할 평가가 돌고 표를 원상복구한다", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, coupledRepo());
  await syncRepo(db, repo);
  const before = cochangeOf(db, repo.id, "src/search.ts").find((item) => item.path === "src/db.ts")?.support;
  const result = evaluateCochange(db, repo.id, 0.5);
  // 커밋이 10개 미만이면 null — 픽스처는 8개
  assert.equal(result, null);
  for (let i = 0; i < 4; i++) {
    addCommit(repo.path, { message: `feat: 더 ${i}`, files: { "src/search.ts": `// ${i}\n`, "src/db.ts": `// ${i}\n` }, date: `2024-09-0${i + 1}T10:00:00+09:00` });
  }
  await syncRepo(db, repo);
  const evaluated = evaluateCochange(db, repo.id, 0.5);
  assert.ok(evaluated && evaluated.queries > 0, JSON.stringify(evaluated));
  assert.equal(evaluated!.l3, 1, "뒷부분 커밋은 전부 search↔db라 L3=1");
  assert.equal(cochangeOf(db, repo.id, "src/search.ts").find((item) => item.path === "src/db.ts")?.support, (before ?? 0) + 4);
});

test("relativeToRepo: 레포 안 Claude Code worktree의 파일은 레포 기준 경로로", () => {
  const repo = path.resolve(path.sep, "w", "grimoire");
  assert.equal(relativeToRepo(repo, path.join(repo, "src", "a.ts")), "src/a.ts");
  assert.equal(relativeToRepo(repo, path.join(repo, ".claude", "worktrees", "x-1", "src", "a.ts")), "src/a.ts");
  assert.equal(relativeToRepo(repo, "src/b.ts"), "src/b.ts");
});

test("shortSubject: 넘칠 때 PR 번호부터 떼고, 그래도 넘치면 자른다 — 번호 중간에서 잘리지 않게", async () => {
  const { shortSubject } = await import("../src/core/context.js");
  assert.equal(shortSubject("fix: 짧음 (#12)", 60), "fix: 짧음 (#12)");
  assert.equal(shortSubject("feat: 편집 직전 훅·커밋에 묶인 왜·공변경 (#17)", 30), "feat: 편집 직전 훅·커밋에 묶인 왜·공변경");
  const cut = shortSubject("feat: 편집 직전 훅·커밋에 묶인 왜·공변경·작업 완수 벤치 — 에이전트 코딩 강화 (P0~P4) (#17)", 40);
  assert.ok(cut.length <= 40 && cut.endsWith("…") && !cut.includes("(#"), cut);
});
