/**
 * 커밋 메시지 트레일러 — 훅 없이도 생기는 "왜" (docs/enhancement-plan.md §3-3 0단계, §10-4).
 *
 * `git interpret-trailers`와 같은 규칙으로 메시지 **마지막 문단**의 `Key: value` 줄들을 읽는다. 키는 대소문자 무시,
 * 같은 키가 여러 번 나와도 되고, 값은 자유 문자열이다(Lore의 논문·CLI·스킬이 열거값을 서로 다르게 쓰므로 검증하지 않는다).
 * 허용 목록:
 *  - Lore: Constraint, Rejected(`대안 | 이유`), Directive(`[until:…]` 만료), Tested, Not-tested, Confidence, Scope-risk,
 *          Reversibility, Supersedes, Depends-on, Related, Lore-id
 *  - QAC: Agent, Mode, What, Why
 *  - 플랫폼: Claude-Session, Agent-Logs-Url, Agent-Conversation, Semantica-Checkpoint, Trace-Session, Co-Authored-By, Assisted-by
 * 모르는 키도 저장한다(Lore 규약상 무시되므로 무해). "왜"로 검색되는 것은 WHY_KEYS뿐이다.
 */

export interface Trailer {
  /** 소문자 키 */
  key: string;
  value: string;
}

const TRAILER_LINE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
/** 본문에 섞인 `Why:`처럼 보이는 줄을 트레일러로 오인하지 않게 — 마지막 문단의 모든 줄이 트레일러 꼴이어야 한다 */
const CONTINUATION = /^\s+\S/;

/** 커밋 본문(제목 제외) → 트레일러 목록. 마지막 문단이 전부 트레일러 꼴일 때만. */
export function parseTrailers(body: string): Trailer[] {
  const paragraphs = body.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  if (!last.trim()) return [];
  const out: Trailer[] = [];
  for (const line of last.split("\n")) {
    if (CONTINUATION.test(line) && out.length > 0) {
      out[out.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const match = TRAILER_LINE.exec(line.trimEnd());
    if (!match) return [];
    out.push({ key: match[1].toLowerCase(), value: match[2].trim() });
  }
  // 흔한 비트레일러 — "Note: …" 한 줄짜리 문단 같은 것. 알려진 키가 하나도 없으면서 줄이 하나면 믿지 않는다.
  if (out.length === 1 && !KNOWN_KEYS.has(out[0].key)) return [];
  return out;
}

export const WHY_KEYS = new Set(["why", "constraint", "rejected", "directive", "not-tested", "what"]);
export const VERIFY_KEYS = new Set(["tested"]);
export const KNOWN_KEYS = new Set([
  ...WHY_KEYS,
  ...VERIFY_KEYS,
  "confidence",
  "scope-risk",
  "reversibility",
  "supersedes",
  "depends-on",
  "related",
  "lore-id",
  "agent",
  "mode",
  "claude-session",
  "agent-logs-url",
  "agent-conversation",
  "semantica-checkpoint",
  "trace-session",
  "co-authored-by",
  "assisted-by",
  "signed-off-by",
  "reviewed-by",
]);

/** 에이전트가 만든 커밋인가 — 어떤 신호였는지 돌려준다 (없으면 null = 사람) */
export function agentSignal(trailers: Trailer[]): string | null {
  for (const trailer of trailers) {
    if (trailer.key === "co-authored-by" && /\bclaude\b/i.test(trailer.value)) return "co-authored-by";
    if (trailer.key === "claude-session") return "claude-session";
    if (trailer.key === "agent-logs-url") return "agent-logs-url";
    if (trailer.key === "agent" && trailer.value) return "agent";
    if (trailer.key === "assisted-by") return "assisted-by";
    if (trailer.key === "semantica-checkpoint" || trailer.key === "trace-session" || trailer.key === "agent-conversation") return trailer.key;
  }
  return null;
}

/** 검색 본문에 덧붙일 "왜" 문장들 */
export function whyLines(trailers: Trailer[]): string[] {
  return trailers.filter((trailer) => WHY_KEYS.has(trailer.key) && trailer.value).map((trailer) => `${trailer.key}: ${trailer.value}`);
}
