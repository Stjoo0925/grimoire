/** 사서 NPC 일과표(순수 로직) 테스트 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildNpcScript,
  SHELVE_TASKS,
  TASK_DWELL,
  walkDuration,
  type NpcBookInput,
} from "../src/lib/library/npc";

function book(
  id: string,
  lastCommitAt: string | null,
  message = "feat: something",
): NpcBookInput {
  return {
    id,
    name: id,
    lastCommitAt,
    recentCommits: lastCommitAt ? [{ date: lastCommitAt, message }] : [],
    commitCount: 5,
  };
}

test("buildNpcScript — 최근 집필 순으로 shelve, 사이에 한가한 일이 끼어든다", () => {
  const books = [
    book("a", "2026-01-01"),
    book("b", "2026-03-01"),
    book("c", "2026-02-01"),
    book("d", null), // 커밋 없는 책은 shelve 대상이 아니다
  ];
  const script = buildNpcScript(books);

  const shelves = script.filter((task) => task.type === "shelve");
  assert.deepEqual(
    shelves.map((task) => task.bookId),
    ["b", "c", "a"],
  );
  // 한가한 일도 섞여 있다
  assert.ok(script.some((task) => task.type === "dust"));
  assert.ok(script.some((task) => task.type === "browse"));
  // shelve에는 커밋 메시지가 실린다
  assert.equal(shelves[0].note, "feat: something");
});

test("buildNpcScript — 결정론적이다 (같은 입력 = 같은 일과)", () => {
  const books = [book("a", "2026-01-01"), book("b", "2026-02-01")];
  assert.deepEqual(buildNpcScript(books), buildNpcScript(books));
});

test("buildNpcScript — shelve 수는 상한까지만", () => {
  const books = Array.from({ length: 30 }, (_, i) =>
    book(`repo-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}`),
  );
  const script = buildNpcScript(books);
  assert.equal(
    script.filter((task) => task.type === "shelve").length,
    SHELVE_TASKS,
  );
});

test("buildNpcScript — 빈 서재면 빈 일과", () => {
  assert.deepEqual(buildNpcScript([]), []);
});

test("walkDuration — 거리 비례 + 최소/최대 클램프", () => {
  assert.equal(walkDuration(0), 600);
  assert.ok(walkDuration(300) > walkDuration(100));
  assert.equal(walkDuration(100_000), 6000);
});

test("TASK_DWELL — 모든 작업 종류에 머무는 시간이 정의돼 있다", () => {
  for (const kind of ["shelve", "dust", "browse"] as const) {
    assert.ok(TASK_DWELL[kind] > 0);
  }
});
