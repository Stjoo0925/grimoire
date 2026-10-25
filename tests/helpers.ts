/**
 * 테스트 도우미 — 임시 git 레포와 메모리 DB.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type DB } from "../src/core/db";

export function tempDir(prefix = "grimoire-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface FakeCommit {
  files: Record<string, string>;
  message: string;
  email?: string;
  date?: string;
}

/** 커밋을 순서대로 쌓은 임시 레포를 만든다. */
export function makeRepo(commits: FakeCommit[], name = "sample"): string {
  const dir = path.join(tempDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["remote", "add", "origin", `git@github.com:someone/${name}.git`]);
  for (const commit of commits) addCommit(dir, commit);
  return dir;
}

export function addCommit(dir: string, commit: FakeCommit): void {
  for (const [file, content] of Object.entries(commit.files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(dir, ["add", "-A"]);
  const email = commit.email ?? "me@example.com";
  const date = commit.date ?? "2024-03-01T10:00:00+09:00";
  git(dir, ["commit", "-q", "-m", commit.message], {
    GIT_AUTHOR_NAME: email.split("@")[0],
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: email.split("@")[0],
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  });
}

export function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir, ...env },
  });
}

export function memoryDb(): DB {
  return openDb(":memory:");
}
