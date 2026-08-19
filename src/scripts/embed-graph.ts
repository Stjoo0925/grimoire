/**
 * 헤드리스 CLI — 소장된 지식그래프에 로컬 임베딩을 굽는다 (5-a).
 *
 * 웹 "그래프 생성하기"의 임베딩 단계만 로그인 세션 없이 실행한다. LLM 재추출은
 * 하지 않으므로 이미 만들어 둔 그래프(개념·문제)를 건드리지 않고, 노드 벡터만
 * 채워 넣는다. 임베딩은 순차 배치(64개)라 keep-alive·동시성 문제와 무관하다.
 *
 * 그래프 자체를 처음부터 다시 굽는 것은 웹 UI "그래프 생성하기"를 쓴다
 * (배치 LLM 추출은 OLLAMA_KEEP_ALIVE를 양수로 둔 환경에서 실행할 것).
 */
import { attachEmbeddings } from "../lib/graph/embeddings";
import { loadGraph, saveGraph } from "../lib/graph/storage";

async function main() {
  const login = process.env.GRIMOIRE_LOGIN || "Stjoo0925";
  const graph = await loadGraph(login);
  if (!graph) {
    console.error(`[embed] 그래프 없음: ${login} — 먼저 그래프를 생성하세요.`);
    process.exit(1);
  }

  const before = graph.nodes.filter((n) => Array.isArray(n.embedding)).length;
  console.log(
    `[embed] ${login} — 노드 ${graph.nodes.length} · 엣지 ${graph.edges.length} · 기존 벡터 ${before}`,
  );

  const outcome = await attachEmbeddings(graph);
  if (!outcome.ok) {
    console.error(`[embed] 임베딩 실패 — ${outcome.reason}`);
    console.error(
      "  로컬 임베딩 모델을 확인하세요: docker exec grimoire-ollama ollama pull nomic-embed-text",
    );
    process.exit(1);
  }

  console.log(
    `[embed] 임베딩 OK — 모델 ${outcome.model} · 신규 ${outcome.embedded} · 재사용 ${outcome.reused}`,
  );
  const file = await saveGraph(graph);
  console.log(`[embed] 저장: ${file}`);
}

main().catch((error) => {
  console.error("[embed] 실패", error);
  process.exit(1);
});
