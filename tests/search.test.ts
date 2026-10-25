import assert from "node:assert/strict";
import { test } from "node:test";

import { addRepo, syncRepo } from "../src/core/indexer";
import { search } from "../src/core/search";
import { callTool } from "../src/mcp/tools";
import { addCommit, git, makeRepo, memoryDb } from "./helpers";

/** main에 squash 머지 커밋, feature 브랜치에 같은 변경의 원본 커밋이 남은 레포 */
function squashedRepo(): string {
  const dir = makeRepo([{ message: "feat: 시작", files: { "README.md": "x\n" }, date: "2024-01-01T10:00:00+09:00" }], "squash");
  git(dir, ["checkout", "-q", "-b", "feature"]);
  addCommit(dir, {
    message: "fix(security): 업데이트 버전 검증 보강",
    files: { "src/update.ts": "export const verify = 1;\n" },
    date: "2024-02-01T17:55:00+09:00",
  });
  git(dir, ["checkout", "-q", "main"]);
  // 시각대가 달라도 실제 시각으로 비교한다 (문자열로는 이쪽이 더 이르다)
  addCommit(dir, {
    message: "fix(security): 업데이트 버전 검증 보강 (#4)",
    files: { "src/update.ts": "export const verify = 1;\n" },
    date: "2024-02-01T10:03:00+00:00",
  });
  // 제목은 같지만 다른 파일을 바꾼 커밋은 접지 않는다
  addCommit(dir, {
    message: "fix(security): 업데이트 버전 검증 보강",
    files: { "src/other.ts": "export const other = 1;\n" },
    date: "2024-03-01T10:00:00+09:00",
  });
  addCommit(dir, { message: "docs: 업데이트 안내", files: { "docs/update.md": "update\n" }, date: "2024-04-01T10:00:00+09:00" });
  return dir;
}

test("search: squash 머지와 브랜치 원본처럼 제목·파일이 같은 커밋은 하나로 접고, 빈자리는 다음 후보가 채운다", async () => {
  const db = memoryDb();
  const dir = squashedRepo();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const merge = git(dir, ["rev-parse", "main~2"]).trim();
  const original = git(dir, ["rev-parse", "feature"]).trim();

  const hits = search(db, "업데이트 버전 검증", { kind: "commit", limit: 3 }).hits;
  const folded = hits.filter((hit) => hit.ref === merge || hit.ref === original);
  assert.equal(folded.length, 1, "같은 변경은 한 결과");
  assert.equal(folded[0].ref, merge, "대표는 늦은 쪽(머지 커밋)");
  assert.deepEqual(folded[0].also, [original]);
  assert.equal(hits.length, 3, "접힌 자리는 다음 후보로 채운다");
  assert.ok(hits.some((hit) => hit.files.includes("src/other.ts")), "파일이 다르면 접지 않는다");
  assert.ok(hits.every((hit) => hit.ref === merge || !hit.also), "접힌 것이 없으면 also가 없다");

  const response = (await callTool({ db, me: [], cwd: dir }, "search_memory", { query: "업데이트 버전 검증", kind: "commit" })) as {
    hits: { sha: string; also?: string[] }[];
  };
  const top = response.hits.find((hit) => hit.sha === merge.slice(0, 10));
  assert.deepEqual(top?.also, [original.slice(0, 8)]);
});
