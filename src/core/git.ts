/**
 * git 호출과 출력 파싱.
 *
 * 쉘을 거치지 않고 `execFile`로 git을 직접 부른다 — 인자에 사용자 입력이 섞여도 주입이 안 된다.
 * 파싱 함수는 순수 함수라 테스트에서 고정 문자열로 검증한다.
 */
import { execFile } from "node:child_process";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;

/** 레코드/필드 구분자 — 커밋 메시지에 나올 일이 없는 제어 문자 */
const RS = "\x1e";
const FS = "\x1f";
/** `git log --format`: 레코드 시작 · sha · 작성자 · 이메일 · 시각 · 원문 메시지 · 끝 */
export const LOG_FORMAT = `${RS}%H${FS}%an${FS}%ae${FS}%aI${FS}%B${FS}`;

export interface GitFileChange {
  path: string;
  /** 바이너리 파일이면 null */
  insertions: number | null;
  deletions: number | null;
}

export interface GitCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
  files: GitFileChange[];
}

export function runGit(
  cwd: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} 실패 (${cwd}): ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** 경로가 속한 작업 트리의 최상위 디렉터리. git 레포가 아니면 null. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return path.resolve((await runGit(dir, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
}

export async function remoteUrl(dir: string): Promise<string | null> {
  try {
    const url = (await runGit(dir, ["remote", "get-url", "origin"])).trim();
    return url || null;
  } catch {
    return null;
  }
}

/** 브랜치·태그·원격 브랜치에서 닿는 머지 아닌 커밋의 sha 전체 */
export async function listShas(dir: string): Promise<string[]> {
  try {
    const out = await runGit(dir, [
      "log",
      "--branches",
      "--tags",
      "--remotes",
      "--no-merges",
      "--format=%H",
    ]);
    return out.split("\n").filter(Boolean);
  } catch (error) {
    // 커밋이 하나도 없는 새 레포
    if (/does not have any commits|bad default revision/.test(String(error))) return [];
    throw error;
  }
}

/** 주어진 sha들의 메타 + 파일별 변경 줄 수 */
export async function readCommits(dir: string, shas: string[]): Promise<GitCommit[]> {
  if (shas.length === 0) return [];
  const out = await runGit(
    dir,
    ["log", "--no-walk=unsorted", "--stdin", "--numstat", `--format=${LOG_FORMAT}`],
    shas.join("\n") + "\n",
  );
  return parseLog(out);
}

/** `LOG_FORMAT` + `--numstat` 출력 → 커밋 목록 */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const fields = record.split(FS);
    if (fields.length < 6) continue;
    const [sha, authorName, authorEmail, authoredAt, message, numstat] = fields;
    const { subject, body } = splitMessage(message);
    commits.push({
      sha: sha.trim(),
      authorName,
      authorEmail: authorEmail.toLowerCase(),
      authoredAt,
      subject,
      body,
      files: parseNumstat(numstat),
    });
  }
  return commits;
}

export function splitMessage(message: string): { subject: string; body: string } {
  const lines = message.replace(/\r\n/g, "\n").trim().split("\n");
  const subject = (lines[0] ?? "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { subject, body };
}

export function parseNumstat(text: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    files.push({
      path: renamedTarget(match[3]),
      insertions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return files;
}

/** numstat의 이름 변경 표기 → 새 경로. `src/{a => b}/x.ts` → `src/b/x.ts`, `a => b` → `b` */
export function renamedTarget(raw: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, "/");
  }
  const plain = raw.split(" => ");
  return plain.length === 2 ? plain[1] : raw;
}

/** 커밋 하나의 패치 (통계 포함). 레포가 사라졌으면 호출부에서 처리한다. */
export function showCommit(dir: string, sha: string): Promise<string> {
  return runGit(dir, ["show", "--stat", "--patch", "--format=fuller", "--no-color", sha]);
}

/** HEAD에 있는 파일 경로 전체 */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await runGit(dir, ["ls-files"])).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function readFileAtHead(dir: string, file: string): Promise<string | null> {
  try {
    return await runGit(dir, ["show", `HEAD:${file}`]);
  } catch {
    return null;
  }
}

/** 전역 git 설정의 내 이메일 (작성자 "me" 필터의 기본값) */
export async function configuredEmail(dir: string): Promise<string | null> {
  try {
    const email = (await runGit(dir, ["config", "user.email"])).trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
}

/**
 * 원격 URL → 커밋 웹 링크. GitHub·GitLab·Bitbucket류의 https/ssh 표기를 처리하고
 * 모르는 형식이면 null.
 */
export function commitWebUrl(remote: string | null, sha: string): string | null {
  const base = remoteWebBase(remote);
  if (!base) return null;
  return base.includes("bitbucket.org") ? `${base}/commits/${sha}` : `${base}/commit/${sha}`;
}

export function remoteWebBase(remote: string | null): string | null {
  if (!remote) return null;
  let url = remote.trim();
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && !/^[a-z]+:\/\//i.test(url)) {
    url = `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const parsed = new URL(url.replace(/^ssh:\/\//, "https://").replace(/^git:\/\//, "https://"));
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const pathname = parsed.pathname.replace(/\.git$/, "").replace(/\/$/, "");
    if (!pathname || pathname === "/") return null;
    return `https://${parsed.hostname}${pathname}`;
  } catch {
    return null;
  }
}
