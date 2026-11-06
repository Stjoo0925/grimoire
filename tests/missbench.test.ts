import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCases, scopesOf, scoreCase, strictMissedFiles, summarize } from "../e2e/missbench";
import type { RepoCommit } from "../e2e/usage";

const T0 = Date.parse("2026-03-01T00:00:00Z");
const H = 3_600_000;
const commit = (sha: string, hoursAfter: number, subject: string, files: string[]): RepoCommit => ({ sha, at: T0 + hoursAfter * H, subject, files });

test("scopesOf: conventional 범위를 쉼표·슬래시로 나눠 소문자로", () => {
  assert.deepEqual(scopesOf("fix(ts-recalc,API): x"), ["ts-recalc", "api"]);
  assert.deepEqual(scopesOf("feat(cad/lod)!: x"), ["cad", "lod"]);
  assert.deepEqual(scopesOf("fix: x"), []);
  assert.deepEqual(scopesOf("그냥 제목"), []);
});

test("strictMissedFiles: 같은 범위를 다시 고치거나 빠뜨림을 밝힌 fix만, 파일 하나 겹친 다음 작업은 뺀다", () => {
  const c = commit("c", 0, "fix(auth): 로그인 화면 리디자인", ["login.tsx", "auth.ts"]);
  const next = commit("d1", 1, "fix(dashboard): 스켈레톤 제거", ["login.tsx", "loading.tsx"]);
  const sameScope = commit("d2", 2, "fix(auth): 토큰 갱신 빠짐", ["auth.ts", "token.ts"]);
  assert.deepEqual(strictMissedFiles(c, [c, next]), [], "범위가 다른 다음 작업");
  assert.deepEqual(strictMissedFiles(c, [c, sameScope]), ["token.ts"]);
  const build = commit("d3", 1, "fix : 빌드 오류 수정", ["auth.ts", "types.ts"]);
  assert.deepEqual(strictMissedFiles(c, [c, build]), ["types.ts"], "범위가 없어도 빌드 오류를 고치면");
});

test("buildCases: 구간 안 커밋만, 놓친 파일이 있으면 사례(직전 트리에 있던 것만 찾을 수 있음), 고친 일이 없으면 오경보 표본", () => {
  const before = commit("b", -10, "feat: 옛날", ["a.ts"]);
  const c = commit("c", 0, "feat(a): a", ["a.ts"]);
  const fix = commit("d", 3, "fix(a): a의 짝", ["a.ts", "b.ts", "new.ts"]);
  const clean = commit("e", 100, "feat: 혼자", ["z.ts"]);
  const all = [before, c, fix, clean];
  const { cases, clean: cleanList } = buildCases(all, T0 - 5 * H, Infinity, () => new Set(["a.ts", "b.ts"]));
  assert.deepEqual(cases.map((item) => item.sha), ["c"]);
  assert.deepEqual(cases[0].targets, ["b.ts", "new.ts"]);
  assert.deepEqual(cases[0].findable, ["b.ts"]);
  assert.deepEqual(cases[0].strictTargets, ["b.ts", "new.ts"]);
  // 뒤에 그 파일을 다시 고친 fix가 없는 커밋은 오경보 표본 — fix d 자신도 그렇다
  assert.deepEqual(cleanList.map((item) => item.sha), ["d", "e"]);
});

test("scoreCase·summarize: 상위 10개 적중·recall, 알림 정밀도, 오경보", () => {
  const score = scoreCase(["x", "b.ts", ...Array.from({ length: 10 }, (_, i) => `f${i}`), "new.ts"], ["b.ts", "q"], { targets: ["b.ts", "new.ts"], findable: ["b.ts"] });
  assert.deepEqual(score, { hit10: 1, recall10: 0.5, recallFindable10: 1, alertHit: 1, alerts: 2, alertCorrect: 1 });
  const empty = scoreCase([], [], { targets: ["n.ts"], findable: [] });
  assert.equal(empty.recallFindable10, null);
  const s = summarize([score, empty], [1, 0, 0, 0]);
  assert.equal(s.hit10, 0.5);
  assert.equal(s.recallFindable10, 1, "찾을 수 있는 정답이 없는 사례는 그 평균에서 뺀다");
  assert.equal(s.alertPrecision, 0.5);
  assert.equal(s.falseAlarm, 0.25);
});
