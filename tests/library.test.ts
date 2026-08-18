/**
 * ③ 인터랙티브 도서관 — 순수 로직 유닛 테스트.
 * 색·서가 배치·발광 점수·집필 연혁·잔디 격자·사서 컨텍스트만 검사한다 (렌더링·네트워크 없음).
 *
 *   npm run test
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ContributionDay } from "../src/lib/collector/types";
import { buildDeterministic } from "../src/lib/graph/deterministic";
import {
  conceptId,
  edgeId,
  projectId,
  techId,
  type KnowledgeGraph,
} from "../src/lib/graph/types";
import {
  LANGUAGE_COLORS,
  UNKNOWN_LANGUAGE_COLOR,
  languageColor,
} from "../src/lib/library/colors";
import { buildHeatmap } from "../src/lib/library/heatmap";
import {
  buildLibrarianContext,
  buildLibrarianPrompt,
  matchProjectMentions,
} from "../src/lib/library/librarian";
import {
  projectsForNodes,
  relatedProjectMap,
  relatedProjects,
} from "../src/lib/library/relatedness";
import {
  UNKNOWN_SHELF,
  groupBooks,
  partitionPrivate,
  spineMetrics,
} from "../src/lib/library/shelves";
import {
  buildLibrary,
  dominantYear,
  quarterBuckets,
  RECENT_COMMIT_LINES,
} from "../src/lib/library/view";
import { SNAPSHOT } from "./fixtures";

function fixtureGraph(): KnowledgeGraph {
  return buildDeterministic(SNAPSHOT).accumulator.build({
    login: SNAPSHOT.login,
    extractorUsed: "none",
  });
}

/* ── 책등 색 ────────────────────────────────────────────────────────── */

test("languageColor: 알려진 언어는 고정 색, 대소문자 무관", () => {
  assert.equal(languageColor("TypeScript"), LANGUAGE_COLORS.typescript);
  assert.equal(languageColor("typescript"), LANGUAGE_COLORS.typescript);
  assert.equal(languageColor(null), UNKNOWN_LANGUAGE_COLOR);
  assert.equal(languageColor(""), UNKNOWN_LANGUAGE_COLOR);
});

test("languageColor: 모르는 언어도 결정론적이고 서로 다르다", () => {
  const first = languageColor("Brainfuck");
  assert.equal(first, languageColor("Brainfuck"));
  assert.match(first, /^hsl\(/);
  assert.notEqual(first, languageColor("Befunge"));
});

/* ── 서가 배치 ──────────────────────────────────────────────────────── */

function library() {
  return buildLibrary(SNAPSHOT, fixtureGraph());
}

test("partitionPrivate: 비공개 서고를 따로 뗀다", () => {
  const { open, restricted } = partitionPrivate(library().books);
  assert.deepEqual(
    restricted.map((book) => book.name),
    ["familiar"],
  );
  assert.equal(open.length, 2);
  assert.ok(open.every((book) => !book.isPrivate));
});

test("groupBooks(language): 언어별 서가, 권수 많은 순", () => {
  const shelves = groupBooks(library().books, "language");
  // 모두 1권씩이므로 커밋(쪽) 수가 많은 서가부터: spellbook 4 · familiar 2 · old-tome 1
  assert.deepEqual(
    shelves.map((shelf) => shelf.key),
    ["TypeScript", "Python", "Go"],
  );
  const ts = shelves.find((shelf) => shelf.key === "TypeScript")!;
  assert.equal(ts.books.length, 1);
  assert.equal(ts.commitCount, 4);
});

test("groupBooks(language): 주 언어를 모르면 미상 서가로 가고 항상 맨 끝", () => {
  const books = library().books.map((book, index) =>
    index === 0 ? { ...book, primaryLanguage: null } : book,
  );
  const shelves = groupBooks(books, "language");
  assert.equal(shelves.at(-1)!.key, UNKNOWN_SHELF);
  assert.equal(shelves.at(-1)!.label, "");
});

test("groupBooks(year): 최근 연도가 위층", () => {
  const shelves = groupBooks(library().books, "year");
  assert.deepEqual(
    shelves.map((shelf) => shelf.key),
    ["2024", "2023", "2022"],
  );
});

test("spineMetrics: 커밋이 많을수록 두껍고 높지만 상한이 있다", () => {
  const thin = spineMetrics(1);
  const thick = spineMetrics(1850);
  assert.ok(thin.height < thick.height);
  assert.ok(thin.width < thick.width);
  assert.ok(thick.height <= 180 && thick.width <= 38);
  assert.deepEqual(spineMetrics(0), spineMetrics(1));
});

/* ── 집필 연혁 ──────────────────────────────────────────────────────── */

test("quarterBuckets: 빈 분기도 0으로 메운다", () => {
  const commits = SNAPSHOT.commits.filter(
    (commit) => commit.repoFullName === "mage/spellbook",
  );
  const buckets = quarterBuckets(commits);
  assert.deepEqual(
    buckets.map((bucket) => bucket.key),
    ["2024-Q1", "2024-Q2"],
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.count),
    [3, 1],
  );
  assert.deepEqual(quarterBuckets([]), []);
});

test("dominantYear: 가장 많이 쓴 해, 커밋이 없으면 생성 연도", () => {
  assert.equal(
    dominantYear(
      [
        { key: "2023-Q1", year: 2023, quarter: 1, count: 2 },
        { key: "2024-Q1", year: 2024, quarter: 1, count: 5 },
      ],
      "2020-01-01T00:00:00.000Z",
    ),
    2024,
  );
  assert.equal(dominantYear([], "2021-07-01T00:00:00.000Z"), 2021);
});

test("buildLibrary: 책 한 권에 커밋 집계·최근 기록·그래프 연결이 붙는다", () => {
  const data = library();
  assert.equal(data.hasGraph, true);
  assert.equal(data.books.length, SNAPSHOT.repos.length);

  const spellbook = data.books.find((book) => book.name === "spellbook")!;
  assert.equal(spellbook.id, projectId("mage/spellbook"));
  assert.equal(spellbook.commitCount, 4);
  assert.equal(spellbook.firstCommitAt, "2024-01-10T00:00:00.000Z");
  assert.ok(spellbook.recentCommits.length <= RECENT_COMMIT_LINES);
  // 최신순
  assert.equal(spellbook.recentCommits[0].date, "2024-05-10");
  assert.ok(spellbook.tech.some((tech) => tech.id === techId("react")));
  assert.ok(spellbook.tech.every((tech) => tech.source !== undefined));
  assert.ok(spellbook.concepts.length > 0);
  assert.ok(spellbook.periods.includes("2024 Q1"));
  assert.equal(spellbook.spineColor, LANGUAGE_COLORS.typescript);
});

test("buildLibrary: 그래프가 없으면 연결과 발광이 비어 있다", () => {
  const data = buildLibrary(SNAPSHOT, null);
  assert.equal(data.hasGraph, false);
  assert.ok(data.books.every((book) => book.tech.length === 0));
  assert.ok(data.books.every((book) => book.relatedIds.length === 0));
});

/* ── 발광(연관도) ───────────────────────────────────────────────────── */

test("relatedProjectMap: 개념·기술을 공유한 책이 서로 연관된다", () => {
  const graph = fixtureGraph();
  const spellbook = projectId("mage/spellbook");
  const familiar = projectId("mage/familiar");
  const oldTome = projectId("mage/old-tome");

  const related = relatedProjectMap(graph);
  const forSpellbook = related.get(spellbook)!;
  assert.equal(forSpellbook[0].id, familiar); // realtime/knowledge-graph 개념 공유
  assert.ok(forSpellbook[0].sharedConcepts >= 2);
  assert.ok(forSpellbook[0].score > 0);

  // 대칭이어야 한다
  assert.equal(related.get(familiar)![0].id, spellbook);
  // 아무것도 공유하지 않는 책은 빛나지 않는다
  assert.deepEqual(related.get(oldTome), []);
  assert.ok(!forSpellbook.some((entry) => entry.id === oldTome));
});

test("relatedProjectMap: 희소한 기술 공유가 흔한 기술 공유보다 세다", () => {
  const graph = fixtureGraph();
  const [a, b, c] = ["p-a", "p-b", "p-c"];
  const rare = techId("rare-rune");
  const common = techId("common-rune");
  const custom: KnowledgeGraph = {
    ...graph,
    nodes: [
      ...[a, b, c].map((id) => ({
        id,
        kind: "project" as const,
        label: id,
        name: id,
        fullName: `mage/${id}`,
        isPrivate: false,
        primaryLang: "TypeScript",
        stars: 0,
        lastPushedAt: "2024-01-01T00:00:00.000Z",
      })),
      {
        id: rare,
        kind: "tech" as const,
        label: "rare",
        name: "rare",
        category: "other" as const,
      },
      {
        id: common,
        kind: "tech" as const,
        label: "common",
        name: "common",
        category: "other" as const,
      },
    ],
    edges: [
      // a-b는 희소 기술만, a-c와 b-c 등은 모두가 쓰는 기술
      { id: edgeId("USES", a, rare), kind: "USES" as const, from: a, to: rare, source: "static" as const },
      { id: edgeId("USES", b, rare), kind: "USES" as const, from: b, to: rare, source: "static" as const },
      ...[a, b, c].map((id) => ({
        id: edgeId("USES", id, common),
        kind: "USES" as const,
        from: id,
        to: common,
        source: "static" as const,
      })),
    ],
  };

  const related = relatedProjectMap(custom);
  const fromA = related.get(a)!;
  assert.equal(fromA[0].id, b, "희소 기술을 공유한 b가 먼저 빛나야 한다");
  assert.ok(fromA[0].score > fromA[1].score);
});

test("relatedProjects: 상한을 지킨다", () => {
  const graph = fixtureGraph();
  const list = relatedProjects(graph, projectId("mage/spellbook"), 1);
  assert.equal(list.length, 1);
});

test("projectsForNodes: 기술·개념 노드는 그것을 쓰는 책으로 펼친다", () => {
  const graph = fixtureGraph();
  const ids = projectsForNodes(graph, [techId("react"), conceptId("realtime")]);
  assert.ok(ids.includes(projectId("mage/spellbook")));
  assert.ok(ids.every((id) => id.startsWith("project-")));
});

/* ── 수련 일지(잔디) ────────────────────────────────────────────────── */

function days(entries: Array<[string, number]>): ContributionDay[] {
  return entries.map(([date, count]) => ({
    date,
    count,
    level: (count > 4 ? 4 : count) as ContributionDay["level"],
  }));
}

test("buildHeatmap: 53주 격자, 마지막 열이 오늘이 속한 주", () => {
  const heatmap = buildHeatmap(days([["2024-06-01", 3]]), "2024-06-05");
  assert.equal(heatmap.weeks.length, 53);
  assert.ok(heatmap.weeks.every((week) => week.length === 7));
  assert.equal(heatmap.to, "2024-06-08"); // 2024-06-05는 수요일 → 그 주 토요일
  assert.equal(heatmap.from, "2023-06-04"); // 53열 전 일요일
  assert.equal(heatmap.total, 3);
});

test("buildHeatmap: 오늘 이후 칸은 future이고 집계에서 빠진다", () => {
  const heatmap = buildHeatmap(days([["2024-06-07", 9]]), "2024-06-05");
  const cells = heatmap.weeks.flat();
  const future = cells.find((cell) => cell.date === "2024-06-07")!;
  assert.equal(future.future, true);
  assert.equal(future.count, 0);
  assert.equal(heatmap.total, 0);
  assert.equal(cells.find((cell) => cell.date === "2024-06-05")!.future, false);
});

test("buildHeatmap: 달 눈금은 열마다 한 번씩만", () => {
  const heatmap = buildHeatmap([], "2024-06-05");
  const columns = heatmap.monthTicks.map((tick) => tick.column);
  assert.equal(new Set(columns).size, columns.length);
  assert.ok(heatmap.monthTicks.length >= 12);
});

/* ── AI 사서 컨텍스트 ───────────────────────────────────────────────── */

test("buildLibrarianContext: 시드와 관련 책, 압축 컨텍스트를 만든다", () => {
  const graph = fixtureGraph();
  const context = buildLibrarianContext(graph, "react");

  assert.ok(context.items.length > 0);
  assert.ok(context.items.some((item) => item.label.toLowerCase() === "react"));
  assert.ok(context.items[0].connections.length > 0);
  assert.ok(context.projectIds.includes(projectId("mage/spellbook")));
  assert.ok(context.contextText.includes("# 검색된 항목"));
  assert.ok(context.contextText.includes("mage/spellbook"));
  assert.ok(context.projectIds.length <= 10);
});

test("buildLibrarianContext: 걸리는 게 없으면 항목도 컨텍스트도 비어 있다", () => {
  const context = buildLibrarianContext(fixtureGraph(), "존재하지않는주문서");
  assert.equal(context.items.length, 0);
  assert.equal(context.contextText, "");
  assert.deepEqual(context.projectIds, []);
});

test("buildLibrarianPrompt: 질문·자료·로케일 지시가 모두 들어간다", () => {
  const context = buildLibrarianContext(fixtureGraph(), "react");
  const ko = buildLibrarianPrompt("react 쓴 책?", context, "ko");
  assert.ok(ko.includes("react 쓴 책?"));
  assert.ok(ko.includes("한국어로 답하세요."));
  assert.ok(buildLibrarianPrompt("q", context, "en").includes("Answer in English."));
});

test("matchProjectMentions: 답변에 이름이 나온 책만 빛낸다", () => {
  const context = buildLibrarianContext(fixtureGraph(), "realtime");
  const matched = matchProjectMentions(
    "서고에서 spellbook을 찾았습니다. 실시간 동기화를 다룹니다.",
    context,
  );
  assert.deepEqual(matched, [projectId("mage/spellbook")]);
});

test("matchProjectMentions: 이름이 안 나오면 검색 후보를 그대로 쓴다", () => {
  const context = buildLibrarianContext(fixtureGraph(), "realtime");
  const matched = matchProjectMentions("관련된 기록을 찾았습니다.", context);
  assert.deepEqual(matched, context.projectIds);
});
