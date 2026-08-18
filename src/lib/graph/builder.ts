/**
 * ② 지식그래프(Brain) — 빌더.
 *
 * 스냅샷 → [결정론적 파이프라인] → (선택) [LLM 추출 병합] → KnowledgeGraph
 *
 * 결정론적 단계는 항상 돈다. 추출기는 env(GRAPH_EXTRACTOR)로 고르며,
 * "none"이어도 유효한 그래프가 나온다 (PLANNING.md §7·§8).
 */
import type { CollectionSnapshot, Repo } from "../collector/types";
import { buildCommitDigest, groupCommitsByRepo } from "./commits";
import { buildDeterministic, linkRelatedConcepts } from "./deterministic";
import { selectExtractor, type Env, type SelectOptions } from "./extractors/selection";
import type { Extractor, ExtractionInput } from "./extractors/types";
import { mergeExtraction } from "./merge";
import { techId, type KnowledgeGraph } from "./types";

/** LLM 추출 동시 실행 수 (로컬 7B 모델을 깔아뭉개지 않을 정도) */
const EXTRACT_CONCURRENCY = 3;
/** README는 앞부분만 넘긴다 */
const README_EXCERPT_CHARS = 1500;

export interface BuildOptions {
  env?: Env;
  /** 미리 정해둔 추출기 (테스트/CLI용). 주면 env 선택을 건너뛴다. */
  extractor?: Extractor | null;
  /** 추출기 선택 동작 조정 (Ollama 가용성 검사 주입 등) */
  select?: SelectOptions;
}

export interface BuildOutcome {
  graph: KnowledgeGraph;
  /** 어떤 추출기가 왜 선택됐는지 (UI 안내용) */
  reason: string;
}

export async function buildGraph(
  snapshot: CollectionSnapshot,
  options: BuildOptions = {},
): Promise<BuildOutcome> {
  const env = options.env ?? process.env;
  const { accumulator, conceptsByRepo, firstCommitByRepo } =
    buildDeterministic(snapshot);

  const selection =
    options.extractor !== undefined
      ? {
          name: options.extractor?.name ?? ("none" as const),
          extractor: options.extractor,
          reason: options.extractor
            ? `${options.extractor.name} 추출기로 보강했습니다.`
            : "정적 분석만으로 그래프를 만들었습니다.",
        }
      : await selectExtractor(env, options.select);

  let partial = snapshot.partial === true;
  let partialReason = snapshot.partial
    ? (snapshot.partialReason ?? "수집 스냅샷이 불완전합니다.")
    : undefined;

  if (selection.extractor) {
    const commitsByRepo = groupCommitsByRepo(snapshot.commits);
    const failed: string[] = [];

    await pooled(snapshot.repos, EXTRACT_CONCURRENCY, async (repo) => {
      const input = toExtractionInput(
        repo,
        buildCommitDigest(commitsByRepo.get(repo.fullName) ?? []),
        accumulator.nodeIds(),
      );
      // 커밋도 README도 없는 레포는 LLM에 물어볼 게 없다.
      if (!input.commitDigest && !input.readmeExcerpt) return;
      try {
        const result = await selection.extractor!.extractRepo(input);
        const concepts = conceptsByRepo.get(repo.fullName) ?? new Set<string>();
        conceptsByRepo.set(repo.fullName, concepts);
        mergeExtraction(
          accumulator,
          repo,
          result,
          concepts,
          firstCommitByRepo.get(repo.fullName) ?? repo.createdAt,
        );
      } catch (error) {
        // 레포 한 권이 실패해도 나머지 추출은 계속한다.
        console.error(`[graph] ${repo.fullName} 추출 실패`, error);
        failed.push(repo.fullName);
      }
    });

    if (failed.length > 0) {
      partial = true;
      partialReason ??= `${failed.length}개 레포의 LLM 추출이 실패했습니다 (${failed
        .slice(0, 3)
        .join(", ")}${failed.length > 3 ? " 외" : ""}).`;
    }

    // LLM이 새 Concept을 붙였으므로 공동 등장 관계를 다시 계산한다.
    linkRelatedConcepts(accumulator, conceptsByRepo);
  }

  const graph = accumulator.build({
    login: snapshot.login,
    extractorUsed: selection.name,
    partial,
    partialReason,
  });

  return { graph, reason: selection.reason };
}

function toExtractionInput(
  repo: Repo,
  commitDigest: string,
  nodeIds: string[],
): ExtractionInput {
  const prefix = techId("");
  const knownTech = nodeIds
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length));
  return {
    repoFullName: repo.fullName,
    repoName: repo.name,
    description: repo.description,
    primaryLanguage: repo.primaryLanguage,
    topics: repo.topics ?? [],
    knownTech,
    commitDigest,
    readmeExcerpt: repo.readme
      ? repo.readme.slice(0, README_EXCERPT_CHARS)
      : null,
  };
}

/** 간단한 동시 실행 풀 */
async function pooled<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

/** 특정 노드와 이어진 이웃 노드 id 목록 (책 하이라이트용) */
export function neighborsOf(graph: KnowledgeGraph, nodeId: string): string[] {
  return graph.edges
    .filter((e) => e.from === nodeId || e.to === nodeId)
    .map((e) => (e.from === nodeId ? e.to : e.from));
}
