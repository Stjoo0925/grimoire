/**
 * ② 지식그래프 — 결정론적 파이프라인 유닛 테스트.
 * 네트워크를 전혀 타지 않으며(추출기는 목), 고정 픽스처만 사용한다.
 *
 *   npm run test
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommitDigest,
  filterCommits,
  isMeaningfulCommit,
  toPeriod,
} from "../src/lib/graph/commits";
import {
  canonicalTech,
  conceptDomain,
  normalizeName,
  techCategory,
} from "../src/lib/graph/canonical";
import { parseManifest } from "../src/lib/graph/manifests";
import { buildDeterministic } from "../src/lib/graph/deterministic";
import { buildGraph } from "../src/lib/graph/builder";
import {
  readMode,
  selectExtractor,
} from "../src/lib/graph/extractors/selection";
import { validateExtraction } from "../src/lib/graph/extractors/types";
import type {
  ExtractionInput,
  ExtractionResult,
  Extractor,
} from "../src/lib/graph/extractors/types";
import {
  conceptId,
  edgeId,
  projectId,
  techId,
  summarizeGraph,
  type GraphNode,
  type KnowledgeGraph,
} from "../src/lib/graph/types";
import {
  CARGO_TOML,
  GO_MOD,
  LEGACY_SNAPSHOT,
  PACKAGE_JSON,
  PYPROJECT_TOML,
  REQUIREMENTS_TXT,
  SNAPSHOT,
} from "./fixtures";

const names = (deps: { raw: string }[]) => deps.map((d) => d.raw).sort();

/* ── 1. 매니페스트 파싱 ─────────────────────────────────────────── */

test("package.json: dependencies/devDependencies를 뽑고 @types는 버린다", () => {
  const parsed = parseManifest("package.json", PACKAGE_JSON);
  assert.deepEqual(names(parsed), [
    "@tanstack/react-query",
    "jest",
    "next",
    "react",
    "typescript",
  ]);
  assert.equal(parsed.find((d) => d.raw === "jest")?.dev, true);
  assert.equal(parsed.find((d) => d.raw === "next")?.dev, false);
});

test("requirements.txt: 버전 지정자·extras·주석·-r 라인 처리", () => {
  assert.deepEqual(names(parseManifest("requirements.txt", REQUIREMENTS_TXT)), [
    "fastapi",
    "sqlalchemy",
    "uvicorn",
  ]);
});

test("pyproject.toml: PEP621 배열과 poetry 섹션 모두 인식", () => {
  const parsed = parseManifest("pyproject.toml", PYPROJECT_TOML);
  assert.deepEqual(names(parsed), ["fastapi", "pydantic", "pytest", "redis"]);
  assert.equal(parsed.find((d) => d.raw === "pytest")?.dev, true);
});

test("go.mod: require 블록/단일 require에서 모듈 마지막 세그먼트를 쓴다", () => {
  assert.deepEqual(names(parseManifest("go.mod", GO_MOD)), [
    "cobra",
    "gin",
    "go-redis",
  ]);
});

test("Cargo.toml: [dependencies]와 [dev-dependencies]", () => {
  const parsed = parseManifest("Cargo.toml", CARGO_TOML);
  assert.deepEqual(names(parsed), ["criterion", "serde", "tokio"]);
  assert.equal(parsed.find((d) => d.raw === "criterion")?.dev, true);
});

test("깨진 매니페스트/모르는 파일은 빈 배열", () => {
  assert.deepEqual(parseManifest("package.json", "{not json"), []);
  assert.deepEqual(parseManifest("Gemfile", "gem 'rails'"), []);
});

/* ── 2. 정규화 ────────────────────────────────────────────────── */

test("normalizeName: 대소문자·점·스코프·공백 흡수", () => {
  assert.equal(normalizeName("React.js"), "react-js");
  assert.equal(normalizeName("@tanstack/react-query"), "react-query");
  assert.equal(normalizeName("  Knowledge Graph "), "knowledge-graph");
});

test("canonicalTech: 별칭을 표준명으로 일원화", () => {
  for (const alias of ["react", "React", "ReactJS", "react.js"]) {
    assert.equal(canonicalTech(alias), "react");
  }
  assert.equal(canonicalTech("next"), "nextjs");
  assert.equal(canonicalTech("NextJS"), "nextjs");
  assert.equal(canonicalTech("node"), "nodejs");
  assert.equal(canonicalTech("@tanstack/react-query"), "react-query");
  // 사전에 없는 신규 기술은 정규화 문자열 그대로 canonical이 된다.
  assert.equal(canonicalTech("Weird New Lib"), "weird-new-lib");
});

test("분류·도메인 사전", () => {
  assert.equal(techCategory("react"), "frontend");
  assert.equal(techCategory("postgresql"), "database");
  assert.equal(techCategory("weird-new-lib"), "other");
  assert.equal(conceptDomain("realtime"), "realtime");
  assert.equal(conceptDomain("knowledge-graph"), "ai");
  assert.equal(conceptDomain("무언가"), "general");
});

/* ── 3. 커밋 필터링 ───────────────────────────────────────────── */

test("merge/chore/오타 커밋은 버리고 feat·fix는 남긴다", () => {
  const c = (message: string) => ({
    sha: "x",
    repoFullName: "mage/spellbook",
    message,
    authoredAt: "2024-01-01T00:00:00.000Z",
    authorLogin: "mage",
  });
  assert.equal(isMeaningfulCommit(c("feat: 실시간 동기화 추가")), true);
  assert.equal(isMeaningfulCommit(c("fix(graph): 누수 수정")), true);
  assert.equal(isMeaningfulCommit(c("Merge branch 'main' into dev")), false);
  assert.equal(isMeaningfulCommit(c("chore: deps 정리")), false);
  assert.equal(isMeaningfulCommit(c("docs: README 갱신")), false);
  assert.equal(isMeaningfulCommit(c("오타")), false);
  assert.equal(isMeaningfulCommit(c("wip")), false);

  const kept = filterCommits(SNAPSHOT.commits);
  assert.deepEqual(
    kept.map((k) => k.message),
    ["feat: 실시간 동기화 추가", "fix: 메모리 누수 수정", "feat: 크롤러 파이프라인"],
  );
});

test("다이제스트는 길이 상한을 지키고 최신 커밋을 남긴다", () => {
  const digest = buildCommitDigest(SNAPSHOT.commits, { maxChars: 40 });
  assert.ok(digest.length <= 40);
  assert.ok(digest.includes("크롤러") || digest.includes("누수"));

  const full = buildCommitDigest(
    SNAPSHOT.commits.filter((c) => c.repoFullName === "mage/spellbook"),
  );
  assert.equal(full.split("\n").length, 2);
  assert.ok(full.startsWith("- 2024-01-10 feat:"));
});

test("toPeriod: 분기 계산", () => {
  assert.deepEqual(toPeriod("2024-01-10T00:00:00.000Z"), { year: 2024, quarter: 1 });
  assert.deepEqual(toPeriod("2024-12-31T00:00:00.000Z"), { year: 2024, quarter: 4 });
});

/* ── 4. 결정론적 그래프 ───────────────────────────────────────── */

const findNode = (graph: KnowledgeGraph, id: string): GraphNode | undefined =>
  graph.nodes.find((n) => n.id === id);

function deterministicGraph(): KnowledgeGraph {
  return buildDeterministic(SNAPSHOT).accumulator.build({
    login: SNAPSHOT.login,
    extractorUsed: "none",
  });
}

test("토픽 → Concept + ABOUT (알려진 기술 토픽은 Tech + USES/topics)", () => {
  const graph = deterministicGraph();

  const realtime = findNode(graph, conceptId("realtime"));
  assert.ok(realtime, "realtime Concept이 있어야 한다");
  assert.equal(realtime?.kind, "concept");

  // "knowledge_graph" / "knowledge-graph" 표기 흔들림이 한 노드로 합쳐진다.
  const kg = graph.nodes.filter(
    (n) => n.kind === "concept" && n.id === conceptId("knowledge-graph"),
  );
  assert.equal(kg.length, 1);

  // 잡음 토픽("awesome")은 승격되지 않는다.
  assert.equal(findNode(graph, conceptId("awesome")), undefined);

  // 기술로 알려진 토픽은 Concept이 아니라 Tech + USES(source:"topics")
  assert.equal(findNode(graph, conceptId("react")), undefined);
  const usesReact = graph.edges.find(
    (e) => e.id === edgeId("USES", projectId("mage/spellbook"), techId("react")),
  );
  assert.ok(usesReact);

  const about = graph.edges.filter((e) => e.kind === "ABOUT");
  assert.ok(about.every((e) => (e as { confidence?: number }).confidence === 0.9));
});

test("매니페스트 → Tech + USES(static) + DEPENDS_ON", () => {
  const graph = deterministicGraph();

  const nextNode = findNode(graph, techId("nextjs"));
  assert.equal((nextNode as { category?: string })?.category, "frontend");

  const uses = graph.edges.find(
    (e) => e.id === edgeId("USES", projectId("mage/spellbook"), techId("nextjs")),
  );
  assert.equal((uses as { source?: string })?.source, "static");

  // next → react 는 자명한 의존
  assert.ok(
    graph.edges.some(
      (e) => e.id === edgeId("DEPENDS_ON", techId("nextjs"), techId("react")),
    ),
  );
  // 언어 통계도 Tech가 된다
  assert.ok(findNode(graph, techId("typescript")));
  assert.ok(findNode(graph, techId("python")));
  // requirements.txt 쪽
  assert.ok(findNode(graph, techId("fastapi")));
  assert.ok(
    graph.edges.some(
      (e) => e.id === edgeId("DEPENDS_ON", techId("fastapi"), techId("python")),
    ),
  );
});

test("커밋 날짜 → Period + DEVELOPED, 기술 최초 등장 → LEARNED", () => {
  const graph = deterministicGraph();

  const developed = graph.edges.filter((e) => e.kind === "DEVELOPED");
  assert.ok(
    developed.some(
      (e) => e.from === "period-2024-Q1" && e.to === projectId("mage/spellbook"),
    ),
  );

  const learnedFastapi = graph.edges.find(
    (e) => e.kind === "LEARNED" && e.to === techId("fastapi"),
  ) as { firstCommitDate?: string; from?: string } | undefined;
  // familiar의 첫 커밋은 2023-05 → 2023 Q2
  assert.equal(learnedFastapi?.from, "period-2023-Q2");
  assert.equal(learnedFastapi?.firstCommitDate, "2023-05-10T00:00:00.000Z");
});

test("같은 레포 공동 등장 → RELATED_TO(strength 0~1)", () => {
  const graph = deterministicGraph();
  const related = graph.edges.filter((e) => e.kind === "RELATED_TO");
  // realtime × knowledge-graph 가 두 레포에서 함께 등장한다.
  const edge = related.find(
    (e) =>
      e.id ===
      edgeId("RELATED_TO", conceptId("knowledge-graph"), conceptId("realtime")),
  ) as { strength?: number } | undefined;
  assert.ok(edge, "공동 등장 개념쌍이 이어져야 한다");
  assert.equal(edge?.strength, 1);
  assert.ok(related.every((e) => {
    const s = (e as { strength?: number }).strength ?? 0;
    return s > 0 && s <= 1;
  }));
});

/* ── 5. none 모드 전체 빌드 ───────────────────────────────────── */

test("none 모드: LLM 없이도 유효한 그래프가 나온다", async () => {
  const { graph } = await buildGraph(SNAPSHOT, {
    env: { GRAPH_EXTRACTOR: "none" },
  });
  const summary = summarizeGraph(graph);

  assert.equal(graph.extractorUsed, "none");
  assert.equal(graph.login, "mage");
  assert.equal(summary.nodes.project, 3);
  assert.ok(summary.nodes.tech > 5);
  assert.ok(summary.nodes.concept >= 2);
  assert.ok(summary.nodes.period >= 3);
  // LLM 없이는 Problem이 없다 — 그래도 정상 결과다.
  assert.equal(summary.nodes.problem, 0);
  assert.ok(summary.edgeTotal > 10);
  // 엣지의 양 끝은 항상 존재하는 노드다.
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(graph.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
});

test("구버전 스냅샷(topics/manifests 없음)도 빌드된다 — 노드가 적을 뿐", async () => {
  const { graph } = await buildGraph(LEGACY_SNAPSHOT, {
    env: { GRAPH_EXTRACTOR: "none" },
  });
  const summary = summarizeGraph(graph);
  assert.equal(summary.nodes.project, 1);
  assert.equal(summary.nodes.concept, 0);
  assert.ok(summary.nodes.tech >= 1); // 언어 통계로 Go는 잡힌다
});

/* ── 6. 추출기 병합 경로 (목 추출기) ──────────────────────────── */

class MockExtractor implements Extractor {
  readonly name = "ollama" as const;
  readonly seen: ExtractionInput[] = [];

  async extractRepo(input: ExtractionInput): Promise<ExtractionResult> {
    this.seen.push(input);
    return {
      concepts: [
        // 토픽에서 온 "realtime"과 같은 노드로 합쳐져야 한다.
        { name: "Realtime", domain: "realtime", summary: "웹소켓 동기화" },
        { name: "분산 락", domain: "concurrency" },
      ],
      problems_solved: [
        {
          title: "커밋 폭증 시 메모리 누수",
          solution_summary: "스트리밍 파싱",
          tech_used: ["Redis"],
        },
      ],
      learned_tech: [{ name: "Neo4j", first_applied_date: "2024-03" }],
    };
  }
}

test("LLM 결과는 결정론적 그래프에 합류한다 (Concept 중복 없음)", async () => {
  const extractor = new MockExtractor();
  const { graph } = await buildGraph(SNAPSHOT, {
    env: { GRAPH_EXTRACTOR: "none" },
    extractor,
  });

  assert.equal(graph.extractorUsed, "ollama");
  // README도 커밋도 없는 레포는 추출을 건너뛴다 (old-tome은 커밋이 필터링돼 남지 않음)
  assert.ok(extractor.seen.length >= 2);
  assert.ok(extractor.seen[0].knownTech.includes("react"));

  // 토픽 유래 realtime과 LLM 유래 Realtime이 하나의 노드
  const realtimeNodes = graph.nodes.filter((n) => n.id === conceptId("realtime"));
  assert.equal(realtimeNodes.length, 1);
  assert.equal(
    (realtimeNodes[0] as { summary?: string }).summary,
    "웹소켓 동기화",
  );

  const summary = summarizeGraph(graph);
  assert.ok(summary.nodes.problem >= 1);
  assert.ok(summary.edges.SOLVED >= 2); // project→problem, tech→problem
  assert.ok(graph.nodes.some((n) => n.id === techId("neo4j")));

  const learnedNeo4j = graph.edges.find(
    (e) => e.kind === "LEARNED" && e.to === techId("neo4j"),
  );
  assert.equal(learnedNeo4j?.from, "period-2024-Q1");

  // 새 개념(분산 락)도 공동 등장 관계에 반영된다.
  assert.ok(
    graph.edges.some(
      (e) => e.kind === "RELATED_TO" && e.to === conceptId("분산-락"),
    ) ||
      graph.edges.some(
        (e) => e.kind === "RELATED_TO" && e.from === conceptId("분산-락"),
      ),
  );
});

test("레포 추출이 실패하면 partial로 표시하고 나머지는 계속한다", async () => {
  const flaky: Extractor = {
    name: "ollama",
    async extractRepo(input) {
      if (input.repoFullName === "mage/familiar") throw new Error("모델 실패");
      return { concepts: [{ name: "테스트 개념" }], problems_solved: [], learned_tech: [] };
    },
  };
  const { graph } = await buildGraph(SNAPSHOT, {
    env: { GRAPH_EXTRACTOR: "none" },
    extractor: flaky,
  });
  assert.equal(graph.partial, true);
  assert.match(graph.partialReason ?? "", /mage\/familiar/);
  assert.ok(graph.nodes.some((n) => n.id === conceptId("테스트-개념")));
});

/* ── 7. 추출기 선택 (프라이버시 원칙) ─────────────────────────── */

const reachable = async () => true;
const unreachable = async () => false;

test("readMode: 모르는 값은 auto", () => {
  assert.equal(readMode({ GRAPH_EXTRACTOR: "none" }), "none");
  assert.equal(readMode({ GRAPH_EXTRACTOR: "OLLAMA" }), "ollama");
  assert.equal(readMode({}), "auto");
  assert.equal(readMode({ GRAPH_EXTRACTOR: "gpt" }), "auto");
});

test("auto는 ANTHROPIC_API_KEY가 있어도 claude를 고르지 않는다", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_EXTRACT_MODEL: "x" };

  const withOllama = await selectExtractor(env, { probeOllama: reachable });
  assert.equal(withOllama.name, "ollama");

  const withoutOllama = await selectExtractor(env, { probeOllama: unreachable });
  assert.equal(withoutOllama.name, "none");
  assert.equal(withoutOllama.extractor, null);

  // 명시적 auto도 마찬가지
  const explicitAuto = await selectExtractor(
    { ...env, GRAPH_EXTRACTOR: "auto" },
    { probeOllama: unreachable },
  );
  assert.equal(explicitAuto.name, "none");
});

test("none 모드는 어떤 키가 있어도 정적 분석", async () => {
  const selection = await selectExtractor(
    { GRAPH_EXTRACTOR: "none", ANTHROPIC_API_KEY: "sk-ant-test" },
    { probeOllama: reachable },
  );
  assert.equal(selection.name, "none");
});

test("ollama 모드: 연결 불가면 none으로 내려간다", async () => {
  const ok = await selectExtractor(
    { GRAPH_EXTRACTOR: "ollama" },
    { probeOllama: reachable },
  );
  assert.equal(ok.name, "ollama");

  const down = await selectExtractor(
    { GRAPH_EXTRACTOR: "ollama" },
    { probeOllama: unreachable },
  );
  assert.equal(down.name, "none");
  assert.match(down.reason, /Ollama/);
});

test("claude는 명시 설정 + 키가 모두 있을 때만", async () => {
  const noKey = await selectExtractor({ GRAPH_EXTRACTOR: "claude" }, {});
  assert.equal(noKey.name, "none");

  const withKey = await selectExtractor(
    { GRAPH_EXTRACTOR: "claude", ANTHROPIC_API_KEY: "sk-ant-test" },
    {},
  );
  assert.equal(withKey.name, "claude");
  assert.ok(withKey.extractor);
});

/* ── 8. 추출 결과 검증 ────────────────────────────────────────── */

test("validateExtraction: 이름 없는 항목은 버리고 키가 없으면 throw", () => {
  const result = validateExtraction({
    concepts: [{ name: "A" }, { summary: "이름 없음" }],
    problems_solved: [{ title: "T", solutionSummary: "camelCase도 받는다" }],
    learned_tech: [{ name: "Neo4j", first_applied_date: "2024-03" }],
    쓰레기: 1,
  });
  assert.equal(result.concepts.length, 1);
  assert.equal(result.problems_solved[0].solution_summary, "camelCase도 받는다");
  assert.equal(result.learned_tech.length, 1);
  assert.throws(() => validateExtraction({ foo: 1 }));
  assert.throws(() => validateExtraction("문자열"));
});
