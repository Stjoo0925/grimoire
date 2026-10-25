/**
 * 오프라인 검색 평가 — Claude를 부르지 않고 `search()`만으로 정확도·지연을 잰다.
 *
 *   npm run eval                                   bench/eval.local.json의 root 아래 레포
 *   npm run eval -- --root ~/work-dir              다른 폴더
 *   npm run eval -- --repo . --repo ../other       레포를 직접 고름
 *   npm run eval -- --label after-x --save         결과를 bench/results/eval-<시각>-<label>.json에 남김
 *
 * 두 가지를 잰다.
 *  1. history→file (자동): 의미 있는 커밋마다 질의 = 커밋 제목, 정답 = 그 커밋이 건드린 파일 중 HEAD에 남은 소스 파일.
 *     kind=file로 찾아 정답 파일이 몇 등에 나오나. git 이력에서 기계적으로 만드는 표준 방식(LocAgent·SweRank)이다.
 *     제목을 그대로 질의로 쓰니 점수가 부풀려진다 — 절대값보다 변경 전후 비교에 쓴다.
 *  2. holdout (손으로 쓴 질문): 질문 파일의 expect 문자열이 모두 들어 있는 첫 결과의 순위.
 *     MCP와 같은 조건(limit 8, kind 없음)으로 찾는다. 실제 쓰임새에 가장 가깝다.
 *
 * 지표: Acc@k(정답이 상위 k 안에 있는 비율), MRR(1/정답 순위의 평균), 검색 지연 p50·p95, 색인 시간.
 * 실제 ~/.grimoire는 건드리지 않는다(임시 DB).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { isIndexable } from "../src/core/code";
import { indexCommitCode } from "../src/core/diffs";
import { openDb, type DB } from "../src/core/db";
import { addRepo, discoverRepos, syncRepo } from "../src/core/indexer";
import { search, type SearchHit } from "../src/core/search";
import { tempDir } from "../tests/helpers";

interface Question {
  id: string;
  type: string;
  q: string;
  expect: string[];
}

interface Scored {
  /** 1부터. 못 찾으면 null */
  rank: number | null;
  ms: number;
}

const K = [1, 3, 5];
/** history→file 과제에서 질의로 쓸 커밋의 변경 파일 수 범위 (대량 커밋은 정답이 흐려진다) */
const MAX_GOLD_FILES = 5;

const expandHome = (value: string) => value.replace(/^~(?=$|\/)/, os.homedir());

function metrics(rows: Scored[], ks = K) {
  const n = rows.length || 1;
  const acc = Object.fromEntries(ks.map((k) => [`acc@${k}`, +(rows.filter((row) => row.rank !== null && row.rank <= k).length / n).toFixed(3)]));
  const mrr = +(rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n).toFixed(3);
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  const pick = (q: number) => +(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0).toFixed(1);
  return { n: rows.length, ...acc, mrr, p50ms: pick(0.5), p95ms: pick(0.95) };
}

function dbSize(db: DB): number {
  const pages = db.pragma("page_count", { simple: true }) as number;
  const size = db.pragma("page_size", { simple: true }) as number;
  return pages * size;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

/** 결과 하나를 문자열로 — expect 비교용 (파일 경로·sha·제목) */
function hitText(hit: SearchHit): string {
  return [hit.repo, hit.ref, hit.title, ...(hit.files ?? [])].join(" ").toLowerCase();
}

function historyToFile(db: DB): Scored[] {
  const commits = db
    .prepare(
      `SELECT c.repo_id, c.sha, c.subject FROM commits c
        WHERE c.meaningful = 1 AND c.files_changed BETWEEN 1 AND 40
        ORDER BY c.repo_id, c.authored_at`,
    )
    .all() as { repo_id: number; sha: string; subject: string }[];
  const filesOf = db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?");
  const atHead = db.prepare("SELECT 1 FROM code_files WHERE repo_id = ? AND path = ?");
  const rows: Scored[] = [];
  for (const commit of commits) {
    const touched = (filesOf.all(commit.repo_id, commit.sha) as { path: string }[]).map((row) => row.path);
    const gold = touched.filter((file) => isIndexable(file, 0) && atHead.get(commit.repo_id, file));
    if (gold.length === 0 || gold.length > MAX_GOLD_FILES) continue;
    const { value, ms } = timed(() => search(db, commit.subject, { kind: "file", limit: 10, preferRepoId: commit.repo_id }));
    const index = value.hits.findIndex((hit) => hit.repoPath !== null && gold.includes(hit.ref) && hitRepoId(db, hit) === commit.repo_id);
    rows.push({ rank: index < 0 ? null : index + 1, ms });
  }
  return rows;
}

const repoIds = new Map<string, number>();
function hitRepoId(db: DB, hit: SearchHit): number | undefined {
  if (!hit.repoPath) return undefined;
  if (!repoIds.has(hit.repoPath)) {
    const row = db.prepare("SELECT id FROM repos WHERE path = ?").get(hit.repoPath) as { id: number } | undefined;
    if (row) repoIds.set(hit.repoPath, row.id);
  }
  return repoIds.get(hit.repoPath);
}

function holdout(db: DB, questions: Question[]) {
  const rows: (Scored & { id: string; type: string })[] = [];
  for (const question of questions) {
    const { value, ms } = timed(() => search(db, question.q, { limit: 8 }));
    const expect = question.expect.map((item) => item.toLowerCase());
    const index = value.hits.findIndex((hit) => expect.every((item) => hitText(hit).includes(item)));
    rows.push({ id: question.id, type: question.type, rank: index < 0 ? null : index + 1, ms });
  }
  return rows;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      questions: { type: "string" },
      root: { type: "string" },
      repo: { type: "string", multiple: true },
      label: { type: "string" },
      save: { type: "boolean" },
      verbose: { type: "boolean" },
      "no-code": { type: "boolean" },
    },
  });
  const questionsFile = values.questions ?? (fs.existsSync("bench/eval.local.json") ? "bench/eval.local.json" : undefined);
  const spec = questionsFile
    ? (JSON.parse(fs.readFileSync(questionsFile, "utf8")) as { root?: string; questions: Question[] })
    : { questions: [] as Question[] };
  const repos = values.repo?.length
    ? values.repo.map((dir) => path.resolve(expandHome(dir)))
    : discoverRepos(path.resolve(expandHome(values.root ?? spec.root ?? "."))).filter((dir) => !dir.includes("node_modules"));
  if (repos.length === 0) throw new Error("평가할 레포가 없습니다 (--root 또는 --repo)");

  const db = openDb(path.join(tempDir("grimoire-eval-"), "eval.db"));
  const indexStart = Date.now();
  let commits = 0;
  for (const dir of repos) {
    const repo = await addRepo(db, dir);
    const result = await syncRepo(db, repo);
    commits += result.added;
  }
  const indexMs = Date.now() - indexStart;
  // diff 식별자 단계 (MCP 서버는 뒤에서 한다) — 시간을 따로 잰다
  const codeStart = Date.now();
  if (!values["no-code"]) for (const repo of db.prepare("SELECT id, path FROM repos").all() as { id: number; path: string }[]) await indexCommitCode(db, repo);
  const codeMs = Date.now() - codeStart;
  const files = (db.prepare("SELECT COUNT(*) AS n FROM code_files").get() as { n: number }).n;

  const history = metrics(historyToFile(db));
  const held = holdout(db, spec.questions);
  const byType = (type: string) => metrics(held.filter((row) => row.type === type), [1, 3, 8]);

  const report = {
    label: values.label ?? "",
    at: new Date().toISOString(),
    corpus: { repos: repos.length, commits, files, indexMs, codeMs, dbBytes: dbSize(db) },
    historyToFile: history,
    holdout: { all: metrics(held, [1, 3, 8]), history: byType("history"), location: byType("location") },
    misses: held.filter((row) => row.rank === null || row.rank > 1).map((row) => `${row.id}:${row.rank ?? "-"}`),
  };
  console.log(JSON.stringify(report, null, 2));
  if (values.verbose) for (const row of held) console.log(`${row.rank ?? "-"}\t${row.id}`);
  if (values.save) {
    const out = path.join("bench", "results", `eval-${report.at.replace(/[:.]/g, "-")}${report.label ? `-${report.label}` : ""}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...report, rows: held }, null, 2));
    console.error(`저장: ${out}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
