/**
 * 실사용 리포트 — 벤치(버그를 미리 설명해 준 단독 에이전트)로는 안 보이는 grimoire의 값을 실제 세션에서 잰다. 읽기 전용.
 *
 *   npm run usage -- [--since 2026-10-20] [--repo ~/work/foo] [--json] [--save]
 *
 * 입력(둘 다 읽기만 한다)
 *   - Claude Code 대화 기록 ~/.claude/projects/*\/*.jsonl (줄 단위로 스트리밍 — 수십 MB도 메모리에 올리지 않는다)
 *   - 그 세션이 일한 레포의 git 이력 (cwd에서 레포 루트를 구하고, .claude/worktrees/<x>는 본 레포로 되돌린다)
 *
 * 세션→커밋 짝짓기: 레포가 같고 커밋의 author 시각이 세션 시간 범위(첫~마지막 줄, 앞뒤 60초 여유) 안이면 그 세션의 커밋이다.
 * 범위가 겹치는 세션이 여럿이면 커밋 시각 직전 10분 안에 `git commit` Bash 호출이 있는 세션을 고르고, 그래도 하나로
 * 안 좁혀지면 모호한 커밋으로 세고 비교에서 뺀다.
 *
 * 재손질률(결과 지표): 세션 중 만든 커밋 C가 48시간 안에 "C와 같은 파일을 하나라도 고치는, 제목이 수정처럼 보이는 커밋"
 * (FIX_SUBJECT)으로 이어지는 비율. 세션이 그 커밋 전에 impact(MCP 또는 grimoire-impact 스킬)를 불렀는지로 나눈다.
 * 표본이 작으니 분자·분모를 그대로 찍는다. 48시간이 아직 안 지난 최근 커밋은 비율에서 뺀다(아직 모르므로).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

import { FIX_SUBJECT } from "../src/core/context";

export const RETOUCH_HOURS = 48;
const GRACE_MS = 60_000;
const COMMIT_CALL_WINDOW_MS = 10 * 60_000;

// ───────── 대화 기록 파싱 ─────────

export interface ToolCall {
  ts: number;
  name: string;
  input: Record<string, unknown>;
}

export interface Session {
  id: string;
  file: string;
  first: number;
  last: number;
  cwds: string[];
  calls: ToolCall[];
}

/** 줄 하나에서 시각·cwd·sessionId·tool_use 호출을 뽑는다. JSON이 아니거나 모양이 낯설면 null/빈 값 — 모르는 줄은 건너뛴다. */
export function parseLine(line: string): {
  ts?: number;
  cwd?: string;
  sessionId?: string;
  calls: Array<{ name: string; input: Record<string, unknown> }>;
} | null {
  if (!line.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const t = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const message = o.message as { role?: unknown; content?: unknown } | undefined;
  if (o.type === "assistant" && message && Array.isArray(message.content)) {
    for (const item of message.content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.type !== "tool_use" || typeof it.name !== "string") continue;
      const input = it.input && typeof it.input === "object" ? (it.input as Record<string, unknown>) : {};
      calls.push({ name: it.name, input });
    }
  }
  return {
    ts: Number.isNaN(t) ? undefined : t,
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    calls,
  };
}

/** jsonl 하나 = 세션 하나. 시간 범위는 타임스탬프가 있는 모든 줄로 잡는다. 호출이 없는 줄만 있어도 세션으로 센다. */
export async function scanTranscript(file: string): Promise<Session | null> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let id = "";
  let first = Infinity;
  let last = -Infinity;
  const cwds = new Set<string>();
  const calls: ToolCall[] = [];
  let lastTs: number | undefined;
  for await (const line of rl) {
    const p = parseLine(line);
    if (!p) continue;
    if (!id && p.sessionId) id = p.sessionId;
    if (p.cwd) cwds.add(p.cwd);
    if (p.ts !== undefined) {
      if (p.ts < first) first = p.ts;
      if (p.ts > last) last = p.ts;
      lastTs = p.ts;
    }
    for (const c of p.calls) {
      const ts = p.ts ?? lastTs; // 시각 없는 줄은 직전 줄 시각으로 대신한다
      if (ts === undefined) continue;
      calls.push({ ts, name: c.name, input: c.input });
    }
  }
  if (!Number.isFinite(first)) return null;
  return { id: id || path.basename(file, ".jsonl"), file, first, last, cwds: [...cwds], calls };
}

/** `mcp__grimoire__search_memory` → `search_memory`. grimoire MCP 도구가 아니면 null. */
export function grimoireTool(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3 || !parts[1].toLowerCase().includes("grimoire")) return null;
  return parts.slice(2).join("__");
}

/** `grimoire-impact` 스킬 호출인가 (Skill 도구의 input.skill 또는 input.name). */
export function isImpactSkill(call: { name: string; input: Record<string, unknown> }): boolean {
  if (call.name !== "Skill") return false;
  const v = call.input.skill ?? call.input.name;
  return typeof v === "string" && v.includes("grimoire-impact");
}

export function isImpactCall(call: { name: string; input: Record<string, unknown> }): boolean {
  return grimoireTool(call.name) === "impact" || isImpactSkill(call);
}

export function isGitCommitCall(call: { name: string; input: Record<string, unknown> }): boolean {
  if (call.name !== "Bash" && call.name !== "PowerShell") return false;
  const cmd = call.input.command;
  return typeof cmd === "string" && /\bgit\b[^|;&\n]*\bcommit\b/.test(cmd);
}

export interface CallSummary {
  sessions: number;
  grimoireSessions: number;
  perTool: Record<string, number>;
  impactSkillCalls: number;
  impactWithIntent: number;
}

export function summarizeCalls(sessions: Session[]): CallSummary {
  const perTool: Record<string, number> = {};
  let grimoireSessions = 0;
  let impactSkillCalls = 0;
  let impactWithIntent = 0;
  for (const s of sessions) {
    let used = false;
    for (const c of s.calls) {
      const tool = grimoireTool(c.name);
      if (tool) {
        used = true;
        perTool[tool] = (perTool[tool] ?? 0) + 1;
        if (tool === "impact" && typeof c.input.intent === "string" && c.input.intent.trim()) impactWithIntent++;
      } else if (isImpactSkill(c)) {
        impactSkillCalls++;
      }
    }
    if (used) grimoireSessions++;
  }
  return { sessions: sessions.length, grimoireSessions, perTool, impactSkillCalls, impactWithIntent };
}

// ───────── 레포 ─────────

const WORKTREE_RE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/;

/** cwd에서 `.claude/worktrees/<x>` 이하를 잘라 본 레포 경로로 되돌린다. */
export function stripWorktree(cwd: string): string {
  return cwd.replace(WORKTREE_RE, "");
}

const rootCache = new Map<string, string | null>();

/** cwd가 속한 git 레포의 루트(worktree는 본 레포). 폴더가 없거나 git이 아니면 null. */
export function repoRootOf(cwd: string): string | null {
  const base = stripWorktree(cwd);
  if (rootCache.has(base)) return rootCache.get(base)!;
  let root: string | null = null;
  try {
    if (fs.existsSync(base)) {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: base,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      root = top ? normPath(top) : null;
    }
  } catch {
    root = null;
  }
  rootCache.set(base, root);
  return root;
}

export function normPath(p: string): string {
  const r = path.resolve(p);
  try {
    return fs.realpathSync.native(r);
  } catch {
    return r;
  }
}

export function samePath(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export interface RepoCommit {
  sha: string;
  /** author 시각(ms) */
  at: number;
  subject: string;
  files: string[];
}

/** 모든 브랜치의 머지 아닌 커밋 + 바꾼 파일. */
export function readCommits(repo: string): RepoCommit[] {
  const out = execFileSync(
    "git",
    ["-c", "core.quotepath=off", "log", "--all", "--no-merges", "--name-only", "--format=%x1e%H%x1f%at%x1f%s"],
    { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const commits: RepoCommit[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split("\n");
    const [sha, at, ...subject] = head.split("\x1f");
    if (!sha || !at) continue;
    commits.push({
      sha,
      at: Number(at) * 1000,
      subject: subject.join("\x1f"),
      files: rest.map((l) => l.trim()).filter(Boolean),
    });
  }
  return commits;
}

// ───────── 짝짓기·재손질 ─────────

/** C 뒤 hours 시간 안에, 같은 파일을 하나라도 고치는 수정성 커밋이 있으면 그 커밋. */
export function findRetouch(c: RepoCommit, all: RepoCommit[], hours = RETOUCH_HOURS): RepoCommit | null {
  const files = new Set(c.files);
  const limit = c.at + hours * 3_600_000;
  for (const d of all) {
    if (d.sha === c.sha || d.at <= c.at || d.at > limit) continue;
    if (!FIX_SUBJECT.test(d.subject)) continue;
    if (d.files.some((f) => files.has(f))) return d;
  }
  return null;
}

export interface Attribution {
  session: Session | null;
  ambiguous: boolean;
}

/** 커밋이 어느 세션 것인지. 겹치는 세션이 여럿이면 직전 `git commit` 호출이 있는 세션을 고른다. */
export function attributeCommit(c: RepoCommit, candidates: Session[]): Attribution {
  const inRange = candidates.filter((s) => c.at >= s.first - GRACE_MS && c.at <= s.last + GRACE_MS);
  if (inRange.length === 0) return { session: null, ambiguous: false };
  if (inRange.length === 1) return { session: inRange[0], ambiguous: false };
  const withCall = inRange.filter((s) =>
    s.calls.some((k) => isGitCommitCall(k) && k.ts <= c.at + GRACE_MS && k.ts >= c.at - COMMIT_CALL_WINDOW_MS),
  );
  if (withCall.length === 1) return { session: withCall[0], ambiguous: false };
  return { session: null, ambiguous: true };
}

/** 세션이 시각 t 이전에 impact(MCP/스킬)를 불렀나. */
export function usedImpactBefore(s: Session, t: number): boolean {
  return s.calls.some((k) => isImpactCall(k) && k.ts <= t);
}

export function usedGrimoireBefore(s: Session, t: number): boolean {
  return s.calls.some((k) => grimoireTool(k.name) !== null && k.ts <= t);
}

export interface Rate {
  n: number;
  retouched: number;
  rate: number | null;
}

function rate(n: number, retouched: number): Rate {
  return { n, retouched, rate: n ? retouched / n : null };
}

export interface RetouchReport {
  repos: number;
  commitsInSessions: number;
  ambiguous: number;
  /** 48시간이 아직 안 지나 판정 못 한 커밋 */
  immature: number;
  withImpact: Rate;
  withoutImpact: Rate;
  withGrimoire: Rate;
  withoutGrimoire: Rate;
  overall: Rate;
}

export function retouchReport(
  sessionsByRepo: Map<string, Session[]>,
  commitsByRepo: Map<string, RepoCommit[]>,
  now: number,
  since: number,
  hours = RETOUCH_HOURS,
): RetouchReport {
  let inSessions = 0;
  let ambiguous = 0;
  let immature = 0;
  const acc = { imp: [0, 0], noImp: [0, 0], gri: [0, 0], noGri: [0, 0], all: [0, 0] };
  const bump = (a: number[], hit: boolean) => {
    a[0]++;
    if (hit) a[1]++;
  };
  for (const [repo, sessions] of sessionsByRepo) {
    const commits = commitsByRepo.get(repo) ?? [];
    for (const c of commits) {
      if (c.at < since) continue;
      const { session, ambiguous: amb } = attributeCommit(c, sessions);
      if (amb) ambiguous++;
      if (!session) continue;
      inSessions++;
      if (c.at + hours * 3_600_000 > now) {
        immature++;
        continue;
      }
      const hit = findRetouch(c, commits, hours) !== null;
      bump(acc.all, hit);
      bump(usedImpactBefore(session, c.at) ? acc.imp : acc.noImp, hit);
      bump(usedGrimoireBefore(session, c.at) ? acc.gri : acc.noGri, hit);
    }
  }
  return {
    repos: sessionsByRepo.size,
    commitsInSessions: inSessions,
    ambiguous,
    immature,
    withImpact: rate(acc.imp[0], acc.imp[1]),
    withoutImpact: rate(acc.noImp[0], acc.noImp[1]),
    withGrimoire: rate(acc.gri[0], acc.gri[1]),
    withoutGrimoire: rate(acc.noGri[0], acc.noGri[1]),
    overall: rate(acc.all[0], acc.all[1]),
  };
}

// ───────── 전체 ─────────

export interface UsageReport {
  generatedAt: string;
  since: string;
  repoFilter: string | null;
  calls: CallSummary;
  retouch: RetouchReport;
}

export function listTranscripts(projectsDir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(projectsDir)) return files;
  for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
  }
  return files;
}

export async function buildReport(opts: {
  projectsDir: string;
  since: number;
  repo?: string;
  now?: number;
}): Promise<UsageReport> {
  const now = opts.now ?? Date.now();
  const sessions: Session[] = [];
  for (const file of listTranscripts(opts.projectsDir)) {
    // 수정 시각이 since보다 이전이면 그 뒤 줄이 없으니 읽지 않는다
    if (fs.statSync(file).mtimeMs < opts.since) continue;
    const s = await scanTranscript(file);
    if (s && s.last >= opts.since) sessions.push(s);
  }
  const sessionsByRepo = new Map<string, Session[]>();
  const selected: Session[] = [];
  for (const s of sessions) {
    const roots = new Set<string>();
    for (const cwd of s.cwds) {
      const r = repoRootOf(cwd);
      if (r) roots.add(r);
    }
    if (opts.repo && ![...roots].some((r) => samePath(r, opts.repo!))) continue;
    selected.push(s);
    for (const r of roots) {
      if (opts.repo && !samePath(r, opts.repo)) continue;
      const list = sessionsByRepo.get(r) ?? [];
      list.push(s);
      sessionsByRepo.set(r, list);
    }
  }
  const commitsByRepo = new Map<string, RepoCommit[]>();
  for (const r of sessionsByRepo.keys()) {
    try {
      commitsByRepo.set(r, readCommits(r));
    } catch {
      commitsByRepo.set(r, []);
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    since: new Date(opts.since).toISOString(),
    repoFilter: opts.repo ?? null,
    calls: summarizeCalls(selected),
    retouch: retouchReport(sessionsByRepo, commitsByRepo, now, opts.since),
  };
}

const pct = (r: Rate) => (r.rate === null ? "-" : `${(r.rate * 100).toFixed(0)}%`);
const line = (label: string, r: Rate) => `  ${label.padEnd(22)} ${pct(r).padStart(4)}  (${r.retouched}/${r.n})`;

export function formatReport(r: UsageReport): string {
  const c = r.calls;
  const out: string[] = [];
  out.push(`실사용 리포트 — ${r.since.slice(0, 10)} 이후${r.repoFilter ? `, 레포 ${r.repoFilter}` : ""}`);
  out.push("");
  out.push("1. 사용량");
  out.push(`  세션 ${c.sessions}개 중 grimoire MCP 도구를 쓴 세션 ${c.grimoireSessions}개`);
  const tools = Object.entries(c.perTool).sort((a, b) => b[1] - a[1]);
  out.push(`  도구별 호출: ${tools.length ? tools.map(([k, v]) => `${k} ${v}`).join(", ") : "없음"}`);
  out.push(`  grimoire-impact 스킬 호출 ${c.impactSkillCalls}회, intent를 넘긴 impact 호출 ${c.impactWithIntent}회`);
  out.push("");
  const t = r.retouch;
  out.push(`2. 재손질률 — 세션 중 커밋이 ${RETOUCH_HOURS}시간 안에 같은 파일의 수정 커밋으로 이어진 비율`);
  out.push(
    `  레포 ${t.repos}개, 세션 중 커밋 ${t.commitsInSessions}개 (모호 ${t.ambiguous}개 제외, ${RETOUCH_HOURS}시간 미경과 ${t.immature}개 제외)`,
  );
  out.push(line("impact를 먼저 부름", t.withImpact));
  out.push(line("impact 안 부름", t.withoutImpact));
  out.push(line("grimoire 도구 썼음", t.withGrimoire));
  out.push(line("grimoire 도구 안 씀", t.withoutGrimoire));
  out.push(line("전체", t.overall));
  const small = Math.min(t.withImpact.n, t.withoutImpact.n);
  if (small < 30) out.push(`  주의: 작은 쪽 표본이 ${small}개라 차이를 해석하기 어렵다.`);
  return out.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      since: { type: "string" },
      repo: { type: "string" },
      json: { type: "boolean", default: false },
      save: { type: "boolean", default: false },
      projects: { type: "string" },
    },
  });
  const sinceMs = values.since ? Date.parse(values.since) : Date.now() - 14 * 86_400_000;
  if (Number.isNaN(sinceMs)) throw new Error(`--since 날짜를 읽을 수 없다: ${values.since}`);
  const report = await buildReport({
    projectsDir: values.projects ?? path.join(os.homedir(), ".claude", "projects"),
    since: sinceMs,
    repo: values.repo ? normPath(values.repo) : undefined,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (values.save) {
    const dir = path.join(__dirname, "..", "..", "bench", "results");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const file = path.join(dir, `usage-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.error(`저장: ${file}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
