/** 도서관 방 배치(책장 묶음·크기·행 분배) 테스트 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CASE_MAX_BOOKS,
  caseInnerRows,
  caseWidth,
  chunkCaseRows,
  groupCases,
  spineHeight,
  spinesPerRow,
} from "../src/lib/library/room";
import type { BookView } from "../src/lib/library/view";

function book(id: string, language: string | null, commits = 5): BookView {
  return {
    id,
    name: id,
    fullName: `mage/${id}`,
    description: null,
    primaryLanguage: language,
    spineColor: "#888888",
    topics: [],
    stars: 0,
    isPrivate: false,
    isFork: false,
    createdAt: "2024-01-01T00:00:00Z",
    pushedAt: "2024-06-01T00:00:00Z",
    htmlUrl: "https://example.invalid",
    commitCount: commits,
    firstCommitAt: null,
    lastCommitAt: null,
    activeYear: 2024,
    quarters: [],
    recentCommits: [],
    tech: [],
    concepts: [],
    problems: [],
    periods: [],
    relatedIds: [],
  } as unknown as BookView;
}

test("groupCases — 언어별로 묶이고 큰 언어가 앞에 온다", () => {
  const cases = groupCases([
    book("a", "TypeScript"),
    book("b", "TypeScript"),
    book("c", "TypeScript"),
    book("d", "Java"),
    book("e", null),
  ]);
  assert.equal(cases[0].language, "TypeScript");
  assert.equal(cases[0].books.length, 3);
  assert.ok(cases.some((c) => c.language === null));
});

test("groupCases — 최대 권수를 넘으면 분권되고 순번이 붙는다", () => {
  const many = Array.from({ length: CASE_MAX_BOOKS + 3 }, (_, i) =>
    book(`ts-${i}`, "TypeScript"),
  );
  const cases = groupCases(many);
  const ts = cases.filter((c) => c.language === "TypeScript");
  assert.equal(ts.length, 2);
  assert.equal(ts[0].part, 1);
  assert.equal(ts[1].part, 2);
  assert.equal(ts[0].books.length, CASE_MAX_BOOKS);
});

test("groupCases — 책장 안에서는 커밋 많은 책이 앞에 온다", () => {
  const cases = groupCases([
    book("small", "Go", 2),
    book("big", "Go", 90),
  ]);
  assert.equal(cases[0].books[0].id, "big");
});

test("caseInnerRows/spinesPerRow — 2단 균형 분배", () => {
  const books = Array.from({ length: 10 }, (_, i) => book(`b${i}`, "Go"));
  assert.equal(spinesPerRow(10), 5);
  const rows = caseInnerRows(books);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 5);
});

test("caseWidth/spineHeight — 크기가 단조 증가하고 상한이 있다", () => {
  assert.ok(caseWidth(12) > caseWidth(4));
  assert.ok(spineHeight(500) > spineHeight(1));
  assert.ok(spineHeight(100_000) <= 36);
});

test("chunkCaseRows — 폭을 넘치면 다음 행으로, 빈 입력은 빈 배열", () => {
  const cases = groupCases(
    Array.from({ length: 40 }, (_, i) => book(`b${i}`, `Lang${i % 8}`)),
  );
  const rows = chunkCaseRows(cases, 700);
  assert.ok(rows.length > 1);
  assert.equal(rows.flat().length, cases.length);
  assert.deepEqual(chunkCaseRows([], 800), []);
});
