/**
 * git 호출과 출력 파싱.
 *
 * 쉘을 거치지 않고 `execFile`로 git을 직접 부른다 — 인자에 사용자 입력이 섞여도 주입이 안 된다.
 * 파싱 함수는 순수 함수라 테스트에서 고정 문자열로 검증한다.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const MAX_BUFFER = 256 * 1024 * 1024;
/**
 * git 한 번의 시간 상한 — 네트워크 파일시스템·잠긴 index.lock 등으로 git이 멈춰도 호출이 영원히 붙잡히지 않게.
 * 넘기면 자식을 죽이고 실패로 돌려준다.
 */
export const GIT_TIMEOUT_MS = 60_000;
/**
 * 이력·트리 전체를 훑는 명령(전체 sha 목록·커밋 묶음·ls-tree·cat-file 등)의 시간 상한.
 * 아주 큰 레포나 느린 파일시스템에서는 1분을 정당하게 넘길 수 있다 — 여기서 끊으면 기준점이 갱신되지 않아
 * 다음 동기화도 같은 데서 끊긴다. 목적은 "멈춘 git이 영원히 붙잡지 않게"이지 "동기화를 1분 안에"가 아니다.
 */
export const GIT_BULK_TIMEOUT_MS = 10 * 60_000;

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

/** 요청이 취소돼 멈춘 작업 — MCP 응답에서는 "요청이 취소되었습니다"로 바꾼다 */
export class CancelledError extends Error {
  override name = "AbortError";
  constructor() {
    super("요청이 취소되었습니다");
  }
}

/** signal이 이미 취소됐으면 CancelledError를 던진다 (git 실패를 삼키는 함수 뒤에 확인용으로 둔다) */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * git 실패를 감싼다 — 메시지는 사람이 읽을 문장, 원래 오류(code: ENOENT·maxBuffer 등)는 cause로 남겨
 * MCP 응답에서 알려진 원인을 골라낼 수 있게 한다.
 */
export function gitError(command: string, cwd: string, error: Error, stderr: string, signal?: AbortSignal): Error {
  if (signal?.aborted) return new CancelledError();
  return new Error(`git ${command} 실패 (${cwd}): ${stderr.trim() || error.message}`, { cause: error });
}

/**
 * git을 쉘 없이 부른다. signal이 취소되거나 timeoutMs(기본 GIT_TIMEOUT_MS)를 넘기면 자식을 죽인다.
 * signal은 그 요청을 위해 하는 일에만 넘긴다 — 뒤에서 도는 동기화는 한 요청의 취소로 멈추면 안 된다.
 * 이력·트리 규모의 명령은 GIT_BULK_TIMEOUT_MS를 넘긴다.
 */
export function runGit(
  cwd: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const child = execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: "utf8", timeout: timeoutMs, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(gitError(args[0], cwd, error, stderr, signal));
          return;
        }
        resolve(stdout);
      },
    );
    // 자식이 일찍 죽으면 stdin 쓰기가 EPIPE를 낸다 — 실패는 위 콜백이 알린다
    child.stdin?.on("error", () => undefined);
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/**
 * 작업 트리의 최상위(top)와, 그것이 `git worktree`로 만든 추가 작업 트리라면 본 레포의 최상위(main).
 * 추가 작업 트리는 커밋 저장소(--git-common-dir)를 본 레포와 함께 쓰므로, 기억은 본 레포 하나로 묶는다 —
 * Claude Code는 세션마다 `.claude/worktrees/<이름>`을 만들어서, 그대로 두면 같은 레포가 세션 수만큼 등록된다.
 * 서브모듈(common dir이 `.git/modules/x`)이나 bare 레포는 main = top. git 레포가 아니면 null.
 */
export async function worktreeRoots(dir: string, signal?: AbortSignal): Promise<{ top: string; main: string } | null> {
  let out: string;
  try {
    out = await runGit(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], undefined, signal);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    // --path-format은 git 2.31부터 — 옛 git이거나 레포가 아니면 최상위만
    const top = await repoRoot(dir, signal);
    return top ? { top, main: top } : null;
  }
  const [topLine, commonLine] = out.trim().split(/\r?\n/);
  if (!topLine) return null;
  const top = path.resolve(topLine);
  const common = commonLine ? path.resolve(commonLine) : "";
  const main = common && path.basename(common) === ".git" ? path.dirname(common) : top;
  return { top, main };
}

/** 본 레포의 최상위 — 추가 작업 트리 안이면 본 레포로 올라간다 (worktreeRoots) */
export async function mainRepoRoot(dir: string, signal?: AbortSignal): Promise<string | null> {
  return (await worktreeRoots(dir, signal))?.main ?? null;
}

/** 경로가 속한 작업 트리의 최상위 디렉터리. git 레포가 아니면 null. */
export async function repoRoot(dir: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return path.resolve((await runGit(dir, ["rev-parse", "--show-toplevel"], undefined, signal)).trim());
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return null;
  }
}

export async function remoteUrl(dir: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const url = (await runGit(dir, ["remote", "get-url", "origin"], undefined, signal)).trim();
    return url || null;
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return null;
  }
}

/** 브랜치·태그·원격 브랜치에서 닿는 머지 아닌 커밋의 sha 전체 */
export async function listShas(dir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const out = await runGit(dir, [
      "log",
      "--branches",
      "--tags",
      "--remotes",
      "--no-merges",
      "--format=%H",
    ], undefined, signal, GIT_BULK_TIMEOUT_MS);
    return out.split("\n").filter(Boolean);
  } catch (error) {
    // 커밋이 하나도 없는 새 레포
    if (/does not have any commits|bad default revision/.test(String(error))) return [];
    throw error;
  }
}

/**
 * 브랜치·태그·원격 브랜치의 끝 커밋들 (정렬). 다음 동기화의 기준점으로 저장해 두고,
 * 그 뒤에 생긴 커밋만 `listNewShas`로 받는다.
 */
export async function refTips(dir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const out = await runGit(dir, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/tags", "refs/remotes"], undefined, signal);
    return [...new Set(out.split("\n").filter(Boolean))].sort();
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return [];
  }
}

/**
 * 지난번 끝 커밋들(oldTips)에서 닿지 않는 새 커밋만. 전체 sha 목록을 매번 받아 DB와 비교하지 않아도 된다.
 * oldTips 중 하나라도 사라졌으면(gc된 rebase 이전 커밋 등) git이 실패한다 — 호출부가 전체 목록으로 돌아간다.
 */
export async function listNewShas(dir: string, oldTips: string[], signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(
    dir,
    ["rev-list", "--no-merges", "--branches", "--tags", "--remotes", "--stdin"],
    ["--not", ...oldTips].join("\n") + "\n",
    signal,
    GIT_BULK_TIMEOUT_MS,
  );
  return out.split("\n").filter(Boolean);
}

/** HEAD의 트리 sha — 그대로면 현재 코드 색인을 다시 볼 필요가 없다. 커밋이 없으면 null */
export async function headTree(dir: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], undefined, signal)).trim() || null;
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return null;
  }
}

/**
 * 주어진 sha들의 메타 + 변경 파일 경로.
 * 줄 수(`--numstat`)는 blob 내용을 diff해야 해서 경로만 읽는 것보다 열 배쯤 느리다 — 색인에는 경로만 쓰고,
 * 줄 수는 `show_commit` 때 그 커밋만 `lineCounts`로 센다.
 */
export async function readCommits(dir: string, shas: string[], signal?: AbortSignal): Promise<GitCommit[]> {
  if (shas.length === 0) return [];
  const out = await runGit(
    dir,
    ["log", "--no-walk=unsorted", "--stdin", "--name-status", `--format=${LOG_FORMAT}`],
    shas.join("\n") + "\n",
    signal,
    GIT_BULK_TIMEOUT_MS,
  );
  return parseLog(out);
}

/**
 * 커밋 하나의 파일별 추가·삭제 줄 수 (바이너리는 null).
 * `--no-ext-diff --no-textconv`: 사용자 git 설정의 외부 diff·textconv 명령을 돌리지 않는다 (출력 형식도 그대로).
 */
export async function lineCounts(dir: string, sha: string, signal?: AbortSignal): Promise<GitFileChange[]> {
  return parseNumstat(await runGit(dir, ["show", "--numstat", "--no-ext-diff", "--no-textconv", "--format=", sha], undefined, signal));
}

/** `LOG_FORMAT` + `--name-status`(또는 `--numstat`) 출력 → 커밋 목록 */
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
      files: parseChangedFiles(numstat),
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

/**
 * 커밋 레코드 뒤의 파일 목록. `--name-status`("M\tpath", "R100\told\tnew")는 줄 수 없이 경로만,
 * `--numstat`("3\t1\tpath")은 줄 수까지 준다. 둘 다 받아들인다.
 */
export function parseChangedFiles(text: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    const status = /^[ACDMRTUXB]\d*\t(.+)$/.exec(trimmed);
    if (status) {
      const fields = status[1].split("\t");
      files.push({ path: unquotePath(fields[fields.length - 1]), insertions: null, deletions: null });
      continue;
    }
    files.push(...parseNumstat(trimmed));
  }
  return files;
}

/** git이 따옴표로 감싼 경로("a\"b.ts") → 원래 경로. core.quotepath=off라 한글은 그대로 오고 제어 문자만 이스케이프된다. */
export function unquotePath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  return raw.slice(1, -1).replace(/\\(["\\tnr])/g, (_, ch: string) => ({ t: "\t", n: "\n", r: "\r" })[ch] ?? ch);
}

export function parseNumstat(text: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    files.push({
      path: unquotePath(renamedTarget(match[3])),
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

export interface PatchLines {
  /** 앞쪽 빈 줄을 뺀 diff 줄 (최대 maxLines) */
  lines: string[];
  /** maxLines보다 길어 뒤를 읽지 않았다 */
  truncated: boolean;
}

/**
 * 커밋 하나의 패치 앞쪽 maxLines줄. 메타데이터(작성자·메시지)는 DB에 있으므로 헤더 없이 diff만 뽑는다.
 * paths를 주면 그 경로의 변경만. 레포가 사라졌으면 호출부에서 처리한다.
 * 출력을 한 줄씩 흘려 받다가 maxLines를 넘으면 git을 끝낸다 — 수백 MB짜리 커밋도 메모리에 다 올리지 않는다.
 * `--no-ext-diff --no-textconv`: 사용자 git 설정의 외부 diff·textconv 명령을 돌리지 않는다.
 */
export function showCommit(
  dir: string,
  sha: string,
  paths: string[] = [],
  options: { maxLines: number; signal?: AbortSignal },
): Promise<PatchLines> {
  const { maxLines, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const args = ["show", "--format=", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", sha, "--", ...paths];
    const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      signal,
    });
    const lines: string[] = [];
    let truncated = false;
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ lines, truncated });
    };
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on("line", (line) => {
      if (truncated) return;
      if (lines.length === 0 && line === "") return; // --format=가 남기는 앞쪽 빈 줄
      if (lines.length < maxLines) {
        lines.push(line);
        return;
      }
      // 한 줄 더 있다 = 잘린다. 나머지는 읽지 않고 git을 끝낸다
      truncated = true;
      reader.close();
      child.kill();
    });
    child.on("error", (error) => finish(gitError("show", dir, error, stderr, signal)));
    child.on("close", (code) => {
      // 잘라서 우리가 끝낸 것이면 성공이다
      if (truncated || code === 0) finish(null);
      else {
        const reason = code === null ? `${GIT_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단` : `종료 코드 ${code}`;
        finish(gitError("show", dir, new Error(reason), stderr, signal));
      }
    });
  });
}

/** 커밋 diff에 새로 들어간 줄들 (소스 파일만, 머리 줄 제외) — 세션의 편집이 커밋에 남았는지 대조하는 데 쓴다 */
export async function addedLines(dir: string, sha: string, maxLines = 5_000): Promise<string[]> {
  const out = await runGit(dir, ["show", "--format=", "--unified=0", "--no-color", "--no-ext-diff", sha]);
  const lines: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push(line.slice(1));
      if (lines.length >= maxLines) break;
    }
  }
  return lines;
}

/** HEAD의 sha */
/**
 * 작업 폴더에서 아직 커밋되지 않은 변경이 있는 파일(수정·추가·미추적, 레포 기준 경로). 못 읽으면 null.
 * 커밋 직후에 부르면 "이번 커밋에 안 들어갔지만 아직 작업 중인 파일"이 된다.
 */
/** 스테이징된 파일 (레포 최상위 기준) — 읽지 못하면 null */
export async function stagedFiles(dir: string): Promise<string[] | null> {
  try {
    return (await runGit(dir, ["-c", "core.quotepath=off", "diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

export async function dirtyFiles(dir: string): Promise<Set<string> | null> {
  let out: string;
  try {
    out = await runGit(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch {
    return null;
  }
  const files = new Set<string>();
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    files.add(entry.slice(3));
    // 이름 바꾸기·복사는 다음 칸이 옛 경로
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

/** 커밋의 committer 시각(ms). 못 읽으면 null */
export async function commitTime(dir: string, sha: string): Promise<number | null> {
  try {
    const seconds = Number((await runGit(dir, ["log", "-1", "--format=%ct", sha])).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

export async function headSha(dir: string): Promise<string | null> {
  try {
    return (await runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** HEAD에 있는 파일 경로 전체 */
export async function listFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    return (await runGit(dir, ["ls-files"], undefined, signal, GIT_BULK_TIMEOUT_MS)).split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return [];
  }
}

export async function readFileAtHead(dir: string, file: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await runGit(dir, ["show", `HEAD:${file}`], undefined, signal, GIT_BULK_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
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
