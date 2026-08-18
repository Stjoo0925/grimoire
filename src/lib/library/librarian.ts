/**
 * ③ AI 사서 — 답변 파이프라인의 순수 부분.
 *
 * 흐름 (KNOWLEDGE_GRAPH.md §5의 1차 버전 — 임베딩은 5차):
 *   질문 → 그래프 키워드 검색(mcp/search 재사용) → 1홉 서브그래프 + 프로젝트 요약으로
 *   압축 컨텍스트 → 로컬 Ollama가 합성.
 *
 * 여기에는 네트워크가 없다. 실제 호출은 ollama.ts, 배선은 app/actions.ts.
 * 외부 API는 어떤 경로로도 부르지 않는다 (PLANNING.md §7).
 */
import { searchGraph } from "../../mcp/search";
import type {
  KnowledgeGraph,
  ProjectNode,
  UsesEdge,
} from "../graph/types";

/** 시드 노드 수 */
const SEED_LIMIT = 6;
/** 컨텍스트에 넣을 이웃 라벨 수 (관계 종류별) */
const NEIGHBORS_PER_KIND = 6;
/** 프로젝트 요약(책 소개) 줄 수 */
const PROJECT_BRIEFS = 6;
/** 프로젝트 요약에 붙이는 기술 수 */
const TECH_PER_BRIEF = 6;
/** 사서가 빛낼 책 상한 */
export const GLOW_LIMIT = 10;

/** 사서가 찾아낸 항목 하나 (LLM이 없을 때 그대로 보여준다) */
export interface LibrarianItem {
  id: string;
  kind: string;
  label: string;
  /** 개념 요약 / 문제 해결 요약 / 프로젝트 설명 */
  detail?: string;
  /** "USES → React, Next.js" 형태의 연결 요약 */
  connections: string[];
  score: number;
}

/** 서버 액션이 채팅창에 돌려주는 한 번의 답 */
export interface LibrarianAnswer {
  ok: boolean;
  question: string;
  /** 로컬 LLM이 합성한 문장. degraded면 null */
  answer: string | null;
  /** 로컬 Ollama가 없어 검색 결과만 보여주는 모드인가 */
  degraded: boolean;
  items: LibrarianItem[];
  /** 서가에서 빛낼 책(Project 노드) id */
  projectIds: string[];
  /** 안내·오류 문구 (이미 번역된 문자열) */
  message: string | null;
}

export interface LibrarianContext {
  /** 검색으로 걸린 항목들 (degraded 모드에서 그대로 노출) */
  items: LibrarianItem[];
  /** 프롬프트에 주입할 압축 컨텍스트 */
  contextText: string;
  /** 검색에 걸린 프로젝트 노드 id (발광 후보) */
  projectIds: string[];
  /** 이름 매칭용 — 발광 후보 프로젝트의 표기 */
  projects: Array<{ id: string; name: string; fullName: string }>;
  totalMatches: number;
}

const KIND_LABEL: Record<string, string> = {
  project: "책",
  tech: "기술",
  concept: "개념",
  problem: "해결한 문제",
  period: "시기",
};

/** 질문 → 검색 → 압축 컨텍스트 */
export function buildLibrarianContext(
  graph: KnowledgeGraph,
  question: string,
): LibrarianContext {
  const search = searchGraph(graph, question, { limit: SEED_LIMIT, hops: 1 });

  const items: LibrarianItem[] = search.seeds.map((seed) => {
    const connections = seed.connections
      .map((connection) => {
        const labels = connection.nodes
          .slice(0, NEIGHBORS_PER_KIND)
          .map((node) => node.label);
        if (labels.length === 0) return null;
        const arrow = connection.direction === "out" ? "→" : "←";
        return `${connection.kind} ${arrow} ${labels.join(", ")}`;
      })
      .filter((line): line is string => line !== null);

    return {
      id: seed.node.id,
      kind: seed.node.kind,
      label: seed.node.label,
      detail:
        seed.node.summary ??
        seed.node.solutionSummary ??
        seed.node.description ??
        undefined,
      connections,
      score: seed.score,
    };
  });

  // 발광 후보: 시드 프로젝트 + 시드의 이웃 프로젝트
  const projectNodes = new Map(
    graph.nodes
      .filter((node): node is ProjectNode => node.kind === "project")
      .map((node) => [node.id, node]),
  );
  const projectIds: string[] = [];
  const pushProject = (id: string) => {
    if (!projectNodes.has(id) || projectIds.includes(id)) return;
    projectIds.push(id);
  };
  for (const seed of search.seeds) pushProject(seed.node.id);
  for (const seed of search.seeds) {
    for (const connection of seed.connections) {
      for (const node of connection.nodes) pushProject(node.id);
    }
  }

  const lines: string[] = [];
  for (const item of items) {
    const head = `- [${KIND_LABEL[item.kind] ?? item.kind}] ${item.label}`;
    lines.push(item.detail ? `${head} — ${item.detail}` : head);
    for (const connection of item.connections) lines.push(`    ${connection}`);
  }

  // 책별 사실 블록 — 각 책 아래에는 "그 책의 엣지"에서 나온 사실만 적는다.
  // 소형 모델이 서로 다른 책의 기술을 섞어 붙이는 환각을 막기 위한 구조.
  const labelOf = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.label;
  const briefs = projectIds.slice(0, PROJECT_BRIEFS).map((id) => {
    const project = projectNodes.get(id)!;
    const tech = graph.edges
      .filter(
        (edge): edge is UsesEdge => edge.kind === "USES" && edge.from === id,
      )
      .map((edge) => labelOf(edge.to))
      .filter((label): label is string => Boolean(label))
      .slice(0, TECH_PER_BRIEF);
    const concepts = graph.edges
      .filter((edge) => edge.kind === "ABOUT" && edge.from === id)
      .map((edge) => labelOf(edge.to))
      .filter((label): label is string => Boolean(label))
      .slice(0, 4);
    const problems = graph.edges
      .filter((edge) => edge.kind === "SOLVED" && edge.from === id)
      .map((edge) => labelOf(edge.to))
      .filter((label): label is string => Boolean(label))
      .slice(0, 3);
    return [
      `## ${project.fullName}${project.isPrivate ? " (비공개)" : ""}`,
      project.primaryLang ? `주 언어: ${project.primaryLang}` : null,
      tech.length > 0 ? `사용 기술: ${tech.join(", ")}` : null,
      concepts.length > 0 ? `다루는 개념: ${concepts.join(", ")}` : null,
      problems.length > 0 ? `해결한 문제: ${problems.join(" / ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  const sections: string[] = [];
  if (lines.length > 0) sections.push(`# 검색된 항목\n${lines.join("\n")}`);
  if (briefs.length > 0)
    sections.push(
      `# 책별 사실 (각 책에 대한 진술은 반드시 그 책의 블록 안 사실만 사용할 것)\n${briefs.join("\n\n")}`,
    );

  return {
    items,
    contextText: sections.join("\n\n"),
    projectIds: projectIds.slice(0, GLOW_LIMIT),
    projects: projectIds.map((id) => {
      const project = projectNodes.get(id)!;
      return { id, name: project.name, fullName: project.fullName };
    }),
    totalMatches: search.totalMatches,
  };
}

export const LIBRARIAN_SYSTEM_PROMPT = [
  "당신은 개발자의 GitHub 이력으로 지어진 마법 도서관의 사서입니다.",
  "주어진 '자료' 안의 사실만으로 답하세요. 자료에 없는 프로젝트·기술을 지어내지 마세요.",
  "특정 책(레포)에 대해 말할 때는 '책별 사실'에서 **그 책의 블록 안에 적힌** 기술·개념·문제만 언급하세요.",
  "한 책의 기술을 다른 책에 옮겨 붙이는 것은 금지입니다. 어느 책의 사실인지 불확실하면 언급하지 마세요.",
  "답변은 3~6문장으로 짧게, 차분한 사서의 말투로 씁니다.",
  "관련된 책(레포)이 있으면 그 이름을 문장 안에 그대로 적어 주세요 — 서가에서 그 책이 빛납니다.",
  "자료가 비어 있으면 찾지 못했다고 솔직히 말하고 다른 검색어를 제안하세요.",
].join("\n");

/** 사용자 로케일에 맞춘 답변 언어 지시 */
export function localeInstruction(locale: string): string {
  return locale === "en"
    ? "Answer in English."
    : "한국어로 답하세요.";
}

export function buildLibrarianPrompt(
  question: string,
  context: LibrarianContext,
  locale: string,
): string {
  const body = context.contextText || "(검색된 항목이 없습니다)";
  return [
    `# 자료`,
    body,
    "",
    `# 질문`,
    question,
    "",
    localeInstruction(locale),
  ].join("\n");
}

/**
 * 답변 본문에 실제로 등장한 책을 골라낸다 (서가 발광 대상).
 * 이름이 하나도 안 잡히면 검색 단계의 후보를 그대로 쓴다.
 */
export function matchProjectMentions(
  answer: string,
  context: LibrarianContext,
  limit = GLOW_LIMIT,
): string[] {
  const haystack = answer.toLowerCase();
  const matched: string[] = [];
  for (const project of context.projects) {
    const name = project.name.toLowerCase();
    const full = project.fullName.toLowerCase();
    if (name.length >= 3 && (haystack.includes(name) || haystack.includes(full))) {
      matched.push(project.id);
    }
  }
  if (matched.length === 0) return context.projectIds.slice(0, limit);
  return matched.slice(0, limit);
}
