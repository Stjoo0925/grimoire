/**
 * 커밋 diff에서 **바뀐 선언**(함수·클래스·타입 이름, hunk 머리의 함수 맥락)을 뽑는다.
 *
 * 쓰임은 둘이다.
 *  1. 검색 결과에 "이 커밋이 무엇을 건드렸나"를 싣는다(`commits.symbols`) — AI가 diff를 열어 보지 않고도
 *     답의 윤곽을 잡아, 이력 질문이 show_commit 왕복 없이 끝나게.
 *  2. 이름을 `docs_fts.code`에 넣어, 제목·본문·경로로 모자랄 때만 채움용으로 찾는다(search.ts) — 지금 코드에도
 *     메시지에도 없는 "지워진 함수" 같은 질문.
 * 바뀐 줄의 식별자 전부를 순위에 섞는 방식(Locus, ASE 2016)도 재 봤다. 89문항 평가에서 Acc@3이 오르는 경향은
 * 있지만 유의하지 않고(p=0.07) 검색이 3배 넘게 느려져, 지금은 쓰지 않는다 (docs/improvement-plan.md §7).
 *
 * 메타 색인(indexer.ts)과 단계를 나눈다: 커밋 메타는 먼저 넣어 바로 검색되게 하고, diff는 뒤에서 채운다
 * (`commits.code_state`: 0 = 아직, 1 = 끝). 소스 파일만, 커밋·파일당 줄 수 상한을 둔다.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

import { extractSymbols, isIndexable, SOURCE_EXT, splitIdentifier } from "./code";
import type { DB } from "./db";

/** git 한 번에 넘길 커밋 수 (쓰기 트랜잭션 단위이기도 하다) */
const BATCH = 200;
/** 파일 하나에서 읽는 바뀐 줄 수 상한 — 생성물·대량 이동이 색인을 부풀리지 않게 */
const LINES_PER_FILE = 400;
/** 커밋 하나에서 읽는 바뀐 줄 수 상한 */
const LINES_PER_COMMIT = 3000;
/** 커밋 하나의 색인 이름 수 상한 */
const NAMES_PER_COMMIT = 200;
/** commits.symbols에 남길 파일 수와 파일당 심볼 수 */
const SYMBOL_FILES = 6;
const SYMBOLS_PER_FILE = 6;
const LONG_LINE = 400;

export interface CommitCode {
  sha: string;
  /** docs_fts.code에 넣을 이름들 — 원형과 낱말로 쪼갠 꼴 (공백 구분) */
  words: string;
  /** 바뀐 선언: 파일별 이름 */
  symbols: { file: string; names: string[] }[];
}

interface FileAcc {
  path: string;
  lines: number;
  names: string[];
}

/** 커밋 하나의 diff 읽기 상태 */
class CommitAcc {
  readonly files: FileAcc[] = [];
  lines = 0;
  constructor(readonly sha: string) {}

  addNames(file: FileAcc, text: string): void {
    for (const symbol of extractSymbols(text)) {
      if (!file.names.includes(symbol.name)) file.names.push(symbol.name);
    }
  }

  finish(): CommitCode {
    const words = new Set<string>();
    for (const word of this.files.flatMap((file) => file.names).slice(0, NAMES_PER_COMMIT)) {
      words.add(word.toLowerCase());
      for (const part of splitIdentifier(word).split(" ")) if (part.length >= 3) words.add(part);
    }
    return {
      sha: this.sha,
      words: [...words].join(" "),
      symbols: this.files
        .filter((file) => file.names.length > 0)
        .slice(0, SYMBOL_FILES)
        .map((file) => ({ file: file.path, names: file.names.slice(0, SYMBOLS_PER_FILE) })),
    };
  }
}

/** git이 경로를 따옴표로 감쌌으면 푼다 ("a\"b.ts") */
function unquote(raw: string): string {
  if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
  return raw.slice(1, -1).replace(/\\(["\\tnr])/g, (_, ch: string) => ({ t: "\t", n: "\n", r: "\r" })[ch] ?? ch);
}

/**
 * `git log -p -U0 --format=<RS>%H` 출력을 한 줄씩 받아 커밋별로 모은다 (순수 상태 기계 — 테스트에서 문자열로 검증).
 * 머리(diff --git ~ +++)와 hunk를 구분해, 내용 줄이 "+++"로 시작해도 헤더로 오인하지 않는다.
 */
export class DiffParser {
  private current: CommitAcc | null = null;
  private file: FileAcc | null = null;
  private inHunk = false;
  private minusPath: string | null = null;
  readonly done: CommitCode[] = [];

  line(text: string): void {
    if (text.startsWith("\x1e")) {
      this.flush();
      this.current = new CommitAcc(text.slice(1).trim());
      return;
    }
    const commit = this.current;
    if (!commit) return;
    if (text.startsWith("diff --git ")) {
      this.inHunk = false;
      this.file = null;
      this.minusPath = null;
      return;
    }
    if (!this.inHunk) {
      if (text.startsWith("--- ")) this.minusPath = text === "--- /dev/null" ? null : unquote(text.slice(4)).replace(/^a\//, "");
      else if (text.startsWith("+++ ")) {
        const plus = text === "+++ /dev/null" ? null : unquote(text.slice(4)).replace(/^b\//, "");
        const target = plus ?? this.minusPath;
        this.file = target && isIndexable(target, 0) ? { path: target, lines: 0, names: [] } : null;
        if (this.file) commit.files.push(this.file);
      } else if (text.startsWith("@@")) this.hunk(text);
      return;
    }
    if (text.startsWith("@@")) {
      this.hunk(text);
      return;
    }
    const file = this.file;
    if (!file || (text[0] !== "+" && text[0] !== "-")) return;
    if (file.lines >= LINES_PER_FILE || commit.lines >= LINES_PER_COMMIT || text.length > LONG_LINE) return;
    file.lines++;
    commit.lines++;
    commit.addNames(file, text.slice(1));
  }

  /** "@@ -1,2 +3,4 @@ export function foo(" — 뒤의 함수 맥락도 이 커밋이 건드린 곳이다 */
  private hunk(text: string): void {
    this.inHunk = true;
    const context = /^@@[^@]*@@ ?(.*)$/.exec(text)?.[1] ?? "";
    if (context && this.file && this.current) this.current.addNames(this.file, context.trimStart());
  }

  flush(): void {
    if (this.current) this.done.push(this.current.finish());
    this.current = null;
    this.file = null;
    this.inHunk = false;
  }
}

/** 커밋들의 diff를 git에서 흘려 받아 식별자를 뽑는다 (출력을 메모리에 다 올리지 않는다) */
export function readCommitCode(dir: string, shas: string[]): Promise<CommitCode[]> {
  return new Promise((resolve, reject) => {
    const pathspecs = [...SOURCE_EXT].map((ext) => `*${ext}`);
    const child = spawn(
      "git",
      [
        "-c", "core.quotepath=off",
        "log", "--no-walk=unsorted", "--stdin", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames",
        "--format=%x1e%H", "--", ...pathspecs,
      ],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
    );
    const parser = new DiffParser();
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => parser.line(line));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git log -p 실패 (${dir}): ${stderr.trim() || code}`));
        return;
      }
      parser.flush();
      resolve(parser.done);
    });
    child.stdin.end(shas.join("\n") + "\n");
  });
}

/** 같은 레포의 diff 색인은 한 번에 하나만 */
const running = new Map<string, Promise<number>>();

/**
 * 레포의 아직 diff를 안 읽은 커밋(최신부터)을 채운다. 돌려주는 값은 채운 커밋 수.
 * 이미 돌고 있으면 그 작업을 기다린다. 레포가 사라졌거나 git이 실패하면 남은 커밋은 다음 기회로 미룬다.
 */
export function indexCommitCode(db: DB, repo: { id: number; path: string }): Promise<number> {
  const existing = running.get(repo.path);
  if (existing) return existing;
  const job = run(db, repo).finally(() => running.delete(repo.path));
  running.set(repo.path, job);
  return job;
}

async function run(db: DB, repo: { id: number; path: string }): Promise<number> {
  const pending = db.prepare(
    "SELECT sha FROM commits WHERE repo_id = ? AND code_state = 0 ORDER BY authored_at DESC LIMIT ?",
  );
  const docId = db.prepare("SELECT id FROM docs WHERE kind = 'commit' AND repo_id = ? AND ref = ?");
  const setCode = db.prepare("UPDATE docs_fts SET code = ? WHERE rowid = ?");
  const mark = db.prepare("UPDATE commits SET code_state = 1, symbols = ? WHERE repo_id = ? AND sha = ?");
  let total = 0;
  for (;;) {
    const shas = (pending.all(repo.id, BATCH) as { sha: string }[]).map((row) => row.sha);
    if (shas.length === 0) return total;
    const results = new Map((await readCommitCode(repo.path, shas)).map((item) => [item.sha, item]));
    db.transaction(() => {
      for (const sha of shas) {
        // git이 내용 없는 커밋(소스 변경 없음)은 머리만 주거나 아예 빼므로, 결과가 없어도 끝난 것으로 표시한다
        const item = results.get(sha);
        const doc = docId.get(repo.id, sha) as { id: number } | undefined;
        if (doc && item?.words) setCode.run(item.words, doc.id);
        mark.run(item && item.symbols.length > 0 ? JSON.stringify(item.symbols) : null, repo.id, sha);
      }
    })();
    total += shas.length;
  }
}
