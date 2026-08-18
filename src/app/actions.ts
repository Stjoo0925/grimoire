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
    await saveGraph(graph);
    revalidatePath("/", "layout");

    const summary = summarizeGraph(graph);
    return {
      ok: true,
      message: `${t("success", {
        nodes: summary.nodeTotal,
        edges: summary.edgeTotal,
      })} ${reason}`,
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

  const context = buildLibrarianContext(graph, trimmed);
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

export async function signOutAction(): Promise<void> {
  const locale = await getLocale();
  await signOut({ redirectTo: `/${locale}` });
}
