import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isBusyError, openDb } from "../src/core/db";
import { addRepo, blobBatches, discoverRepos, findRepo, listRepos, matchRepos, removeRepo, syncRepo } from "../src/core/indexer";
import { indexCommitCode } from "../src/core/diffs";
import { addNote, TAG_CHARS, TAGS_MAX } from "../src/core/notes";
import { commitDetail, repoOverview } from "../src/core/overview";
import { buildMatchExpression, search, stripParticle } from "../src/core/search";
import { slimCommit } from "../src/mcp/format";
import { callTool, describeError, isTooBroad, MAX_SCAN_REPOS, ToolError, TOOLS } from "../src/mcp/tools";
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

test("syncRepo: 지난 끝 커밋 뒤의 새 커밋만 읽고, 끝 커밋이 사라지면 전체 비교로 돌아간다", async () => {
  const db = memoryDb();
  const dir = sampleRepo();
  const repo = await addRepo(db, dir);
  assert.equal((await syncRepo(db, repo)).added, 4);

  const noop = await syncRepo(db, repo);
  assert.deepEqual([noop.added, noop.files, noop.total], [0, 0, 4]);

  addCommit(dir, { message: "feat: 결제 웹훅 서명 검증", files: { "src/pay/webhook.ts": "export function verifySignature() {}\n" } });
  const next = await syncRepo(db, repo);
  assert.deepEqual([next.added, next.files, next.total], [1, 1, 5]);
  assert.equal(search(db, "웹훅 서명", { kind: "file" }).hits[0]?.ref, "src/pay/webhook.ts");

  // 마지막 커밋을 고쳐 쓰고 옛 커밋을 지운다 → 저장해 둔 끝 커밋이 사라짐
  // 테스트 git은 HOME을 바꿔 사용자 설정이 없다 — 작성자를 직접 준다 (Linux git은 추정하지 않고 거부한다)
  const who = { GIT_AUTHOR_NAME: "me", GIT_AUTHOR_EMAIL: "me@example.com", GIT_COMMITTER_NAME: "me", GIT_COMMITTER_EMAIL: "me@example.com" };
  git(dir, ["commit", "-q", "--amend", "-m", "feat: 결제 웹훅 서명 검증 (HMAC)"], who);
  git(dir, ["reflog", "expire", "--expire=now", "--all"]);
  git(dir, ["gc", "-q", "--prune=now"]);
  const rewritten = await syncRepo(db, repo);
  assert.equal(rewritten.added, 1);
  assert.ok(search(db, "HMAC").hits.some((hit) => hit.title.includes("HMAC")));
});

test("commitDetail: 줄 수는 색인하지 않고 show_commit 때 센다", async () => {
  const db = memoryDb();
  const dir = sampleRepo();
  await syncRepo(db, await addRepo(db, dir));
  const stored = db.prepare("SELECT insertions FROM commit_files WHERE path = 'src/order/lock.ts'").get() as { insertions: number | null };
  assert.equal(stored.insertions, null);
  const sha = (db.prepare("SELECT sha FROM commits WHERE subject LIKE '%분산 락%'").get() as { sha: string }).sha;
  const detail = await commitDetail(db, sha);
  assert.ok(!("error" in detail));
  if (!("error" in detail)) assert.deepEqual(detail.files, [{ path: "src/order/lock.ts", insertions: 1, deletions: 0, binary: false }]);
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
  assert.equal(reader.pragma("journal_mode"), "wal");
  writer.close();
  reader.close();
});

test("DB.transaction: 던지면 되돌리고, 안쪽 트랜잭션은 안쪽만 되돌린다", () => {
  const db = memoryDb();
  const insert = db.prepare("INSERT INTO notes (text, source, created_at) VALUES (?, 'test', '2026-01-01')");
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;

  assert.throws(
    db.transaction(() => {
      insert.run("a");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(count(), 0);

  db.transaction(() => {
    insert.run("outer");
    assert.throws(
      db.transaction(() => {
        insert.run("inner");
        throw new Error("inner");
      }),
    );
  })();
  assert.deepEqual(db.prepare("SELECT text FROM notes").all(), [{ text: "outer" }]);
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

test("diff 단계: 바뀐 선언을 채우고, search_memory 기본(index)은 목록만, summary를 요청하면 본문·바뀐 함수를 싣는다", async () => {
  const db = memoryDb();
  const dir = sampleRepo();
  addCommit(dir, {
    message: "fix: 웹훅 재전송 중복 처리\n\n같은 이벤트 id가 다시 오면 저장된 결과를 돌려준다. 결제사가 타임아웃 뒤 같은 웹훅을 다시 보내기 때문.",
    files: { "src/pay/webhook.ts": "export function dedupeWebhookEvent(id: string) {\n  return id;\n}\n" },
  });
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const pending = () => (db.prepare("SELECT COUNT(*) AS n FROM commits WHERE code_state = 0").get() as { n: number }).n;
  assert.equal(pending(), 5);
  assert.equal(await indexCommitCode(db, repo), 5);
  assert.equal(pending(), 0);
  assert.equal(await indexCommitCode(db, repo), 0);

  const context = { db, me: ["me@example.com"], cwd: dir };
  const summary = (await callTool(context, "search_memory", { query: "웹훅 중복", kind: "commit", detail: "summary" })) as { hits: Record<string, unknown>[] };
  assert.deepEqual(summary.hits[0].changed, ["webhook.ts: dedupeWebhookEvent"]);
  assert.match(String(summary.hits[0].body), /결제사가 타임아웃 뒤/);
  // detail을 주지 않으면 index — 예전 목록 형태
  const index = (await callTool(context, "search_memory", { query: "웹훅 중복", kind: "commit" })) as { hits: Record<string, unknown>[] };
  assert.equal(index.hits[0].changed, undefined);
  assert.ok(String(index.hits[0].body ?? "").length <= 141);
  const full = (await callTool(context, "search_memory", { query: "웹훅 중복", kind: "commit", detail: "full" })) as { diff?: { patch: string } };
  assert.match(full.diff?.patch ?? "", /\+export function dedupeWebhookEvent/);
});

test("검색: 제목·본문·경로에 없는 지워진 함수 이름은 diff 이름으로 채워 찾는다", async () => {
  const db = memoryDb();
  const dir = sampleRepo();
  addCommit(dir, { message: "feat: 쿠폰", files: { "src/coupon.ts": "export function applyLegacyCoupon() {}\n" } });
  addCommit(dir, { message: "refactor: 정리", files: { "src/coupon.ts": "export const coupon = 1;\n" } });
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  assert.equal(search(db, "applyLegacyCoupon").hits.length, 0);
  await indexCommitCode(db, repo);
  const titles = search(db, "applyLegacyCoupon").hits.map((hit) => hit.title);
  assert.deepEqual(titles.sort(), ["feat: 쿠폰", "refactor: 정리"]);
});

test("add_repo scan: 홈의 조상·루트 바로 아래는 거절하고, 레포가 너무 많으면 터미널로 안내한다", async () => {
  const home = os.homedir();
  const root = path.parse(home).root;
  assert.equal(isTooBroad(root), true);
  assert.equal(isTooBroad(home), true);
  assert.equal(isTooBroad(path.dirname(home)), true); // /home, /Users, C:\Users
  assert.equal(isTooBroad(path.join(root, "opt")), true); // 루트 바로 아래
  assert.equal(isTooBroad(path.join(home, "work")), false);
  assert.equal(isTooBroad(tempDir()), false);

  const db = memoryDb();
  const context = { db, me: [], cwd: home };
  await assert.rejects(callTool(context, "add_repo", { path: "~/..", scan: true }), /스캔하지는 않습니다/);
  const rootChild = [path.join(root, "Windows"), "/usr", "/tmp", "/opt"].find((dir) => fs.existsSync(dir) && path.dirname(path.resolve(dir)) === path.parse(path.resolve(dir)).root);
  if (rootChild) await assert.rejects(callTool(context, "add_repo", { path: rootChild, scan: true }), /스캔하지는 않습니다/);

  // .git 폴더만 있어도 레포로 센다 — 상한 + 1개
  const many = tempDir();
  for (let index = 0; index <= MAX_SCAN_REPOS; index++) fs.mkdirSync(path.join(many, `r${index}`, ".git"), { recursive: true });
  assert.equal(discoverRepos(many, 4, MAX_SCAN_REPOS).length, MAX_SCAN_REPOS + 1); // 상한을 넘으면 더 걷지 않는다
  await assert.rejects(callTool(context, "add_repo", { path: many, scan: true }), /50개를 넘습니다[\s\S]*grimoire scan/);
  assert.equal(listRepos(db).length, 0);
});

test("record_note tags: 개수·길이 상한을 넘으면 잘라서 저장한다", async () => {
  const db = memoryDb();
  const context = { db, me: [], cwd: process.cwd() };
  const schema = TOOLS.find((tool) => tool.name === "record_note")!.inputSchema.properties.tags;
  assert.equal(schema.maxItems, TAGS_MAX);
  assert.equal(schema.items.maxLength, TAG_CHARS);

  await assert.rejects(callTool(context, "record_note", { text: "x", tags: "a b" }), /배열/);
  const recorded = (await callTool(context, "record_note", { text: "긴 태그", tags: Array.from({ length: 20_000 }, () => "y".repeat(200)) })) as { id: number };
  const stored = db.prepare("SELECT tags FROM notes WHERE id = ?").get(recorded.id) as { tags: string };
  assert.equal(stored.tags.split(" ").length, TAGS_MAX);
  assert.ok(stored.tags.split(" ").every((tag) => tag.length === TAG_CHARS));
  const note = addNote(db, { text: "많은 태그", tags: Array.from({ length: 1000 }, (_, i) => `tag${i}`), source: "cli" });
  assert.equal(note.tags.split(" ").length, TAGS_MAX);
  const longest = db.prepare("SELECT MAX(LENGTH(tags)) AS n FROM notes").get() as { n: number };
  assert.ok(longest.n <= TAGS_MAX * (TAG_CHARS + 1), `tags ${longest.n}자`);
});

test("노트 검색 결과에 누가 남겼는지(by: me | ai)가 실린다", async () => {
  const db = memoryDb();
  const context = { db, me: ["me@example.com"], cwd: process.cwd() };
  addNote(db, { text: "결정: 캐시는 Redis\n사람이 남김", source: "cli" });
  await callTool(context, "record_note", { text: "결정: 캐시는 메모리\nAI가 남김" });
  const result = (await callTool(context, "search_memory", { query: "캐시", kind: "note" })) as { hits: { title: string; by: string }[] };
  const by = Object.fromEntries(result.hits.map((hit) => [hit.title, hit.by]));
  assert.deepEqual(by, { "결정: 캐시는 Redis": "me", "결정: 캐시는 메모리": "ai" });
  assert.ok(JSON.stringify(result.hits[0]).length < 260);
});

test("레포 이름이 여럿과 부분 일치하면 고르지 않고 후보를 알린다", async () => {
  const db = memoryDb();
  await syncRepo(db, await addRepo(db, sampleRepo("shop-api")));
  await syncRepo(db, await addRepo(db, sampleRepo("shop-web")));
  assert.equal(findRepo(db, "shop"), null);
  assert.deepEqual(matchRepos(db, "shop").map((repo) => repo.name), ["shop-api", "shop-web"]);
  assert.equal(findRepo(db, "shop-api")?.name, "shop-api");
  assert.equal(findRepo(db, "web")?.name, "shop-web");
  const context = { db, me: [], cwd: process.cwd() };
  await assert.rejects(callTool(context, "get_repo_overview", { repo: "shop" }), /여럿입니다: shop-api, shop-web/);
  await assert.rejects(callTool(context, "record_note", { text: "x", repo: "shop" }), ToolError);
});

test("show_commit: diff는 보낼 만큼만 읽고(잘림 표시), 취소된 요청은 git을 부르지 않는다", async () => {
  const db = memoryDb();
  const dir = sampleRepo();
  addCommit(dir, { message: "feat: 큰 파일", files: { "src/big.ts": Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i};`).join("\n") } });
  await syncRepo(db, await addRepo(db, dir));
  const sha = (db.prepare("SELECT sha FROM commits WHERE subject = 'feat: 큰 파일'").get() as { sha: string }).sha;

  const detail = await commitDetail(db, sha, { maxDiffLines: 20 });
  assert.ok(!("error" in detail));
  if ("error" in detail) return;
  assert.equal(detail.patchTruncated, true);
  assert.equal(detail.patch?.split("\n").length, 20);
  assert.equal(detail.patchLines, 21);
  assert.match(detail.patch ?? "", /^diff --git/);
  assert.match(slimCommit(detail, []).truncated ?? "", /20줄만 보냄/);
  const whole = await commitDetail(db, sha, { maxDiffLines: 3000 });
  assert.ok(!("error" in whole) && !whole.patchTruncated && (whole.patch ?? "").includes("v299"));

  const aborted = new AbortController();
  aborted.abort();
  const context = { db, me: [], cwd: dir };
  await assert.rejects(callTool(context, "show_commit", { sha }, aborted.signal), /요청이 취소되었습니다/);
  await assert.rejects(callTool(context, "add_repo", { path: dir }, aborted.signal), /요청이 취소되었습니다/);
});

test("다른 프로세스가 쓰기 잠금을 쥐면 record_note는 잠깐 다시 해 보고 친절한 오류를 낸다", async () => {
  const file = path.join(tempDir(), "g.db");
  const holder = openDb(file);
  const db = openDb(file);
  db.pragma("busy_timeout = 50");
  holder.exec("BEGIN IMMEDIATE");
  try {
    let caught: unknown;
    try {
      addNote(db, { text: "x", source: "cli" });
    } catch (error) {
      caught = error;
    }
    assert.equal(isBusyError(caught), true);
    assert.match(describeError(caught).message, /다른 grimoire 프로세스가 DB를 쓰는 중/);
    await assert.rejects(callTool({ db, me: [], cwd: process.cwd() }, "record_note", { text: "잠긴 동안" }), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.match((error as Error).message, /잠시 후 다시 시도하세요/);
      return true;
    });
  } finally {
    holder.exec("ROLLBACK");
  }
  // 잠금이 풀리면 그대로 된다
  assert.equal(((await callTool({ db, me: [], cwd: process.cwd() }, "record_note", { text: "풀린 뒤" })) as { recorded: boolean }).recorded, true);
  // 알 수 없는 내부 오류는 메시지를 그대로 내보내지 않는다
  assert.deepEqual(describeError(new Error("SQLITE internal /secret/path")), { message: "내부 오류 — 서버 로그(stderr)를 확인하세요.", known: false });
  assert.match(describeError(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", syscall: "spawn git" })).message, /git을 찾을 수 없습니다/);
  assert.match(describeError(new Error("x", { cause: Object.assign(new Error("y"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) })).message, /출력이 너무 커서/);
  holder.close();
  db.close();
});

test("blobBatches: blob 크기 합계가 상한을 넘지 않게 나눈다", () => {
  const file = (size: number, index: number) => ({ path: `f${index}`, blob: `b${index}`, size });
  const batches = blobBatches([60, 30, 20, 100, 5].map(file), 100);
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.size)), [[60, 30], [20], [100], [5]]);
  assert.deepEqual(blobBatches([]), []);
});

test("addNote: 노트의 비밀(연결 문자열·토큰)을 저장 전에 지우고 그렇게 했다고 알린다, 옛 노트는 마이그레이션 8이 고친다", async () => {
  const { reRedactStored } = await import("../src/core/capture.js");
  const db = memoryDb();
  const note = addNote(db, { text: "원인: DATABASE_URL=postgres://app:s3cretpw@db/x 로 붙어 풀 고갈\n다음엔 풀 크기부터 확인", tags: ["db"], source: "mcp" });
  assert.equal(note.redacted, true);
  assert.ok(!note.text.includes("s3cretpw"), note.text);
  assert.equal(search(db, "s3cretpw").hits.length, 0);
  assert.ok(search(db, "풀 고갈").hits.length > 0, "나머지 말은 검색된다");
  assert.equal(addNote(db, { text: "평범한 결정 메모", source: "cli" }).redacted, false);

  // 0.7.x가 그대로 저장한 노트
  const old = addNote(db, { text: "임시 메모", tags: ["auth", "token"], source: "cli" });
  db.prepare("UPDATE notes SET text = ? WHERE id = ?").run("스테이징 GITHUB_TOKEN=ghsecret123 로 배포", old.id);
  const docId = (db.prepare("SELECT id FROM docs WHERE kind = 'note' AND ref = ?").get(String(old.id)) as { id: number }).id;
  db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(docId);
  db.prepare("INSERT INTO docs_fts (rowid, title, body, paths, code) VALUES (?, ?, 'auth token', '', '')").run(docId, "스테이징 GITHUB_TOKEN=ghsecret123 로 배포");
  assert.ok(search(db, "ghsecret123").hits.length > 0, "준비: 새어 있어야 합니다");
  assert.equal(reRedactStored(db), 1);
  assert.equal(search(db, "ghsecret123").hits.length, 0);
  assert.ok(search(db, "스테이징 배포").hits.length > 0);
  const body = (db.prepare("SELECT body FROM docs_fts WHERE rowid = ?").get(docId) as { body: string }).body;
  assert.equal(body, "auth token", "태그는 비밀이 아니다 — auth [redacted]로 망가지면 안 됩니다");
});

test("notes paths: 노트를 파일에 묶고(명시·본문 자동), 그 파일을 고치기 전에 보이며, 파일이 바뀌면 stale, 경로로 검색된다", async () => {
  const { notesForFile } = await import("../src/core/notes.js");
  const { fileContext, formatFileContext } = await import("../src/core/context.js");
  const { slimFileContext } = await import("../src/mcp/format.js");
  const { backfillNotePaths } = await import("../src/core/capture.js");
  const db = memoryDb();
  const dir = sampleRepo("noted");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const known = (db.prepare("SELECT path FROM code_files WHERE repo_id = ? ORDER BY path").all(repo.id) as { path: string }[]).map((row) => row.path);
  const target = known.find((file) => file.endsWith(".ts"))!;
  const other = known.find((file) => file !== target)!;

  // 명시한 경로(역슬래시·앞의 ./·줄 번호는 손질) + 본문에 적힌 레포 파일은 자동으로
  const note = addNote(db, { text: `결정: ${other}는 동기 호출로 둔다\n재시도는 호출부에서 한다`, repoId: repo.id, paths: [`.\\${target.replace(/\//g, "\\")}:12`], source: "mcp" });
  assert.deepEqual(
    JSON.parse(note.paths).map((item: { path: string; blob: string | null }) => [item.path, typeof item.blob]),
    [
      [target, "string"],
      [other, "string"],
    ],
  );

  const hints = notesForFile(db, repo.id, target);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].id, note.id);
  assert.equal(hints[0].stale, false);
  assert.equal(notesForFile(db, repo.id, "src/none.ts").length, 0);

  // 편집 직전 카드(lean)와 file_context에 노트가 실린다 — 노트만 있어도 줄 것이 있다
  const context = fileContext(db, repo.id, target);
  assert.equal(context.worth, true);
  const card = formatFileContext(context, { lean: true });
  assert.ok(card.startsWith(`Grimoire: ${target}\nNotes: #${note.id} "결정: `), card);
  assert.ok(!card.includes("Recent:"));
  const slim = slimFileContext(context, []) as { notes?: string[] };
  assert.match(slim.notes![0], new RegExp(`^#${note.id} \\d{4}-\\d\\d-\\d\\d "결정: `));

  // 경로(파일 이름)로 검색된다
  const base = target.split("/").pop()!.replace(/\.[^.]+$/, "");
  assert.ok(search(db, base, { kind: "note" }).hits.some((hit) => hit.ref === String(note.id) && hit.files.includes(target)), "노트가 경로로 검색되지 않습니다");

  // 파일이 바뀌고 동기화되면 stale
  addCommit(dir, { message: "refactor: 바꿈", files: { [target]: "export const changed = 1;\n" } });
  await syncRepo(db, repo);
  assert.equal(notesForFile(db, repo.id, target)[0].stale, true);
  assert.match(formatFileContext(fileContext(db, repo.id, target), { lean: true }), /file changed since/);
  assert.equal(notesForFile(db, repo.id, other)[0].stale, false, "안 바뀐 파일은 그대로");

  // 옛 노트(paths 없음)는 마이그레이션 11이 본문의 경로를 묶는다 — blob을 몰라 stale로 보지 않는다
  db.prepare("INSERT INTO notes (repo_id, text, tags, paths, source, created_at) VALUES (?, ?, '', '[]', 'cli', ?)").run(repo.id, `교훈: ${other} 재시도 주의`, new Date().toISOString());
  assert.equal(backfillNotePaths(db), 1);
  assert.equal(notesForFile(db, repo.id, other).length, 2);
  assert.ok(notesForFile(db, repo.id, other).every((hint) => !hint.stale));
  assert.equal(backfillNotePaths(db), 0);
});

test("record_note paths: 절대경로는 레포 기준으로, repo를 안 주면 작업 레포에 묶는다", async () => {
  const db = memoryDb();
  const dir = sampleRepo("noted-tool");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const target = (db.prepare("SELECT path FROM code_files WHERE repo_id = ? ORDER BY path LIMIT 1").get(repo.id) as { path: string }).path;
  const recorded = (await callTool({ db, me: [], cwd: dir }, "record_note", { text: "제약: 외부 API는 초당 5회", paths: [path.join(dir, target)] })) as { paths?: string[] };
  assert.deepEqual(recorded.paths, [target]);
  const row = db.prepare("SELECT repo_id FROM notes ORDER BY id DESC LIMIT 1").get() as { repo_id: number };
  assert.equal(row.repo_id, repo.id);
  await assert.rejects(callTool({ db, me: [], cwd: dir }, "record_note", { text: "x", paths: "a.ts" }), /문자열 배열/);
  assert.ok(TOOLS.find((tool) => tool.name === "record_note")!.inputSchema.properties.paths, "스키마에 paths가 있어야 한다");
});

test("notes rules: 폴더에 묶은 규칙은 아래 파일마다 먼저 보이고, 규칙이 바뀌면 supersedes로 갈아 끼워 옛 규칙은 훅에서 사라지고 검색에만 남는다", async () => {
  const { notesForFile, ruleNotes } = await import("../src/core/notes.js");
  const { formatFileContext, fileContext } = await import("../src/core/context.js");
  const db = memoryDb();
  const dir = makeRepo(
    [{ message: "feat: 시작", files: { "src/core/a.ts": "export const a = 1;\n", "src/core/deep/b.ts": "export const b = 1;\n", "src/other.ts": "export const o = 1;\n" } }],
    "ruled",
  );
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);

  // 폴더: 끝에 "/"가 없어도 레포의 폴더면 폴더로 묶는다. blob은 없다
  const rule = addNote(db, { text: "규칙: core에서는 db를 직접 열지 않는다\nopenDb는 cli·mcp에서만", repoId: repo.id, tags: ["rule"], paths: ["src/core"], source: "cli" });
  assert.deepEqual(JSON.parse(rule.paths), [{ path: "src/core/", blob: null }]);
  const plain = addNote(db, { text: "교훈: a.ts는 순서에 민감", repoId: repo.id, paths: ["src/core/a.ts"], source: "cli" });

  // 규칙이 먼저, 폴더 아래 깊은 파일에도, 폴더 밖 파일에는 없다
  assert.deepEqual(
    notesForFile(db, repo.id, "src/core/a.ts").map((hint) => [hint.id, hint.rule, hint.stale]),
    [
      [rule.id, true, false],
      [plain.id, false, false],
    ],
  );
  assert.deepEqual(notesForFile(db, repo.id, "src/core/deep/b.ts").map((hint) => hint.id), [rule.id]);
  assert.equal(notesForFile(db, repo.id, "src/other.ts").length, 0);
  assert.match(formatFileContext(fileContext(db, repo.id, "src/core/a.ts"), { lean: true }), new RegExp(`Notes: #${rule.id} rule "규칙: core에서는`));

  // 규칙이 바뀌었다 — 새 노트가 옛 노트를 대신한다. paths·tags를 안 주면 물려받는다
  const changed = addNote(db, { text: "규칙: core에서 db를 열 때는 openDbReadOnly만", repoId: repo.id, supersedes: rule.id, source: "mcp" });
  assert.equal(changed.tags, "rule");
  assert.deepEqual(JSON.parse(changed.paths), [{ path: "src/core/", blob: null }]);
  assert.equal((db.prepare("SELECT superseded_by FROM notes WHERE id = ?").get(rule.id) as { superseded_by: number }).superseded_by, changed.id);
  assert.deepEqual(notesForFile(db, repo.id, "src/core/a.ts").map((hint) => hint.id), [changed.id, plain.id], "옛 규칙은 더 안 보인다");
  assert.deepEqual(ruleNotes(db, repo.id).map((item) => item.id), [changed.id]);
  // 검색에는 남고, 대신한 노트가 표시된다
  const hits = search(db, "core db", { kind: "note" }).hits;
  assert.equal(hits.find((hit) => hit.ref === String(rule.id))?.supersededBy, changed.id);
  assert.equal(hits.find((hit) => hit.ref === String(changed.id))?.supersededBy, undefined);
  // 이미 대신된 노트는 다시 대신할 수 없다, 없는 노트도
  assert.throws(() => addNote(db, { text: "x", supersedes: rule.id, source: "cli" }), /이미 #/);
  assert.throws(() => addNote(db, { text: "x", supersedes: 9999, source: "cli" }), /없습니다/);

  // 레포 전체 규칙(경로 없음)은 ruleNotes(…, [])로만, 파일 규칙은 그 파일(또는 조상 폴더)로
  const wide = addNote(db, { text: "규칙: 커밋 제목은 한국어", repoId: repo.id, tags: ["rule"], paths: [], source: "cli" });
  assert.deepEqual(ruleNotes(db, repo.id, []).map((item) => item.id), [wide.id]);
  assert.deepEqual(ruleNotes(db, repo.id, ["src/core/deep/b.ts"]).map((item) => item.id), [changed.id]);
  assert.deepEqual(ruleNotes(db, repo.id, ["src/other.ts"]).map((item) => item.id), []);
});

test("record_note supersedes: 옛 노트의 레포·경로를 물려받고, 같은 경로에 규칙이 이미 있으면 알린다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/ui/Button.tsx": "export const Button = 1;\n", "src/ui/Input.tsx": "export const Input = 1;\n" } }], "ruled-tool");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const context = { db, me: [], cwd: dir };
  type Recorded = { id: number; paths?: string[]; supersedes?: number; existingRules?: string[]; warning?: string };

  const first = (await callTool(context, "record_note", { text: "규칙: 버튼은 ui/Button을 쓴다", tags: ["rule"], paths: ["src/ui/"], repo: "ruled-tool" })) as Recorded;
  assert.deepEqual(first.paths, ["src/ui/"]);
  assert.equal(first.existingRules, undefined);

  // 같은 폴더에 규칙을 또 남기면(supersedes 없이) 있는 규칙을 알린다 — 저장은 된다
  const second = (await callTool(context, "record_note", { text: "규칙: ui는 forwardRef 필수", tags: ["rule"], paths: ["src/ui/Input.tsx"], repo: "ruled-tool" })) as Recorded;
  assert.deepEqual(second.existingRules, [`#${first.id} "규칙: 버튼은 ui/Button을 쓴다" (src/ui/)`]);
  assert.match(second.warning!, /supersedes/);
  // 규칙이 아닌 노트는 알리지 않는다
  const plain = (await callTool(context, "record_note", { text: "메모", paths: ["src/ui/Input.tsx"], repo: "ruled-tool" })) as Recorded;
  assert.equal(plain.existingRules, undefined);

  // 바꿔 끼우기 — repo·paths를 안 줘도 옛 노트에서 물려받는다, 작업 폴더 밖에서 불러도
  const replaced = (await callTool({ db, me: [], cwd: os.tmpdir() }, "record_note", { text: "규칙: 버튼은 ui/Button, 링크는 ui/Link", supersedes: first.id })) as Recorded;
  assert.equal(replaced.supersedes, first.id);
  assert.deepEqual(replaced.paths, ["src/ui/"]);
  assert.equal(replaced.existingRules, undefined, "자기 자신과 다른 경로의 규칙(Input.tsx)은 어긋나지 않는다");
  assert.equal((db.prepare("SELECT repo_id FROM notes WHERE id = ?").get(replaced.id) as { repo_id: number }).repo_id, repo.id);
  await assert.rejects(callTool(context, "record_note", { text: "x", supersedes: "1" }), /정수/);
  await assert.rejects(callTool(context, "record_note", { text: "x", supersedes: 9999 }), ToolError);
  assert.ok(TOOLS.find((tool) => tool.name === "record_note")!.inputSchema.properties.supersedes, "스키마에 supersedes가 있어야 한다");
});
