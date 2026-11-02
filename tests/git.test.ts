import assert from "node:assert/strict";
import { test } from "node:test";

import { commitWebUrl, LOG_FORMAT, parseChangedFiles, parseLog, parseNumstat, remoteWebBase, renamedTarget, unquotePath } from "../src/core/git";
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

test("parseChangedFiles: --name-status는 경로만(이름 변경은 새 경로), 따옴표 경로는 풀어 준다", () => {
  assert.deepEqual(parseChangedFiles("\n\nM\tsrc/a.ts\nR087\tsrc/old.ts\tsrc/new.ts\nD\tgone.ts\nA\t\"we\\\"ird.ts\"\n"), [
    { path: "src/a.ts", insertions: null, deletions: null },
    { path: "src/new.ts", insertions: null, deletions: null },
    { path: "gone.ts", insertions: null, deletions: null },
    { path: 'we"ird.ts', insertions: null, deletions: null },
  ]);
  // numstat 꼴도 그대로 받는다
  assert.deepEqual(parseChangedFiles("3\t1\tsrc/a.ts\n"), [{ path: "src/a.ts", insertions: 3, deletions: 1 }]);
  assert.equal(unquotePath('"a\\tb.ts"'), "a\tb.ts");
  assert.equal(unquotePath("plain.ts"), "plain.ts");
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

test("색인하는 레포의 .git/config에 적힌 textconv·fsmonitor 명령을 돌리지 않는다", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { addedLines, dirtyFiles, headSha, stagedFiles } = await import("../src/core/git.js");
  const { workingChanges } = await import("../src/core/impact.js");
  const { addRepo, syncRepo } = await import("../src/core/indexer.js");
  const { git, makeRepo, memoryDb, tempDir } = await import("./helpers.js");

  const dir = makeRepo(
    [
      { message: "feat: 시작", files: { ".gitattributes": "* diff=pwn\n", "CLAUDE.md": "# 규칙\n- 테스트를 먼저 쓴다\n", "src/a.ts": "export const a = 1;\n" } },
      { message: "fix: 고침", files: { "CLAUDE.md": "# 규칙\n- 테스트를 먼저 쓴다\n- 커밋은 작게\n", "src/a.ts": "export const a = 2;\n" } },
    ],
    "untrusted-config",
  );
  // 압축본으로 받은 레포처럼 .git/config가 명령을 들고 있다 — 불리면 표식 파일에 한 줄씩 남긴다
  const marker = path.join(tempDir(), "ran.txt");
  const script = path.join(tempDir(), "pwn.js");
  fs.writeFileSync(
    script,
    [
      'const fs = require("fs");',
      `fs.appendFileSync(${JSON.stringify(marker)}, "ran\\n");`,
      "const file = process.argv[2];",
      "if (file && fs.existsSync(file)) process.stdout.write(fs.readFileSync(file));",
    ].join("\n"),
  );
  const slash = (value: string) => value.split(path.sep).join("/");
  const command = `"${slash(process.execPath)}" "${slash(script)}"`;
  git(dir, ["config", "diff.pwn.textconv", command]);
  git(dir, ["config", "core.fsmonitor", command]);
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 3;\n");

  // 준비: git을 그대로 부르면 실제로 돈다
  git(dir, ["log", "-p", "-1"]);
  assert.ok(fs.existsSync(marker), "준비: 설정이 먹혀야 합니다");
  fs.rmSync(marker);

  const db = memoryDb();
  await syncRepo(db, await addRepo(db, dir));
  await addedLines(dir, (await headSha(dir))!);
  await dirtyFiles(dir);
  await stagedFiles(dir);
  await workingChanges(dir);
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0, 0);
});
