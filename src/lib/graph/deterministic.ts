/**
 * ② 지식그래프 — 결정론적 파이프라인.
 *
 * LLM 없이(=GRAPH_EXTRACTOR=none) 여기까지만 돌려도 온톨로지가 성립한다
 * (PLANNING.md §8 "LLM-free 모드 정식 티어").
 *
 *   매니페스트 → Tech + USES(static) + DEPENDS_ON
 *   언어 통계  → Tech(language) + USES(static)
 *   토픽       → 알려진 기술이면 Tech + USES(topics), 아니면 Concept + ABOUT
 *   커밋 날짜  → Period + DEVELOPED, 기술별 최초 등장 → LEARNED
 *   같은 레포 안의 Concept 공동 등장 → RELATED_TO(strength)
 */
import type { CollectionSnapshot, Repo } from "../collector/types";
import { GraphAccumulator } from "./accumulator";
import {
  canonicalConcept,
  canonicalTech,
  conceptDomain,
  displayName,
  isNoiseConcept,
  techCategory,
} from "./canonical";
import { groupCommitsByRepo, toPeriod } from "./commits";
import { TECH_ALIASES, TECH_CATEGORIES, TECH_DEPENDENCIES } from "./dictionaries";
import { parseManifests } from "./manifests";
import {
  conceptId,
  edgeId,
  periodId,
  projectId,
  techId,
  type GraphNode,
} from "./types";

/** 정적 분석 결과 + 이후 단계(LLM 병합)가 쓰는 부수 정보 */
export interface DeterministicBuild {
  accumulator: GraphAccumulator;
  /** repoFullName → 그 레포에서 등장한 Concept canonical 이름 */
  conceptsByRepo: Map<string, Set<string>>;
  /** repoFullName → 그 레포 첫 커밋 날짜 (ISO, 커밋 없으면 createdAt) */
  firstCommitByRepo: Map<string, string>;
}

/** 토픽/매니페스트 이름이 "우리가 아는 기술"인가 */
function isKnownTech(canonical: string): boolean {
  return canonical in TECH_CATEGORIES || canonical in TECH_ALIASES;
}

function techNode(canonical: string, source: string, raw?: string): GraphNode {
  return {
    id: techId(canonical),
    kind: "tech",
    label: displayName(canonical, raw),
    name: canonical,
    category: techCategory(canonical),
    sources: [source],
  };
}

function conceptNode(canonical: string, source: string, raw?: string): GraphNode {
  return {
    id: conceptId(canonical),
    kind: "concept",
    label: displayName(canonical, raw),
    name: canonical,
    domain: conceptDomain(canonical),
    sources: [source],
  };
}

function addTechUse(
  acc: GraphAccumulator,
  repo: Repo,
  canonical: string,
  opts: { weight: number; source: "static" | "topics" | "llm"; origin: string; raw?: string },
): void {
  acc.addNode(techNode(canonical, opts.origin, opts.raw));
  acc.addEdge({
    id: edgeId("USES", projectId(repo.fullName), techId(canonical)),
    kind: "USES",
    from: projectId(repo.fullName),
    to: techId(canonical),
    weight: opts.weight,
    source: opts.source,
    sources: [opts.origin],
  });
}

/** 자명한 기술 간 의존(next→react 등)을 붙인다 */
function addDependsOn(acc: GraphAccumulator, canonical: string, origin: string): void {
  for (const target of TECH_DEPENDENCIES[canonical] ?? []) {
    // 대상 기술도 실제로 쓰인 것으로 본다 (next를 쓰면 react 위에서 돈다).
    acc.addNode(techNode(target, origin));
    acc.addEdge({
      id: edgeId("DEPENDS_ON", techId(canonical), techId(target)),
      kind: "DEPENDS_ON",
      from: techId(canonical),
      to: techId(target),
      sources: [origin],
    });
  }
}

export function buildDeterministic(
  snapshot: CollectionSnapshot,
): DeterministicBuild {
  const acc = new GraphAccumulator();
  const commitsByRepo = groupCommitsByRepo(snapshot.commits);
  const conceptsByRepo = new Map<string, Set<string>>();
  const firstCommitByRepo = new Map<string, string>();
  /** tech canonical → 최초 등장 날짜 (ISO) */
  const techFirstSeen = new Map<string, string>();

  for (const repo of snapshot.repos) {
    const pid = projectId(repo.fullName);
    acc.addNode({
      id: pid,
      kind: "project",
      label: repo.name,
      name: repo.name,
      fullName: repo.fullName,
      isPrivate: repo.isPrivate,
      primaryLang: repo.primaryLanguage,
      stars: repo.stars,
      lastPushedAt: repo.pushedAt,
      sources: [repo.fullName],
    });

    const repoCommits = commitsByRepo.get(repo.fullName) ?? [];
    const firstCommit = repoCommits.at(0)?.authoredAt ?? repo.createdAt;
    firstCommitByRepo.set(repo.fullName, firstCommit);

    const noteTech = (canonical: string) => {
      const prev = techFirstSeen.get(canonical);
      if (!prev || firstCommit < prev) techFirstSeen.set(canonical, firstCommit);
    };

    // ── 언어 통계 → Tech(language) ────────────────────────────────
    const totalBytes = Object.values(repo.languages ?? {}).reduce(
      (sum, n) => sum + n,
      0,
    );
    for (const [language, bytes] of Object.entries(repo.languages ?? {})) {
      const canonical = canonicalTech(language);
      if (!canonical) continue;
      addTechUse(acc, repo, canonical, {
        weight: totalBytes > 0 ? round(bytes / totalBytes) : 0.5,
        source: "static",
        origin: `${repo.fullName}#languages`,
        raw: language,
      });
      noteTech(canonical);
    }
    if (repo.primaryLanguage) {
      const canonical = canonicalTech(repo.primaryLanguage);
      addTechUse(acc, repo, canonical, {
        weight: 1,
        source: "static",
        origin: `${repo.fullName}#primaryLanguage`,
        raw: repo.primaryLanguage,
      });
      noteTech(canonical);
    }

    // ── 의존성 매니페스트 → Tech + DEPENDS_ON ─────────────────────
    for (const { dependency, manifestPath } of parseManifests(repo.manifests)) {
      const canonical = canonicalTech(dependency.raw);
      if (!canonical) continue;
      addTechUse(acc, repo, canonical, {
        weight: dependency.dev ? 0.4 : 0.8,
        source: "static",
        origin: `${repo.fullName}#${manifestPath}`,
        raw: dependency.raw,
      });
      addDependsOn(acc, canonical, `${repo.fullName}#${manifestPath}`);
      noteTech(canonical);
    }

    // ── 토픽 → Tech(USES/topics) 또는 Concept(ABOUT) ──────────────
    const repoConcepts = new Set<string>();
    for (const topic of repo.topics ?? []) {
      const canonical = canonicalConcept(topic);
      if (!canonical || isNoiseConcept(canonical)) continue;
      const origin = `${repo.fullName}#topics`;
      if (isKnownTech(canonical)) {
        addTechUse(acc, repo, canonical, {
          weight: 0.6,
          source: "topics",
          origin,
          raw: topic,
        });
        addDependsOn(acc, canonical, origin);
        noteTech(canonical);
        continue;
      }
      acc.addNode(conceptNode(canonical, origin, topic));
      acc.addEdge({
        id: edgeId("ABOUT", pid, conceptId(canonical)),
        kind: "ABOUT",
        from: pid,
        to: conceptId(canonical),
        // 사람이 직접 붙인 라벨이므로 신뢰도가 높다.
        confidence: 0.9,
        sources: [origin],
      });
      repoConcepts.add(canonical);
    }
    conceptsByRepo.set(repo.fullName, repoConcepts);

    // ── 커밋 날짜 → Period + DEVELOPED ────────────────────────────
    const periods = new Set<string>();
    for (const commit of repoCommits) periods.add(commit.authoredAt);
    if (periods.size === 0) periods.add(repo.createdAt);
    for (const iso of periods) {
      const { year, quarter } = toPeriod(iso);
      if (!Number.isFinite(year)) continue;
      const pid2 = periodId(year, quarter);
      acc.addNode({
        id: pid2,
        kind: "period",
        label: `${year} Q${quarter}`,
        year,
        quarter,
      });
      acc.addEdge({
        id: edgeId("DEVELOPED", pid2, pid),
        kind: "DEVELOPED",
        from: pid2,
        to: pid,
        sources: [repo.fullName],
      });
    }
  }

  // ── 기술별 최초 등장 → Period -[LEARNED]-> Tech ────────────────
  for (const [canonical, iso] of techFirstSeen) {
    const { year, quarter } = toPeriod(iso);
    if (!Number.isFinite(year)) continue;
    const pid = periodId(year, quarter);
    acc.addNode({
      id: pid,
      kind: "period",
      label: `${year} Q${quarter}`,
      year,
      quarter,
    });
    acc.addEdge({
      id: edgeId("LEARNED", pid, techId(canonical)),
      kind: "LEARNED",
      from: pid,
      to: techId(canonical),
      firstCommitDate: iso,
    });
  }

  linkRelatedConcepts(acc, conceptsByRepo);

  return { accumulator: acc, conceptsByRepo, firstCommitByRepo };
}

/**
 * 같은 레포에 함께 등장한 Concept끼리 RELATED_TO를 잇는다.
 * strength = 공동 등장 횟수 / 최대 공동 등장 횟수 (0~1 정규화).
 * LLM 병합 이후에도 다시 호출해 새 개념까지 반영한다.
 */
export function linkRelatedConcepts(
  acc: GraphAccumulator,
  conceptsByRepo: Map<string, Set<string>>,
): void {
  const pairCount = new Map<string, { a: string; b: string; count: number; repos: string[] }>();

  for (const [repoFullName, concepts] of conceptsByRepo) {
    const sorted = [...concepts].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        const entry = pairCount.get(key);
        if (entry) {
          entry.count += 1;
          entry.repos.push(repoFullName);
        } else {
          pairCount.set(key, {
            a: sorted[i],
            b: sorted[j],
            count: 1,
            repos: [repoFullName],
          });
        }
      }
    }
  }

  const max = Math.max(1, ...[...pairCount.values()].map((p) => p.count));
  for (const { a, b, count, repos } of pairCount.values()) {
    acc.addEdge({
      id: edgeId("RELATED_TO", conceptId(a), conceptId(b)),
      kind: "RELATED_TO",
      from: conceptId(a),
      to: conceptId(b),
      strength: round(count / max),
      sources: repos,
    });
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
