import assert from "node:assert/strict";
import { test } from "node:test";

import { commitWebUrl, LOG_FORMAT, parseLog, parseNumstat, remoteWebBase, renamedTarget } from "../src/core/git";
import { isMeaningfulSubject } from "../src/core/meaningful";

test("parseLog: 메시지 본문과 numstat을 레코드별로 나눈다", () => {
  const record = (sha: string, message: string, numstat: string) =>
    LOG_FORMAT.replace("%H", sha)
      .replace("%an", "Me")
      .replace("%ae", "ME@Example.com")
      .replace("%aI", "2024-01-02T03:04:05+09:00")
      .replace("%B", message) + numstat;

  const out =
    record("aaa", "feat: 로그인\n\n세션 쿠키로 바꿈\n", "\n\n10\t2\tsrc/auth.ts\n-\t-\tlogo.png\n") +
    record("bbb", "fix: 오타", "\n\n1\t1\tREADME.md\n");
  const commits = parseLog(out);

  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, "aaa");
  assert.equal(commits[0].subject, "feat: 로그인");
  assert.equal(commits[0].body, "세션 쿠키로 바꿈");
  assert.equal(commits[0].authorEmail, "me@example.com");
  assert.deepEqual(commits[0].files, [
    { path: "src/auth.ts", insertions: 10, deletions: 2 },
    { path: "logo.png", insertions: null, deletions: null },
  ]);
  assert.equal(commits[1].files[0].path, "README.md");
});

test("renamedTarget: 이름 변경 표기에서 새 경로를 꺼낸다", () => {
  assert.equal(renamedTarget("src/{old => new}/a.ts"), "src/new/a.ts");
  assert.equal(renamedTarget("src/{ => lib}/a.ts"), "src/lib/a.ts");
  assert.equal(renamedTarget("a.ts => b.ts"), "b.ts");
  assert.equal(renamedTarget("plain.ts"), "plain.ts");
  assert.equal(parseNumstat("3\t0\tdocs/{a.md => b.md}")[0].path, "docs/b.md");
});

test("remoteWebBase / commitWebUrl: ssh·https 원격을 웹 링크로", () => {
  assert.equal(remoteWebBase("git@github.com:me/repo.git"), "https://github.com/me/repo");
  assert.equal(remoteWebBase("https://github.com/me/repo.git"), "https://github.com/me/repo");
  assert.equal(remoteWebBase("ssh://git@gitlab.com/group/sub/repo.git"), "https://gitlab.com/group/sub/repo");
  assert.equal(remoteWebBase("/local/path/repo"), null);
  assert.equal(remoteWebBase(null), null);
  assert.equal(commitWebUrl("git@github.com:me/repo.git", "abc"), "https://github.com/me/repo/commit/abc");
  assert.equal(commitWebUrl("git@bitbucket.org:me/repo.git", "abc"), "https://bitbucket.org/me/repo/commits/abc");
});

test("isMeaningfulSubject: 머지·잡무 커밋을 거른다", () => {
  assert.equal(isMeaningfulSubject("feat: 검색 추가"), true);
  assert.equal(isMeaningfulSubject("Add rate limiter to collector"), true);
  assert.equal(isMeaningfulSubject("Merge branch 'main' into dev"), false);
  assert.equal(isMeaningfulSubject("chore: bump deps"), false);
  assert.equal(isMeaningfulSubject("typo"), false);
});
