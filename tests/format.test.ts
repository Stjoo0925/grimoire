import assert from "node:assert/strict";
import { test } from "node:test";

import type { SearchResult } from "../src/core/search";
import { slimSearch, who } from "../src/mcp/format";

test("who: 내 커밋은 me, 아니면 이름만", () => {
  assert.equal(who("Me Kim <ME@x.com>".replace("ME@", "me@"), ["me@x.com"]), "me");
  assert.equal(who("Teammate <t@x.com>", ["me@x.com"]), "Teammate");
  assert.equal(who(null, []), null);
});

test("slimSearch: 링크는 레포별 접두 한 번, 결과는 sha 10자·날짜·남은 파일 수", () => {
  const sha = "a".repeat(40);
  const result: SearchResult = {
    query: "q",
    mode: "keyword",
    semanticNote: "임베딩 없음",
    hits: [
      {
        kind: "commit",
        repo: "api",
        repoPath: "/Users/me/api",
        ref: sha,
        date: "2024-01-02T03:04:05+09:00",
        author: "Me <me@x.com>",
        title: "feat: x",
        snippet: "본문\n  여러   줄",
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        filesChanged: 7,
        url: `https://github.com/o/api/commit/${sha}`,
        score: 0.1,
        matchedBy: ["keyword"],
      },
    ],
  };
  const slim = slimSearch(result, ["me@x.com"]);
  assert.deepEqual(slim, {
    hits: [
      {
        repo: "api",
        sha: "a".repeat(10),
        date: "2024-01-02",
        by: "me",
        title: "feat: x",
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "+3"],
        body: "본문 여러 줄",
      },
    ],
    links: { api: "https://github.com/o/api/commit/" },
  });
  // 로컬 경로·점수·이메일·semanticNote는 내보내지 않는다
  assert.doesNotMatch(JSON.stringify(slim), /Users|score|matchedBy|me@x\.com|임베딩/);
});
