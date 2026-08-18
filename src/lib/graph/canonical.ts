/**
 * ② 지식그래프 — 엔티티 정규화 (KNOWLEDGE_GRAPH.md §4.1 4단계).
 *
 * ["react", "react.js", "ReactJS"] → canonical `react` → 노드 id `tech-react`.
 * 사전에 없는 신규 이름은 정규화 문자열 그대로 canonical로 삼는다.
 */
import {
  CONCEPT_DOMAINS,
  CONCEPT_STOPWORDS,
  TECH_ALIASES,
  TECH_CATEGORIES,
} from "./dictionaries";
import type { TechCategory } from "./types";

const CATEGORIES = new Set<TechCategory>([
  "frontend",
  "backend",
  "database",
  "devops",
  "testing",
  "mobile",
  "ai",
  "language",
  "tooling",
  "other",
]);

/**
 * 표기 흔들림 흡수: 소문자화 · 공백/밑줄/점 → 하이픈 · 스코프 제거 · 잡문자 제거.
 * "React.js" → "react-js", "@tanstack/react-query" → "react-query", "실시간 동기화" → "실시간-동기화"
 */
export function normalizeName(raw: string): string {
  let name = raw.trim().toLowerCase();
  // npm 스코프(@scope/pkg) → pkg
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    name = slash >= 0 ? name.slice(slash + 1) : name.slice(1);
  }
  name = name
    .replace(/[\s_.]+/g, "-")
    // 한글/영숫자/하이픈/+/# 외 제거 (c++, c# 보존)
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ+#-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return name;
}

/**
 * canonical 기술명. 별칭 사전을 1회 적용한다.
 *
 * TODO(2차): 사전에 없는 신규 이름은 nomic-embed-text 임베딩 코사인 유사도(>0.88)로
 * 기존 노드와 자동 매칭한다 (KNOWLEDGE_GRAPH.md §4.1). 임베딩 계층이 붙는 자리.
 */
export function canonicalTech(raw: string): string {
  const normalized = normalizeName(raw);
  return TECH_ALIASES[normalized] ?? normalized;
}

/** canonical 개념명. 기술 별칭도 함께 적용해 concept/tech 표기를 맞춘다. */
export function canonicalConcept(raw: string): string {
  const normalized = normalizeName(raw);
  return TECH_ALIASES[normalized] ?? normalized;
}

/** 사전 기반 기술 분류 */
export function techCategory(canonical: string): TechCategory {
  const found = TECH_CATEGORIES[canonical];
  if (found && CATEGORIES.has(found as TechCategory)) {
    return found as TechCategory;
  }
  return "other";
}

/** 사전 기반 개념 도메인 (모르면 general) */
export function conceptDomain(canonical: string): string {
  if (CONCEPT_DOMAINS[canonical]) return CONCEPT_DOMAINS[canonical];
  // "realtime-chat" 처럼 합성된 라벨은 조각으로도 찾아본다.
  for (const part of canonical.split("-")) {
    if (CONCEPT_DOMAINS[part]) return CONCEPT_DOMAINS[part];
  }
  return "general";
}

/** 신호가 없는 라벨인가 (Concept 승격 제외 대상) */
export function isNoiseConcept(canonical: string): boolean {
  if (canonical.length < 2) return true;
  return CONCEPT_STOPWORDS.has(canonical);
}

/** canonical 이름 → 사람이 읽는 표시명 (사전에 있으면 그 표기를 우선) */
const DISPLAY_OVERRIDES: Record<string, string> = {
  nextjs: "Next.js",
  nodejs: "Node.js",
  react: "React",
  vue: "Vue",
  typescript: "TypeScript",
  javascript: "JavaScript",
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  graphql: "GraphQL",
  tailwindcss: "Tailwind CSS",
  socketio: "Socket.IO",
  websocket: "WebSocket",
  "next-auth": "Auth.js",
  neo4j: "Neo4j",
  qdrant: "Qdrant",
  ollama: "Ollama",
  "scikit-learn": "scikit-learn",
  "react-query": "TanStack Query",
};

export function displayName(canonical: string, fallback?: string): string {
  return DISPLAY_OVERRIDES[canonical] ?? fallback ?? canonical;
}
