/**
 * ② 지식그래프 — 로컬 Ollama 추출기 (기본 권장 티어).
 *
 * 데이터가 이 머신 밖으로 나가지 않는다 (PLANNING.md §7).
 * POST {OLLAMA_HOST}/api/chat, format:"json" — 실패하면 1회 교정 재시도.
 */
import {
  buildUserPrompt,
  parseLooseJson,
  validateExtraction,
  SYSTEM_PROMPT,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
} from "./types";

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b-instruct";

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaExtractor implements Extractor {
  readonly name = "ollama" as const;

  constructor(
    private readonly host: string = process.env.OLLAMA_HOST ||
      DEFAULT_OLLAMA_HOST,
    private readonly model: string = process.env.OLLAMA_MODEL ||
      DEFAULT_OLLAMA_MODEL,
  ) {}

  async extractRepo(input: ExtractionInput): Promise<ExtractionResult> {
    const userPrompt = buildUserPrompt(input);
    const first = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    try {
      return validateExtraction(parseLooseJson(first));
    } catch (error) {
      // 1회 교정 재시도 — 무엇이 잘못됐는지 알려주고 다시 받는다.
      const repaired = await this.chat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
        { role: "assistant", content: first.slice(0, 2000) },
        {
          role: "user",
          content: `위 응답이 형식에 맞지 않습니다 (${
            error instanceof Error ? error.message : "형식 오류"
          }). 설명 없이 concepts / problems_solved / learned_tech 키를 가진 JSON 객체 하나만 다시 출력하세요.`,
        },
      ]);
      return validateExtraction(parseLooseJson(repaired));
    }
  }

  private async chat(
    messages: { role: string; content: string }[],
  ): Promise<string> {
    const res = await fetch(`${this.host.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
      }),
      // 7B 모델이 CPU로 돌면 느리다 — 넉넉히 준다.
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as OllamaChatResponse;
    if (body.error) throw new Error(`Ollama: ${body.error}`);
    const content = body.message?.content;
    if (!content) throw new Error("Ollama 응답이 비어 있습니다");
    return content;
  }
}

/** Ollama가 지금 떠 있는지 빠르게 확인한다 (auto 모드 판정용) */
export async function isOllamaReachable(
  host: string = process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
