/**
 * ② 지식그래프 — 추출기 선택 (PLANNING.md §7 프라이버시 원칙의 집행 지점).
 *
 * GRAPH_EXTRACTOR = "none" | "ollama" | "claude" | "auto" (기본 auto)
 *
 *   auto   → Ollama가 떠 있으면 ollama, 아니면 none.
 *            **ANTHROPIC_API_KEY가 있어도 claude를 고르지 않는다.**
 *   none   → 정적 분석만. 오류가 아니라 정식 티어다.
 *   ollama → 로컬 Ollama. 연결 불가면 none으로 내려간다(사유 표시).
 *   claude → 사용자가 명시적으로 적어 넣은 경우에만. 커밋 다이제스트/README가
 *            Anthropic API로 전송된다.
 */
import type { ExtractorMode, ExtractorName } from "../types";
import { ClaudeExtractor } from "./claude";
import { isOllamaReachable, OllamaExtractor } from "./ollama";
import type { Extractor } from "./types";

export interface ExtractorSelection {
  /** 실제로 사용할 추출기 이름 */
  name: ExtractorName;
  /** name === "none"이면 null */
  extractor: Extractor | null;
  /** 왜 이렇게 결정됐는지 (UI/로그용, 한국어) */
  reason: string;
}

export type Env = Record<string, string | undefined>;

/** env 문자열 → 모드. 모르는 값은 auto로 본다. */
export function readMode(env: Env = process.env): ExtractorMode {
  const raw = (env.GRAPH_EXTRACTOR ?? "").trim().toLowerCase();
  if (raw === "none" || raw === "ollama" || raw === "claude" || raw === "auto") {
    return raw;
  }
  return "auto";
}

const NONE = (reason: string): ExtractorSelection => ({
  name: "none",
  extractor: null,
  reason,
});

export interface SelectOptions {
  /** Ollama 가용성 검사 (테스트에서 주입) */
  probeOllama?: (host: string) => Promise<boolean>;
}

export async function selectExtractor(
  env: Env = process.env,
  options: SelectOptions = {},
): Promise<ExtractorSelection> {
  const mode = readMode(env);
  const host = env.OLLAMA_HOST || "http://localhost:11434";
  const probe = options.probeOllama ?? ((h: string) => isOllamaReachable(h));

  if (mode === "none") {
    return NONE("GRAPH_EXTRACTOR=none — 정적 분석만으로 그래프를 만들었습니다.");
  }

  if (mode === "claude") {
    // 여기까지 오려면 사용자가 GRAPH_EXTRACTOR=claude를 직접 적어야 한다.
    if (!env.ANTHROPIC_API_KEY) {
      return NONE(
        "GRAPH_EXTRACTOR=claude 이지만 ANTHROPIC_API_KEY가 없어 정적 분석만 수행했습니다.",
      );
    }
    return {
      name: "claude",
      extractor: new ClaudeExtractor(
        env.ANTHROPIC_API_KEY,
        env.CLAUDE_EXTRACT_MODEL,
      ),
      reason:
        "GRAPH_EXTRACTOR=claude — 커밋 다이제스트와 README 발췌를 Anthropic API로 전송했습니다.",
    };
  }

  if (mode === "ollama") {
    if (await probe(host)) {
      return {
        name: "ollama",
        extractor: new OllamaExtractor(host, env.OLLAMA_MODEL),
        reason: `로컬 Ollama(${host})로 추출했습니다.`,
      };
    }
    return NONE(
      `Ollama(${host})에 연결할 수 없어 정적 분석만 수행했습니다. 컨테이너/데몬이 떠 있는지 확인하세요.`,
    );
  }

  // mode === "auto": 로컬이 가능하면 로컬, 아니면 정적. 외부 API는 후보가 아니다.
  if (await probe(host)) {
    return {
      name: "ollama",
      extractor: new OllamaExtractor(host, env.OLLAMA_MODEL),
      reason: `auto — 로컬 Ollama(${host})를 찾아 개념/문제 추출까지 수행했습니다.`,
    };
  }
  return NONE(
    "auto — 로컬 Ollama를 찾지 못해 정적 분석만 수행했습니다. (auto는 외부 API를 절대 선택하지 않습니다)",
  );
}
