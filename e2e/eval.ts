/**
 * 오프라인 검색 평가 — Claude를 부르지 않고 정확도·답변 가능성·응답 크기·지연을 잰다.
 *
 *   npm run eval                                   bench/eval.local.json(+ eval-*.local.json 질문)의 고정 코퍼스
 *   npm run eval -- --detail index                 search_memory 응답 형태를 바꿔 잼
 *   npm run eval -- --core path/to/dist            다른 빌드(core/, mcp/가 든 폴더)를 잼 — 빌드 사이 비교용
 *   npm run eval -- --label x --save               bench/results/eval-<시각>-x.json에 남김
 *   npm run eval -- --compare a.json b.json        저장한 두 결과를 질문별로 짝지어 비교 (맥니마 검정)
 *   npm run eval -- --repo ~/big-repo --no-questions   색인 속도만
 *
 * 설정 파일(bench/eval.local.json):
 *   { "corpus": [{ "path": "~/work-dir/x", "sha": "<기본 브랜치 40자>", "tips": ["<고정 시점의 태그 끝 커밋>", …] }, …],
 *     "questions": [{ id, repo?, type, q, expect: ["sha 7자 또는 경로 일부", "대안은 a|b"], key?: ["답에 필요한 코드 조각"] }],
 *     "include": ["eval-new.local.json"] }
 *
 * 코퍼스 고정: 원본 레포는 건드리지 않고, 고정한 sha(+ tips)만 가리키는 임시 shared clone(객체는 원본 것을 빌려 씀)을
 * 색인한다. 실제 Grimoire는 브랜치·태그를 모두 보므로, 태그에서만 닿는 커밋도 tips로 남긴다.
 * 레포에 커밋이 쌓여도 같은 코퍼스를 다시 잴 수 있다.
 *
 * 지표
 *  - 찾기(locate): search() 상위 8개 안에서 expect를 모두 담은 첫 결과의 순위 → Acc@1/3/8, MRR.
 *  - 답변 가능성(answerable): MCP와 같은 search_memory 응답 한 번에 정답 근거(expect)가 들어 있나(evidence),
 *    이력 질문은 "어떻게"에 필요한 코드 조각(key)까지 모두 들어 있나. 한 번 검색으로 답할 수 있는지를 LLM 없이 잰다.
 *  - 응답 크기(chars), 검색 지연, 색인 시간, DB 크기.
 *  - 자동 과제(history→file): 커밋 제목 → 그 커밋이 건드린 소스 파일. 제목을 그대로 쓰니 점수가 부풀려진다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { tempDir } from "../tests/helpers";

interface Question {
  id: string;
  repo?: string;
  type: string;
  q: string;
  expect: string[];
  key?: string[];
  source?: string;
}

interface Row {
  id: string;
  type: string;
  /** 찾기 순위 (1부터, 못 찾으면 null) */
  rank: number | null;
  /** 응답에 정답 근거가 있나 */
  evidence: boolean;
  /** key가 있으면: 근거 + key 전부가 응답에 있나 */
  answerable: boolean | null;
  chars: number;
  ms: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Core = { db: any; search: any; indexer: any; diffs: any; tools: any; code: any };

const expandHome = (value: string) => value.replace(/^~(?=$|\/)/, os.homedir());

function loadCore(dir: string): Core {
  const load = (name: string) => require(path.join(dir, name));
  let diffs: any = null;
  try {
    diffs = load("core/diffs");
  } catch {
    diffs = null; // diff 단계가 없는 옛 빌드
  }
  return { db: load("core/db"), search: load("core/search"), indexer: load("core/indexer"), diffs, tools: load("mcp/tools"), code: load("core/code") };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 원본 레포의 sha 하나만 가리키는 임시 clone — 원본 객체를 빌려 써서 빠르고, 원본은 건드리지 않는다 */
export function pin(source: string, sha: string, root: string, tips: string[] = []): string {
  const dir = path.join(root, path.basename(source));
  execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", source, dir], { stdio: "ignore" });
  for (const ref of git(dir, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) git(dir, ["update-ref", "-d", ref]);
  git(dir, ["update-ref", "refs/heads/pinned", sha]);
  tips.forEach((tip, index) => git(dir, ["update-ref", `refs/tags/pinned-${index}`, tip]));
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/pinned"]);
  // 링크 모양을 원본과 같게
  let origin = "";
  try {
    origin = git(source, ["remote", "get-url", "origin"]).trim();
  } catch {
    origin = "";
  }
  if (origin) git(dir, ["remote", "set-url", "origin", origin]);
  else git(dir, ["remote", "remove", "origin"]);
  return dir;
}

function metrics(rows: Row[], ks = [1, 3, 8]) {
  const n = rows.length || 1;
  const acc = Object.fromEntries(ks.map((k) => [`acc@${k}`, +(rows.filter((row) => row.rank !== null && row.rank <= k).length / n).toFixed(3)]));
  const keyed = rows.filter((row) => row.answerable !== null);
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
  const pick = (values: number[], q: number) => sorted(values)[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  return {
    n: rows.length,
    ...acc,
    mrr: +(rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n).toFixed(3),
    evidence: +(rows.filter((row) => row.evidence).length / n).toFixed(3),
    answerable: keyed.length ? +(keyed.filter((row) => row.answerable).length / keyed.length).toFixed(3) : null,
    keyed: keyed.length,
    chars: Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / n),
    charsP90: pick(rows.map((row) => row.chars), 0.9),
    p50ms: +pick(rows.map((row) => row.ms), 0.5).toFixed(1),
  };
}

/** expect 하나 — "a|b"면 대안 중 하나라도 있으면 맞음 */
function matches(text: string, expect: string): boolean {
  return expect.split("|").some((alternative) => text.includes(alternative));
}

function hitText(hit: any): string {
  return [hit.repo, hit.ref, hit.title, ...(hit.files ?? [])].join(" ").toLowerCase();
}

async function runQuestions(core: Core, db: any, questions: Question[], detail: string): Promise<Row[]> {
  const context = { db, me: [], cwd: "/" };
  const rows: Row[] = [];
  for (const question of questions) {
    const expect = question.expect.map((item) => item.toLowerCase());
    const start = process.hrtime.bigint();
    const result = core.search.search(db, question.q, { limit: 8 });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const index = result.hits.findIndex((hit: any) => expect.every((item) => matches(hitText(hit), item)));
    const response = JSON.stringify(await core.tools.callTool(context, "search_memory", { query: question.q, ...(detail ? { detail } : {}) }));
    const text = response.toLowerCase();
    const evidence = expect.every((item) => matches(text, item));
    const keys = (question.key ?? []).map((item) => item.toLowerCase());
    rows.push({
      id: question.id,
      type: question.type,
      rank: index < 0 ? null : index + 1,
      evidence,
      answerable: keys.length > 0 ? evidence && keys.every((item) => text.includes(item)) : null,
      chars: response.length,
      ms,
    });
  }
  return rows;
}

function historyToFile(core: Core, db: any) {
  const commits = db
    .prepare("SELECT repo_id, sha, subject FROM commits WHERE meaningful = 1 AND files_changed BETWEEN 1 AND 40 ORDER BY repo_id, authored_at")
    .all() as { repo_id: number; sha: string; subject: string }[];
  const filesOf = db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?");
  const atHead = db.prepare("SELECT 1 FROM code_files WHERE repo_id = ? AND path = ?");
  const repoPath = new Map((db.prepare("SELECT id, path FROM repos").all() as { id: number; path: string }[]).map((row) => [row.path, row.id]));
  const rows: { rank: number | null }[] = [];
  for (const commit of commits) {
    const gold = (filesOf.all(commit.repo_id, commit.sha) as { path: string }[])
      .map((row) => row.path)
      .filter((file) => core.code.isIndexable(file, 0) && atHead.get(commit.repo_id, file));
    if (gold.length === 0 || gold.length > 5) continue;
    const hits = core.search.search(db, commit.subject, { kind: "file", limit: 10, preferRepoId: commit.repo_id }).hits;
    const index = hits.findIndex((hit: any) => gold.includes(hit.ref) && repoPath.get(hit.repoPath) === commit.repo_id);
    rows.push({ rank: index < 0 ? null : index + 1 });
  }
  const n = rows.length || 1;
  return {
    n: rows.length,
    "acc@1": +(rows.filter((row) => row.rank === 1).length / n).toFixed(3),
    "acc@5": +(rows.filter((row) => row.rank !== null && row.rank <= 5).length / n).toFixed(3),
    mrr: +(rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n).toFixed(3),
  };
}

/** 이항 양측 정확 검정 — 짝지은 두 결과에서 한쪽만 맞은 질문 수(b, c)로 맥니마 p값 */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += comb(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function comb(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
}

function compare(fileA: string, fileB: string): void {
  const a = JSON.parse(fs.readFileSync(fileA, "utf8")) as { label: string; rows: Row[] };
  const b = JSON.parse(fs.readFileSync(fileB, "utf8")) as { label: string; rows: Row[] };
  const byId = new Map(b.rows.map((row) => [row.id, row]));
  const pairs = a.rows.filter((row) => byId.has(row.id)).map((row) => [row, byId.get(row.id)!] as const);
  const test = (name: string, ok: (row: Row) => boolean | null) => {
    const usable = pairs.filter(([x, y]) => ok(x) !== null && ok(y) !== null);
    const onlyA = usable.filter(([x, y]) => ok(x) && !ok(y)).map(([x]) => x.id);
    const onlyB = usable.filter(([x, y]) => !ok(x) && ok(y)).map(([x]) => x.id);
    const rate = (pick: (pair: readonly [Row, Row]) => Row) => +(usable.filter((pair) => ok(pick(pair))).length / (usable.length || 1)).toFixed(3);
    console.log(
      `${name.padEnd(12)} n=${usable.length}  ${a.label}=${rate(([x]) => x)}  ${b.label}=${rate(([, y]) => y)}  ` +
        `${a.label}만=${onlyA.length} ${b.label}만=${onlyB.length}  p=${mcnemar(onlyA.length, onlyB.length).toFixed(3)}`,
    );
    if (onlyA.length + onlyB.length > 0 && onlyA.length + onlyB.length <= 12) console.log(`             ${a.label}만: ${onlyA.join(" ")} | ${b.label}만: ${onlyB.join(" ")}`);
  };
  test("acc@1", (row) => row.rank === 1);
  test("acc@3", (row) => row.rank !== null && row.rank <= 3);
  test("acc@8", (row) => row.rank !== null);
  test("evidence", (row) => row.evidence);
  test("answerable", (row) => row.answerable);
  const chars = (rows: Row[]) => Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / (rows.length || 1));
  console.log(`chars        ${a.label}=${chars(pairs.map(([x]) => x))}  ${b.label}=${chars(pairs.map(([, y]) => y))}`);
}

function readQuestions(file: string): { corpus: { path: string; sha: string; tips?: string[] }[]; questions: Question[] } {
  const spec = JSON.parse(fs.readFileSync(file, "utf8")) as {
    corpus?: { path: string; sha: string; tips?: string[] }[];
    questions?: Question[];
    include?: string[];
  };
  const questions = [...(spec.questions ?? [])];
  for (const extra of spec.include ?? []) {
    const included = path.resolve(path.dirname(file), extra);
    if (fs.existsSync(included)) questions.push(...readQuestions(included).questions);
  }
  return { corpus: spec.corpus ?? [], questions };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      repo: { type: "string", multiple: true },
      core: { type: "string" },
      detail: { type: "string" },
      label: { type: "string" },
      save: { type: "boolean" },
      verbose: { type: "boolean" },
      compare: { type: "boolean" },
      "no-questions": { type: "boolean" },
      "no-code": { type: "boolean" },
    },
  });
  if (values.compare) {
    compare(positionals[0], positionals[1]);
    return 0;
  }
  const core = loadCore(path.resolve(values.core ?? path.join(__dirname, "..", "src")));
  const config = values.config ?? "bench/eval.local.json";
  const spec = fs.existsSync(config) ? readQuestions(config) : { corpus: [], questions: [] as Question[] };
  const questions = values["no-questions"] ? [] : spec.questions;

  // 코퍼스: --repo(HEAD 고정) 또는 설정 파일의 고정 sha
  const work = tempDir("grimoire-eval-");
  const pinned = (values.repo?.length
    ? values.repo.map((dir) => {
        const source = path.resolve(expandHome(dir));
        return { source, sha: git(source, ["rev-parse", "HEAD"]).trim(), tips: [] as string[] };
      })
    : spec.corpus.map((item) => ({ source: path.resolve(expandHome(item.path)), sha: item.sha, tips: item.tips ?? [] }))
  ).map((item) => ({ ...item, dir: pin(item.source, item.sha, path.join(work, "repos"), item.tips) }));
  if (pinned.length === 0) throw new Error("코퍼스가 없습니다 (설정 파일의 corpus 또는 --repo)");

  const db = core.db.openDb(path.join(work, "eval.db"));
  const indexStart = Date.now();
  let commits = 0;
  const repos: any[] = [];
  for (const item of pinned) {
    const repo = await core.indexer.addRepo(db, item.dir);
    commits += (await core.indexer.syncRepo(db, repo)).added;
    repos.push(repo);
  }
  const indexMs = Date.now() - indexStart;
  const codeStart = Date.now();
  if (core.diffs && !values["no-code"]) for (const repo of repos) await core.diffs.indexCommitCode(db, repo);
  const codeMs = Date.now() - codeStart;
  const files = (db.prepare("SELECT COUNT(*) AS n FROM code_files").get() as { n: number }).n;
  const dbBytes = (db.pragma("page_count") as number) * (db.pragma("page_size") as number);

  const rows = await runQuestions(core, db, questions, values.detail ?? "");
  const types = [...new Set(rows.map((row) => row.type))];
  const report = {
    label: values.label ?? "",
    at: new Date().toISOString(),
    core: values.core ?? "src",
    detail: values.detail ?? "(기본)",
    corpus: { repos: pinned.map((item) => `${path.basename(item.source)}@${item.sha.slice(0, 7)}`), commits, files, indexMs, codeMs, dbBytes },
    historyToFile: historyToFile(core, db),
    all: metrics(rows),
    byType: Object.fromEntries(types.map((type) => [type, metrics(rows.filter((row) => row.type === type))])),
  };
  console.log(JSON.stringify(report, null, 2));
  if (values.verbose) for (const row of rows) console.log(`${row.rank ?? "-"}\t${row.evidence ? "E" : "-"}${row.answerable === null ? " " : row.answerable ? "A" : "x"}\t${row.chars}\t${row.id}`);
  if (values.save) {
    const out = path.join("bench", "results", `eval-${report.at.replace(/[:.]/g, "-")}${report.label ? `-${report.label}` : ""}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...report, rows }, null, 2));
    console.error(`저장: ${out}`);
  }
  db.close();
  fs.rmSync(work, { recursive: true, force: true });
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    },
  );
}
