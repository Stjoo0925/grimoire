/**
 * 실사용 리포트 — 벤치(버그를 미리 설명해 준 단독 에이전트)로는 안 보이는 grimoire의 값을 실제 세션에서 잰다. 읽기 전용.
 *
 *   npm run usage -- [--since 2026-10-20] [--until 2026-10-28] [--repo ~/work/foo] [--json] [--save]
 *
 * 기간은 [since, until) — 세션·커밋·도구 호출 모두 이 안의 것만 센다. until을 빼면 지금까지.
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
 * 이 지표는 같은 파일의 일반 반복 수정까지 세서 바닥이 높다(약 68%, 노트 #65).
 *
 * 놓친 파일률(impact가 줄일 수 있는 것): C를 고친 수정 커밋들이 고친 파일 중 C에 없던 파일 = C가 놓친 파일.
 * 놓친 파일이 하나라도 있는 커밋의 비율을 impact 유무와 커밋 크기별로 나눈다. 노이즈 걸러내기(노트 #66):
 * 같은 변경(브랜치 원본↔squash)은 한 번만, 되돌리기·큰 fix는 빼고, fix 하나는 그 파일을 직전에 건드린 커밋 하나에만 매긴다.
 * 실전 recall: impact MCP를 부른 세션에서, 커밋 직전 마지막 impact 결과(제안 목록)에 놓친 파일이 들어 있었던 비율.
 * 스킬이 CLI로 부른 impact는 결과 형식이 달라 recall에 넣지 않는다.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

import { changeKey, FIX_SUBJECT } from "../src/core/context";

export const RETOUCH_HOURS = 48;
const GRACE_MS = 60_000;
const COMMIT_CALL_WINDOW_MS = 10 * 60_000;

// ───────── 대화 기록 파싱 ─────────

export interface ToolCall {
  ts: number;
  name: string;
  input: Record<string, unknown>;
}

/** impact MCP 호출 하나의 결과 — 제안한 파일(레포 상대 경로) */
export interface ImpactResult {
  ts: number;
  suggested: string[];
}

export interface Session {
  id: string;
  file: string;
  first: number;
  last: number;
  cwds: string[];
  calls: ToolCall[];
  impactResults?: ImpactResult[];
}

/** 줄 하나에서 시각·cwd·sessionId·tool_use 호출·tool_result를 뽑는다. JSON이 아니거나 모양이 낯설면 null/빈 값 — 모르는 줄은 건너뛴다. */
export function parseLine(line: string): {
  ts?: number;
  cwd?: string;
  sessionId?: string;
  calls: Array<{ id?: string; name: string; input: Record<string, unknown> }>;
  results: Array<{ id: string; text: string }>;
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
  const calls: Array<{ id?: string; name: string; input: Record<string, unknown> }> = [];
  const results: Array<{ id: string; text: string }> = [];
  const message = o.message as { role?: unknown; content?: unknown } | undefined;
  if (o.type === "assistant" && message && Array.isArray(message.content)) {
    for (const item of message.content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.type !== "tool_use" || typeof it.name !== "string") continue;
      const input = it.input && typeof it.input === "object" ? (it.input as Record<string, unknown>) : {};
      calls.push({ ...(typeof it.id === "string" ? { id: it.id } : {}), name: it.name, input });
    }
  }
  if (o.type === "user" && message && Array.isArray(message.content)) {
    for (const item of message.content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.type !== "tool_result" || typeof it.tool_use_id !== "string") continue;
      results.push({ id: it.tool_use_id, text: resultText(it.content) });
    }
  }
  return {
    ts: Number.isNaN(t) ? undefined : t,
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    calls,
    results,
  };
}

/** tool_result.content는 문자열이거나 [{type:"text", text}] 배열 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
}

/** impact 줄 "0.82 src/a.ts — 근거" 또는 의도로만 찾은 "intent src/a.ts — 근거" (core/impact.ts impactLines)에서 경로 */
const IMPACT_LINE = /^(?:-?\d+(?:\.\d+)?|intent)\s+(.+?)\s+—\s/;

/** impact MCP 결과(JSON의 impact 배열)에서 제안된 파일. 오류 문자열 등 낯선 결과면 빈 배열. */
export function parseImpactSuggestions(text: string): string[] {
  let lines: unknown;
  try {
    lines = (JSON.parse(text) as { impact?: unknown }).impact;
  } catch {
    return [];
  }
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const l of lines) {
    const m = typeof l === "string" ? IMPACT_LINE.exec(l) : null;
    if (m) out.push(m[1]);
  }
  return out;
}

/** jsonl 하나 = 세션 하나. 시간 범위는 타임스탬프가 있는 모든 줄로 잡는다. 호출이 없는 줄만 있어도 세션으로 센다. */
export async function scanTranscript(file: string): Promise<Session | null> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let id = "";
  let first = Infinity;
  let last = -Infinity;
  const cwds = new Set<string>();
  const calls: ToolCall[] = [];
  const impactResults: ImpactResult[] = [];
  const impactIds = new Set<string>();
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
    const ts = p.ts ?? lastTs; // 시각 없는 줄은 직전 줄 시각으로 대신한다
    if (ts === undefined) continue;
    for (const c of p.calls) {
      calls.push({ ts, name: c.name, input: c.input });
      if (c.id && grimoireTool(c.name) === "impact") impactIds.add(c.id);
    }
    for (const r of p.results) {
      if (!impactIds.delete(r.id)) continue;
      impactResults.push({ ts, suggested: parseImpactSuggestions(r.text) });
    }
  }
  if (!Number.isFinite(first)) return null;
  return { id: id || path.basename(file, ".jsonl"), file, first, last, cwds: [...cwds], calls, impactResults };
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

/** 세션들의 도구 호출을 센다. 범위 [since, until)를 주면 그 안의 호출만 — 기간 경계에 걸친 세션의 바깥 호출은 빼야 비교가 맞는다. */
export function summarizeCalls(sessions: Session[], since = -Infinity, until = Infinity): CallSummary {
  const perTool: Record<string, number> = {};
  let grimoireSessions = 0;
  let impactSkillCalls = 0;
  let impactWithIntent = 0;
  for (const s of sessions) {
    let used = false;
    for (const c of s.calls) {
      if (c.ts < since || c.ts >= until) continue;
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

/** C 뒤 hours 시간 안에, 같은 파일을 하나라도 고치는 수정성 커밋 전부. */
export function findRetouches(c: RepoCommit, all: RepoCommit[], hours = RETOUCH_HOURS): RepoCommit[] {
  const files = new Set(c.files);
  const limit = c.at + hours * 3_600_000;
  return all.filter(
    (d) =>
      d.sha !== c.sha && d.at > c.at && d.at <= limit && FIX_SUBJECT.test(d.subject) && d.files.some((f) => files.has(f)),
  );
}

/** C 뒤 hours 시간 안에, 같은 파일을 하나라도 고치는 수정성 커밋이 있으면 그 커밋. */
export function findRetouch(c: RepoCommit, all: RepoCommit[], hours = RETOUCH_HOURS): RepoCommit | null {
  return findRetouches(c, all, hours)[0] ?? null;
}

/** 놓친 파일을 셀 때 수정 커밋 크기 상한 — 이보다 큰 fix는 "C를 고친 것"보다 별개 작업일 가능성이 크다 */
export const MISSED_MAX_FIX_FILES = 10;
const REVERT_SUBJECT = /\brevert|되돌/i;
const SQUASH_SUFFIX = /\s*\(#\d+\)\s*$/;
const SQUASH_WINDOW_MS = 14 * 86_400_000;

/**
 * 같은 변경이 두 번 보이는 것을 접는다(시각순, 먼저 나온 것만 남김). `--all`로 읽으면 브랜치 원본과 squash 머지 커밋이 둘 다 나온다.
 * changeKey(제목+파일)가 같거나, squash 커밋(제목 끝 "(#N)")의 파일 집합이 14일 안의 앞선 커밋과 같으면 같은 변경 —
 * squash 제목은 PR 제목이라 브랜치 커밋 제목과 다를 때가 많다.
 */
export function dedupeChanges(commits: RepoCommit[]): RepoCommit[] {
  const keys = new Set<string>();
  const lastByFiles = new Map<string, number>();
  const out: RepoCommit[] = [];
  for (const c of [...commits].sort((a, b) => a.at - b.at)) {
    const files = [...new Set(c.files)].sort().join("\n");
    const key = changeKey(c.subject, c.files);
    const prev = lastByFiles.get(files);
    const squashOfPrev = SQUASH_SUFFIX.test(c.subject) && prev !== undefined && c.at - prev <= SQUASH_WINDOW_MS;
    lastByFiles.set(files, c.at);
    if (keys.has(key) || squashOfPrev) continue;
    keys.add(key);
    out.push(c);
  }
  return out;
}

/** 수정 커밋 D가 고친 대상 — D 전에 D의 파일을 하나라도 건드린 가장 최근 커밋. 공용 파일 하나로 앞선 커밋 여럿에 걸리지 않게 하나만 고른다. */
export function fixTarget(d: RepoCommit, all: RepoCommit[]): RepoCommit | null {
  const files = new Set(d.files);
  let best: RepoCommit | null = null;
  for (const c of all) {
    if (c.sha === d.sha || c.at >= d.at || (best && c.at <= best.at)) continue;
    if (c.files.some((f) => files.has(f))) best = c;
  }
  return best;
}

/**
 * C가 놓친 파일 — C를 고친 수정 커밋들이 같이 고쳤지만 C에는 없던 파일 (정렬, 중복 없음).
 * "C를 고친" 수정 커밋: 48시간 안, 제목이 수정(되돌리기 제외 — 다른 변경을 통째로 무르면 그 파일이 다 걸린다),
 * 파일 MISSED_MAX_FIX_FILES개 이하, 그리고 fixTarget이 C. all은 dedupeChanges를 거친 목록이어야 한다.
 */
export function missedFiles(c: RepoCommit, all: RepoCommit[], hours = RETOUCH_HOURS): string[] {
  const own = new Set(c.files);
  const missed = new Set<string>();
  for (const d of findRetouches(c, all, hours)) {
    if (REVERT_SUBJECT.test(d.subject) || d.files.length > MISSED_MAX_FIX_FILES) continue;
    if (fixTarget(d, all)?.sha !== c.sha) continue;
    for (const f of d.files) if (!own.has(f)) missed.add(f);
  }
  return [...missed].sort();
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

/** 시각 t 이전 마지막 impact MCP 결과 — 그 커밋을 앞두고 에이전트가 본 제안 목록 */
export function lastImpactBefore(s: Session, t: number): ImpactResult | null {
  let best: ImpactResult | null = null;
  for (const r of s.impactResults ?? []) if (r.ts <= t && (!best || r.ts >= best.ts)) best = r;
  return best;
}

export interface Rate {
  n: number;
  retouched: number;
  rate: number | null;
}

function rate(n: number, retouched: number): Rate {
  return { n, retouched, rate: n ? retouched / n : null };
}

export interface MissedReport {
  /** retouched = 놓친 파일이 하나라도 있는 커밋 */
  withImpact: Rate;
  withoutImpact: Rate;
  overall: Rate;
  /** 그룹 비교 교란 확인용 — 커밋당 평균 파일 수 (impact를 부르는 커밋이 더 큰 변경일 수 있다) */
  avgFiles: { withImpact: number | null; withoutImpact: number | null };
  /** 커밋 크기(파일 수)별로 나눈 비교 — 크기 교란을 걷어 낸다 */
  bySize: Array<{ label: string; withImpact: Rate; withoutImpact: Rate }>;
}

/** 커밋 크기 구간 [최소, 최대] */
export const SIZE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1~3개", min: 1, max: 3 },
  { label: "4~10개", min: 4, max: 10 },
  { label: "11개 이상", min: 11, max: Infinity },
];

export interface RecallReport {
  /** 커밋 직전 impact 결과가 있고 놓친 파일도 있는 커밋 */
  commits: number;
  /** 그중 놓친 파일을 하나라도 impact가 제안한 커밋 */
  commitsHit: number;
  /** 그 커밋들이 놓친 파일 수 */
  missed: number;
  /** 그중 impact 제안 목록에 있던 파일 수 */
  suggested: number;
  rate: number | null;
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
  missed: MissedReport;
  recall: RecallReport;
}

export function retouchReport(
  sessionsByRepo: Map<string, Session[]>,
  commitsByRepo: Map<string, RepoCommit[]>,
  now: number,
  since: number,
  hours = RETOUCH_HOURS,
  until = Infinity,
): RetouchReport {
  let inSessions = 0;
  let ambiguous = 0;
  let immature = 0;
  const acc = { imp: [0, 0], noImp: [0, 0], gri: [0, 0], noGri: [0, 0], all: [0, 0] };
  const miss = { imp: [0, 0], noImp: [0, 0], all: [0, 0] };
  const files = { imp: 0, noImp: 0 };
  const sized = SIZE_BUCKETS.map(() => ({ imp: [0, 0], noImp: [0, 0] }));
  const recall = { commits: 0, commitsHit: 0, missed: 0, suggested: 0 };
  const bump = (a: number[], hit: boolean) => {
    a[0]++;
    if (hit) a[1]++;
  };
  for (const [repo, sessions] of sessionsByRepo) {
    // 브랜치 원본과 squash 커밋을 둘 다 세면 같은 작업이 두 번 표본이 되고, fixTarget도 엉뚱한 쪽을 고른다
    const commits = dedupeChanges(commitsByRepo.get(repo) ?? []);
    for (const c of commits) {
      if (c.at < since || c.at >= until) continue;
      const { session, ambiguous: amb } = attributeCommit(c, sessions);
      if (amb) ambiguous++;
      if (!session) continue;
      inSessions++;
      if (c.at + hours * 3_600_000 > now) {
        immature++;
        continue;
      }
      const hit = findRetouch(c, commits, hours) !== null;
      const impact = usedImpactBefore(session, c.at);
      bump(acc.all, hit);
      bump(impact ? acc.imp : acc.noImp, hit);
      bump(usedGrimoireBefore(session, c.at) ? acc.gri : acc.noGri, hit);

      const missed = missedFiles(c, commits, hours);
      bump(miss.all, missed.length > 0);
      bump(impact ? miss.imp : miss.noImp, missed.length > 0);
      files[impact ? "imp" : "noImp"] += c.files.length;
      const bucket = SIZE_BUCKETS.findIndex((b) => c.files.length >= b.min && c.files.length <= b.max);
      if (bucket >= 0) bump(impact ? sized[bucket].imp : sized[bucket].noImp, missed.length > 0);
      const last = missed.length > 0 ? lastImpactBefore(session, c.at) : null;
      if (last) {
        const suggested = new Set(last.suggested);
        const hits = missed.filter((f) => suggested.has(f)).length;
        recall.commits++;
        if (hits > 0) recall.commitsHit++;
        recall.missed += missed.length;
        recall.suggested += hits;
      }
    }
  }
  const avg = (sum: number, n: number) => (n ? sum / n : null);
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
    missed: {
      withImpact: rate(miss.imp[0], miss.imp[1]),
      withoutImpact: rate(miss.noImp[0], miss.noImp[1]),
      overall: rate(miss.all[0], miss.all[1]),
      avgFiles: { withImpact: avg(files.imp, miss.imp[0]), withoutImpact: avg(files.noImp, miss.noImp[0]) },
      bySize: SIZE_BUCKETS.map((b, i) => ({
        label: b.label,
        withImpact: rate(sized[i].imp[0], sized[i].imp[1]),
        withoutImpact: rate(sized[i].noImp[0], sized[i].noImp[1]),
      })),
    },
    recall: { ...recall, rate: recall.missed ? recall.suggested / recall.missed : null },
  };
}

// ───────── 전체 ─────────

export interface UsageReport {
  generatedAt: string;
  since: string;
  until: string | null;
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
  /** 이 시각 전까지 (배타). 빼면 끝없음 */
  until?: number;
  repo?: string;
  now?: number;
}): Promise<UsageReport> {
  const now = opts.now ?? Date.now();
  const until = opts.until ?? Infinity;
  const sessions: Session[] = [];
  for (const file of listTranscripts(opts.projectsDir)) {
    // 수정 시각이 since보다 이전이면 그 뒤 줄이 없으니 읽지 않는다
    if (fs.statSync(file).mtimeMs < opts.since) continue;
    const s = await scanTranscript(file);
    if (s && s.last >= opts.since && s.first < until) sessions.push(s);
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
    until: Number.isFinite(until) ? new Date(until).toISOString() : null,
    repoFilter: opts.repo ?? null,
    calls: summarizeCalls(selected, opts.since, until),
    retouch: retouchReport(sessionsByRepo, commitsByRepo, now, opts.since, RETOUCH_HOURS, until),
  };
}

const pctOf = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(0)}%`);
const pct = (r: Rate) => pctOf(r.rate);
const line = (label: string, r: Rate) => `  ${label.padEnd(22)} ${pct(r).padStart(4)}  (${r.retouched}/${r.n})`;

export function formatReport(r: UsageReport): string {
  const c = r.calls;
  const out: string[] = [];
  const range = r.until ? `${r.since.slice(0, 10)} ~ ${r.until.slice(0, 10)}(미포함)` : `${r.since.slice(0, 10)} 이후`;
  out.push(`실사용 리포트 — ${range}${r.repoFilter ? `, 레포 ${r.repoFilter}` : ""}`);
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
  out.push("");
  const m = t.missed;
  out.push(`3. 놓친 파일률 — 그 커밋을 고친 fix(${MISSED_MAX_FIX_FILES}파일 이하, 되돌리기 제외)가 원래 커밋에 없던 파일까지 고친 비율`);
  out.push(line("impact를 먼저 부름", m.withImpact));
  out.push(line("impact 안 부름", m.withoutImpact));
  out.push(line("전체", m.overall));
  const avg = (v: number | null) => (v === null ? "-" : v.toFixed(1));
  out.push(`  커밋당 평균 파일 수: impact 부름 ${avg(m.avgFiles.withImpact)}, 안 부름 ${avg(m.avgFiles.withoutImpact)} (크기가 다르면 그룹 비교는 교란된다)`);
  out.push("  크기별 (impact 부름 | 안 부름):");
  for (const b of m.bySize) {
    const cell = (r: Rate) => `${pct(r).padStart(4)} (${r.retouched}/${r.n})`;
    out.push(`    ${b.label.padEnd(8)} ${cell(b.withImpact)} | ${cell(b.withoutImpact)}`);
  }
  out.push("");
  const rc = t.recall;
  out.push(`4. 실전 recall — 놓친 파일이 커밋 직전 impact 제안 목록(최대 10개)에 있었던 비율`);
  out.push(`  파일 기준 ${pctOf(rc.rate)}  (놓친 파일 ${rc.missed}개 중 ${rc.suggested}개)`);
  out.push(`  커밋 기준 ${pctOf(rc.commits ? rc.commitsHit / rc.commits : null)}  (커밋 ${rc.commits}개 중 ${rc.commitsHit}개에서 하나 이상 맞힘)`);
  return out.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      since: { type: "string" },
      until: { type: "string" },
      repo: { type: "string" },
      json: { type: "boolean", default: false },
      save: { type: "boolean", default: false },
      projects: { type: "string" },
    },
  });
  const sinceMs = values.since ? Date.parse(values.since) : Date.now() - 14 * 86_400_000;
  if (Number.isNaN(sinceMs)) throw new Error(`--since 날짜를 읽을 수 없다: ${values.since}`);
  const untilMs = values.until ? Date.parse(values.until) : undefined;
  if (untilMs !== undefined && Number.isNaN(untilMs)) throw new Error(`--until 날짜를 읽을 수 없다: ${values.until}`);
  if (untilMs !== undefined && untilMs <= sinceMs) throw new Error("--until은 --since보다 뒤여야 한다");
  const report = await buildReport({
    projectsDir: values.projects ?? path.join(os.homedir(), ".claude", "projects"),
    since: sinceMs,
    until: untilMs,
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
