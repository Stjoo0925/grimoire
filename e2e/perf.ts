/**
 * 성능 루프 — 지금 Grimoire에 색인된 내 레포들을 코퍼스로, 빌드 둘(기준·후보)의 속도와 정확도를 한 번에 잰다.
 *
 *   npm run perf -- --freeze                       ~/.grimoire의 레포 목록과 지금 sha로 bench/perf.local.json을 만든다 (한 번)
 *   npm run perf -- --snapshot base                지금 빌드(dist)를 bench/builds/base로 떠 둔다 — 고치기 전에
 *   npm run perf -- --core bench/builds/base       기준(base)과 지금 소스(src)를 같은 코퍼스·같은 질의로 번갈아 잰다
 *   npm run perf -- --core … --save --note         결과를 bench/results/perf-*.json에 남기고, 판정을 Grimoire 노트로도 남긴다
 *   npm run perf -- --compare a.json b.json        저장한 두 결과를 다시 비교
 *
 * 왜 번갈아 재나: 같은 기계라도 몇 분 사이에 지연이 10~20% 흔들린다. 두 빌드의 DB를 나란히 열고 질의마다
 * A·B를 번갈아 돌리면 그 흔들림이 양쪽에 똑같이 실려, 상대 차이만 남는다.
 *
 * 질의는 손으로 쓰지 않고 색인에서 만든다 (그래서 레포가 바뀌어도 루프가 그대로 돈다).
 *  - commit: 커밋 제목(머리 "feat(x):"·꼬리 "(#N)" 뗌) → 그 커밋이 상위 8개 안에 있나. 제목을 그대로 쓰니 점수는
 *    부풀려진다 — 절대값이 아니라 **빌드 사이에 떨어지지 않았나**를 보는 안전망이다.
 *  - symbol: 한 파일에만 있는 심볼 이름 → 그 파일이 상위 8개 안에 있나.
 * 정확도는 eval(손 질문 89+48문항)이 본다. 여기서는 "빨라졌는데 결과가 바뀌지 않았나"만 본다.
 *
 * 지표: 첫 색인(메타)·diff 단계·바뀐 것 없는 재동기화 시간, DB 크기, search() 지연과 search_memory 응답 지연의
 * p50/p95, 질의 유형별 Acc@1·Acc@8. 판정은 docs/perf-loop.md의 채택 기준을 따른다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { tempDir } from "../tests/helpers";
import { mcnemar, pin } from "./eval";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Core = { db: any; search: any; indexer: any; diffs: any; tools: any };

interface CorpusItem {
  path: string;
  sha: string;
  tips: string[];
}

interface Query {
  id: string;
  type: "commit" | "symbol";
  q: string;
  /** 정답: commit이면 sha, symbol이면 "레포이름\0경로" */
  gold: string;
}

interface Side {
  label: string;
  dir: string;
  core: Core;
  db: any;
  indexMs: number;
  codeMs: number;
  resyncMs: number;
  dbBytes: number;
  searchMs: number[][];
  toolMs: number[][];
  ranks: (number | null)[];
}

const CONFIG = "bench/perf.local.json";
const TOP = 8;

function loadCore(dir: string): Core {
  const load = (name: string) => require(path.join(dir, name));
  return { db: load("core/db"), search: load("core/search"), indexer: load("core/indexer"), diffs: load("core/diffs"), tools: load("mcp/tools") };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 지금 Grimoire(~/.grimoire 또는 GRIMOIRE_HOME)에 색인된 레포 — 읽기 전용으로 연다 */
function indexedRepos(): string[] {
  const config = require(path.join(__dirname, "..", "src", "core", "config"));
  const file = config.dbPath() as string;
  if (!fs.existsSync(file)) throw new Error(`Grimoire DB가 없습니다: ${file} (grimoire scan을 먼저)`);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT path FROM repos ORDER BY id").all() as { path: string }[];
  db.close();
  return rows.map((row) => row.path).filter((dir) => fs.existsSync(dir));
}

/** 레포마다 HEAD와 브랜치·태그 끝 커밋을 지금 값으로 고정한다 — Grimoire는 이 끝들에서 닿는 커밋을 모두 본다 */
function freeze(): CorpusItem[] {
  return indexedRepos().map((dir) => {
    const sha = git(dir, ["rev-parse", "HEAD"]).trim();
    const tips = git(dir, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/tags"])
      .split("\n")
      .filter((tip) => tip && tip !== sha);
    // 태그 객체는 커밋으로 벗긴다 (update-ref는 무엇이든 받지만 Grimoire는 커밋 끝만 본다)
    const peeled = [...new Set(tips.map((tip) => git(dir, ["rev-parse", `${tip}^{commit}`]).trim()))].filter((tip) => tip !== sha);
    return { path: dir, sha, tips: peeled };
  });
}

function pick(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

const median = (values: number[]) => pick(values, 0.5);
const round = (value: number, digits = 2) => +value.toFixed(digits);

/** 색인에서 질의를 만든다 — sha·경로 순서로 고르므로 같은 코퍼스면 늘 같은 질의다 */
function makeQueries(db: any, perType: number): Query[] {
  const commits = db
    .prepare(
      `SELECT sha, subject FROM commits WHERE meaningful = 1 AND files_changed BETWEEN 1 AND 40 AND length(subject) >= 12
        GROUP BY subject HAVING COUNT(*) = 1 ORDER BY sha LIMIT ?`,
    )
    .all(perType) as { sha: string; subject: string }[];
  const queries: Query[] = commits.map((row) => ({
    id: `c-${row.sha.slice(0, 8)}`,
    type: "commit",
    q: row.subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/\s*\(#\d+\)\s*$/, ""),
    gold: row.sha,
  }));

  // 한 파일에만 있는 심볼 (짧거나 흔한 이름은 뺌)
  const files = db.prepare("SELECT r.name AS repo, f.path, f.symbols FROM code_files f JOIN repos r ON r.id = f.repo_id ORDER BY f.path, r.name").all() as {
    repo: string;
    path: string;
    symbols: string;
  }[];
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    for (const symbol of JSON.parse(file.symbols) as { name: string }[]) {
      if (symbol.name.length < 8) continue;
      const set = owners.get(symbol.name) ?? new Set<string>();
      set.add(`${file.repo}\0${file.path}`);
      owners.set(symbol.name, set);
    }
  }
  const unique = [...owners.entries()].filter(([, set]) => set.size === 1).sort(([a], [b]) => (a < b ? -1 : 1));
  const step = Math.max(1, Math.floor(unique.length / perType));
  for (let index = 0; index < unique.length && queries.filter((query) => query.type === "symbol").length < perType; index += step) {
    const [name, set] = unique[index];
    queries.push({ id: `s-${name}`, type: "symbol", q: name, gold: [...set][0] });
  }
  return queries;
}

function rankOf(hits: any[], query: Query): number | null {
  const index = hits.findIndex((hit) =>
    query.type === "commit" ? hit.ref === query.gold || (hit.also ?? []).includes(query.gold) : `${hit.repo}\0${hit.ref}` === query.gold,
  );
  return index < 0 ? null : index + 1;
}

async function indexSide(side: Side, pinned: { dir: string }[]): Promise<void> {
  const { core, db } = side;
  const repos: any[] = [];
  let start = Date.now();
  for (const item of pinned) {
    const repo = await core.indexer.addRepo(db, item.dir);
    await core.indexer.syncRepo(db, repo);
    repos.push(repo);
  }
  side.indexMs = Date.now() - start;
  start = Date.now();
  for (const repo of repos) await core.diffs.indexCommitCode(db, repo);
  side.codeMs = Date.now() - start;
  start = Date.now();
  for (const repo of repos) await core.indexer.syncRepo(db, repo);
  side.resyncMs = Date.now() - start;
  side.dbBytes = (db.pragma("page_count") as number) * (db.pragma("page_size") as number);
}

function report(side: Side, queries: Query[]) {
  const perQuery = (samples: number[][]) => samples.map(median);
  const search = perQuery(side.searchMs);
  const tool = perQuery(side.toolMs);
  const acc = (type: string) => {
    const rows = queries.map((query, index) => ({ query, rank: side.ranks[index] })).filter((row) => row.query.type === type);
    const n = rows.length || 1;
    return { n: rows.length, "acc@1": round(rows.filter((row) => row.rank === 1).length / n, 3), "acc@8": round(rows.filter((row) => row.rank !== null).length / n, 3) };
  };
  return {
    label: side.label,
    core: side.dir,
    indexMs: side.indexMs,
    codeMs: side.codeMs,
    resyncMs: side.resyncMs,
    dbMB: round(side.dbBytes / 1048576, 1),
    search: { p50: round(pick(search, 0.5)), p95: round(pick(search, 0.95)), max: round(Math.max(...search)) },
    tool: { p50: round(pick(tool, 0.5)), p95: round(pick(tool, 0.95)), max: round(Math.max(...tool)) },
    commit: acc("commit"),
    symbol: acc("symbol"),
  };
}

type Report = ReturnType<typeof report>;
interface Saved {
  at: string;
  corpus: { repos: string[]; commits: number; files: number };
  queries: { id: string; type: string; q: string }[];
  sides: (Report & { ranks: (number | null)[]; searchMs: number[] })[];
}

/** 기준(a) 대비 후보(b) — 시간 지표는 % 변화, 정확도는 질의별 짝 비교 */
function verdict(a: Saved["sides"][number], b: Saved["sides"][number], queries: Saved["queries"]): string[] {
  const lines: string[] = [];
  const pct = (x: number, y: number) => (x === 0 ? 0 : round(((y - x) / x) * 100, 1));
  const time: [string, number, number][] = [
    ["색인(메타)", a.indexMs, b.indexMs],
    ["diff 단계", a.codeMs, b.codeMs],
    ["재동기화", a.resyncMs, b.resyncMs],
    ["search p50", a.search.p50, b.search.p50],
    ["search p95", a.search.p95, b.search.p95],
    ["응답 p50", a.tool.p50, b.tool.p50],
    ["응답 p95", a.tool.p95, b.tool.p95],
    ["DB MB", a.dbMB, b.dbMB],
  ];
  lines.push(`지표          ${a.label.padStart(10)} ${b.label.padStart(10)}   변화`);
  for (const [name, x, y] of time) lines.push(`${name.padEnd(12)} ${String(x).padStart(10)} ${String(y).padStart(10)}   ${pct(x, y) > 0 ? "+" : ""}${pct(x, y)}%`);

  let regressed = false;
  for (const type of ["commit", "symbol"]) {
    const index = queries.map((query, i) => (query.type === type ? i : -1)).filter((i) => i >= 0);
    for (const [name, ok] of [
      ["acc@1", (rank: number | null) => rank === 1],
      ["acc@8", (rank: number | null) => rank !== null],
    ] as const) {
      const onlyA = index.filter((i) => ok(a.ranks[i]) && !ok(b.ranks[i]));
      const onlyB = index.filter((i) => !ok(a.ranks[i]) && ok(b.ranks[i]));
      const p = mcnemar(onlyA.length, onlyB.length);
      // 채택 기준: 순손실 2문항 이하이거나 손실이 유의하지 않음(p ≥ 0.1)
      const loss = onlyA.length - onlyB.length > 2 && p < 0.1;
      if (loss) regressed = true;
      lines.push(
        `${`${type} ${name}`.padEnd(14)} ${a.label}만=${onlyA.length} ${b.label}만=${onlyB.length} p=${p.toFixed(3)}${loss ? "  ✗ 정확도 손실" : ""}` +
          (onlyA.length > 0 && onlyA.length <= 5 ? `  (${a.label}만: ${onlyA.map((i) => queries[i].id).join(" ")})` : ""),
      );
    }
  }
  // 문턱: 지연은 질의 수백 개의 분위수라 ±5% 안에서 흔들리고, 색인·동기화는 한 번 잰 값이라 ±10%까지 흔들린다
  // (같은 빌드끼리 잰 A/A 기록). 그래서 지연 10%, 색인·동기화 20%를 넘어야 차이로 본다.
  const margin = (name: string) => (/^(search|응답)/.test(name) ? 0.1 : 0.2);
  const wins = time.filter(([name, x, y]) => name !== "DB MB" && y <= x * (1 - margin(name))).map(([name]) => name);
  const losses = time.filter(([name, x, y]) => y > x * (1 + margin(name))).map(([name]) => name);
  const ok = !regressed && wins.length > 0 && losses.length === 0;
  lines.push(
    `판정: ${ok ? "✓ 채택" : "✗ 미채택"} — 10% 이상 빨라짐: ${wins.join(", ") || "없음"} / 10% 이상 나빠짐: ${losses.join(", ") || "없음"}` +
      `${regressed ? " / 정확도 손실" : ""}`,
  );
  return lines;
}

function noteText(saved: Saved, lines: string[], message: string): string {
  const [a, b] = saved.sides;
  return [
    `perf: ${message || `${b.label} vs ${a.label}`} — ${lines[lines.length - 1].replace(/^판정: /, "")}`,
    `코퍼스: 레포 ${saved.corpus.repos.length}개, 커밋 ${saved.corpus.commits}, 파일 ${saved.corpus.files}, 질의 ${saved.queries.length}`,
    ...lines.slice(0, -1),
  ].join("\n");
}

function recordNote(text: string): void {
  const cli = path.resolve(__dirname, "..", "..", "dist", "cli.js");
  const args = [cli, "note", text, "--tag", "perf", "--tag", "perf-loop"];
  try {
    execFileSync(process.execPath, [...args, "--repo", "grimoire"], { stdio: "inherit" });
  } catch {
    // grimoire 레포가 색인돼 있지 않으면 레포 없이 남긴다
    execFileSync(process.execPath, args, { stdio: "inherit" });
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      freeze: { type: "boolean" },
      snapshot: { type: "string" },
      core: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      queries: { type: "string" },
      rounds: { type: "string" },
      save: { type: "boolean" },
      note: { type: "boolean" },
      message: { type: "string" },
      compare: { type: "boolean" },
    },
  });

  if (values.compare) {
    const [a, b] = positionals.map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as Saved);
    // 각 파일의 마지막 쪽(후보)끼리 비교한다
    const sideA = a.sides[a.sides.length - 1];
    const sideB = b.sides[b.sides.length - 1];
    if (a.queries.map((query) => query.id).join() !== b.queries.map((query) => query.id).join()) throw new Error("두 결과의 질의가 다릅니다 (코퍼스가 달라짐)");
    for (const line of verdict(sideA, sideB, a.queries)) console.log(line);
    return 0;
  }

  if (values.snapshot) {
    const from = path.resolve(__dirname, "..", "..", "dist");
    const to = path.resolve("bench", "builds", values.snapshot);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    console.log(`빌드 고정: ${to}`);
    return 0;
  }

  if (values.freeze || !fs.existsSync(CONFIG)) {
    const corpus = freeze();
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ corpus }, null, 2));
    console.log(`코퍼스 고정: ${CONFIG} (레포 ${corpus.length}개)`);
    if (values.freeze) return 0;
  }
  const corpus = (JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { corpus: CorpusItem[] }).corpus;

  // 기준 빌드(--core, 여러 개 가능) + 지금 소스. 같은 이름 레포가 있으면 pin 폴더가 겹치므로 번호를 붙인다
  const dirs = [...(values.core ?? []).map((dir) => path.resolve(dir)), path.resolve(__dirname, "..", "src")];
  const labels = dirs.map((dir, index) => values.label?.[index] ?? (index === dirs.length - 1 ? "src" : path.basename(dir)));
  const work = tempDir("grimoire-perf-");
  const pinned = corpus.map((item, index) => ({ dir: pin(item.path, item.sha, path.join(work, "repos", String(index)), item.tips) }));

  const sides: Side[] = [];
  for (const [index, dir] of dirs.entries()) {
    const core = loadCore(dir);
    const side: Side = {
      label: labels[index],
      dir,
      core,
      db: core.db.openDb(path.join(work, `${index}.db`)),
      indexMs: 0,
      codeMs: 0,
      resyncMs: 0,
      dbBytes: 0,
      searchMs: [],
      toolMs: [],
      ranks: [],
    };
    process.stderr.write(`색인 ${side.label} …\n`);
    await indexSide(side, pinned);
    sides.push(side);
  }

  const first = sides[0].db;
  const queries = makeQueries(first, Number.parseInt(values.queries ?? "150", 10));
  const rounds = Math.max(1, Number.parseInt(values.rounds ?? "3", 10));
  const counts = {
    commits: (first.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number }).n,
    files: (first.prepare("SELECT COUNT(*) AS n FROM code_files").get() as { n: number }).n,
  };
  process.stderr.write(`질의 ${queries.length}개 × ${rounds}회, 빌드 ${sides.length}개 번갈아\n`);

  // 데우기 한 바퀴 (FTS 페이지 캐시·모듈 JIT) — 기록하지 않는다
  for (const side of sides) for (const query of queries) side.core.search.search(side.db, query.q, { limit: TOP });
  for (const side of sides) {
    side.searchMs = queries.map(() => []);
    side.toolMs = queries.map(() => []);
  }
  for (let round = 0; round < rounds; round++) {
    for (const [index, query] of queries.entries()) {
      // 순서도 번갈아 — 매번 같은 쪽이 먼저 돌면 캐시 이득이 한쪽에만 간다
      const order = (round + index) % 2 === 0 ? sides : [...sides].reverse();
      for (const side of order) {
        let start = process.hrtime.bigint();
        const result = side.core.search.search(side.db, query.q, { limit: TOP });
        side.searchMs[index].push(Number(process.hrtime.bigint() - start) / 1e6);
        if (round === 0) side.ranks[index] = rankOf(result.hits, query);
        start = process.hrtime.bigint();
        await side.core.tools.callTool({ db: side.db, me: [], cwd: "/" }, "search_memory", { query: query.q });
        side.toolMs[index].push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    }
  }

  const reports = sides.map((side) => report(side, queries));
  console.log(JSON.stringify({ corpus: { repos: corpus.length, ...counts }, queries: queries.length, rounds, sides: reports }, null, 2));
  const saved: Saved = {
    at: new Date().toISOString(),
    corpus: { repos: corpus.map((item) => `${path.basename(item.path)}@${item.sha.slice(0, 7)}`), ...counts },
    queries: queries.map(({ id, type, q }) => ({ id, type, q })),
    sides: reports.map((item, index) => ({ ...item, ranks: sides[index].ranks, searchMs: sides[index].searchMs.map(median) })),
  };
  const lines = sides.length >= 2 ? verdict(saved.sides[0], saved.sides[saved.sides.length - 1], saved.queries) : [];
  if (lines.length > 0) console.log(`\n${lines.join("\n")}`);

  // 가장 느린 질의 — 다음에 볼 곳
  const last = saved.sides[saved.sides.length - 1];
  const slow = last.searchMs
    .map((ms, index) => ({ ms, query: queries[index] }))
    .sort((x, y) => y.ms - x.ms)
    .slice(0, 5);
  console.log(`\n느린 질의 (${last.label}): ${slow.map((item) => `${round(item.ms, 1)}ms "${item.query.q.slice(0, 40)}"`).join(" · ")}`);

  if (values.save) {
    const label = values.message ? `-${values.message.replace(/[^\p{L}\p{N}-]+/gu, "-").slice(0, 40)}` : "";
    const out = path.join("bench", "results", `perf-${saved.at.replace(/[:.]/g, "-")}${label}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(saved, null, 2));
    console.error(`저장: ${out}`);
  }
  if (values.note && lines.length > 0) recordNote(noteText(saved, lines, values.message ?? ""));

  for (const side of sides) side.db.close();
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
