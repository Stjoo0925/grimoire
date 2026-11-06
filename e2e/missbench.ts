/**
 * 놓친 파일 벤치 — "커밋 C를 하기 전에 impact를 돌렸다면, 나중에 fix 커밋이 고쳐야 했던 파일을 미리 알려 줬나"를 이력으로 잰다.
 * Claude를 부르지 않는다. 사용자가 실제로 얻는 것(커밋 뒤 다시 고치는 일)을 그대로 채점하려고 만들었다 (노트 #80·#81).
 *
 *   npm run missbench -- --repo ~/work/foo [--repo …] [--splits 0.5,0.55,…,0.95] [--label x] [--save]
 *
 * impactbench와 다른 점: impactbench는 "파일 하나 → 같은 커밋의 나머지"(파일 2~10개 커밋)를 채점한다. 실사용은 커밋 전체를
 * 넣고(impact를 부른 커밋은 평균 18.8파일), 맞혀야 할 것은 그 커밋이 빠뜨려 48시간 안의 fix 커밋이 고친 파일이다.
 *
 * 사례: C 뒤 48시간 안의 수정 커밋이 C를 고치면서(fixTarget이 C) C에 없던 파일도 고친 커밋 C — e2e/usage.ts missedFiles와 같은 정의.
 * 정답: 그 놓친 파일들. 바뀐 파일: C의 파일 전부(최대 MAX_SEED_FILES).
 * 오경보 표본: C 뒤 48시간 안에 같은 파일을 고친 수정 커밋이 하나도 없는 커밋.
 *
 * 시간 분할: --splits의 비율마다 first-parent 이력을 잘라 그 커밋까지만 보이는 clone(pinnedClone)으로 색인한다.
 * 사례는 자기보다 앞선 가장 가까운 분할의 색인으로 잰다 — 분할과 C 사이 커밋은 안 보이니 실제보다 불리하지, 미래가 새지는 않는다.
 *
 * 지표 (사례마다, 평균):
 *   hit@10   — impact 상위 10개(에이전트가 보는 목록)에 놓친 파일이 하나라도
 *   R@10     — 놓친 파일 중 상위 10개에 든 비율. "찾을 수 있는" 쪽은 분할 시점에 이미 있던 놓친 파일만 분모로 (새 파일은 이력으로 못 맞힌다)
 *   알림     — 커밋 직전 훅(commitImpact: 점수 ≥ 0.3, 다섯 개까지)이 놓친 파일을 하나라도 알렸나, 알린 것 중 맞은 비율, 오경보 표본에서 울린 비율
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { isIndexable } from "../src/core/code";
import { openDb, type DB } from "../src/core/db";
import { COMMIT_IMPACT_MAX, COMMIT_IMPACT_MIN_SCORE, impactOf, MISSING_MAX_COMMIT_FILES, missingCompanions, type ImpactOptions } from "../src/core/impact";
import { addRepo, syncRepo } from "../src/core/indexer";
import { tempDir } from "../tests/helpers";
import { pinnedClone, wilcoxon } from "./taskbench";
import { dedupeChanges, findRetouches, fixTarget, missedFiles, MISSED_MAX_FIX_FILES, readCommits, RETOUCH_HOURS, type RepoCommit } from "./usage";

const REVERT_SUBJECT = /revert|되돌/i;

/** impact에 넣는 바뀐 파일 상한 — MCP impact 도구와 같다 */
const MAX_SEED_FILES = 50;
const MERGE_SUBJECT = /^merge\s+(branch|pull request|remote|commit|tag)\b/i;
/** 크기별 표에서 default와 견줄 전략 (기본: 바꾸기 전 방식) */
const BEST = process.env.MISSBENCH_BEST ?? "old (noisy-or)";
/** 오경보 표본 상한 (레포마다, 고르게 솎는다) */
const MAX_CLEAN = 300;

export interface MissCase {
  sha: string;
  subject: string;
  files: string[];
  targets: string[];
  /** 엄격한 라벨의 정답 — 그 fix가 C와 같은 범위(scope)를 다루거나 빠뜨림·빌드 오류를 고친다고 밝힌 경우만 (strictMissedFiles) */
  strictTargets: string[];
  strictFindable: string[];
  /** C 직전에 이미 있던 정답 — 이력으로 맞힐 수 있는 것 (C나 그 뒤에 새로 생긴 파일은 어떤 이력 도구도 미리 못 짚는다) */
  findable: string[];
}

export interface Strategy {
  name: string;
  options: ImpactOptions;
  /** 커밋 제목을 작업 의도로 준다 */
  intent?: boolean;
}

/**
 * 첫 줄이 기준(default = 지금 기본값). 2026-11-06에 noisy-or·감점 없음(old)에서 seed-damped·fanin 0.5로 바꿨다 —
 * 그때 훑은 조합(seed-max, hub 2·5, fanin 1·2 …)은 기본값보다 낫지 않았다 (노트 참고)
 */
export const STRATEGIES: Strategy[] = [
  { name: "default", options: {} },
  { name: "old (noisy-or)", options: { aggregate: "noisy-or", fanin: 0 } },
  { name: "fanin1", options: { fanin: 1 } },
  { name: "hub2", options: { hub: 2 } },
  { name: "default+intent", options: {}, intent: true },
  { name: "old+intent", options: { aggregate: "noisy-or", fanin: 0 }, intent: true },
];

export interface CaseScore {
  hit10: number;
  recall10: number;
  /** 찾을 수 있는 정답이 없으면 null */
  recallFindable10: number | null;
  alertHit: number;
  alerts: number;
  alertCorrect: number;
}

/** 순위 목록·알림 → 사례 하나의 점수 */
export function scoreCase(ranked: string[], alerted: string[], c: Pick<MissCase, "targets" | "findable">): CaseScore {
  const truth = new Set(c.targets);
  const top = ranked.slice(0, 10);
  const hits = top.filter((file) => truth.has(file)).length;
  const findable = new Set(c.findable);
  const correct = alerted.filter((file) => truth.has(file)).length;
  return {
    hit10: hits > 0 ? 1 : 0,
    recall10: hits / truth.size,
    recallFindable10: findable.size ? top.filter((file) => findable.has(file)).length / findable.size : null,
    alertHit: correct > 0 ? 1 : 0,
    alerts: alerted.length,
    alertCorrect: correct,
  };
}

/** 커밋 직전 훅의 알림을 전략 옵션으로 — core/impact.ts commitImpact와 같은 거르기 */
export function alertsOf(db: DB, repoId: number, committed: string[], options: ImpactOptions): string[] {
  if (committed.length === 0 || committed.length > MISSING_MAX_COMMIT_FILES) return [];
  const touched = new Set(committed);
  return impactOf(db, repoId, committed, { ...options, limit: 50, noteFiles: 0 })
    .items.filter((item) => (item.score >= COMMIT_IMPACT_MIN_SCORE || item.reasons.some((reason) => reason.source === "intent")) && !touched.has(item.path))
    .slice(0, COMMIT_IMPACT_MAX)
    .map((item) => item.path);
}

/** conventional 범위: "fix(ts-recalc,api): …" → ["ts-recalc", "api"] */
export function scopesOf(subject: string): string[] {
  const match = /^\s*\w+(?:\(([^)]+)\))?!?\s*:/.exec(subject);
  return match?.[1] ? match[1].split(/[,/\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
}

/** fix 제목이 앞 커밋의 빠뜨림을 고친다고 밝힌 말 */
export const MISS_WORDS = /누락|빠진|빠뜨|빠져|미반영|반영\s*안|안\s*된|깜빡|빌드|컴파일|타입\s*오류|타입\s*에러|lint|린트|missing|forgot|forgotten|build|compile|typecheck|type error|follow-?up|leftover|잘못된|오타|typo/i;

/**
 * 엄격한 놓친 파일 — missedFiles와 같되, 그 fix가 C의 범위를 다시 다루거나(제목의 scope가 겹침) 빠뜨림·빌드 오류를 고친다고 밝힌 것만.
 * missedFiles는 "C의 파일 하나를 다시 고친 48시간 안의 fix"를 다 세서, 다음 작업(파일 하나만 겹치는 별개 수정)이 대부분이었다
 * (2026-11-06 표본 24개 중 진짜 빠뜨림은 서넛).
 */
export function strictMissedFiles(c: RepoCommit, all: RepoCommit[], hours = RETOUCH_HOURS): string[] {
  const own = new Set(c.files);
  const scopes = new Set(scopesOf(c.subject));
  const missed = new Set<string>();
  for (const d of findRetouches(c, all, hours)) {
    if (REVERT_SUBJECT.test(d.subject) || d.files.length > MISSED_MAX_FIX_FILES) continue;
    if (fixTarget(d, all)?.sha !== c.sha) continue;
    const sameScope = scopesOf(d.subject).some((scope) => scopes.has(scope));
    if (!sameScope && !MISS_WORDS.test(d.subject)) continue;
    for (const f of d.files) if (!own.has(f)) missed.add(f);
  }
  return [...missed].sort();
}

/**
 * 이력 → 사례와 오경보 표본. all은 dedupeChanges를 거친 시각순 목록.
 * existsBefore: 커밋 C 직전 트리의 파일 목록 (사례의 찾을 수 있는 정답을 가른다)
 */
export function buildCases(all: RepoCommit[], from: number, until: number, existsBefore: (sha: string) => Set<string>): { cases: MissCase[]; clean: RepoCommit[] } {
  const cases: MissCase[] = [];
  const clean: RepoCommit[] = [];
  for (const c of all) {
    if (c.at <= from || c.at > until || MERGE_SUBJECT.test(c.subject)) continue;
    const files = [...new Set(c.files)];
    if (files.length === 0 || files.length > MAX_SEED_FILES) continue;
    const targets = missedFiles(c, all);
    if (targets.length > 0) {
      const exists = existsBefore(c.sha);
      const strict = strictMissedFiles(c, all);
      cases.push({
        sha: c.sha,
        subject: c.subject,
        files,
        targets,
        findable: targets.filter((file) => exists.has(file)),
        strictTargets: strict,
        strictFindable: strict.filter((file) => exists.has(file)),
      });
    }
    else if (findRetouches(c, all).length === 0) clean.push(c);
  }
  return { cases, clean };
}

const mean = (values: number[]) => (values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3) : 0);

export interface Summary {
  cases: number;
  hit10: number;
  recall10: number;
  recallFindable10: number;
  findableCases: number;
  alertHit: number;
  alertPrecision: number;
  alertsPerCase: number;
  falseAlarm: number;
}

export function summarize(scores: CaseScore[], cleanAlarms: number[]): Summary {
  const findable = scores.flatMap((score) => (score.recallFindable10 === null ? [] : [score.recallFindable10]));
  const alerts = scores.reduce((sum, score) => sum + score.alerts, 0);
  return {
    cases: scores.length,
    hit10: mean(scores.map((score) => score.hit10)),
    recall10: mean(scores.map((score) => score.recall10)),
    recallFindable10: mean(findable),
    findableCases: findable.length,
    alertHit: mean(scores.map((score) => score.alertHit)),
    alertPrecision: alerts ? +(scores.reduce((sum, score) => sum + score.alertCorrect, 0) / alerts).toFixed(3) : 0,
    alertsPerCase: mean(scores.map((score) => score.alerts)),
    falseAlarm: mean(cleanAlarms),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

const SIZE_BUCKETS = [
  { label: "1-3", min: 1, max: 3 },
  { label: "4-10", min: 4, max: 10 },
  { label: "11+", min: 11, max: Infinity },
];

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", multiple: true },
      splits: { type: "string" },
      label: { type: "string" },
      save: { type: "boolean" },
    },
  });
  if (!values.repo?.length) throw new Error("--repo <경로>가 필요합니다 (여러 번 줄 수 있음)");
  const ratios = (values.splits ?? "0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95").split(",").map((value) => Number.parseFloat(value)).filter((value) => value > 0 && value < 1).sort((a, b) => b - a);
  const work = tempDir("grimoire-missbench-");
  const db = openDb(path.join(work, "miss.db"));
  const pooled: Record<string, CaseScore[]> = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.name, []]));
  const pooledStrict: Record<string, CaseScore[]> = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.name, []]));
  const pooledClean: Record<string, number[]> = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.name, []]));
  const companions = { hit: 0, alerts: 0, correct: 0, cleanAlarms: [] as number[] };
  const bySize: Record<string, Record<string, CaseScore[]>> = Object.fromEntries(SIZE_BUCKETS.map((bucket) => [bucket.label, { default: [], best: [] }]));
  const ceiling = { targets: 0, findable: 0, findableSource: 0, source: 0 };
  const perRepo: Record<string, unknown> = {};

  for (const dir of values.repo) {
    const source = path.resolve(dir.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? process.env.HOME ?? "~"));
    const name = path.basename(source);
    const all = dedupeChanges(readCommits(source));
    const line = git(source, ["log", "--first-parent", "--format=%H%x1f%at", "HEAD"])
      .trim()
      .split("\n")
      .map((row) => {
        const [sha, at] = row.split("\x1f");
        return { sha, at: Number(at) * 1000 };
      });
    // 오래된 분할부터 — 사례는 [분할, 다음 분할) 구간
    const splits = ratios.map((ratio) => line[Math.floor(line.length * (1 - ratio))]).filter(Boolean).sort((a, b) => a.at - b.at);
    let repoCases = 0;
    let repoClean = 0;
    for (const [index, split] of splits.entries()) {
      const until = splits[index + 1]?.at ?? Infinity;
      const existsBefore = (sha: string) => {
        try {
          return new Set(git(source, ["ls-tree", "-r", "--name-only", `${sha}^`]).split("\n").filter(Boolean));
        } catch {
          return new Set<string>();
        }
      };
      const { cases, clean: allClean } = buildCases(all, split.at, until, existsBefore);
      if (cases.length === 0 && allClean.length === 0) continue;
      const pinned = pinnedClone(source, split.sha, path.join(work, "repos", `${name}-${index}`));
      const repo = await addRepo(db, pinned);
      await syncRepo(db, repo);
      const step = Math.max(1, allClean.length / MAX_CLEAN);
      const clean = Array.from({ length: Math.min(MAX_CLEAN, allClean.length) }, (_, i) => allClean[Math.floor(i * step)]);
      repoCases += cases.length;
      repoClean += clean.length;
      for (const c of cases) {
        ceiling.targets += c.targets.length;
        ceiling.findable += c.findable.length;
        ceiling.source += c.targets.filter((file) => isIndexable(file, 0)).length;
        ceiling.findableSource += c.findable.filter((file) => isIndexable(file, 0)).length;
        const truth = new Set(c.targets);
        const strong = missingCompanions(db, repo.id, c.files, new Set(c.files)).map((item) => item.path);
        companions.alerts += strong.length;
        companions.correct += strong.filter((file) => truth.has(file)).length;
        companions.hit += strong.some((file) => truth.has(file)) ? 1 : 0;
        const bucket = SIZE_BUCKETS.find((item) => c.files.length >= item.min && c.files.length <= item.max)!.label;
        for (const strategy of STRATEGIES) {
          const options: ImpactOptions = { ...strategy.options, ...(strategy.intent ? { intent: c.subject } : {}) };
          const ranked = impactOf(db, repo.id, c.files, { ...options, limit: 10, noteFiles: 0 }).items.map((item) => item.path);
          const alerted = alertsOf(db, repo.id, c.files, options);
          const score = scoreCase(ranked, alerted, c);
          pooled[strategy.name].push(score);
          if (c.strictTargets.length > 0) pooledStrict[strategy.name].push(scoreCase(ranked, alerted, { targets: c.strictTargets, findable: c.strictFindable }));
          if (strategy.name === "default") bySize[bucket].default.push(score);
          if (strategy.name === BEST) bySize[bucket].best.push(score);
        }
      }
      for (const c of clean) {
        const files = [...new Set(c.files)];
        companions.cleanAlarms.push(missingCompanions(db, repo.id, files, new Set(files)).length > 0 ? 1 : 0);
        for (const strategy of STRATEGIES) {
          const options: ImpactOptions = { ...strategy.options, ...(strategy.intent ? { intent: c.subject } : {}) };
          pooledClean[strategy.name].push(alertsOf(db, repo.id, files, options).length > 0 ? 1 : 0);
        }
      }
      process.stdout.write(`${name} 분할 ${index + 1}/${splits.length} ${split.sha.slice(0, 8)}: 사례 ${cases.length}, 오경보 표본 ${clean.length}\n`);
    }
    perRepo[name] = { cases: repoCases, clean: repoClean };
  }

  const summary = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.name, summarize(pooled[strategy.name], pooledClean[strategy.name])]));
  const n = pooled.default.length;
  process.stdout.write(`\n## 천장 — 사례 ${n}개, 놓친 파일 ${ceiling.targets}개\n`);
  const pct = (value: number) => `${((value / Math.max(1, ceiling.targets)) * 100).toFixed(1)}%`;
  process.stdout.write(`커밋 직전에 이미 있던 파일 ${pct(ceiling.findable)} (그중 소스 ${pct(ceiling.findableSource)}), 전체 중 소스 ${pct(ceiling.source)}\n`);
  process.stdout.write("\n## 전략별 (사례 평균)\n");
  process.stdout.write("전략                 hit@10  R@10   R@10찾을수있는  알림적중  알림정밀도  알림수  오경보\n");
  for (const [strategyName, s] of Object.entries(summary)) {
    process.stdout.write(
      `${strategyName.padEnd(20)} ${s.hit10.toFixed(3).padEnd(7)} ${s.recall10.toFixed(3).padEnd(6)} ${s.recallFindable10.toFixed(3).padEnd(15)} ${s.alertHit.toFixed(3).padEnd(9)} ${s.alertPrecision.toFixed(3).padEnd(11)} ${s.alertsPerCase.toFixed(2).padEnd(7)} ${s.falseAlarm.toFixed(3)}\n`,
    );
  }
  const strictSummary = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.name, summarize(pooledStrict[strategy.name], pooledClean[strategy.name])]));
  process.stdout.write(`\n## 엄격한 라벨 (같은 범위를 다시 고치거나 빠뜨림·빌드 오류를 고친 fix만) — 사례 ${pooledStrict.default.length}개\n`);
  process.stdout.write("전략                 hit@10  R@10   R@10찾을수있는  알림적중  알림정밀도\n");
  for (const [strategyName, s] of Object.entries(strictSummary)) {
    process.stdout.write(`${strategyName.padEnd(20)} ${s.hit10.toFixed(3).padEnd(7)} ${s.recall10.toFixed(3).padEnd(6)} ${s.recallFindable10.toFixed(3).padEnd(15)} ${s.alertHit.toFixed(3).padEnd(9)} ${s.alertPrecision.toFixed(3)}\n`);
  }
  for (const strategy of STRATEGIES.slice(1)) {
    const diffs = pooledStrict[strategy.name].map((score, i) => score.recall10 - pooledStrict.default[i].recall10);
    process.stdout.write(`  vs default ${strategy.name.padEnd(20)} ${mean(diffs) >= 0 ? "+" : ""}${mean(diffs)}  p=${wilcoxon(diffs).toFixed(4)}\n`);
  }
  const companionSummary = {
    alertHit: mean(Array.from({ length: n }, (_, i) => (i < companions.hit ? 1 : 0))),
    alertPrecision: companions.alerts ? +(companions.correct / companions.alerts).toFixed(3) : 0,
    falseAlarm: mean(companions.cleanAlarms),
  };
  process.stdout.write(`늘 같이(missingCompanions, 지금 기본 훅) 알림적중 ${companionSummary.alertHit} 정밀도 ${companionSummary.alertPrecision} 오경보 ${companionSummary.falseAlarm}\n`);
  process.stdout.write("\n## 짝 비교 vs default (사례별 R@10 차이, 윌콕슨)\n");
  const pairs: Record<string, { delta: number; p: number }> = {};
  for (const strategy of STRATEGIES.slice(1)) {
    const diffs = pooled[strategy.name].map((score, i) => score.recall10 - pooled.default[i].recall10);
    pairs[strategy.name] = { delta: mean(diffs), p: +wilcoxon(diffs).toFixed(4) };
    process.stdout.write(`${strategy.name.padEnd(20)} ${pairs[strategy.name].delta >= 0 ? "+" : ""}${pairs[strategy.name].delta}  p=${pairs[strategy.name].p}\n`);
  }
  process.stdout.write(`\n## 커밋 크기별 R@10 (default → ${BEST})\n`);
  for (const bucket of SIZE_BUCKETS) {
    const group = bySize[bucket.label];
    process.stdout.write(`${bucket.label.padEnd(5)} 사례 ${String(group.default.length).padEnd(4)} ${mean(group.default.map((s) => s.recall10))} → ${mean(group.best.map((s) => s.recall10))}\n`);
  }
  if (values.save) {
    const dirOut = path.resolve("bench", "results");
    fs.mkdirSync(dirOut, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dirOut, `missbench-${stamp}${values.label ? `-${values.label}` : ""}.json`);
    fs.writeFileSync(file, JSON.stringify({ label: values.label, ratios, repos: perRepo, ceiling, summary, strictSummary, companions: companionSummary, pairs }, null, 2));
    process.stdout.write(`결과: ${file}\n`);
  }
  db.close();
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 2;
    },
  );
}
