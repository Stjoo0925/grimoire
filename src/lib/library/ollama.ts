/**
 * ③ AI 사서 — 로컬 Ollama 호출 (외부 API 금지, PLANNING.md §7).
 *
 * 추출기(lib/graph/extractors/ollama.ts)와 같은 엔드포인트를 쓰지만
 * 사서 응답은 JSON이 아니라 사람의 문장이므로 format:"json"을 걸지 않고,
 * 토큰도 적게 뽑는다(빠른 대화). 닿지 않으면 null — 호출부가 degraded 모드로 간다.
 */
import { getOllamaModel, resolveOllamaHost } from "../settings";

/** 사서 답변 최대 토큰 (짧고 빠르게) */
const MAX_TOKENS = 400;
/** CPU 추론도 감안한 응답 대기 상한 */
const TIMEOUT_MS = 90_000;

export interface LibrarianChatResult {
  ok: boolean;
  text: string | null;
  /** 실패 사유 (로그·디버깅용, 화면 문구는 i18n에서 만든다) */
  reason?: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export function ollamaHost(): string {
  return resolveOllamaHost();
}

/**
 * 사서가 쓸 모델. 화면에서 고른 값(data/settings.json)이 최우선이고
 * 그다음이 OLLAMA_MODEL env, 마지막이 기본값이다 (lib/settings.ts).
 */
export function ollamaModel(): Promise<string> {
  return getOllamaModel();
}

/** 로컬 Ollama에 한 번 물어본다. 닿지 않거나 실패하면 ok:false */
export async function askOllama(
  systemPrompt: string,
  userPrompt: string,
): Promise<LibrarianChatResult> {
  try {
    const model = await ollamaModel();
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        // 사서는 창작이 아니라 자료 요약이다 — 낮은 온도로 교차 환각을 줄인다.
        options: { temperature: 0.1, num_predict: MAX_TOKENS },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, text: null, reason: `Ollama ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as OllamaChatResponse;
    if (body.error) return { ok: false, text: null, reason: body.error };
    const text = body.message?.content?.trim();
    if (!text) return { ok: false, text: null, reason: "빈 응답" };
    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      text: null,
      reason: error instanceof Error ? error.message : "연결 실패",
    };
  }
}
