/** 게임 프로필(레벨·직업·업적·스트릭) 순수 로직 테스트 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  computeClass,
  computeGameProfile,
  computeStreaks,
  hasComeback,
  hourOfIso,
} from "../src/lib/library/game";
import { SNAPSHOT } from "./fixtures";

function days(dates: string[]): Array<{ date: string; count: number }> {
  return dates.map((date) => ({ date, count: 1 }));
}

test("hourOfIso — 기록된 시각을 그대로 읽고 이상값은 null", () => {
  assert.equal(hourOfIso("2024-01-01T03:12:00Z"), 3);
  assert.equal(hourOfIso("2024-01-01T23:00:00+09:00"), 23);
  assert.equal(hourOfIso("not-a-date"), null);
});

test("computeStreaks — 최장/현재 스트릭 분리 계산", () => {
  const streak = computeStreaks(
    days(["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-10", "2024-01-11"]),
  );
  assert.equal(streak.longest, 3);
  assert.equal(streak.current, 2); // 마지막 활동일 기준 뒤로 연속
});

test("computeStreaks — count 0인 날은 활동이 아니다", () => {
  const streak = computeStreaks([
    { date: "2024-01-01", count: 1 },
    { date: "2024-01-02", count: 0 },
    { date: "2024-01-03", count: 2 },
  ]);
  assert.equal(streak.longest, 1);
  assert.equal(streak.current, 1);
});

test("hasComeback — 180일 이상 공백 후 복귀만 인정", () => {
  assert.equal(hasComeback(days(["2023-01-01", "2024-01-01"])), true);
  assert.equal(hasComeback(days(["2024-01-01", "2024-03-01"])), false);
  assert.equal(hasComeback(days([])), false);
});

test("computeClass — 언어 바이트 합산으로 직업 판정, 포크 제외", () => {
  const { classId, topLanguages } = computeClass(SNAPSHOT);
  // TypeScript 8000 + CSS 2000 = mage 10000 > alchemist(Python 5000)
  assert.equal(classId, "mage");
  assert.equal(topLanguages[0].name, "TypeScript");
});

test("computeGameProfile — EXP·레벨·업적이 결정론적으로 나온다", () => {
  const profile = computeGameProfile(SNAPSHOT);
  // 커밋 7*10 + 별 3*25 + 자작 레포 3*30 = 235
  assert.equal(profile.exp, 235);
  assert.equal(profile.level, 1);
  assert.ok(profile.expForNext > profile.expIntoLevel);

  const byId = new Map(profile.achievements.map((a) => [a.id, a]));
  assert.equal(byId.get("pages")!.value, 7);
  assert.equal(byId.get("pages")!.earned, false);
  assert.equal(byId.get("pages")!.nextTarget, 100);
  assert.equal(byId.get("secret-archive")!.value, 1);
  assert.equal(byId.get("polyglot")!.value, 4);
  assert.equal(byId.get("marathon")!.value, 4); // spellbook 커밋 4개
  // 잔디가 비어 있으니 스트릭 0
  assert.equal(profile.streak.longest, 0);
});

test("computeGameProfile — 단계 초과 달성 시 만렙 처리", () => {
  const big = {
    ...SNAPSHOT,
    commits: Array.from({ length: 3500 }, (_, i) => ({
      sha: String(i),
      repoFullName: "mage/spellbook",
      message: "feat",
      authoredAt: "2024-01-01T02:00:00Z",
      authorLogin: "mage",
    })),
  };
  const profile = computeGameProfile(big);
  const pages = profile.achievements.find((a) => a.id === "pages")!;
  assert.equal(pages.tier, 3);
  assert.equal(pages.nextTarget, null);
  const owl = profile.achievements.find((a) => a.id === "night-owl")!;
  assert.equal(owl.tier, 3); // 전부 02시 커밋
  assert.ok(profile.level > 10);
});
