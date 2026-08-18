/**
 * ② 지식그래프 — Claude API 추출기 (명시적 opt-in 전용).
 *
 * ⚠ 프라이버시 (PLANNING.md §7): 이 추출기는 커밋 다이제스트와 README 발췌를
 * Anthropic API로 전송한다. `GRAPH_EXTRACTOR=claude`를 직접 설정한 경우에만 생성되며,
 * auto 모드는 ANTHROPIC_API_KEY가 있어도 절대 이 추출기를 고르지 않는다(selection.ts).
 *
 * 응답 형식은 tool use로 강제하고, 그래도 어긋나면 검증에서 걸러낸다.
 */
import Anthropic from "@anthropic-ai/sdk";

import {
  buildUserPrompt,
  validateExtraction,
  SYSTEM_PROMPT,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
} from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";

const TOOL_NAME = "emit_knowledge";

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          domain: { type: "string" },
          summary: { type: "string" },
        },
        required: ["name"],
      },
    },
    problems_solved: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          solution_summary: { type: "string" },
          tech_used: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
    learned_tech: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          first_applied_date: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  required: ["concepts", "problems_solved", "learned_tech"],
};

export class ClaudeExtractor implements Extractor {
  readonly name = "claude" as const;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "[graph] ClaudeExtractor: ANTHROPIC_API_KEY가 필요합니다 (외부 API 추출은 opt-in입니다)",
      );
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model ?? process.env.CLAUDE_EXTRACT_MODEL ?? DEFAULT_CLAUDE_MODEL;
  }

  async extractRepo(input: ExtractionInput): Promise<ExtractionResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
      tools: [
        {
          name: TOOL_NAME,
          description:
            "레포지토리에서 추출한 개념/해결한 문제/학습한 기술을 구조화해 제출한다.",
          input_schema: INPUT_SCHEMA,
        },
      ],
      // 스키마를 벗어난 자유 서술을 막는다.
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const block = response.content.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error("Claude 응답에 tool_use 결과가 없습니다");
    }
    return validateExtraction(block.input);
  }
}
