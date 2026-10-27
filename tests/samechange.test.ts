import assert from "node:assert/strict";
import { test } from "node:test";

import { bindToCommit, commitContextOf, recordPrompt, sameChangeShas, whyLine } from "../src/core/capture";
import { changeKey, cochangeOf, fileContext } from "../src/core/context";
import { headSha } from "../src/core/git";
import { addRepo, syncRepo } from "../src/core/indexer";
import { search } from "../src/core/search";
import { callTool } from "../src/mcp/tools";
import { addCommit, git, makeRepo, memoryDb } from "./helpers";

/**
 * PR을 squash로 합치는 흐름 — 같은 변경이 브랜치 원본 커밋과 main의 "(#N)" 커밋으로 두 번 남는다.
 * fix 두 건을 이렇게 만들고, 브랜치 원본 sha들을 돌려준다.
 */
async function squashRepo() {
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 0;\n", "src/b.ts": "export const b = 0;\n" }, date: "2025-01-01T10:00:00+09:00" }], "squash");
  const branchShas: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const files = { "src/a.ts": `export const a = ${i};\n`, "src/b.ts": `export const b = ${i};\n` };
    const date = new Date(Date.now() - (10 - i) * 86_400_000).toISOString();
    git(dir, ["checkout", "-q", "-b", `fix-${i}`]);
    addCommit(dir, { message: `fix(a): 경계값 ${i}`, files, date });
    branchShas.push((await headSha(dir))!);
    git(dir, ["checkout", "-q", "main"]);
    // squash 머지: 같은 내용, 제목 끝에 PR 번호
    addCommit(dir, { message: `fix(a): 경계값 ${i} (#${i + 10})`, files, date: new Date(Date.now() - (9 - i) * 86_400_000).toISOString() });
  }
  return { dir, branchShas };
}

test("changeKey: PR 번호 접미와 파일 순서는 무시하고, 파일 집합이 다르면 다른 변경", () => {
  assert.equal(changeKey("fix: x (#12)", ["b", "a"]), changeKey("fix: x", ["a", "b"]));
  assert.notEqual(changeKey("fix: x", ["a"]), changeKey("fix: x", ["a", "b"]));
  assert.notEqual(changeKey("fix: x", ["a"]), changeKey("fix: y", ["a"]));
});

test("squash 중복: 공변경·최근 커밋·취약도가 같은 변경을 한 번만 센다", async () => {
  const { dir, branchShas } = await squashRepo();
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  // 브랜치 원본과 squash 커밋이 모두 색인됐고 같은 키다
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?").get(repo.id) as { n: number }).n, 5);
  assert.equal(sameChangeShas(db, repo.id, branchShas[0]).length, 1);

  // 공변경: 시작 커밋 1 + fix 2건 = 3 (중복을 세면 5)
  assert.equal(cochangeOf(db, repo.id, "src/a.ts", { minSupport: 1 }).find((item) => item.path === "src/b.ts")?.support, 3);

  const ctx = fileContext(db, repo.id, "src/a.ts");
  const subjects = ctx.recent.map((line) => line.subject.replace(/\s*\(#\d+\)$/, ""));
  assert.deepEqual(subjects, ["fix(a): 경계값 2", "fix(a): 경계값 1", "feat: 시작"], "같은 수정이 두 번 보이면 안 됩니다");
  assert.match(ctx.recent[0].subject, /\(#12\)$/, "대표는 최신(main의 squash 커밋)");
  // 취약도: 최근 90일 fix 2건 / 전체 2건 (중복을 세면 4/4)
  assert.deepEqual(ctx.fragile && { fixes: ctx.fragile.fixes, total: ctx.fragile.total }, { fixes: 2, total: 2 });
});

test("squash 중복: 워크트리 브랜치 커밋에 묶인 '왜'를 main의 squash 커밋에서도 찾는다", async () => {
  const { dir, branchShas } = await squashRepo();
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  // 세션은 브랜치 커밋(fix-2)에 묶였다 — 워크트리에서 커밋한 그대로
  recordPrompt(db, "s1", repo.id, "음수가 들어오면 경계값이 깨져서 0으로 막자");
  bindToCommit(db, { sessionId: "s1", repoId: repo.id, sha: branchShas[1], files: ["src/a.ts", "src/b.ts"], addedHashes: new Set() });
  const squashSha = (await headSha(dir))!;
  assert.notEqual(squashSha, branchShas[1]);

  assert.deepEqual(commitContextOf(db, repo.id, squashSha)?.prompts, ["음수가 들어오면 경계값이 깨져서 0으로 막자"]);
  assert.equal(whyLine(db, repo.id, squashSha), "음수가 들어오면 경계값이 깨져서 0으로 막자");
  const ctx = fileContext(db, repo.id, "src/a.ts");
  assert.equal(ctx.why?.text, "음수가 들어오면 경계값이 깨져서 0으로 막자");
  assert.equal(ctx.why?.sha, squashSha, "보여 주는 sha는 main에 남은 커밋");

  // 검색: 접힌 결과(대표 = squash 커밋)에 why가 실린다
  const hit = search(db, "경계값 2").hits.find((item) => item.kind === "commit");
  assert.equal(hit?.ref, squashSha);
  assert.equal(hit?.why, "음수가 들어오면 경계값이 깨져서 0으로 막자");
  const shown = (await callTool({ db, me: [], cwd: dir }, "show_commit", { sha: squashSha.slice(0, 10) })) as { why?: { prompts?: string[] } };
  assert.deepEqual(shown.why?.prompts, ["음수가 들어오면 경계값이 깨져서 0으로 막자"]);
});

test("옛 DB: change_key가 비어 있던 커밋도 동기화 때 채워지고 공변경이 다시 만들어진다", async () => {
  const { dir } = await squashRepo();
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  // 마이그레이션 7 직후를 흉내 — 키를 지우고 공변경 표를 비운다
  db.exec("UPDATE commits SET change_key = NULL; DELETE FROM cochange; DELETE FROM file_touches; DELETE FROM cochange_seen;");
  addCommit(dir, { message: "docs: 메모", files: { "NOTES.md": "x\n" } }); // 동기화가 돌도록 새 커밋 하나
  await syncRepo(db, repo);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM commits WHERE change_key IS NULL").get() as { n: number }).n, 0);
  assert.equal(cochangeOf(db, repo.id, "src/a.ts", { minSupport: 1 }).find((item) => item.path === "src/b.ts")?.support, 3);
});

test("squash 중복: 세션 기록과 트레일러를 서로 다른 형제 커밋에서 따로 빌려 온다", async () => {
  const { dir, branchShas } = await squashRepo();
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  recordPrompt(db, "s1", repo.id, "경계값 0으로 막자");
  bindToCommit(db, { sessionId: "s1", repoId: repo.id, sha: branchShas[1], files: ["src/a.ts", "src/b.ts"], addedHashes: new Set() });
  const squashSha = (await headSha(dir))!;
  // 같은 변경의 세 번째 커밋(예: 다시 쓴 메시지로 cherry-pick) — 가장 최신이고 트레일러만 있다
  const fake = "f".repeat(40);
  db.prepare(
    `INSERT INTO commits (sha, repo_id, author_name, author_email, authored_at, subject, body, files_changed, insertions, deletions, meaningful, change_key)
     SELECT ?, repo_id, author_name, author_email, '2999-01-01T00:00:00Z', subject, body, files_changed, insertions, deletions, meaningful, change_key
       FROM commits WHERE repo_id = ? AND sha = ?`,
  ).run(fake, repo.id, squashSha);
  db.prepare("INSERT INTO commit_context (repo_id, sha, kind, text, ord) VALUES (?, ?, 'trailer:tested', 'npm test', 0)").run(repo.id, fake);
  assert.equal(sameChangeShas(db, repo.id, squashSha)[0], fake, "트레일러만 있는 형제가 먼저 보인다");

  const view = commitContextOf(db, repo.id, squashSha);
  assert.deepEqual(view?.prompts, ["경계값 0으로 막자"], "트레일러를 찾았다고 세션 기록 찾기를 멈추면 안 됩니다");
  assert.deepEqual(view?.trailers.map((trailer) => trailer.value), ["npm test"]);
});

test("옛 버전이 다시 채운 공변경(중복 거르기 기록 없음)은 다음 동기화에서 걸러 다시 만든다", async () => {
  const { needsCochangeBackfill } = await import("../src/core/context.js");
  const { dir } = await squashRepo();
  const db = memoryDb();
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const support = () => cochangeOf(db, repo.id, "src/a.ts", { minSupport: 1 }).find((item) => item.path === "src/b.ts")?.support;
  assert.equal(support(), 3);
  assert.equal(needsCochangeBackfill(db, repo.id), false);
  // 0.7.x가 업그레이드 중에 표를 다시 채운 상태를 흉내 — 지지도가 부풀고 cochange_seen은 없다
  db.exec("UPDATE cochange SET support = support * 2; DELETE FROM cochange_seen;");
  assert.equal(needsCochangeBackfill(db, repo.id), true);
  addCommit(dir, { message: "docs: 메모", files: { "NOTES.md": "x\n" } });
  await syncRepo(db, repo);
  assert.equal(support(), 3, "다시 만들어 중복이 걸러져야 합니다");
  assert.equal(needsCochangeBackfill(db, repo.id), false);
});
