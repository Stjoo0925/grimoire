/**
 * 영향 범위 벤치 — "파일 하나를 바꾸면, 같은 변경에서 실제로 같이 바뀐 파일을 맞히나"를 이력으로 잰다. Claude를 부르지 않는다.
 *
 *   npm run impactbench -- --repo ~/work/foo [--repo …] [--ratio 0.8] [--max-queries 3000] [--label x] [--save] [--grid]
 *   --grid: 전체 근거를 켠 채 가중치 조합을 훑어 MRR 순 상위를 보인다 (같은 질의로 고르므로 과적합 주의 — 다른 레포로 다시 확인)
 *
 * 시간 분할: 레포의 first-parent 이력을 ratio에서 자른다. grimoire 색인은 그 커밋까지만 보이는 clone(taskbench의
 * pinnedClone)으로 만든다 — 공변경뿐 아니라 import 그래프·파일 목록·테스트 짝까지 분할 시점의 것이다(분할 뒤 커밋이
 * 추가한 import가 정답을 미리 알려 주지 않게). 정답은 원본 레포의 분할 뒤 커밋(머지 제외, 파일 2~10개, 같은 변경은 한 번).
 *
 * 질의: 그 커밋의 파일 중 분할 시점에 있던 소스 파일 f 하나 → 나머지(같은 조건)를 맞힌다. code-review-graph의
 * "Impact Accuracy"와 같은 꼴이지만 정답을 사람이 만들지 않고 이력에서 얻으니 질의가 수천 개다.
 *
 * 전략: 근거를 하나씩·합쳐서 (core/impact.ts의 sources). dir(같은 폴더)은 기준선 — 이것보다 못하면 쓸 이유가 없다.
 * 지표: hit@5(상위 5개에 정답이 하나라도), recall@5·@10, precision@5(맞힌 수/5), MRR, 후보를 하나라도 낸 비율(coverage).
 * 짝 비교: 기본 조합 vs import만 — 질의별 recall@10 차이의 윌콕슨 p.
 *
 * 커밋 직전 알림(core/impact.ts missingCompanions)도 같은 커밋으로 잰다: 빠진 것 없는 커밋에서 울리는 비율(오경보),
 * 파일 하나를 빼고 커밋했다고 칠 때 그것을 되찾는 비율, 알린 것 중 그 변경의 파일인 비율(정밀도).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { changeKey } from "../src/core/context";
import { openDb } from "../src/core/db";
import { DEFAULT_SOURCES, impactOf, missingCompanions, type ImpactSource } from "../src/core/impact";
import { addRepo, syncRepo } from "../src/core/indexer";
import { tempDir } from "../tests/helpers";
import { pinnedClone, wilcoxon } from "./taskbench";
import { execFileSync } from "node:child_process";

const STRATEGIES: Record<string, ImpactSource[]> = {
  dir: ["dir"],
  import: ["import"],
  "import+2hop": ["import", "import2"],
  cochange: ["cochange"],
  test: ["test"],
  ref: ["ref"],
  sibling: ["sibling"],
  "no-ref/sibling": ["import", "import2", "cochange", "test", "dir"],
  default: DEFAULT_SOURCES,
};
/** 짝 비교의 기준 — 정적 그래프 도구가 하는 것 */
const BASELINE = "import+2hop";
const MIN_FILES = 2;
const MAX_FILES = 10;
const MERGE_SUBJECT = /^merge\s+(branch|pull request|remote|commit|tag)\b/i;

export interface Query {
  sha: string;
  seed: string;
  targets: string[];
}

export interface Score {
  hit5: number;
  recall5: number;
  recall10: number;
  precision5: number;
  rr: number;
  covered: number;
}

/** 예측 순위 목록과 정답 → 질의 하나의 점수 */
export function scoreQuery(predicted: string[], targets: string[]): Score {
  const truth = new Set(targets);
  const hitsAt = (k: number) => predicted.slice(0, k).filter((item) => truth.has(item)).length;
  const first = predicted.findIndex((item) => truth.has(item));
  return {
    hit5: hitsAt(5) > 0 ? 1 : 0,
    recall5: hitsAt(5) / truth.size,
    recall10: hitsAt(10) / truth.size,
    precision5: hitsAt(5) / 5,
    rr: first >= 0 ? 1 / (first + 1) : 0,
    covered: predicted.length > 0 ? 1 : 0,
  };
}

export interface AlertScore {
  complete: number;
  falseAlarm: number;
  dropped: number;
  recovered: number;
  alerts: number;
  correct: number;
}

/** 커밋 직전 알림 — 분할 뒤 커밋의 레포 안 파일 묶음마다 (alerts: 커밋 파일 → 알린 파일) */
export function scoreAlerts(groups: string[][], alerts: (committed: string[]) => string[]): AlertScore {
  const score: AlertScore = { complete: 0, falseAlarm: 0, dropped: 0, recovered: 0, alerts: 0, correct: 0 };
  for (const files of groups) {
    score.complete++;
    if (alerts(files).length > 0) score.falseAlarm++;
    for (const dropped of files) {
      const alerted = alerts(files.filter((file) => file !== dropped));
      score.dropped++;
      score.alerts += alerted.length;
      score.correct += alerted.filter((file) => file === dropped).length;
      if (alerted.includes(dropped)) score.recovered++;
    }
  }
  return score;
}

export function meanScore(scores: Score[]): Score & { n: number } {
  const avg = (key: keyof Score) => (scores.length ? +(scores.reduce((sum, item) => sum + item[key], 0) / scores.length).toFixed(3) : 0);
  return { n: scores.length, hit5: avg("hit5"), recall5: avg("recall5"), recall10: avg("recall10"), precision5: avg("precision5"), rr: avg("rr"), covered: avg("covered") };
}

/** git log 출력(%x00%H%x09%s + --name-only) → 커밋들 */
export function parseLog(text: string): { sha: string; subject: string; files: string[] }[] {
  return text
    .split("\0")
    .filter((block) => block.trim())
    .map((block) => {
      const [head, ...rest] = block.split("\n");
      const [sha, ...subject] = head.split("\t");
      return { sha: sha.trim(), subject: subject.join("\t"), files: rest.map((line) => line.trim()).filter(Boolean) };
    });
}

/** 분할 뒤 커밋 → 질의. known: 분할 시점에 있던 소스 파일 */
export function buildQueries(commits: { sha: string; subject: string; files: string[] }[], known: Set<string>): Query[] {
  const seen = new Set<string>();
  const queries: Query[] = [];
  for (const commit of commits) {
    const files = [...new Set(commit.files)];
    if (MERGE_SUBJECT.test(commit.subject) || files.length < MIN_FILES || files.length > MAX_FILES) continue;
    const key = changeKey(commit.subject, files);
    if (seen.has(key)) continue;
    seen.add(key);
    const usable = files.filter((file) => known.has(file));
    if (usable.length < 2) continue;
    for (const seed of usable) queries.push({ sha: commit.sha, seed, targets: usable.filter((file) => file !== seed) });
  }
  return queries;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", multiple: true },
      ratio: { type: "string" },
      "max-queries": { type: "string" },
      label: { type: "string" },
      save: { type: "boolean" },
      grid: { type: "boolean" },
    },
  });
  if (!values.repo?.length) throw new Error("--repo <경로>가 필요합니다 (여러 번 줄 수 있음)");
  const ratio = Number.parseFloat(values.ratio ?? "0.8");
  const maxQueries = Number.parseInt(values["max-queries"] ?? "3000", 10) || 3000;
  const work = tempDir("grimoire-impactbench-");
  const db = openDb(path.join(work, "impact.db"));
  const perRepo: Record<string, unknown> = {};
  const all: { repoId: number; query: Query }[] = [];
  const alertTotal: AlertScore = { complete: 0, falseAlarm: 0, dropped: 0, recovered: 0, alerts: 0, correct: 0 };
  // "+intent": 기본 근거 + 그 커밋의 제목을 작업 의도로 (실제 쓰임에서는 사용자의 요청 — 제목은 그보다 정보가 많을 수 있다)
  const pooled: Record<string, Score[]> = Object.fromEntries([...Object.keys(STRATEGIES), "+intent"].map((name) => [name, []]));

  for (const dir of values.repo) {
    const source = path.resolve(dir.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? "~"));
    const name = path.basename(source);
    const line = git(source, ["rev-list", "--first-parent", "HEAD"]).trim().split("\n");
    const split = line[Math.floor(line.length * (1 - ratio))];
    const head = line[0];
    const pinned = pinnedClone(source, split, path.join(work, "repos", name));
    const started = Date.now();
    const repo = await addRepo(db, pinned);
    await syncRepo(db, repo);
    const indexMs = Date.now() - started;
    const known = new Set((db.prepare("SELECT path FROM code_files WHERE repo_id = ?").all(repo.id) as { path: string }[]).map((row) => row.path));
    const commits = parseLog(git(source, ["log", "--no-merges", "--no-renames", "--format=%x00%H%x09%s", "--name-only", `${split}..${head}`]));
    let queries = buildQueries(commits, known);
    const total = queries.length;
    // 질의가 너무 많으면 고르게 솎는다 (결정론)
    if (queries.length > maxQueries) {
      const step = queries.length / maxQueries;
      queries = Array.from({ length: maxQueries }, (_, index) => queries[Math.floor(index * step)]);
    }
    all.push(...queries.map((query) => ({ repoId: repo.id, query })));
    const scores: Record<string, Score[]> = {};
    const timing: Record<string, number> = {};
    for (const [strategy, sources] of Object.entries(STRATEGIES)) {
      const begin = Date.now();
      scores[strategy] = queries.map((query) =>
        scoreQuery(
          impactOf(db, repo.id, [query.seed], { sources, limit: 10, noteFiles: 0 }).items.map((item) => item.path),
          query.targets,
        ),
      );
      timing[strategy] = queries.length ? +((Date.now() - begin) / queries.length).toFixed(2) : 0;
      pooled[strategy].push(...scores[strategy]);
    }
    // 커밋 직전 알림: 질의를 만든 커밋들의 레포 안 파일 묶음
    const groups = [...new Map(queries.map((query) => [query.sha, [query.seed, ...query.targets].sort()])).values()];
    const alerts = scoreAlerts(groups, (committed) => missingCompanions(db, repo.id, committed, new Set(committed)).map((item) => item.path));
    for (const key of Object.keys(alertTotal) as (keyof AlertScore)[]) alertTotal[key] += alerts[key];
    const subjects = new Map(commits.map((commit) => [commit.sha, commit.subject]));
    const begin = Date.now();
    scores["+intent"] = queries.map((query) =>
      scoreQuery(impactOf(db, repo.id, [query.seed], { limit: 10, noteFiles: 0, intent: subjects.get(query.sha) }).items.map((item) => item.path), query.targets),
    );
    timing["+intent"] = queries.length ? +((Date.now() - begin) / queries.length).toFixed(2) : 0;
    pooled["+intent"].push(...scores["+intent"]);
    const summary = Object.fromEntries(Object.entries(scores).map(([strategy, list]) => [strategy, { ...meanScore(list), msPerQuery: timing[strategy] }]));
    perRepo[name] = { split: split.slice(0, 10), evalCommits: commits.length, queries: queries.length, totalQueries: total, knownFiles: known.size, indexMs, summary };
    process.stdout.write(`\n## ${name} — 분할 ${split.slice(0, 10)}, 뒤 커밋 ${commits.length}개, 질의 ${queries.length}/${total}, 파일 ${known.size}개\n`);
    printTable(summary);
  }

  const alertSummary = {
    ...alertTotal,
    falseAlarmRate: +(alertTotal.falseAlarm / Math.max(1, alertTotal.complete)).toFixed(3),
    recoveredRate: +(alertTotal.recovered / Math.max(1, alertTotal.dropped)).toFixed(3),
    precision: +(alertTotal.correct / Math.max(1, alertTotal.alerts)).toFixed(3),
  };
  const pooledSummary = Object.fromEntries(Object.entries(pooled).map(([strategy, list]) => [strategy, meanScore(list)]));
  process.stdout.write(`\n## 전체 (질의 ${pooled.default.length}개)\n`);
  printTable(pooledSummary);
  const diffs = pooled.default.map((score, index) => score.recall10 - pooled[BASELINE][index].recall10);
  const p = wilcoxon(diffs);
  const intentDiffs = pooled["+intent"].map((score, index) => score.recall10 - pooled.default[index].recall10);
  process.stdout.write(`\n의도 합침: +intent vs default — recall@10 ${(pooledSummary["+intent"].recall10 - pooledSummary.default.recall10).toFixed(3)}, 윌콕슨 p=${wilcoxon(intentDiffs)}\n`);
  const verdict = { versus: BASELINE, recall10Delta: +(pooledSummary.default.recall10 - pooledSummary[BASELINE].recall10).toFixed(3), wilcoxonP: p };
  process.stdout.write(
    `\n커밋 직전 알림: 빠진 것 없는 커밋 ${alertSummary.complete}개 중 오경보 ${alertSummary.falseAlarmRate}, 하나 뺀 커밋 ${alertSummary.dropped}개에서 되찾음 ${alertSummary.recoveredRate}, 정밀도 ${alertSummary.precision}\n`,
  );
  process.stdout.write(`\n판정: default vs ${BASELINE} — recall@10 ${verdict.recall10Delta >= 0 ? "+" : ""}${verdict.recall10Delta}, 윌콕슨 p=${p}\n`);
  if (values.grid) {
    const grid: { weights: Record<string, number>; score: Score & { n: number } }[] = [];
    for (const imp of [0.2, 0.35])
      for (const ref of [0, 0.05, 0.1, 0.2])
        for (const sibling of [0, 0.15])
          for (const co of [0.7, 1]) {
            const weights = { import: imp, ref, sibling, cochange: co };
            const list = all.map(({ repoId, query }) =>
              scoreQuery(
                impactOf(db, repoId, [query.seed], { sources: DEFAULT_SOURCES, weights, limit: 10, noteFiles: 0 }).items.map((item) => item.path),
                query.targets,
              ),
            );
            grid.push({ weights, score: meanScore(list) });
          }
    grid.sort((a, b) => b.score.rr - a.score.rr || b.score.recall10 - a.score.recall10);
    process.stdout.write("\n## 가중치 그리드 (MRR 순 상위 8)\n");
    for (const item of grid.slice(0, 8)) process.stdout.write(`${JSON.stringify(item.weights)}  MRR ${item.score.rr}  hit@5 ${item.score.hit5}  R@10 ${item.score.recall10}\n`);
  }
  if (values.save) {
    const dirOut = path.resolve("bench", "results");
    fs.mkdirSync(dirOut, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dirOut, `impactbench-${stamp}${values.label ? `-${values.label}` : ""}.json`);
    fs.writeFileSync(file, JSON.stringify({ label: values.label, ratio, repos: perRepo, pooled: pooledSummary, alerts: alertSummary, verdict }, null, 2));
    process.stdout.write(`결과: ${file}\n`);
  }
  db.close();
  return 0;
}

function printTable(summary: Record<string, Score & { n: number }>): void {
  process.stdout.write("전략            hit@5  R@5    R@10   P@5    MRR    낸 비율\n");
  for (const [strategy, score] of Object.entries(summary)) {
    const cells = [score.hit5, score.recall5, score.recall10, score.precision5, score.rr, score.covered].map((value) => value.toFixed(3).padEnd(6));
    process.stdout.write(`${strategy.padEnd(15)} ${cells.join(" ")}\n`);
  }
}

if (require.main === module) {
  main().then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    },
  );
}
