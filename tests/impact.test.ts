import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildQueries, meanScore, parseLog, scoreQuery } from "../e2e/impactbench";
import { extractImports } from "../src/core/context";
import { formatImpact, impactOf, workingChanges } from "../src/core/impact";
import { addRepo, syncRepo } from "../src/core/indexer";
import { addNote } from "../src/core/notes";
import { callTool } from "../src/mcp/tools";
import { git, makeRepo, memoryDb, type FakeCommit } from "./helpers";

/**
 * api.ts ← handler.ts ← route.ts (import 사슬), api.ts는 schema.sql과 늘 같이 바뀐다(import 없음 — 이력에만 있는 결합),
 * api.test.ts는 이름 짝, 같은 폴더에 아무 관계 없는 lonely.ts.
 */
function sampleRepo() {
  const commits: FakeCommit[] = [
    {
      message: "feat: 시작",
      files: {
        "src/api.ts": "export function api() {}\n",
        "src/handler.ts": 'import { api } from "./api";\nexport const handler = api;\n',
        "src/route.ts": 'import { handler } from "./handler";\nexport const route = handler;\n',
        "src/lonely.ts": "export const lonely = 1;\n",
        "src/api.test.ts": "// test\n",
        "db/schema.sql": "create table a(id int);\n",
      },
      date: "2024-01-01T10:00:00+09:00",
    },
  ];
  for (let i = 1; i <= 4; i++) {
    commits.push({
      message: `feat(api): 컬럼 ${i}`,
      files: { "src/api.ts": `export function api() { return ${i}; }\n`, "db/schema.sql": `create table a(id int, c${i} int);\n` },
      date: `2024-0${i + 1}-01T10:00:00+09:00`,
    });
  }
  return makeRepo(commits, "impact");
}

async function indexed() {
  const dir = sampleRepo();
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  return { db, repo, dir };
}

test("impactOf: import 이웃·2홉·공변경·이름 짝 테스트를 근거와 함께 순위 매긴다", async () => {
  const { db, repo } = await indexed();
  const impact = impactOf(db, repo.id, ["src/api.ts"], { noteFiles: 0 });
  const by = Object.fromEntries(impact.items.map((item) => [item.path, item]));
  // 공변경 5/5(시작 커밋 포함)가 가장 세다 — import 그래프로는 못 찾는 결합
  assert.equal(impact.items[0].path, "db/schema.sql");
  assert.match(by["db/schema.sql"].reasons[0].detail, /co-changed with src\/api\.ts 5× \(100%\)/);
  assert.deepEqual(by["src/handler.ts"].reasons.map((reason) => reason.source).sort(), ["dir", "import"]);
  assert.equal(by["src/route.ts"].reasons.some((reason) => reason.source === "import2"), true, "2홉 이웃");
  assert.equal(by["src/api.test.ts"].test, true);
  // 같은 폴더뿐인 파일은 가장 약하다
  assert.equal(impact.items.at(-1)?.path === "src/lonely.ts" || by["src/lonely.ts"].score < by["src/handler.ts"].score, true);
  assert.equal(impact.items.some((item) => item.path === "src/api.ts"), false, "바뀐 파일 자신은 빠진다");
});

test("impactOf: 근거를 골라 끌 수 있고, 여러 파일의 근거는 noisy-OR로 합친다", async () => {
  const { db, repo } = await indexed();
  const importOnly = impactOf(db, repo.id, ["src/api.ts"], { sources: ["import"], noteFiles: 0 });
  assert.deepEqual(importOnly.items.map((item) => item.path), ["src/handler.ts"]);
  // route.ts는 handler.ts를 바꾸면 1홉, api.ts를 바꾸면 2홉 — 둘 다 바꾸면 근거가 둘이라 점수가 오른다
  const one = impactOf(db, repo.id, ["src/handler.ts"], { sources: ["import", "import2"], noteFiles: 0 }).items.find((item) => item.path === "src/route.ts")!;
  const both = impactOf(db, repo.id, ["src/handler.ts", "src/api.ts"], { sources: ["import", "import2"], noteFiles: 0 }).items.find((item) => item.path === "src/route.ts")!;
  assert.ok(both.score > one.score);
  assert.equal(both.reasons.length, 2);
});

test("impactOf: 바뀐 파일과 상위 영향 파일에 묶인 노트를 모은다", async () => {
  const { db, repo } = await indexed();
  addNote(db, { text: "스키마는 마이그레이션으로만 바꾼다\n본문", repoId: repo.id, paths: ["db/schema.sql"], source: "cli" });
  const impact = impactOf(db, repo.id, ["src/api.ts"]);
  assert.equal(impact.notes.length, 1);
  assert.equal(impact.notes[0].path, "db/schema.sql");
  assert.match(formatImpact(impact), /Notes: #\d+ db\/schema\.sql "스키마는 마이그레이션으로만 바꾼다"/);
});

test("workingChanges·impact 도구: 경로를 안 주면 커밋 안 된 변경(새 파일 포함)을 쓴다", async () => {
  const { db, repo, dir } = await indexed();
  fs.writeFileSync(path.join(dir, "src", "api.ts"), "export function api() { return 9; }\n");
  fs.writeFileSync(path.join(dir, "src", "new.ts"), "export const n = 1;\n");
  assert.deepEqual((await workingChanges(path.join(dir, "src"))).sort(), ["src/api.ts", "src/new.ts"]);

  const result = (await callTool({ db, me: [], cwd: dir }, "impact", { repo: repo.name })) as { changed: string[]; impact: string[] };
  assert.deepEqual(result.changed.sort(), ["src/api.ts", "src/new.ts"]);
  assert.match(result.impact[0], /^\d\.\d\d db\/schema\.sql — co-changed/);
  const explicit = (await callTool({ db, me: [], cwd: dir }, "impact", { paths: [path.join(dir, "src", "handler.ts")] })) as { changed: string[] };
  assert.deepEqual(explicit.changed, ["src/handler.ts"]);
  git(dir, ["checkout", "--", "."]);
});

test("extractImports: 경로 별칭(@/·~/·@name/·baseUrl)을 가까운 조상 폴더에서 풀고, npm 패키지는 버린다", () => {
  const known = new Set(["web/components/ui/Button.tsx", "web/lib/x.ts", "shared/errors/codes.ts", "api/src/utils/a.ts", "api/src/common/index.ts"]);
  const web = extractImports(
    "web/app/admin/page.tsx",
    'import B from "@/components/ui/Button";\nimport x from "~/lib/x";\nimport c from "@shared/errors/codes";\nimport r from "react";\nimport n from "@nestjs/common";\n',
    known,
  );
  assert.deepEqual(web.sort(), ["shared/errors/codes.ts", "web/components/ui/Button.tsx", "web/lib/x.ts"]);
  // baseUrl식 — 조상 폴더 아래 src/에서도 찾는다. "lodash/fp"·"@nestjs/common"은 레포에 없어 버려진다
  assert.deepEqual(extractImports("api/src/x/y.ts", 'import a from "utils/a";\nimport f from "lodash/fp";\nimport n from "@nestjs/common";\n', known), ["api/src/utils/a.ts"]);
});

test("impactOf ref: import 문이 없는 언어도 정의-참조로 잇고, 형제 폴더의 같은 이름 파일을 잇는다", async () => {
  const commits: FakeCommit[] = [
    {
      message: "feat: 시작",
      files: {
        "App/Data/ReportDB.cs": "public class ReportDB {\n  public static string Load() { return PathConfig.Root; }\n}\n",
        "App/Conn/PathConfig.cs": "public class PathConfig {\n  public static string Root = \"/\";\n}\n",
        "App/Service.cs": "public class Service {\n  public void Run() { ReportDB.Load(); }\n}\n",
        "App/Other.cs": "public class Other {}\n",
        "web/app/login/layout.tsx": "export default function Layout() {}\n",
        "web/app/register/layout.tsx": "export default function Layout() {}\n",
        "web/app/login/page.tsx": "export default function Page() {}\n",
      },
      date: "2024-01-01T10:00:00+09:00",
    },
  ];
  const db = memoryDb();
  const repo = await addRepo(db, makeRepo(commits, "csharp"));
  await syncRepo(db, repo);
  const ref = impactOf(db, repo.id, ["App/Data/ReportDB.cs"], { sources: ["ref"], noteFiles: 0 });
  const by = Object.fromEntries(ref.items.map((item) => [item.path, item.reasons[0].detail]));
  assert.equal(by["App/Conn/PathConfig.cs"], "App/Data/ReportDB.cs uses its PathConfig");
  assert.equal(by["App/Service.cs"], "uses ReportDB from App/Data/ReportDB.cs");
  assert.equal("App/Other.cs" in by, false);
  const sibling = impactOf(db, repo.id, ["web/app/login/layout.tsx"], { sources: ["sibling"], noteFiles: 0 });
  assert.deepEqual(sibling.items.map((item) => item.path), ["web/app/register/layout.tsx"]);
});

test("syncRepo: 코드 색인 규칙이 바뀐 옛 레포(code_version 0)는 트리가 그대로여도 한 번 다시 읽어 정의-참조를 채운다", async () => {
  const { db, repo } = await indexed();
  db.prepare("DELETE FROM file_defs").run();
  db.prepare("UPDATE repos SET code_version = 0").run();
  await syncRepo(db, repo);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM file_defs").get() as { n: number }).n > 0);
  assert.equal((db.prepare("SELECT code_version FROM repos").get() as { code_version: number }).code_version, 1);
});

test("impactbench: 이력에서 질의를 만들고(머지·대량·같은 변경 제외) 순위를 채점한다", () => {
  const log = "\0aaa\tfeat: x\nsrc/a.ts\nsrc/b.ts\nsrc/gone.ts\n\0bbb\tMerge branch 'x'\nsrc/a.ts\nsrc/b.ts\n\0ccc\tfeat: x\nsrc/a.ts\nsrc/b.ts\nsrc/gone.ts\n";
  const commits = parseLog(log);
  assert.equal(commits.length, 3);
  const queries = buildQueries(commits, new Set(["src/a.ts", "src/b.ts"]));
  // 머지는 빠지고, ccc는 aaa와 같은 변경, 분할 뒤에 생긴 gone.ts는 질의·정답 모두에서 빠진다
  assert.deepEqual(queries, [
    { sha: "aaa", seed: "src/a.ts", targets: ["src/b.ts"] },
    { sha: "aaa", seed: "src/b.ts", targets: ["src/a.ts"] },
  ]);
  const score = scoreQuery(["x", "y", "src/b.ts"], ["src/b.ts", "z"]);
  assert.deepEqual(score, { hit5: 1, recall5: 0.5, recall10: 0.5, precision5: 0.2, rr: 1 / 3, covered: 1 });
  assert.deepEqual(meanScore([score, scoreQuery([], ["a"])]), { n: 2, hit5: 0.5, recall5: 0.25, recall10: 0.25, precision5: 0.1, rr: 0.167, covered: 0.5 });
});

test("toolsWithDescriptions: 벤치 전용 설명 바꿔 끼우기 — 그 도구만, 깨진 JSON·없는 도구는 무시", async () => {
  const { toolsWithDescriptions, TOOLS } = await import("../src/mcp/tools.js");
  const base = TOOLS.find((tool) => tool.name === "impact")!.description;
  const swapped = toolsWithDescriptions({ GRIMOIRE_BENCH_TOOL_DESC: JSON.stringify({ impact: "Call before every git commit.", nope: "x" }) });
  assert.equal(swapped.find((tool) => tool.name === "impact")!.description, "Call before every git commit.");
  assert.equal(swapped.find((tool) => tool.name === "search_memory")!.description, TOOLS.find((tool) => tool.name === "search_memory")!.description);
  assert.equal(toolsWithDescriptions({ GRIMOIRE_BENCH_TOOL_DESC: "{broken" }).find((tool) => tool.name === "impact")!.description, base);
  assert.equal(toolsWithDescriptions({}).length, TOOLS.length);
});

test("impactOf intent: 작업 의도로 찾은 과거 커밋의 파일을 순위에 합치고, 근거로 그 커밋을 댄다", async () => {
  const { db, repo } = await indexed();
  // handler.ts만 바꿨다 — 구조로는 schema.sql과 이어지지 않지만, "컬럼"을 다룬 과거 커밋들이 schema.sql을 바꿨다
  const plain = impactOf(db, repo.id, ["src/handler.ts"], { noteFiles: 0 }).items.map((item) => item.path);
  assert.equal(plain.includes("db/schema.sql"), false);
  const withIntent = impactOf(db, repo.id, ["src/handler.ts"], { noteFiles: 0, intent: "컬럼 추가" }).items;
  const schema = withIntent.find((item) => item.path === "db/schema.sql");
  assert.ok(schema, "의도로 찾은 파일이 들어와야 합니다");
  assert.equal(schema!.score, 0, "의도 근거는 점수(문턱)에 넣지 않는다");
  assert.match(schema!.reasons.find((reason) => reason.source === "intent")!.detail, /^changed in [0-9a-f]{7} "feat\(api\): 컬럼/);
  // 바뀐 파일 자신과 지금 레포에 없는 파일은 넣지 않는다
  assert.equal(withIntent.some((item) => item.path === "src/handler.ts"), false);
});
