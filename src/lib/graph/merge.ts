/**
 * ② 지식그래프 — LLM 추출 결과를 결정론적 그래프에 합류시킨다.
 *
 * LLM은 그래프를 "새로 만들지" 않는다. 이미 정적 분석으로 세워진 노드 위에
 * Concept/Problem/Learned를 덧붙일 뿐이며, 이름은 전부 canonical 정규화를 거쳐
 * 토픽에서 나온 노드와 같은 id로 합쳐진다.
 */
import type { Repo } from "../collector/types";
import type { GraphAccumulator } from "./accumulator";
import {
  canonicalConcept,
  canonicalTech,
  conceptDomain,
  displayName,
  isNoiseConcept,
  normalizeName,
  techCategory,
} from "./canonical";
import { toPeriod } from "./commits";
import {
  conceptId,
  edgeId,
  periodId,
  problemId,
  projectId,
  techId,
} from "./types";
import type { ExtractionResult } from "./extractors/types";

/** "2024-03" / "2024-03-15" → ISO. 못 읽으면 null. */
function parseApplied(date: string | undefined): string | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month}-${day ?? "01"}T00:00:00.000Z`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

function problemSlug(title: string, index: number): string {
  const slug = normalizeName(title).slice(0, 48);
  return slug.length >= 2 ? slug : `p${index}`;
}

/**
 * 레포 하나의 추출 결과를 병합한다.
 * @param repoConcepts 이 레포에서 등장한 Concept canonical 집합 (RELATED_TO 재계산용, 제자리 수정)
 */
export function mergeExtraction(
  acc: GraphAccumulator,
  repo: Repo,
  result: ExtractionResult,
  repoConcepts: Set<string>,
  fallbackDate: string,
): void {
  const pid = projectId(repo.fullName);
  const origin = `${repo.fullName}#llm`;

  // ── Concept ──────────────────────────────────────────────────
  for (const concept of result.concepts) {
    const canonical = canonicalConcept(concept.name);
    if (!canonical || isNoiseConcept(canonical)) continue;
    acc.addNode({
      id: conceptId(canonical),
      kind: "concept",
      label: displayName(canonical, concept.name),
      name: canonical,
      domain: concept.domain
        ? normalizeName(concept.domain) || "general"
        : conceptDomain(canonical),
      summary: concept.summary,
      sources: [origin],
    });
    acc.addEdge({
      id: edgeId("ABOUT", pid, conceptId(canonical)),
      kind: "ABOUT",
      from: pid,
      to: conceptId(canonical),
      confidence: 0.7,
      sources: [origin],
    });
    repoConcepts.add(canonical);
  }

  // ── Problem ──────────────────────────────────────────────────
  result.problems_solved.forEach((problem, index) => {
    const id = problemId(repo.fullName, problemSlug(problem.title, index));
    acc.addNode({
      id,
      kind: "problem",
      label: problem.title,
      title: problem.title,
      description: problem.description,
      solutionSummary: problem.solution_summary,
      sources: [origin],
    });
    acc.addEdge({
      id: edgeId("SOLVED", pid, id),
      kind: "SOLVED",
      from: pid,
      to: id,
      sources: [origin],
    });

    for (const rawTech of problem.tech_used ?? []) {
      const canonical = canonicalTech(rawTech);
      if (!canonical) continue;
      addLlmTech(acc, repo, canonical, rawTech, origin);
      acc.addEdge({
        id: edgeId("SOLVED", techId(canonical), id),
        kind: "SOLVED",
        from: techId(canonical),
        to: id,
        sources: [origin],
      });
    }
  });

  // ── Learned tech ─────────────────────────────────────────────
  for (const learned of result.learned_tech) {
    const canonical = canonicalTech(learned.name);
    if (!canonical) continue;
    addLlmTech(acc, repo, canonical, learned.name, origin);

    const applied = parseApplied(learned.first_applied_date) ?? fallbackDate;
    const { year, quarter } = toPeriod(applied);
    if (!Number.isFinite(year)) continue;
    const period = periodId(year, quarter);
    acc.addNode({
      id: period,
      kind: "period",
      label: `${year} Q${quarter}`,
      year,
      quarter,
    });
    acc.addEdge({
      id: edgeId("LEARNED", period, techId(canonical)),
      kind: "LEARNED",
      from: period,
      to: techId(canonical),
      firstCommitDate: applied,
      sources: [origin],
    });
  }
}

function addLlmTech(
  acc: GraphAccumulator,
  repo: Repo,
  canonical: string,
  raw: string,
  origin: string,
): void {
  acc.addNode({
    id: techId(canonical),
    kind: "tech",
    label: displayName(canonical, raw),
    name: canonical,
    category: techCategory(canonical),
    sources: [origin],
  });
  acc.addEdge({
    id: edgeId("USES", projectId(repo.fullName), techId(canonical)),
    kind: "USES",
    from: projectId(repo.fullName),
    to: techId(canonical),
    weight: 0.6,
    source: "llm",
    sources: [origin],
  });
}
