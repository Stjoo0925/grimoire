import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { openDb } from "../src/core/db";
import { addRepo, discoverRepos, listRepos, removeRepo, syncRepo } from "../src/core/indexer";
import { addNote } from "../src/core/notes";
import { commitDetail, repoOverview } from "../src/core/overview";
import { buildMatchExpression, search, stripParticle } from "../src/core/search";
import { callTool, ToolError } from "../src/mcp/tools";
import { addCommit, git, makeRepo, memoryDb, tempDir } from "./helpers";

function sampleRepo(name = "shop-api"): string {
  return makeRepo(
    [
      {
        message: "feat: 프로젝트 시작",
        files: { "package.json": JSON.stringify({ dependencies: { express: "^4", "react.js": "1" }, devDependencies: { jest: "^29" } }) },
        date: "2023-01-10T10:00:00+09:00",
      },
      {
        message: "feat(auth): JWT 리프레시 토큰 회전\n\n만료 직전에 refresh token을 새로 발급하고 이전 토큰을 폐기한다.",
        files: { "src/auth/refresh.ts": "export const rotate = 1;\n" },
        date: "2023-05-02T10:00:00+09:00",
      },
      {
        message: "fix: 재고 차감 동시성 문제를 Redis 분산 락으로 해결",
        files: { "src/order/lock.ts": "export const lock = 1;\n" },
        email: "teammate@example.com",
        date: "2024-02-03T10:00:00+09:00",
      },
      {
        message: "chore: bump deps",
        files: { "package.json": JSON.stringify({ dependencies: { express: "^5" } }) },
        date: "2024-06-01T10:00:00+09:00",
      },
    ],
    name,
  );
}

test("stripParticle / buildMatchExpression: 조사 제거·접두 일치·연산자 무력화", () => {
  assert.equal(stripParticle("인증을"), "인증");
  assert.equal(stripParticle("락으로"), null); // 남는 글자가 1자면 떼지 않는다
  assert.equal(stripParticle("분산락으로"), "분산락");
  assert.equal(stripParticle("auth"), null);

  const expr = buildMatchExpression('React.js 인증을 OR "drop');
  assert.ok(expr);
  assert.match(expr!, /"react\.js"\*/);
  assert.match(expr!, /"인증"\*/);
  assert.match(expr!, /"react"\*/); // 기술 별칭 정규화
  assert.equal(buildMatchExpression("  ??? "), null);
});

test("syncRepo: 인덱싱은 멱등이고 새 커밋만 더한다", async () => {
  const db = memoryDb();
  const dir = sampleRepo();
  const repo = await addRepo(db, path.join(dir, "src"));
  assert.equal(repo.path, fs.realpathSync(dir)); // 하위 경로를 줘도 최상위로
  assert.equal(repo.remote_url, "git@github.com:someone/shop-api.git");

  const first = await syncRepo(db, repo);
  assert.equal(first.added, 4);
  assert.equal((await syncRepo(db, repo)).added, 0);

  addCommit(dir, { message: "feat: 결제 웹훅 서명 검증", files: { "src/pay/webhook.ts": "x" } });
  const third = await syncRepo(db, repo);
  assert.equal(third.added, 1);
  assert.equal(third.total, 5);

  const tech = (db.prepare("SELECT tech FROM repo_tech WHERE repo_id = ?").all(repo.id) as { tech: string }[]).map(
    (row) => row.tech,
  );
  assert.deepEqual(tech.sort(), ["express"]); // HEAD 기준 매니페스트
});

test("search: 키워드로 근거(sha·파일·링크)를 찾고 필터가 먹는다", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, sampleRepo());
  await syncRepo(db, repo);

  const result = await search(db, "refresh 토큰을");
  const top = result.hits[0];
  assert.equal(top.title, "feat(auth): JWT 리프레시 토큰 회전");
  assert.deepEqual(top.files, ["src/auth/refresh.ts"]);
  assert.match(top.url ?? "", /^https:\/\/github\.com\/someone\/shop-api\/commit\/[0-9a-f]{40}$/);
  assert.equal(top.author, "me <me@example.com>");

  // 파일 경로로도 걸린다 (커밋 이력 쪽)
  assert.equal((await search(db, "lock.ts", { kind: "commit" })).hits[0]?.title.startsWith("fix:"), true);

  // 작성자 필터
  const mine = await search(db, "동시성", { authors: ["me@example.com"] });
  assert.equal(mine.hits.length, 0);
  const theirs = await search(db, "동시성", { authors: ["teammate@example.com"] });
  assert.equal(theirs.hits.length, 1);

  // 기간 필터
  assert.equal((await search(db, "동시성", { since: "2025-01-01" })).hits.length, 0);

  // FTS 연산자처럼 보이는 입력도 오류 없이 처리
  assert.doesNotThrow(() => search(db, 'NEAR( "x" AND -', {}));
});

test("notes: 노트도 검색되고 레포 삭제 시 색인이 정리된다", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, sampleRepo());
  await syncRepo(db, repo);
  addNote(db, { text: "결정: 세션 대신 JWT\n모바일 클라이언트 때문", repoId: repo.id, tags: ["Decision"], source: "cli" });

  const notes = await search(db, "모바일", { kind: "note" });
  assert.equal(notes.hits.length, 1);
  assert.equal(notes.hits[0].title, "결정: 세션 대신 JWT");
  // 노트는 작성자 필터(나)와 무관하게 통과
  assert.equal((await search(db, "모바일", { authors: ["nobody@x"] })).hits.length, 1);

  removeRepo(db, repo);
  assert.equal(listRepos(db).length, 0);
  assert.equal((await search(db, "토큰")).hits.length, 0);
  const fts = db.prepare("SELECT COUNT(*) AS n FROM docs_fts").get() as { n: number };
  // 레포에 묶인 노트는 repo_id가 NULL로 남고(ON DELETE SET NULL) 색인 문서는 지워진다
  assert.equal(fts.n, 0);
});

test("overview / commitDetail: 개요와 로컬 diff", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, sampleRepo());
  await syncRepo(db, repo);

  const overview = repoOverview(db, repo, ["me@example.com"]);
  assert.equal(overview.commits, 4);
  assert.equal(overview.mine, 3);
  assert.ok(overview.topDirectories.some((dir) => dir.path === "src/auth"));
  assert.ok(overview.activity.some((bucket) => bucket.period === "2023-Q2"));
  assert.ok(overview.recentCommits.every((commit) => !commit.subject.startsWith("chore")));

  const sha = (db.prepare("SELECT sha FROM commits WHERE subject LIKE 'feat(auth)%'").get() as { sha: string }).sha;
  const detail = await commitDetail(db, sha.slice(0, 8));
  assert.ok(!("error" in detail));
  if (!("error" in detail)) {
    assert.match(detail.patch ?? "", /\+export const rotate = 1;/);
    assert.equal(detail.body, "만료 직전에 refresh token을 새로 발급하고 이전 토큰을 폐기한다.");
  }
  assert.ok("error" in (await commitDetail(db, "zzzz")));
});

test("MCP 도구: 인자 검증과 기록", async () => {
  const db = memoryDb();
  const repo = await addRepo(db, sampleRepo());
  await syncRepo(db, repo);
  const context = { db, me: ["me@example.com"], cwd: process.cwd() };

  const found = (await callTool(context, "search_memory", { query: "토큰", author: "me", repo: "shop" })) as {
    hits: unknown[];
  };
  assert.equal(found.hits.length, 1);

  await assert.rejects(callTool(context, "search_memory", {}), ToolError);
  await assert.rejects(callTool(context, "get_repo_overview", { repo: "없는레포" }), /찾지 못했습니다/);
  await assert.rejects(callTool({ db, me: [], cwd: process.cwd() }, "search_memory", { query: "x", author: "me" }), /GRIMOIRE_ME/);

  const recorded = (await callTool(context, "record_note", { text: "배움: FTS5 접두 질의", tags: ["sqlite"] })) as {
    recorded: boolean;
  };
  assert.equal(recorded.recorded, true);
  const listed = (await callTool(context, "list_repos")) as { repos: { name: string; mine: number }[] };
  assert.equal(listed.repos[0].mine, 3);
});

test("파일 DB: 두 연결이 동시에 열려도 쓰기가 보인다 (WAL)", async () => {
  const file = path.join(tempDir(), "g.db");
  const writer = openDb(file);
  const reader = openDb(file);
  const repo = await addRepo(writer, sampleRepo());
  await syncRepo(writer, repo);
  const count = reader.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number };
  assert.equal(count.n, 4);
  assert.equal(reader.pragma("journal_mode", { simple: true }), "wal");
  writer.close();
  reader.close();
});

test("discoverRepos: 하위 레포를 찾되 레포 안으로는 내려가지 않는다", () => {
  const root = tempDir();
  for (const name of ["a", "nested/b"]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
    fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
    git(path.join(dir, "inner"), ["init", "-q"]);
  }
  const found = discoverRepos(root).map((dir) => path.relative(root, dir)).sort();
  assert.deepEqual(found, ["a", path.join("nested", "b")]);
});
