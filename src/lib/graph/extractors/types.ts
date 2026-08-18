/**
 * ② 지식그래프 — LLM 추출기 인터페이스 (KNOWLEDGE_GRAPH.md §4.2).
 *
 * 추출기는 "레포 하나 → 구조화 JSON"만 책임진다. 그래프 병합은 merge.ts.
 * 프라이버시(PLANNING.md §7): 여기 들어오는 입력은 커밋 다이제스트와 README 발췌 —
 * 즉 사용자 데이터다. 외부 API 추출기(claude)는 명시적 opt-in 없이는 선택되지 않는다.
 */
import type { ExtractorName } from "../types";

export interface ExtractionInput {
  repoFullName: string;
  repoName: string;
  description: string | null;
  primaryLanguage: string | null;
  topics: string[];
  /** 정적 분석으로 이미 확보한 기술들 (LLM에 힌트로 준다) */
  knownTech: string[];
  /** 필터링·압축된 커밋 다이제스트 */
  commitDigest: string;
  /** README 발췌 (앞부분 일부) */
  readmeExcerpt: string | null;
}

/** KNOWLEDGE_GRAPH.md §4.2의 응답 포맷 */
export interface ExtractedConcept {
  name: string;
  domain?: string;
  summary?: string;
}

export interface ExtractedProblem {
  title: string;
  description?: string;
  solution_summary?: string;
  tech_used?: string[];
}

export interface ExtractedLearnedTech {
  name: string;
  /** "YYYY-MM" 또는 "YYYY-MM-DD" */
  first_applied_date?: string;
}

export interface ExtractionResult {
  concepts: ExtractedConcept[];
  problems_solved: ExtractedProblem[];
  learned_tech: ExtractedLearnedTech[];
}

export interface Extractor {
  readonly name: ExtractorName;
  extractRepo(input: ExtractionInput): Promise<ExtractionResult>;
}

export const EMPTY_EXTRACTION: ExtractionResult = {
  concepts: [],
  problems_solved: [],
  learned_tech: [],
};

/* ── 응답 검증 (모델은 언제든 헛소리를 한다) ────────────────────────── */

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 400) : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 모델 출력(임의의 JSON) → 안전한 ExtractionResult. 형식이 깨졌으면 throw. */
export function validateExtraction(raw: unknown): ExtractionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("추출 결과가 객체가 아닙니다");
  }
  const obj = raw as Record<string, unknown>;
  if (
    obj.concepts === undefined &&
    obj.problems_solved === undefined &&
    obj.learned_tech === undefined
  ) {
    throw new Error("concepts/problems_solved/learned_tech 키가 없습니다");
  }

  const concepts: ExtractedConcept[] = [];
  for (const item of arr(obj.concepts).slice(0, 12)) {
    const record = item as Record<string, unknown>;
    const name = str(record?.name);
    if (!name) continue;
    concepts.push({
      name,
      domain: str(record?.domain),
      summary: str(record?.summary),
    });
  }

  const problems: ExtractedProblem[] = [];
  for (const item of arr(obj.problems_solved).slice(0, 12)) {
    const record = item as Record<string, unknown>;
    const title = str(record?.title);
    if (!title) continue;
    problems.push({
      title,
      description: str(record?.description),
      solution_summary:
        str(record?.solution_summary) ?? str(record?.solutionSummary),
      tech_used: arr(record?.tech_used)
        .map((t) => str(t))
        .filter((t): t is string => Boolean(t)),
    });
  }

  const learned: ExtractedLearnedTech[] = [];
  for (const item of arr(obj.learned_tech).slice(0, 12)) {
    const record = item as Record<string, unknown>;
    const name = str(record?.name);
    if (!name) continue;
    learned.push({
      name,
      first_applied_date:
        str(record?.first_applied_date) ?? str(record?.firstAppliedDate),
    });
  }

  return { concepts, problems_solved: problems, learned_tech: learned };
}

/** 모델이 코드펜스나 잡담을 섞어 보내는 경우까지 감안한 JSON 파서 */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("JSON을 찾지 못했습니다");
  }
}

/* ── 공통 프롬프트 (KNOWLEDGE_GRAPH.md §4.2) ──────────────────────── */

export const SYSTEM_PROMPT =
  "당신은 개발자의 깃허브 이력을 분석해 지식그래프를 구축하는 AI 아키텍트입니다. " +
  "주어진 레포지토리 정보와 커밋 내역에서 핵심 기술(Tech), 도메인 개념(Concept), " +
  "해결한 문제(Problem)를 정밀 추출하여 정해진 JSON 포맷으로만 응답하세요. " +
  "추측하지 말고 근거가 있는 항목만 넣으세요. 설명 문장은 넣지 말고 JSON만 출력하세요.";

export const JSON_SCHEMA_HINT = `{
  "concepts": [{"name": "실시간 데이터 동기화", "domain": "realtime", "summary": "WebSocket 기반 양방향 통신 구현"}],
  "problems_solved": [{"title": "커밋 폭증 시 메모리 누수 방지", "description": "…", "solution_summary": "…", "tech_used": ["RxJS", "Redis"]}],
  "learned_tech": [{"name": "Neo4j", "first_applied_date": "2024-03"}]
}`;

export function buildUserPrompt(input: ExtractionInput): string {
  const parts = [
    `레포지토리: ${input.repoFullName}`,
    input.description ? `설명: ${input.description}` : null,
    input.primaryLanguage ? `주 언어: ${input.primaryLanguage}` : null,
    input.topics.length > 0 ? `토픽: ${input.topics.join(", ")}` : null,
    input.knownTech.length > 0
      ? `정적 분석으로 확인된 기술: ${input.knownTech.slice(0, 40).join(", ")}`
      : null,
    input.readmeExcerpt ? `\nREADME 발췌:\n${input.readmeExcerpt}` : null,
    input.commitDigest ? `\n주요 커밋:\n${input.commitDigest}` : null,
    `\n아래 JSON 스키마 그대로, 이 형식으로만 응답하세요:\n${JSON_SCHEMA_HINT}`,
  ];
  return parts.filter(Boolean).join("\n");
}
