/**
 * ② MCP 서버 — 순수 로직 유닛 테스트 (SDK도 네트워크도 타지 않는다).
 * 고정 픽스처와 임시 디렉터리만 쓴다 — 실제 사용자 데이터(data/)는 건드리지 않는다.
 *
 *   npm run test
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGraph } from "../src/lib/graph/builder";
import { buildDeterministic } from "../src/lib/graph/deterministic";
import {
  conceptId,
  edgeId,
  periodId,
  problemId,
  projectId,
  techId,
  type KnowledgeGraph,
} from "../src/lib/graph/types";
import { recordLearning } from "../src/mcp/learning";
import { pickLogin, dataDirCandidates } from "../src/mcp/paths";
import {
  buildProjectHistory,
  commitStats,
  resolveProject,
} from "../src/mcp/project";
import { scoreNode, searchGraph, tokenize } from "../src/mcp/search";
import {
  listGraphLogins,
  readGraph,
  writeGraphAtomic,
} from "../src/mcp/storage";
import { isAuthorized, readTransportConfig } from "../src/mcp/transport";
import { SNAPSHOT } from "./fixtures";

/** 결정론적 그래프 + LLM이 붙였을 법한 Problem 하나 */
function fixtureGraph(): KnowledgeGraph {
  const graph = buildDeterministic(SNAPSHOT).accumulator.build({
    login: SNAPSHOT.login,
    extractorUsed: "none",
  });
  const pid = problemId("mage/spellbook", "memory-leak");
  graph.nodes.push({
    id: pid,
    kind: "problem",
    label: "커밋 폭증 시 메모리 누수",
    title: "커밋 폭증 시 메모리 누수",
    description: "수집기가 커밋을 한 번에 올려 힙이 터졌다",
    solutionSummary: "스트리밍 파싱으로 전환",
    sources: ["mage/spellbook"],
  });
  graph.edges.push({
    id: edgeId("SOLVED", projectId("mage/spellbook"), pid),
    kind: "SOLVED",
    from: projectId("mage/spellbook"),
    to: pid,
  });
  return graph;
}

const find = (graph: KnowledgeGraph, id: string) =>
  graph.nodes.find((node) => node.id === id);

/* ── 1. 검색 점수 ──────────────────────────────────────────────── */

test("tokenize: 구두점으로 자르고 여러 단어면 구문 토큰도 더한다", () => {
  // "React.js"는 점을 자르지 않고 한 토큰으로 남아 canonical(react)에 걸린다.
  assert.deepEqual(tokenize("React.js").map((t) => t.norm), ["react-js"]);
  assert.equal(tokenize("React.js")[0].canon, "react");
  assert.deepEqual(
    tokenize("React.js, Next").map((t) => t.norm),
    ["react-js", "next", "react-js-next"],
  );
  assert.deepEqual(tokenize("knowledge graph").map((t) => t.norm), [
    "knowledge",
    "graph",
    "knowledge-graph",
  ]);
  assert.deepEqual(tokenize("   ").map((t) => t.norm), []);
});

test("scoreNode: 정확 > 접두 > 부분 > 본문, 차수는 순서를 뒤집지 않는다", () => {
  const graph = fixtureGraph();
  const react = find(graph, techId("react"))!;
  const reactQuery = find(graph, techId("react-query"))!;
  const problem = find(graph, problemId("mage/spellbook", "memory-leak"))!;

  const exact = scoreNode(react, tokenize("React.js"));
  const prefix = scoreNode(reactQuery, tokenize("react"));
  assert.equal(exact, 10);
  assert.equal(prefix, 6);

  // 차수 가산이 붙어도 정확 일치가 접두 일치를 앞선다.
  assert.ok(scoreNode(react, tokenize("react"), 0) > scoreNode(reactQuery, tokenize("react"), 50));
  // 차수가 높으면 같은 종류의 일치 중에서는 앞선다.
  assert.ok(scoreNode(react, tokenize("react"), 50) > scoreNode(react, tokenize("react"), 0));

  // 본문(설명·해결 요약)만 걸리면 약한 점수
  assert.equal(scoreNode(problem, tokenize("스트리밍")), 1.5);
  // 걸리는 게 없으면 0
  assert.equal(scoreNode(react, tokenize("전혀없는말")), 0);
});

test("검색: 시드는 점수순, 엣지는 끝점 라벨과 함께 묶여 나온다", () => {
  const graph = fixtureGraph();
  const result = searchGraph(graph, "React.js", { limit: 3 });

  assert.equal(result.seeds[0].node.id, techId("react"));
  assert.equal(result.seeds[0].node.kind, "tech");
  assert.ok(result.seeds.length <= 3);
  assert.ok(result.totalMatches >= result.seeds.length);

  const usedBy = result.seeds[0].connections.find(
    (c) => c.kind === "USES" && c.direction === "in",
  );
  assert.ok(usedBy, "React를 쓰는 프로젝트가 붙어 있어야 한다");
  assert.ok(usedBy!.nodes.some((n) => n.label === "spellbook"));
});

test("검색: Problem은 solutionSummary를 항상 싣는다", () => {
  const graph = fixtureGraph();
  const result = searchGraph(graph, "메모리 누수");
  const seed = result.seeds[0];
  assert.equal(seed.node.kind, "problem");
  assert.equal(seed.node.solutionSummary, "스트리밍 파싱으로 전환");
  // 1홉으로 그 문제를 푼 프로젝트가 딸려 온다.
  assert.ok(
    seed.connections.some((c) => c.kind === "SOLVED" && c.nodes.some((n) => n.label === "spellbook")),
  );
});

test("검색: hops=2면 1홉 이웃 너머 경로가 붙는다", () => {
  const graph = fixtureGraph();
  const one = searchGraph(graph, "fastapi", { hops: 1 });
  const two = searchGraph(graph, "fastapi", { hops: 2 });

  assert.equal(one.secondHop, undefined);
  assert.ok((two.secondHop ?? []).length > 0);
  // 2홉 경로는 라벨 3연이다.
  const hop = two.secondHop![0];
  assert.equal(typeof hop.from, "string");
  assert.equal(typeof hop.to, "string");
});

test("검색: 결과가 없으면 안내 note", () => {
  const result = searchGraph(fixtureGraph(), "존재하지않는기술xyz");
  assert.equal(result.seeds.length, 0);
  assert.match(result.note ?? "", /일치하는 노드가 없습니다/);
});

/* ── 2. 프로젝트 해석 ─────────────────────────────────────────── */

test("resolveProject: 정확 → 접두 → 부분, owner/repo 표기도 받는다", () => {
  const graph = fixtureGraph();

  assert.equal(resolveProject(graph, "spellbook").match?.how, "exact");
  assert.equal(
    resolveProject(graph, "mage/familiar").match?.project.fullName,
    "mage/familiar",
  );
  assert.equal(resolveProject(graph, "  SpellBook ").match?.project.name, "spellbook");

  const prefix = resolveProject(graph, "spell");
  assert.equal(prefix.match?.how, "prefix");
  assert.equal(prefix.match?.project.name, "spellbook");

  const substring = resolveProject(graph, "tome");
  assert.equal(substring.match?.how, "substring");
  assert.equal(substring.match?.project.name, "old-tome");

  assert.equal(resolveProject(graph, "없는책").match, null);
});

test("get_project_history: 그래프 + 커밋 통계", () => {
  const graph = fixtureGraph();
  const { match, candidates } = resolveProject(graph, "spellbook");
  const history = buildProjectHistory(graph, match!, SNAPSHOT, candidates);

  assert.equal(history.project.fullName, "mage/spellbook");
  assert.equal(history.project.isPrivate, false);
  assert.equal(history.project.primaryLang, "TypeScript");
  assert.equal(history.project.createdAt, "2024-01-05T00:00:00.000Z");
  assert.equal(history.project.description, "실시간 주문서");

  assert.ok(history.tech.some((t) => t.label === "Next.js"));
  assert.ok(history.tech.every((t) => typeof t.source === "string"));
  assert.ok(history.concepts.some((c) => c.id === conceptId("realtime")));
  assert.ok(history.problems.some((p) => p.solutionSummary === "스트리밍 파싱으로 전환"));
  assert.ok(history.periods.includes("2024 Q1"));

  assert.equal(history.commits?.count, 4);
  assert.equal(history.commits?.firstCommitAt, "2024-01-10T00:00:00.000Z");
  assert.equal(history.commits?.lastCommitAt, "2024-05-10T00:00:00.000Z");
  assert.equal(history.commits?.recentMessages[0].message, "fix: 메모리 누수 수정");
});

test("스냅샷이 없으면 그래프만으로 답하고 사유를 남긴다", () => {
  const graph = fixtureGraph();
  const { match } = resolveProject(graph, "familiar");
  const history = buildProjectHistory(graph, match!, null);
  assert.equal(history.commits, null);
  assert.match(history.notes.join(" "), /스냅샷/);
});

test("commitStats: 최근 커밋은 20개까지, 최신순", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    sha: `s${i}`,
    repoFullName: "mage/spellbook",
    message: `feat: ${i}\n본문은 버린다`,
    authoredAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    authorLogin: "mage",
  }));
  const stats = commitStats(many, "mage/spellbook");
  assert.equal(stats.count, 30);
  assert.equal(stats.recentMessages.length, 20);
  assert.equal(stats.recentMessages[0].message, "feat: 29");
  assert.equal(stats.recentMessages[0].date, "2024-01-30");
});

/* ── 3. record_new_learning ───────────────────────────────────── */

const NOW = new Date("2025-08-18T09:00:00.000Z"); // 2025 Q3

test("새 Tech를 추가하고 Period-[LEARNED]->Tech를 잇는다", () => {
  const before = fixtureGraph();
  const result = recordLearning(
    before,
    { name: "Qdrant", kind: "tech", note: "벡터 DB", relatedProject: "spellbook" },
    NOW,
  );

  assert.equal(result.alreadyKnown, false);
  assert.equal(result.nodeId, techId("qdrant"));
  assert.equal(result.label, "Qdrant");
  assert.equal(result.linkedProject, "mage/spellbook");
  assert.equal(result.period, periodId(2025, 3));

  const node = find(result.graph, techId("qdrant"))!;
  assert.equal(node.meta?.source, "mcp");
  assert.equal(node.meta?.note, "벡터 DB");
  assert.equal((node as { category?: string }).category, "database");

  assert.ok(
    result.graph.edges.some(
      (e) => e.id === edgeId("USES", projectId("mage/spellbook"), techId("qdrant")),
    ),
  );
  assert.ok(
    result.graph.edges.some(
      (e) => e.id === edgeId("LEARNED", periodId(2025, 3), techId("qdrant")),
    ),
  );
  // 입력 그래프는 그대로 (불변)
  assert.equal(find(before, techId("qdrant")), undefined);
});

test("이미 아는 기술은 already known — 노드를 늘리지 않고 메모만 붙인다", () => {
  const graph = fixtureGraph();
  const nodeCount = graph.nodes.length;
  // "React.js"도 canonical 정규화로 tech-react에 걸린다.
  const result = recordLearning(graph, { name: "React.js", kind: "tech", note: "서버 컴포넌트" }, NOW);

  assert.equal(result.alreadyKnown, true);
  assert.equal(result.nodeId, techId("react"));
  assert.match(result.messages.join(" "), /already known/);
  // Period 노드가 새로 생겼을 수 있으므로 tech 노드 수로 비교한다.
  assert.equal(
    result.graph.nodes.filter((n) => n.kind === "tech").length,
    graph.nodes.filter((n) => n.kind === "tech").length,
  );
  assert.ok(result.graph.nodes.length >= nodeCount);
  assert.equal(find(result.graph, techId("react"))!.meta?.note, "서버 컴포넌트");
});

test("Concept 기록과 없는 프로젝트 처리", () => {
  const result = recordLearning(
    fixtureGraph(),
    { name: "이벤트 소싱", kind: "concept", relatedProject: "없는책" },
    NOW,
  );
  assert.equal(result.nodeId, conceptId("이벤트-소싱"));
  assert.equal(result.linkedProject, null);
  assert.match(result.messages.join(" "), /찾지 못해/);
  assert.equal(find(result.graph, conceptId("이벤트-소싱"))!.kind, "concept");
});

test("빈 이름은 거부", () => {
  assert.throws(() => recordLearning(fixtureGraph(), { name: "  ", kind: "tech" }, NOW));
});

test("재빌드해도 MCP로 기록한 노드는 살아남는다 (preserve)", async () => {
  const recorded = recordLearning(
    fixtureGraph(),
    { name: "Qdrant", kind: "tech", note: "벡터 DB", relatedProject: "spellbook" },
    NOW,
  ).graph;

  const { graph } = await buildGraph(SNAPSHOT, {
    env: { GRAPH_EXTRACTOR: "none" },
    preserve: recorded,
  });

  const node = find(graph, techId("qdrant"));
  assert.ok(node, "손으로 기록한 Tech가 재빌드 후에도 있어야 한다");
  assert.equal(node!.meta?.note, "벡터 DB");
  assert.ok(
    graph.edges.some(
      (e) => e.id === edgeId("USES", projectId("mage/spellbook"), techId("qdrant")),
    ),
  );
  // preserve를 주지 않으면 사라진다 (동작 대비)
  const { graph: plain } = await buildGraph(SNAPSHOT, { env: { GRAPH_EXTRACTOR: "none" } });
  assert.equal(find(plain, techId("qdrant")), undefined);
});

/* ── 4. login 해석 ────────────────────────────────────────────── */

test("pickLogin: env 우선 → 하나뿐이면 그것 → 여럿이면 안내와 함께 실패", () => {
  assert.equal(pickLogin(["mage"], undefined), "mage");
  assert.equal(pickLogin(["mage", "witch"], "witch"), "witch");

  assert.throws(() => pickLogin(["mage", "witch"], undefined), /GRIMOIRE_LOGIN/);
  assert.throws(() => pickLogin(["mage", "witch"], undefined), /mage, witch/);
  assert.throws(() => pickLogin([], undefined), /그래프 JSON이 없습니다/);
  assert.throws(() => pickLogin(["mage"], "witch"), /찾지 못했습니다/);
  assert.throws(() => pickLogin(["mage"], "../etc/passwd"), /형식이 아닙니다/);
});

test("dataDirCandidates: env → cwd/data → 모듈 옆", () => {
  const candidates = dataDirCandidates(
    { GRIMOIRE_DATA_DIR: "/mnt/grimoire-data" },
    path.join("/app", "dist-mcp", "mcp"),
    "/elsewhere",
  );
  assert.deepEqual(candidates, [
    path.resolve("/mnt/grimoire-data"),
    path.resolve("/elsewhere", "data"),
    path.resolve("/app", "data"),
  ]);

  // cwd와 모듈 위치가 같은 곳을 가리키면 한 번만 나온다 (컨테이너: cwd=/app).
  assert.deepEqual(
    dataDirCandidates({}, path.join("/app", "dist-mcp", "mcp"), "/app"),
    [path.resolve("/app", "data")],
  );
});

/* ── 5. 저장 (임시 디렉터리) ──────────────────────────────────── */

test("writeGraphAtomic: 임시 파일 + rename, 되읽기 일치", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grimoire-mcp-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const graph = fixtureGraph();
  const file = await writeGraphAtomic(dir, graph);
  assert.ok(file.endsWith(path.join("graph", "mage.json")));

  assert.deepEqual(await listGraphLogins(dir), ["mage"]);
  const roundTrip = await readGraph(dir, "mage");
  assert.equal(roundTrip?.nodes.length, graph.nodes.length);

  // 덮어쓰기도 되고 임시 파일이 남지 않는다.
  await writeGraphAtomic(dir, { ...graph, nodes: graph.nodes.slice(0, 3) });
  assert.equal((await readGraph(dir, "mage"))?.nodes.length, 3);
  const left = await fs.readdir(path.join(dir, "graph"));
  assert.deepEqual(left, ["mage.json"]);

  // 없는 그래프는 null
  assert.equal(await readGraph(dir, "nobody"), null);
  assert.deepEqual(await listGraphLogins(path.join(dir, "없음")), []);
});

/* ── 6. 전송 설정 · 인증 게이트 ───────────────────────────────── */

test("readTransportConfig: 기본은 stdio, http는 토큰 없으면 기동 거부", () => {
  assert.equal(readTransportConfig({}).mode, "stdio");
  assert.equal(readTransportConfig({ MCP_TRANSPORT: "STDIO" }).mode, "stdio");
  assert.equal(readTransportConfig({ MCP_TRANSPORT: "그외" }).mode, "stdio");
  // stdio에서는 토큰을 무시한다.
  assert.equal(readTransportConfig({ MCP_AUTH_TOKEN: "t" }).authToken, null);

  assert.throws(
    () => readTransportConfig({ MCP_TRANSPORT: "http" }),
    /MCP_AUTH_TOKEN/,
  );
  assert.throws(
    () => readTransportConfig({ MCP_TRANSPORT: "http", MCP_AUTH_TOKEN: "   " }),
    /토큰 없이 원격에 노출할 수 없습니다/,
  );

  const http = readTransportConfig({
    MCP_TRANSPORT: "http",
    MCP_AUTH_TOKEN: "secret",
    MCP_PORT: "9000",
  });
  assert.equal(http.mode, "http");
  assert.equal(http.port, 9000);
  assert.equal(http.host, "0.0.0.0");
  assert.equal(http.path, "/mcp");
  assert.equal(http.authToken, "secret");

  // 이상한 포트는 기본값으로
  assert.equal(
    readTransportConfig({ MCP_TRANSPORT: "http", MCP_AUTH_TOKEN: "s", MCP_PORT: "abc" }).port,
    8765,
  );
});

test("isAuthorized: Bearer 토큰 검사", () => {
  assert.equal(isAuthorized(undefined, null), true); // stdio
  assert.equal(isAuthorized("Bearer secret", "secret"), true);
  assert.equal(isAuthorized("bearer secret", "secret"), true);
  assert.equal(isAuthorized("Bearer  secret ", "secret"), true);
  assert.equal(isAuthorized(["Bearer secret"], "secret"), true);

  assert.equal(isAuthorized(undefined, "secret"), false);
  assert.equal(isAuthorized("secret", "secret"), false);
  assert.equal(isAuthorized("Bearer wrong", "secret"), false);
  assert.equal(isAuthorized("Bearer secretx", "secret"), false);
  assert.equal(isAuthorized("Basic secret", "secret"), false);
});
