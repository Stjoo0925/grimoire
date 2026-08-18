"use server";

/**
 * 서버 액션 — 수집(collect)·그래프 생성 트리거와 로그아웃.
 * 토큰은 서버 세션에서만 읽어 GitHub API 호출에 쓰고, 클라이언트로 넘기지 않는다.
 */
import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";

import { auth, signOut } from "@/auth";
import { collectAll } from "@/lib/collector/github";
import { loadSnapshot, saveSnapshot } from "@/lib/collector/storage";
import type { CollectResult } from "@/lib/collector/types";
import { buildGraph } from "@/lib/graph/builder";
import { attachEmbeddings } from "@/lib/graph/embeddings";
import { loadGraph, saveGraph } from "@/lib/graph/storage";
import { summarizeGraph, type GraphBuildResult } from "@/lib/graph/types";
import {
  buildLibrarianContext,
  buildLibrarianPrompt,
  matchProjectMentions,
  LIBRARIAN_SYSTEM_PROMPT,
  type LibrarianAnswer,
} from "@/lib/library/librarian";
import { askOllama } from "@/lib/library/ollama";
import {
  isValidModelName,
  loadSettings,
  parseTagsResponse,
  resolveOllamaHost,
  resolveOllamaModel,
  saveSettings,
  type ModelActionResult,
  type ModelOptionsResult,
} from "@/lib/settings";

/** useActionState 시그니처 — 이전 상태와 폼 데이터는 쓰지 않는다. */
export async function collectAction(
  _prev: CollectResult | null,
  _formData: FormData,
): Promise<CollectResult> {
  void _prev;
  void _formData;

  const t = await getTranslations("collect");

  const session = await auth();
  const token = session?.accessToken;
  if (!token) {
    return { ok: false, message: t("sessionExpired") };
  }

  try {
    // login을 넘기지 않으면 collectAll이 GET /user로 직접 확인한다.
    const snapshot = await collectAll({
      accessToken: token,
      login: session.login,
    });
    await saveSnapshot(snapshot);
    revalidatePath("/");

    return {
      ok: true,
      message: snapshot.partial
        ? (snapshot.partialReason ?? t("partialDefault"))
        : t("success", { count: snapshot.stats.repoCount }),
    };
  } catch (error) {
    console.error("[collector] 수집 실패", error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? t("failure", { message: error.message })
          : t("failureGeneric"),
    };
  }
}

/**
 * 소장된 스냅샷 → 지식그래프.
 * GitHub API는 건드리지 않는다 (읽는 것은 `data/{login}.json` 뿐).
 * 추출기는 GRAPH_EXTRACTOR env로 결정되며, "none"이어도 정상 결과다.
 */
export async function buildGraphAction(
  _prev: GraphBuildResult | null,
  _formData: FormData,
): Promise<GraphBuildResult> {
  void _prev;
  void _formData;

  const t = await getTranslations("graph");

  const session = await auth();
  const login = session?.login;
  if (!login) {
    return { ok: false, message: t("sessionExpired") };
  }

  try {
    const snapshot = await loadSnapshot(login);
    if (!snapshot) {
      return { ok: false, message: t("noSnapshot") };
    }

    // MCP(record_new_learning)로 손수 적어 넣은 노드는 재빌드에서도 살린다.
    const previous = await loadGraph(login);
    const { graph, reason } = await buildGraph(snapshot, { preserve: previous });

    // 5-a: 노드 임베딩은 **선택적 보강**이다 — 로컬 임베딩 모델이 없으면
    // 벡터 없이 그대로 저장되고 검색은 키워드로만 동작한다 (PLANNING.md §6·§7).
    const embeddings = await attachEmbeddings(graph, { previous });
    if (!embeddings.ok) {
      console.warn("[graph] 임베딩 생략 —", embeddings.reason);
    }

    await saveGraph(graph);
    revalidatePath("/", "layout");

    const summary = summarizeGraph(graph);
    // 추출기 사유(builder.ts)와 같은 결로 임베딩 결과도 한 문장 덧붙인다.
    const embedNote = embeddings.ok
      ? `의미 검색 벡터 ${embeddings.embedded + embeddings.reused}개를 ${embeddings.model}로 만들었습니다.`
      : "로컬 임베딩 모델에 닿지 못해 키워드 검색만 됩니다 (nomic-embed-text 내려받기 후 다시 생성).";
    return {
      ok: true,
      message: `${t("success", {
        nodes: summary.nodeTotal,
        edges: summary.edgeTotal,
      })} ${reason} ${embedNote}`,
    };
  } catch (error) {
    console.error("[graph] 그래프 생성 실패", error);
    return {
      ok: false,
      message:
        error instanceof Error
          ? t("failure", { message: error.message })
          : t("failureGeneric"),
    };
  }
}

/** 사서 질문 1회 길이 상한 (프롬프트 폭주 방지) */
const LIBRARIAN_QUESTION_MAX = 500;

/**
 * ③ AI 사서 — 질문 하나에 답한다.
 *
 * 그래프 키워드 검색 → 압축 컨텍스트 → 로컬 Ollama 합성.
 * Ollama가 없으면 검색 결과를 그대로 돌려주는 degraded 모드로 내려간다.
 * 외부 LLM API는 어떤 경우에도 부르지 않는다 (PLANNING.md §7).
 */
export async function askLibrarianAction(
  question: string,
): Promise<LibrarianAnswer> {
  const [t, locale] = await Promise.all([
    getTranslations("library"),
    getLocale(),
  ]);
  const trimmed = question.trim().slice(0, LIBRARIAN_QUESTION_MAX);

  const empty = (message: string): LibrarianAnswer => ({
    ok: false,
    question: trimmed,
    answer: null,
    degraded: false,
    items: [],
    projectIds: [],
    message,
  });

  if (!trimmed) return empty(t("chat.emptyQuestion"));

  const session = await auth();
  const login = session?.login;
  if (!login) return empty(t("chat.sessionExpired"));

  const graph = await loadGraph(login);
  if (!graph) return empty(t("chat.noGraph"));

  const context = await buildLibrarianContext(graph, trimmed);
  if (context.items.length === 0) {
    return {
      ok: true,
      question: trimmed,
      answer: null,
      degraded: false,
      items: [],
      projectIds: [],
      message: t("chat.noMatch"),
    };
  }

  const result = await askOllama(
    LIBRARIAN_SYSTEM_PROMPT,
    buildLibrarianPrompt(trimmed, context, locale),
  );

  if (!result.ok || !result.text) {
    console.warn("[librarian] 로컬 Ollama 사용 불가 —", result.reason);
    return {
      ok: true,
      question: trimmed,
      answer: null,
      degraded: true,
      items: context.items,
      projectIds: context.projectIds,
      message: t("chat.degraded"),
    };
  }

  return {
    ok: true,
    question: trimmed,
    answer: result.text,
    degraded: false,
    items: context.items,
    projectIds: matchProjectMentions(result.text, context),
    message: null,
  };
}

/* ── 로컬 LLM 모델 설정 ───────────────────────────────────────── */

/** 설치 목록 조회는 화면을 붙잡지 않는다 — 닿지 않으면 곧바로 "꺼짐"으로 본다. */
const TAGS_TIMEOUT_MS = 1_500;
/**
 * `ollama pull`은 stream:false면 다운로드가 끝날 때까지 응답이 오지 않는다.
 * 14B(약 9GB)는 회선에 따라 수십 분이 걸리므로 상한을 크게 잡고,
 * 화면은 그동안 "내려받는 중" pending 상태를 계속 보여 준다.
 */
const PULL_TIMEOUT_MS = 30 * 60_000;

/**
 * 설치된 로컬 모델 목록 + 지금 쓰이는 모델 + Ollama 연결 여부.
 * 외부로 나가는 요청은 없다 — 부르는 곳은 로컬 Ollama뿐이다 (PLANNING.md §7).
 */
export async function getModelOptionsAction(): Promise<ModelOptionsResult> {
  const t = await getTranslations("settings");
  const host = resolveOllamaHost();

  const session = await auth();
  if (!session?.login) {
    return {
      reachable: false,
      host,
      current: resolveOllamaModel(null),
      fromSettings: false,
      models: [],
      message: t("sessionExpired"),
    };
  }

  const settings = await loadSettings();
  const current = resolveOllamaModel(settings);
  const fromSettings = isValidModelName(settings.ollamaModel);

  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const models = parseTagsResponse(await res.json());
    return {
      reachable: true,
      host,
      current,
      fromSettings,
      models,
      message: models.length === 0 ? t("installedEmpty") : null,
    };
  } catch {
    return {
      reachable: false,
      host,
      current,
      fromSettings,
      models: [],
      message: t("offline"),
    };
  }
}

/** 쓸 모델을 골라 `data/settings.json`에 적는다. 다음 질문·다음 그래프 생성부터 적용. */
export async function setModelAction(model: string): Promise<ModelActionResult> {
  const t = await getTranslations("settings");

  const session = await auth();
  if (!session?.login) {
    return { ok: false, current: null, message: t("sessionExpired") };
  }

  const trimmed = model.trim();
  if (!isValidModelName(trimmed)) {
    return { ok: false, current: null, message: t("invalidModel") };
  }

  try {
    const saved = await saveSettings({ ollamaModel: trimmed });
    revalidatePath("/", "layout");
    return {
      ok: true,
      current: resolveOllamaModel(saved),
      message: t("saved", { model: trimmed }),
    };
  } catch (error) {
    console.error("[settings] 모델 저장 실패", error);
    return { ok: false, current: null, message: t("saveFailed") };
  }
}

/**
 * 로컬 Ollama에 모델을 내려받는다 (`POST /api/pull`, stream:false).
 *
 * Ollama가 다운로드를 끝낼 때까지 응답을 붙잡고 있으므로 수 분~수십 분이 걸린다.
 * 모델 태그는 안전 패턴을 통과한 값만 넘긴다.
 */
export async function pullModelAction(model: string): Promise<ModelActionResult> {
  const t = await getTranslations("settings");

  const session = await auth();
  if (!session?.login) {
    return { ok: false, current: null, message: t("sessionExpired") };
  }

  const trimmed = model.trim();
  if (!isValidModelName(trimmed)) {
    return { ok: false, current: null, message: t("invalidModel") };
  }

  const host = resolveOllamaHost();
  try {
    const res = await fetch(`${host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: trimmed, stream: false }),
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        current: null,
        message: t("pullFailed", { model: trimmed }),
      };
    }
    const body = (await res.json()) as { status?: string; error?: string };
    if (body.error) {
      return {
        ok: false,
        current: null,
        message: t("pullFailed", { model: trimmed }),
      };
    }
  } catch (error) {
    console.error("[settings] 모델 내려받기 실패", error);
    return { ok: false, current: null, message: t("offline") };
  }

  // 받아 놨으면 바로 그 모델을 쓰게 한다.
  return setModelAction(trimmed);
}

export async function signOutAction(): Promise<void> {
  const locale = await getLocale();
  await signOut({ redirectTo: `/${locale}` });
}
