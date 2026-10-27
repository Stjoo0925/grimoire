/**
 * 작업 완수 벤치 — "실제 수정 작업을 Grimoire가 있을 때 더 싸게, 회귀 없이 끝내나" (docs/enhancement-plan.md §3-4).
 *
 * 1) 채굴: 자기 레포의 과거 fix 커밋 중, 부모에서(테스트 패치만 적용하면) 실패하고 그 커밋에서 통과하는 것을 고른다.
 *    npm run taskbench -- --mine --repo ~/work/foo --test "npm test" [--limit 40] [--all] [--out bench/tasks.local.json]
 *    --all: 브랜치 커밋까지 본다 (squash 머지 레포용, 같은 변경의 중복은 한 번만)
 *    --link backend/node_modules[,node_modules]: 작업 폴더마다 원본 레포의 그 폴더를 연결(Windows는 정션) — 의존성을 새로 깔지 않게.
 *      사례에 저장돼 실행 때도 같이 쓴다. 지울 때는 연결을 Node로 먼저 끊는다(git worktree remove는 정션 너머를 지운다)
 *    --under backend/: 변경 파일이 모두 그 폴더 아래인 커밋만 (테스트 명령이 그 폴더에서 돌 때)
 *    --test의 {tests}: 그 사례의 테스트 파일들(레포 기준 경로)로 바뀐다 — 예: "cd backend && npx vitest run {tests}"
 *    사람이 tasks.local.json의 `prompt`를 증상 서술로 다듬는다 (기본값은 커밋 제목 — 수정 힌트가 들어 있을 수 있다).
 *
 * 2) 실행: 사례마다 부모 커밋의 임시 worktree에서 claude -p를 두 모드로 돌린다.
 *    npm run taskbench -- --run --tasks bench/tasks.local.json [--seeds 3] [--modes bare,grimoire] [--model sonnet] [--bare]
 *      기본은 구독(Pro/Max) 로그인으로 돈다 — 추가 요금 없이 구독 사용량을 쓴다. 내 ~/.claude 설정(CLAUDE.md·다른 훅·플러그인)이
 *      두 모드에 똑같이 섞이고, 전역에 설치한 grimoire 훅은 GRIMOIRE_HOOKS=0으로 막는다(대조군 오염·실제 DB 기록 방지).
 *      --bare: 사용자 설정을 모두 끈 깨끗한 비교. 문서상 ANTHROPIC_API_KEY가 필요하고 토큰당 과금된다.
 *      모드 bare = 내장 도구만 (--bare 플래그와는 별개)
 *      grimoire  내장 도구 + Grimoire MCP + 편집 직전 훅 — 임시 DB는 부모 커밋까지만 색인(시간 마스킹)
 *    채점: pass(F2P), p2p_broken, cost_billed·modelUsage, turns, stray/missed, reverted_edits, churn_ratio, subtype.
 *    결과: bench/results/taskbench-<시각>.json + 짝지은 요약(_ok 변형, cost_per_solved).
 *
 * 구독으로 돌면 추가 요금은 없지만 사용량 한도(5시간·주간)를 먹는다 — 실행마다 결과의 $는 API 환산 추정치다.
 * 먼저 10사례 × 1시드 파일럿(20회)으로 분산을 보고 N을 정한다. 본 실험(40×3×2=240회)은 한도를 크게 쓴다.
 * 채택 기준은 결과를 보기 전에 §3-4에 고정돼 있다.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { HOOK_EVENTS } from "../src/setup/hooks";
import { tempDir } from "../tests/helpers";
import { runClaude, type AgentRun } from "./claude";

type Mode = "bare" | "grimoire";
const MODES: Mode[] = ["bare", "grimoire"];

interface Task {
  id: string;
  repo: string;
  /** 실제 fix 커밋 */
  sha: string;
  parent: string;
  subject: string;
  /** 사람이 다듬는 증상 서술. 비면 subject */
  prompt: string;
  /** 테스트 명령 (셸) */
  test: string;
  /** 실제 fix가 건드린 비테스트 파일 */
  files: string[];
  testFiles: string[];
  /** 채굴 때 부모+테스트패치에서 실패한 테스트 이름(알 수 있을 때만) */
  failing?: string[];
  /** 작업 폴더마다 원본 레포에서 연결해 올 폴더 (--link, 예: backend/node_modules) */
  links?: string[];
  /** 테스트 명령이 도는 하위 폴더 (--under, 예: backend/) — {tests}의 경로를 이 폴더 기준으로 바꾼다 */
  under?: string;
}

interface TaskFile {
  tasks: Task[];
}

interface RunRow {
  task: string;
  mode: Mode;
  seed: number;
  pass: boolean;
  p2pBroken: boolean;
  costUsd: number | null;
  turns: number | null;
  toolCalls: number;
  stray: number;
  missed: number;
  revertedEdits: number;
  churnRatio: number | null;
  subtype: string | null;
  seconds: number;
  usage: AgentRun["modelUsage"];
  /** grimoire MCP 도구 호출 — 합계와 도구별 */
  grimoireToolCalls: number;
  grimoireTools: Record<string, number>;
  /** 이 실행의 훅이 한 일 (hook.js의 GRIMOIRE_HOOK_TRACE) */
  hook: HookStats;
  error?: string;
}

/** 훅 trace(hook.js가 GRIMOIRE_HOOK_TRACE에 덧붙인 JSON 줄) 한 줄 */
export interface TraceLine {
  event: string | null;
  tool: string | null;
  file: string | null;
  enabled: boolean;
  injected: boolean;
  chars: number;
  error?: string;
}

export interface HookStats {
  /** 켜진 훅이 불린 횟수 (GRIMOIRE_HOOKS=0으로 꺼진 사용자 전역 훅 호출은 뺀다) */
  calls: number;
  /** 실제로 무언가를 넣은 횟수 */
  injections: number;
  /** 넣은 글자 수 합 */
  chars: number;
  /** 이벤트별 주입 횟수 (PreToolUse=편집 직전, PostToolUse=막혔을 때 2단계, SessionStart=시작 요약) */
  byEvent: Record<string, number>;
  /** 편집 직전 맥락을 받은 파일 (작업 폴더 기준 경로) */
  files: string[];
  /** 꺼져 있어야 할 훅이 무언가를 넣은 횟수 — 0이 아니면 대조군이 오염된 것 */
  leaked: number;
  errors: number;
}

/** trace 파일 → 훅 통계. 파일이 없거나 깨진 줄은 건너뛴다 */
export function hookStats(text: string, root?: string): HookStats {
  const stats: HookStats = { calls: 0, injections: 0, chars: 0, byEvent: {}, files: [], leaked: 0, errors: 0 };
  const files = new Set<string>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: TraceLine;
    try {
      line = JSON.parse(raw) as TraceLine;
    } catch {
      continue;
    }
    if (!line.enabled) {
      if (line.injected) stats.leaked++;
      continue;
    }
    stats.calls++;
    if (line.error) stats.errors++;
    if (!line.injected) continue;
    stats.injections++;
    stats.chars += line.chars;
    const event = line.event ?? "?";
    stats.byEvent[event] = (stats.byEvent[event] ?? 0) + 1;
    if (event === "PreToolUse" && line.file) {
      const relative = root && path.isAbsolute(line.file) ? path.relative(root, line.file) : line.file;
      files.add(relative.split(path.sep).join("/"));
    }
  }
  stats.files = [...files];
  return stats;
}

const GRIMOIRE_TOOL = /^mcp__grimoire__(.+)$/;

/** 에이전트가 부른 grimoire MCP 도구 — 도구별 횟수 */
export function grimoireToolStats(calls: { name: string }[]): { total: number; byTool: Record<string, number> } {
  const byTool: Record<string, number> = {};
  for (const call of calls) {
    const match = GRIMOIRE_TOOL.exec(call.name);
    if (match) byTool[match[1]] = (byTool[match[1]] ?? 0) + 1;
  }
  return { total: Object.values(byTool).reduce((sum, n) => sum + n, 0), byTool };
}

/** 이 실행에 grimoire가 실제로 닿았나 — 훅이 무언가를 넣었거나 grimoire 도구를 불렀다 */
export function influenced(row: Pick<RunRow, "hook" | "grimoireToolCalls">): boolean {
  return row.hook.injections > 0 || row.grimoireToolCalls > 0;
}

const TEST_PATH = /(?:^|\/)(?:test(?:ing|s)?|e2e|__tests__|spec)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+$|_test\.[^/]+$/i;
const DEPENDENCY_FILE = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/;
const FIX_SUBJECT = /\b(fix(es|ed)?|bug|regress|hotfix)\b|^(fix|hotfix)(\([^)]*\))?!?\s*:|수정|버그|Why:|Constraint:/i;
const TEST_TIMEOUT_MS = 120_000;
const MAX_FILES = 15;
const MAX_NON_TEST_LINES = 100;
/** 각 상태를 몇 번 돌려 뒤집히는 테스트를 거르나 */
const FLAKY_RUNS = 3;

const expandHome = (value: string) => value.replace(/^~(?=$|[\\/])/, os.homedir());

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function runShell(command: string, cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: TEST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0 && !result.error, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

/** 실패한 테스트 이름을 흔한 출력 꼴에서 뽑는다 (node:test·jest·vitest·pytest·go test). 정보용 */
function failingNames(output: string): string[] {
  const names = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    const m = /^not ok \d+ - (.+)$/.exec(line) ?? /^\s*[✕✗×] (.+)$/.exec(line) ?? /^FAILED (\S+)/.exec(line) ?? /^--- FAIL: (\S+)/.exec(line);
    if (m) names.add(m[1].trim());
  }
  return [...names];
}

/**
 * 부모 커밋의 worktree를 임시로 만든다 (끝나면 지운다).
 * links: 원본 레포에서 연결해 올 폴더(레포 기준 경로, 예: backend/node_modules) — 의존성이 무거운 레포에서 작업 폴더마다
 * 새로 깔지 않으려고. Windows는 정션, 그 밖은 심볼릭 링크.
 *
 * 지우기 순서가 중요하다: Windows에서 정션이 든 워크트리를 `git worktree remove --force`로 지우면 정션이 가리키는
 * 원본 폴더의 내용까지 지워진다(2026-10-27 실험). 그래서 연결은 Node로 먼저 끊고(unlink는 연결만 지운다),
 * 하나라도 못 끊으면 워크트리를 지우지 않고 남겨 둔 채 알린다.
 */
export function worktree(repo: string, sha: string, links: string[] = []): { dir: string; remove: () => void } {
  const dir = path.join(tempDir("grimoire-taskbench-wt-"), "repo");
  git(repo, ["worktree", "add", "--detach", "-q", dir, sha]);
  const made: string[] = [];
  for (const rel of links) {
    const target = path.join(repo, rel);
    const link = path.join(dir, rel);
    if (!fs.existsSync(target) || fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    made.push(link);
  }
  return {
    dir,
    remove: () => {
      const stuck: string[] = [];
      for (const link of made) {
        try {
          if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") stuck.push(link);
        }
      }
      if (stuck.length > 0) {
        process.stderr.write(`⚠ 연결을 끊지 못해 작업 폴더를 지우지 않았습니다(원본 보호): ${dir}\n  ${stuck.join("\n  ")}\n`);
        return;
      }
      try {
        git(repo, ["worktree", "remove", "--force", dir]);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * 테스트 명령의 {tests} 자리에 그 사례의 테스트 파일을 넣는다 — 전체 스위트가 무거운 레포용.
 * under(예: backend/)가 있으면 명령이 그 폴더에서 돈다는 뜻이라 경로도 그 폴더 기준으로 바꾼다
 * (`cd backend && vitest run backend/src/x.spec.ts`는 "No test files found"로 늘 실패한다).
 */
export function testCommand(test: string, testFiles: string[], under = ""): string {
  const prefix = under && !under.endsWith("/") ? `${under}/` : under;
  const local = testFiles.map((file) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file));
  return test.replace(/\{tests\}/g, local.map((file) => `"${file}"`).join(" "));
}

/** 테스트 출력의 마지막 몇 줄 — 후보를 왜 버렸는지 보여 줄 때 */
function outputTail(output: string, lines = 4): string {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .map((line) => `      ${line.slice(0, 160)}`)
    .join("\n");
}

/* ── 채굴 ───────────────────────────────────────────────── */

/** 같은 변경인가 — squash 머지 커밋과 브랜치의 원본 커밋은 제목(PR 번호 접미 제외)과 변경 파일 집합이 같다 */
function changeKey(subject: string, files: string[]): string {
  return `${subject.replace(/\s*\(#\d+\)\s*$/, "").trim()}\0${[...files].sort().join("\n")}`;
}

function mine(repo: string, test: string, limit: number, existing: Task[], all = false, links: string[] = [], under = ""): Task[] {
  const known = new Set(existing.map((task) => task.sha));
  // --all: 브랜치·원격 브랜치의 커밋까지 — PR을 squash로 합치는 레포는 main만 보면 후보가 적다
  const log = git(repo, ["log", ...(all ? ["--all"] : []), "--no-merges", "--format=%H%x1f%P%x1f%s", "-n", "2000"]).trim().split("\n");
  const tasks: Task[] = [...existing];
  const seen = new Set(existing.map((task) => changeKey(task.subject, [...task.files, ...task.testFiles])));
  let scanned = 0;
  for (const line of log) {
    if (tasks.length - existing.length >= limit) break;
    const [sha, parents, subject] = line.split("\x1f");
    if (!sha || known.has(sha) || !parents || parents.includes(" ")) continue;
    const body = git(repo, ["log", "-1", "--format=%b", sha]);
    if (!FIX_SUBJECT.test(subject) && !FIX_SUBJECT.test(body)) continue;
    if (/^revert\b/i.test(subject)) continue;
    const changed = git(repo, ["show", "--format=", "--name-only", sha]).trim().split("\n").filter(Boolean);
    if (changed.length === 0 || changed.length > MAX_FILES) continue;
    if (changed.some((file) => DEPENDENCY_FILE.test(file))) continue; // 환경 드리프트
    const testFiles = changed.filter((file) => TEST_PATH.test(file));
    const files = changed.filter((file) => !TEST_PATH.test(file));
    if (testFiles.length === 0 || files.length === 0) continue;
    // --under: 테스트 명령이 도는 하위 폴더(예: backend/)의 사례만 — 다른 폴더 테스트는 그 명령으로 못 돌린다
    if (under && !changed.every((file) => file.startsWith(under))) continue;
    // 같은 변경이 커밋 둘로 남은 것(squash 머지 ↔ 브랜치 원본)은 한 번만
    const key = changeKey(subject, changed);
    if (seen.has(key)) continue;
    seen.add(key);
    const numstat = git(repo, ["show", "--format=", "--numstat", sha, "--", ...files]);
    const nonTestLines = numstat
      .trim()
      .split("\n")
      .reduce((sum, row) => sum + (Number(row.split("\t")[0]) || 0) + (Number(row.split("\t")[1]) || 0), 0);
    if (nonTestLines > MAX_NON_TEST_LINES) continue;
    scanned++;
    process.stderr.write(`… ${sha.slice(0, 10)} ${subject.slice(0, 60)}\n`);

    // 부모 + 테스트 패치만 → 실패해야 함(3회 모두). 커밋 → 통과해야 함(3회 모두)
    const wt = worktree(repo, parents, links);
    const command = testCommand(test, testFiles, under);
    let failing: string[] = [];
    // 버린 후보는 이유를 남긴다 — 이유 없이 "사례 0개"면 명령이 틀렸는지 레포가 안 맞는지 알 수 없다
    const reject = (reason: string, output = "") => process.stderr.write(`  ✗ ${reason}\n${output ? `${outputTail(output)}\n` : ""}`);
    try {
      const patch = git(repo, ["show", "--format=", sha, "--", ...testFiles]);
      const apply = spawnSync("git", ["apply", "--3way", "-"], { cwd: wt.dir, input: patch, encoding: "utf8" });
      if (apply.status !== 0) {
        reject("테스트 패치를 부모에 적용하지 못함", apply.stderr);
        continue;
      }
      let consistentFail = true;
      for (let i = 0; i < FLAKY_RUNS && consistentFail; i++) {
        const result = runShell(command, wt.dir);
        if (result.ok) {
          consistentFail = false;
          reject(i === 0 ? "부모에서도 테스트가 통과 — 테스트가 이 버그를 잡지 못함" : `부모에서 ${i + 1}번째에 통과 — 들쭉날쭉`);
        } else if (i === 0) failing = failingNames(result.output);
      }
      if (!consistentFail) continue;
      git(wt.dir, ["checkout", "-q", "--detach", sha]);
      let consistentPass = true;
      for (let i = 0; i < FLAKY_RUNS && consistentPass; i++) {
        const result = runShell(command, wt.dir);
        if (!result.ok) {
          consistentPass = false;
          reject(i === 0 ? "고친 커밋에서도 테스트가 실패 — 명령·환경을 확인하세요" : `고친 커밋에서 ${i + 1}번째에 실패 — 들쭉날쭉`, result.output);
        }
      }
      if (!consistentPass) continue;
    } finally {
      wt.remove();
    }
    tasks.push({ id: `${path.basename(repo)}-${sha.slice(0, 8)}`, repo, sha, parent: parents, subject, prompt: "", test, files, testFiles, ...(failing.length > 0 ? { failing } : {}), ...(links.length > 0 ? { links } : {}), ...(under ? { under } : {}) });
    process.stderr.write(`  ✓ 사례 ${tasks.length - existing.length}: ${sha.slice(0, 10)}\n`);
  }
  process.stderr.write(`후보 ${scanned}개를 돌려 사례 ${tasks.length - existing.length}개\n`);
  return tasks;
}

/* ── 실행 ───────────────────────────────────────────────── */

function editedFiles(run: AgentRun, root: string): string[] {
  const out = new Set<string>();
  for (const call of run.calls) {
    if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(call.name)) continue;
    const file = (call.input as { file_path?: string; notebook_path?: string }).file_path ?? (call.input as { notebook_path?: string }).notebook_path;
    if (typeof file === "string") out.add(path.relative(root, file).split(path.sep).join("/"));
  }
  return [...out];
}

function editChurn(run: AgentRun): number {
  let lines = 0;
  for (const call of run.calls) {
    const input = call.input as { old_string?: string; new_string?: string; content?: string; edits?: { old_string?: string; new_string?: string }[] };
    if (call.name === "Edit") lines += (input.old_string ?? "").split("\n").length + (input.new_string ?? "").split("\n").length;
    else if (call.name === "Write") lines += (input.content ?? "").split("\n").length;
    else if (call.name === "MultiEdit") for (const edit of input.edits ?? []) lines += (edit.old_string ?? "").split("\n").length + (edit.new_string ?? "").split("\n").length;
  }
  return lines;
}

async function runTask(task: Task, mode: Mode, seed: number, options: { cli: string; model?: string; bare: boolean; budget: string; maxTurns: number }): Promise<RunRow> {
  const wt = worktree(task.repo, task.parent, task.links ?? []);
  const test = testCommand(task.test, task.testFiles, task.under);
  const data = tempDir("grimoire-taskbench-data-");
  const started = Date.now();
  try {
    const env = { GRIMOIRE_HOME: data, GRIMOIRE_SYNC_ON_START: "0", GRIMOIRE_UPDATE_CHECK: "0", GRIMOIRE_AUTO_ADD: "0" };
    const mcpConfig = path.join(data, "mcp.json");
    let settings: string | undefined;
    if (mode === "grimoire") {
      // 시간 마스킹: 부모 커밋까지만 보이는 공유 clone을 색인한다 (실제 fix는 보이지 않는다)
      const pinned = path.join(data, "pinned");
      execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", task.repo, pinned], { stdio: "ignore" });
      for (const ref of git(pinned, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) git(pinned, ["update-ref", "-d", ref]);
      git(pinned, ["update-ref", "refs/heads/pinned", task.parent]);
      git(pinned, ["symbolic-ref", "HEAD", "refs/heads/pinned"]);
      git(pinned, ["checkout", "-q", "pinned"]);
      execFileSync(process.execPath, [options.cli, "add", pinned], { env: { ...process.env, ...env }, stdio: "ignore" });
      // 훅은 worktree 경로로 들어오므로 worktree도 같은 레포로 등록한다(같은 커밋들, 이미 색인된 sha는 건너뜀)
      execFileSync(process.execPath, [options.cli, "add", wt.dir], { env: { ...process.env, ...env }, stdio: "ignore" });
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { grimoire: { command: process.execPath, args: [options.cli, "mcp"], env } } }));
      const hook = path.join(path.dirname(options.cli), "hook.js");
      const slash = (value: string) => value.split(path.sep).join("/");
      // GRIMOIRE_HOOKS=1: claude 프로세스에는 0을 줘 사용자 전역 grimoire 훅을 끄므로, 이 실행의 훅만 다시 켠다.
      // 캡처는 이 임시 DB에만 켠다 — "막혔을 때 2단계"는 캡처한 검증 실패로 발화하므로, 끄면 실제 사용자가 받는 것과 달라진다
      const command = `"${slash(process.execPath)}" "${slash(hook)}" --env "GRIMOIRE_HOME=${slash(data)}" --env "GRIMOIRE_HOOKS=1"`;
      settings = path.join(data, "settings.json");
      // `grimoire install claude-code --hooks`와 같은 이벤트 목록 — 실제 설치본이 받는 것을 잰다
      const hooks = Object.fromEntries(
        HOOK_EVENTS.map((item) => [item.event, [{ ...(item.matcher ? { matcher: item.matcher } : {}), hooks: [{ type: "command", command, timeout: item.timeout }] }]]),
      );
      fs.writeFileSync(settings, JSON.stringify({ hooks }));
    } else {
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
    }
    // 훅이 무엇을 넣었는지 — 두 모드 모두 기록한다. bare에서는 사용자 전역 훅이 꺼진 채(enabled: false) 불리는지,
    // 그래도 무언가 넣었는지(leaked)를 본다
    const traceFile = path.join(data, "hook-trace.jsonl");
    const prompt = `${task.prompt || task.subject}\n\n고친 뒤에는 \`${test}\`로 확인해 줘. 작업 폴더 밖은 건드리지 마.`;
    const run = await runClaude({
      prompt,
      cwd: wt.dir,
      mcpConfig,
      allowedTools: ["Bash", "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", ...(mode === "grimoire" ? ["mcp__grimoire"] : [])],
      model: options.model,
      budgetUsd: options.budget,
      maxTurns: options.maxTurns,
      settings,
      bare: options.bare,
      // 사용자가 전역에 설치한 grimoire 훅은 끈다 — 대조군(bare 모드)에 맥락이 새거나(실제 DB는 미래 커밋까지 안다),
      // 실험 프롬프트가 실제 DB에 캡처되지 않게. 이 실행의 훅은 명령에 GRIMOIRE_HOOKS=1을 따로 준다
      env: { GRIMOIRE_HOOKS: "0", GRIMOIRE_HOOK_TRACE: traceFile },
      permissionMode: "bypassPermissions",
      timeoutMs: 20 * 60_000,
    });
    const hook = hookStats(fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "", wt.dir);
    const tools = grimoireToolStats(run.calls);
    // 채점: 실제 fix의 테스트 패치를 얹고 돌린다 (에이전트가 테스트를 고쳐 통과시킨 경우를 막는다)
    for (const file of task.testFiles) git(wt.dir, ["checkout", "-q", task.sha, "--", file]);
    const pass = runShell(test, wt.dir).ok;
    // 회귀: 부모에서 통과하던 것이 깨졌나 — 실제 fix 커밋 전체 테스트가 아니라 "부모 상태 테스트"를 에이전트 결과에 얹어 돌린다
    for (const file of task.testFiles) git(wt.dir, ["checkout", "-q", task.parent, "--", file]);
    const p2pBroken = !runShell(test, wt.dir).ok;
    const edited = editedFiles(run, wt.dir).filter((file) => !task.testFiles.includes(file));
    const finalDiff = git(wt.dir, ["diff", "--numstat", task.parent, "--"]).trim().split("\n").filter(Boolean);
    const finalLines = finalDiff.reduce((sum, row) => sum + (Number(row.split("\t")[0]) || 0) + (Number(row.split("\t")[1]) || 0), 0);
    const changedAtEnd = new Set(finalDiff.map((row) => row.split("\t")[2]));
    const reverted = edited.filter((file) => !changedAtEnd.has(file)).length;
    const churn = editChurn(run);
    return {
      task: task.id,
      mode,
      seed,
      pass,
      p2pBroken,
      costUsd: run.costUsd,
      turns: run.turns,
      toolCalls: run.calls.length,
      stray: edited.filter((file) => !task.files.includes(file)).length,
      missed: task.files.filter((file) => !edited.includes(file)).length,
      revertedEdits: reverted,
      churnRatio: pass && finalLines > 0 ? +(churn / finalLines).toFixed(2) : null,
      subtype: run.subtype,
      seconds: +((Date.now() - started) / 1000).toFixed(1),
      usage: run.modelUsage,
      grimoireToolCalls: tools.total,
      grimoireTools: tools.byTool,
      hook,
      ...(run.error ? { error: run.error } : {}),
    };
  } finally {
    wt.remove();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

/* ── 요약 ───────────────────────────────────────────────── */

function summarize(rows: RunRow[]) {
  const by = (mode: Mode) => rows.filter((row) => row.mode === mode && !row.error);
  const mean = (values: number[]) => (values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3) : null);
  const modes = Object.fromEntries(
    MODES.map((mode) => {
      const list = by(mode);
      const solved = list.filter((row) => row.pass).length;
      const cost = list.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
      return [
        mode,
        {
          runs: list.length,
          pass: list.length ? +(solved / list.length).toFixed(3) : null,
          p2pBroken: list.length ? +(list.filter((row) => row.p2pBroken).length / list.length).toFixed(3) : null,
          cost: +cost.toFixed(3),
          costPerSolved: solved ? +(cost / solved).toFixed(3) : null,
          turns: mean(list.map((row) => row.turns ?? 0)),
          missed: mean(list.map((row) => row.missed)),
          stray: mean(list.map((row) => row.stray)),
          reverted: mean(list.map((row) => row.revertedEdits)),
          churn: mean(list.map((row) => row.churnRatio).filter((value): value is number => value !== null)),
          // grimoire가 실제로 닿은 정도 — bare는 0이어야 한다
          hookInjections: mean(list.map((row) => row.hook.injections)),
          hookChars: mean(list.map((row) => row.hook.chars)),
          grimoireToolCalls: mean(list.map((row) => row.grimoireToolCalls)),
          influencedRuns: list.filter(influenced).length,
          leaked: list.reduce((sum, row) => sum + row.hook.leaked, 0),
        },
      ];
    }),
  );
  // 짝 비교: 같은 사례·시드에서 둘 다 푼 것만(_ok)의 log 비용·턴 차이, 그리고 missed·p2p 차이
  const key = (row: RunRow) => `${row.task}#${row.seed}`;
  const bare = new Map(by("bare").map((row) => [key(row), row]));
  const pairs = by("grimoire").map((row) => [bare.get(key(row)), row] as const).filter((pair): pair is readonly [RunRow, RunRow] => Boolean(pair[0]));
  const ok = pairs.filter(([a, b]) => a.pass && b.pass && a.costUsd && b.costUsd);
  const ratio = (list: (readonly [RunRow, RunRow])[]) => {
    const diffs = list.map(([a, b]) => Math.log(b.costUsd! / a.costUsd!));
    return diffs.length ? +Math.exp(diffs.reduce((x, y) => x + y, 0) / diffs.length).toFixed(3) : null;
  };
  const logDiff = ok.map(([a, b]) => Math.log(b.costUsd! / a.costUsd!));
  const turnDiff = ok.map(([a, b]) => (b.turns ?? 0) - (a.turns ?? 0));
  // grimoire가 실제로 닿은 짝(훅이 무언가 넣었거나 grimoire 도구를 부름)과 아닌 짝을 나눠 본다 —
  // 닿지 않은 짝의 차이는 그리모어 덕이 아니라 실행 간 흔들림이다
  const touched = ok.filter(([, b]) => influenced(b));
  const untouched = ok.filter(([, b]) => !influenced(b));
  return {
    modes,
    paired: {
      n: pairs.length,
      okPairs: ok.length,
      costRatioOk: ratio(ok),
      turnsDeltaOk: mean(turnDiff),
      missedDelta: mean(pairs.map(([a, b]) => b.missed - a.missed)),
      p2pDelta: mean(pairs.map(([a, b]) => Number(b.p2pBroken) - Number(a.p2pBroken))),
      wilcoxonCostP: ok.length >= 5 ? wilcoxon(logDiff) : null,
      influencedOkPairs: touched.length,
      costRatioInfluenced: ratio(touched),
      costRatioUninfluenced: ratio(untouched),
    },
  };
}

/** 윌콕슨 부호 순위 검정의 정규 근사 p값 (양측) */
export function wilcoxon(diffs: number[]): number {
  const nonzero = diffs.filter((value) => value !== 0);
  const n = nonzero.length;
  if (n === 0) return 1;
  const ranked = nonzero.map((value) => ({ value, abs: Math.abs(value) })).sort((a, b) => a.abs - b.abs).map((item, index) => ({ ...item, rank: index + 1 }));
  const wPlus = ranked.filter((item) => item.value > 0).reduce((sum, item) => sum + item.rank, 0);
  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (wPlus - meanW) / sdW;
  const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  return +(2 * (1 - phi(Math.abs(z)))).toFixed(4);
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/* ── 진입점 ─────────────────────────────────────────────── */

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mine: { type: "boolean" },
      run: { type: "boolean" },
      repo: { type: "string" },
      test: { type: "string" },
      limit: { type: "string" },
      all: { type: "boolean" },
      link: { type: "string" },
      under: { type: "string" },
      out: { type: "string" },
      tasks: { type: "string" },
      seeds: { type: "string" },
      modes: { type: "string" },
      only: { type: "string" },
      model: { type: "string" },
      budget: { type: "string" },
      "max-turns": { type: "string" },
      bare: { type: "boolean" },
      label: { type: "string" },
    },
  });
  if (values.mine) {
    if (!values.repo || !values.test) throw new Error("--mine에는 --repo <경로>와 --test \"<테스트 명령>\"이 필요합니다");
    const repo = path.resolve(expandHome(values.repo));
    const out = path.resolve(values.out ?? "bench/tasks.local.json");
    const existing: TaskFile = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as TaskFile) : { tasks: [] };
    const tasks = mine(repo, values.test, Number.parseInt(values.limit ?? "40", 10) || 40, existing.tasks, values.all === true, (values.link ?? "").split(",").map((item) => item.trim()).filter(Boolean), values.under ? values.under.replace(/\\/g, "/").replace(/\/?$/, "/") : "");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ tasks }, null, 2) + "\n");
    process.stdout.write(`${out}: 사례 ${tasks.length}개. 각 사례의 "prompt"를 증상 서술로 다듬으세요(비면 커밋 제목을 씁니다 — 수정 힌트가 샐 수 있습니다).\n`);
    return 0;
  }
  if (!values.run) throw new Error("--mine 또는 --run");
  const file = path.resolve(values.tasks ?? "bench/tasks.local.json");
  const spec = JSON.parse(fs.readFileSync(file, "utf8")) as TaskFile;
  const only = values.only?.split(",").map((item) => item.trim());
  const tasks = spec.tasks.filter((task) => !only || only.includes(task.id));
  const seeds = Math.max(1, Number.parseInt(values.seeds ?? "1", 10) || 1);
  const modes = (values.modes?.split(",") as Mode[] | undefined) ?? MODES;
  const cli = process.env.BENCH_CLI ? path.resolve(process.env.BENCH_CLI) : path.resolve(__dirname, "..", "..", "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error(`${cli}가 없습니다 — npm run build를 먼저 하세요`);
  const options = { cli, model: values.model, bare: values.bare === true, budget: values.budget ?? "2.00", maxTurns: Number.parseInt(values["max-turns"] ?? "60", 10) || 60 };
  process.stdout.write(
    options.bare
      ? "--bare: 사용자 설정을 끈 깨끗한 비교 — ANTHROPIC_API_KEY로 돌아 토큰당 과금됩니다\n"
      : "구독 로그인으로 실행합니다 — 추가 요금 없이 구독 사용량을 씁니다 (결과의 $는 API 환산 추정치)\n",
  );
  // 캐시 TTL을 두 모드에 같게 — 쓰기 단가가 다르면 비용 비교가 흔들린다
  process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= "5m";

  const rows: RunRow[] = [];
  for (const task of tasks) {
    for (let seed = 1; seed <= seeds; seed++) {
      // 블록(사례·시드)마다 모드 순서를 섞는다
      const order = [...modes].sort(() => Math.random() - 0.5);
      for (const mode of order) {
        process.stdout.write(`… ${task.id} #${seed} ${mode}\n`);
        const row = await runTask(task, mode, seed, options);
        rows.push(row);
        process.stdout.write(
          `   ${row.pass ? "✓" : "✗"}${row.p2pBroken ? " 회귀" : ""}  $${(row.costUsd ?? 0).toFixed(3)}  ${row.turns ?? "-"}턴  missed ${row.missed}  stray ${row.stray}  훅 ${row.hook.injections}/${row.hook.calls}  도구 ${row.grimoireToolCalls}${row.hook.leaked ? `  누수 ${row.hook.leaked}` : ""}  ${row.subtype ?? ""}${row.error ? `  ${row.error.slice(0, 80)}` : ""}\n`,
        );
      }
    }
  }
  const summary = summarize(rows);
  const resultsDir = path.resolve("bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(resultsDir, `taskbench-${stamp}${values.label ? `-${values.label}` : ""}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ label: values.label, model: values.model, bare: options.bare, tasks: tasks.map((task) => task.id), seeds, summary, rows }, null, 2));
  process.stdout.write("\n" + JSON.stringify(summary, null, 2) + "\n");
  const paired = summary.paired;
  if (paired.okPairs > 0) {
    process.stdout.write(
      `\n판정(§3-4): 둘 다 푼 짝 ${paired.okPairs}개에서 grimoire/bare 비용비 ${paired.costRatioOk} (목표 ≤ 0.85), 턴 차이 ${paired.turnsDeltaOk}, missed 차이 ${paired.missedDelta}, p2p 차이 ${paired.p2pDelta}, 비용 윌콕슨 p=${paired.wilcoxonCostP ?? "-"}\n`,
    );
    process.stdout.write(
      `그리모어가 실제로 닿은 짝 ${paired.influencedOkPairs}/${paired.okPairs}개 — 닿은 짝 비용비 ${paired.costRatioInfluenced ?? "-"}, 안 닿은 짝 비용비 ${paired.costRatioUninfluenced ?? "-"} (안 닿은 짝의 차이는 실행 간 흔들림)\n`,
    );
  }
  const leaked = summary.modes.bare?.leaked ?? 0;
  if (leaked > 0) process.stdout.write(`⚠ 대조군(bare)에 훅 주입이 ${leaked}번 새었습니다 — 이 결과의 비교는 믿을 수 없습니다\n`);
  process.stdout.write(`결과: ${outFile}\n`);
  return 0;
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
