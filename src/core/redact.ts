/**
 * 저장 전 비밀 제거 — 세션 캡처(capture.ts)가 사용자 프롬프트·명령을 DB에 넣기 전에 거친다 (docs/enhancement-plan.md §3-3).
 *
 * 지우는 것: `<private>…</private>` 구간, 붙여 넣은 블록(`<pasted_content>`), 토큰·키 꼴, `password=…` 류의 값.
 * 보수적으로 — 의심스러우면 지운다. 규칙은 여기 한 곳에만 있고 단위 테스트가 고정한다.
 */

const BLOCKS: RegExp[] = [
  /<private>[\s\S]*?<\/private>/gi,
  /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 그 자체로 비밀인 토큰 꼴 */
const TOKENS: RegExp[] = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
];

/** `password=…`, `token: …`, `--api-key …` — 값만 지운다 */
const ASSIGNMENTS = /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential)s?\b(\s*[=:]\s*|\s+)(["']?)([^\s"',;]{4,})\3/gi;

export const REDACTED = "[redacted]";

export function redact(text: string): string {
  let out = text;
  for (const block of BLOCKS) out = out.replace(block, REDACTED);
  for (const token of TOKENS) out = out.replace(token, REDACTED);
  out = out.replace(ASSIGNMENTS, (_, key: string, sep: string) => `${key}${sep.trim() ? sep : " "}${REDACTED}`);
  return out;
}

/** 지운 자리가 있는가 (테스트·로그용) */
export function wasRedacted(original: string, redacted: string): boolean {
  return original !== redacted;
}
