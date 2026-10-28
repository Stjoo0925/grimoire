import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { addRepo, syncRepo } from "../src/core/indexer";
import { callTool } from "../src/mcp/tools";
import { git, makeRepo, memoryDb } from "./helpers";

async function indexed() {
  const dir = makeRepo(
    [
      {
        message: "feat: 시작",
        files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "src/c.ts": "export const c = 1;\n", "README.md": "# x\n" },
        date: "2024-01-01T10:00:00+09:00",
      },
    ],
    "autobind",
  );
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  return { db, dir, repo: repo.name };
}

type Recorded = { recorded: boolean; paths?: string[]; autoBound?: boolean; note?: string };
const record = (ctx: { db: ReturnType<typeof memoryDb>; dir: string; repo: string }, args: Record<string, unknown>) =>
  callTool({ db: ctx.db, me: [], cwd: ctx.dir }, "record_note", { text: "결정: 이건 이렇게 한다", repo: ctx.repo, ...args }) as Promise<Recorded>;

test("record_note: paths를 안 주면 바뀐 파일(수정 + 새 파일)에 자동으로 묶고 알린다", async () => {
  const ctx = await indexed();
  fs.writeFileSync(path.join(ctx.dir, "src", "a.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(ctx.dir, "src", "new.ts"), "export const n = 1;\n");
  const two = await record(ctx, {});
  assert.deepEqual([...(two.paths ?? [])].sort(), ["src/a.ts", "src/new.ts"]);
  assert.equal(two.autoBound, true);
  const stored = ctx.db.prepare("SELECT repo_id FROM notes").get() as { repo_id: number | null };
  assert.notEqual(stored.repo_id, null);

  // 파일이 하나뿐일 때
  git(ctx.dir, ["checkout", "--", "."]);
  fs.rmSync(path.join(ctx.dir, "src", "new.ts"));
  fs.writeFileSync(path.join(ctx.dir, "src", "b.ts"), "export const b = 2;\n");
  const one = await record(ctx, {});
  assert.deepEqual(one.paths, ["src/b.ts"]);
});

test("record_note: 소스가 아닌 파일은 묶지 않는다", async () => {
  const ctx = await indexed();
  fs.writeFileSync(path.join(ctx.dir, "README.md"), "# y\n");
  const result = await record(ctx, {});
  assert.equal(result.paths, undefined);
  assert.equal(result.autoBound, undefined);
});

test("record_note: 바뀐 소스 파일이 5개를 넘으면 묶지 않고 말한다", async () => {
  const ctx = await indexed();
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(ctx.dir, "src", `n${i}.ts`), `export const n = ${i};\n`);
  const result = await record(ctx, {});
  assert.equal(result.recorded, true);
  assert.equal(result.paths, undefined);
  assert.equal(result.autoBound, undefined);
  assert.match(result.note ?? "", /5개를 넘어/);
});

test("record_note: paths: []는 묶지 않음, 준 paths와 본문 경로는 그대로", async () => {
  const ctx = await indexed();
  fs.writeFileSync(path.join(ctx.dir, "src", "a.ts"), "export const a = 2;\n");
  const optOut = await record(ctx, { paths: [] });
  assert.equal(optOut.paths, undefined);
  assert.equal(optOut.autoBound, undefined);

  const explicit = await record(ctx, { paths: ["src/c.ts"] });
  assert.deepEqual(explicit.paths, ["src/c.ts"]);
  assert.equal(explicit.autoBound, undefined);

  const inBody = await record(ctx, { text: "src/b.ts 는 건드리지 않는다" });
  assert.deepEqual(inBody.paths, ["src/b.ts"]);
  assert.equal(inBody.autoBound, undefined);
});
