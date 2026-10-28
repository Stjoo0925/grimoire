import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  attributeCommit,
  buildReport,
  findRetouch,
  grimoireTool,
  isImpactCall,
  parseLine,
  readCommits,
  scanTranscript,
  stripWorktree,
  summarizeCalls,
  type RepoCommit,
  type Session,
} from "../e2e/usage";
import { addCommit, makeRepo, tempDir } from "./helpers";

function use(ts: string, name: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    sessionId: "s1",
    ...extra,
    message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "tool_use", id: "t", name, input }] },
  });
}

function writeSession(dir: string, id: string, lines: string[]): string {
  const sub = path.join(dir, "proj");
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("parseLine: 낯선 줄은 건너뛴다", () => {
  assert.equal(parseLine("not json"), null);
  assert.equal(parseLine(""), null);
  assert.deepEqual(parseLine('{"type":"queue-operation","timestamp":"2026-10-20T00:00:00Z"}')?.calls, []);
});

test("도구 호출 세기: grimoire MCP·impact intent·스킬", async () => {
  const dir = tempDir();
  const file = writeSession(dir, "s1", [
    '{"type":"queue-operation","timestamp":"2026-10-20T00:00:00Z","sessionId":"s1"}',
    use("2026-10-20T00:01:00Z", "mcp__grimoire__search_memory", { query: "a" }, { cwd: "/x" }),
    use("2026-10-20T00:02:00Z", "mcp__grimoire__impact", { paths: ["a"], intent: "fix login" }),
    use("2026-10-20T00:03:00Z", "mcp__grimoire__impact", { paths: ["a"] }),
    use("2026-10-20T00:04:00Z", "Skill", { skill: "grimoire-impact" }),
    use("2026-10-20T00:05:00Z", "Skill", { skill: "code-review" }),
    use("2026-10-20T00:06:00Z", "mcp__other__impact", {}),
    "garbage line {{{",
  ]);
  const s = (await scanTranscript(file))!;
  const other = (await scanTranscript(writeSession(dir, "s2", [use("2026-10-20T00:00:00Z", "Bash", { command: "ls" })])))!;
  const sum = summarizeCalls([s, other]);
  assert.equal(sum.sessions, 2);
  assert.equal(sum.grimoireSessions, 1);
  assert.deepEqual(sum.perTool, { search_memory: 1, impact: 2 });
  assert.equal(sum.impactSkillCalls, 1);
  assert.equal(sum.impactWithIntent, 1);
  assert.equal(grimoireTool("mcp__grimoire__impact"), "impact");
  assert.equal(grimoireTool("Bash"), null);
  assert.ok(isImpactCall({ name: "Skill", input: { name: "grimoire-impact" } }));
  assert.ok(!isImpactCall({ name: "Skill", input: { skill: "x" } }));
  assert.equal(s.cwds[0], "/x");
});

test("stripWorktree: worktree 경로를 본 레포로", () => {
  assert.equal(stripWorktree("C:\\w\\grimoire\\.claude\\worktrees\\abc-123"), "C:\\w\\grimoire");
  assert.equal(stripWorktree("/w/g/.claude/worktrees/abc/sub"), "/w/g");
  assert.equal(stripWorktree("/w/g"), "/w/g");
});

const T0 = Date.parse("2026-03-01T00:00:00Z");
const H = 3_600_000;
const commit = (sha: string, hoursAfter: number, subject: string, files: string[]): RepoCommit => ({
  sha,
  at: T0 + hoursAfter * H,
  subject,
  files,
});

test("findRetouch: 48시간 안/밖, 같은 파일, 수정 제목만", () => {
  const c = commit("c", 0, "feat: a", ["a.ts"]);
  assert.equal(findRetouch(c, [c, commit("d", 47, "fix: a", ["a.ts", "b.ts"])])?.sha, "d");
  assert.equal(findRetouch(c, [c, commit("d", 49, "fix: a", ["a.ts"])]), null);
  assert.equal(findRetouch(c, [c, commit("d", 5, "fix: b", ["b.ts"])]), null);
  assert.equal(findRetouch(c, [c, commit("d", 5, "feat: more a", ["a.ts"])]), null);
  assert.equal(findRetouch(c, [c, commit("d", -5, "fix: a", ["a.ts"])]), null);
  assert.equal(findRetouch(c, [c, commit("d", 5, "feat: 로그인 버그 수정", ["a.ts"])])?.sha, "d");
});

function session(id: string, fromH: number, toH: number, calls: Session["calls"] = []): Session {
  return { id, file: id, first: T0 + fromH * H, last: T0 + toH * H, cwds: [], calls };
}

test("attributeCommit: 범위, 겹침은 직전 git commit 호출로 가른다", () => {
  const c = commit("c", 2, "x", []);
  assert.equal(attributeCommit(c, [session("a", 0, 1)]).session, null);
  assert.equal(attributeCommit(c, [session("a", 0, 3)]).session?.id, "a");
  const call = { ts: T0 + 2 * H - 30_000, name: "Bash", input: { command: "git commit -m x" } };
  const r = attributeCommit(c, [session("a", 0, 3), session("b", 1, 4, [call])]);
  assert.equal(r.session?.id, "b");
  const amb = attributeCommit(c, [session("a", 0, 3), session("b", 1, 4)]);
  assert.deepEqual([amb.session, amb.ambiguous], [null, true]);
});

test("buildReport: 실제 git 레포·합성 대화 기록으로 세션→커밋 짝짓기와 재손질", async () => {
  const repo = makeRepo([{ files: { "base.ts": "0" }, message: "chore: init", date: "2026-03-01T00:00:00Z" }]);
  // 세션 A(impact 부름): 10시 커밋 → 12시 같은 파일 fix → 재손질
  addCommit(repo, { files: { "a.ts": "1" }, message: "feat: a", date: "2026-03-02T10:00:00Z" });
  addCommit(repo, { files: { "a.ts": "2" }, message: "fix: a", date: "2026-03-02T12:00:00Z" });
  // 세션 B(안 부름): 20시 커밋 → 4일 뒤 fix(48시간 밖) → 재손질 아님
  addCommit(repo, { files: { "b.ts": "1" }, message: "feat: b", date: "2026-03-03T20:00:00Z" });
  addCommit(repo, { files: { "b.ts": "2" }, message: "fix: b", date: "2026-03-07T20:00:00Z" });
  // 세션 밖 커밋
  addCommit(repo, { files: { "z.ts": "1" }, message: "feat: z", date: "2026-03-05T00:00:00Z" });

  const root = fs.realpathSync.native(repo);
  const dir = tempDir();
  const cwd = path.join(root, ".claude", "worktrees", "w1"); // 존재하지 않아도 본 레포로 되돌아온다
  writeSession(dir, "A", [
    use("2026-03-02T09:00:00Z", "mcp__grimoire__impact", { intent: "x" }, { cwd, sessionId: "A" }),
    use("2026-03-02T09:59:00Z", "Bash", { command: "git commit -m a" }, { cwd, sessionId: "A" }),
    use("2026-03-02T12:30:00Z", "Bash", { command: "git commit -m fix" }, { cwd, sessionId: "A" }),
  ]);
  writeSession(dir, "B", [
    use("2026-03-03T19:00:00Z", "Bash", { command: "ls" }, { cwd: root, sessionId: "B" }),
    use("2026-03-03T21:00:00Z", "Bash", { command: "git commit" }, { cwd: root, sessionId: "B" }),
  ]);

  const rep = await buildReport({
    projectsDir: dir,
    since: Date.parse("2026-03-01T00:00:00Z"),
    now: Date.parse("2026-03-20T00:00:00Z"),
    repo: root,
  });
  assert.equal(rep.calls.sessions, 2);
  assert.equal(rep.calls.grimoireSessions, 1);
  assert.equal(rep.retouch.commitsInSessions, 3); // feat: a, fix: a, feat: b
  assert.deepEqual([rep.retouch.withImpact.n, rep.retouch.withImpact.retouched], [2, 1]); // feat: a(재손질)·fix: a(뒤따르는 fix 없음)
  assert.deepEqual([rep.retouch.withoutImpact.n, rep.retouch.withoutImpact.retouched], [1, 0]);
  assert.equal(rep.retouch.immature, 0);

  // 최근 커밋은 48시간이 안 지나 비율에서 빠진다
  const recent = await buildReport({
    projectsDir: dir,
    since: Date.parse("2026-03-01T00:00:00Z"),
    now: Date.parse("2026-03-02T13:00:00Z"),
    repo: root,
  });
  assert.equal(recent.retouch.immature, 3); // feat: a, fix: a, feat: b 모두 now+48h 안
  assert.equal(readCommits(repo).length, 6);
});
