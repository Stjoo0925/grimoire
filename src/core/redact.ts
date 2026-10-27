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
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, // Slack 웹훅 URL 자체가 비밀
];

/**
 * `password=…`, `token: …`, `--api-key …`, `OPENAI_API_KEY=…`, `DB_PASSWORD=…` — 값만 지운다.
 * 이름 앞에 `OPENAI_`·`db-` 같은 접두가 붙어도 잡는다(`_`는 낱말 글자라 `\b`만으로는 `_API_KEY`의 경계가 안 생긴다) —
 * 접두를 매칭하지 않고 "바로 앞이 영숫자가 아님"만 본다. 접두를 `(…[_-])*`로 매칭하면 긴 `ab-cd-…`에서 역추적이
 * 제곱으로 늘어 60KB 프롬프트 하나에 1.3초가 걸렸다(훅 예산 초과).
 */
const ASSIGNMENTS =
  /(?<![A-Za-z0-9])(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential)s?\b(\s*[=:]\s*|\s+)(["']?)([^\s"',;]{4,})\3/gi;

/**
 * `scheme://user:비밀번호@host` — 연결 문자열의 비밀번호만 지운다. scheme 길이에 상한을 둔다 — 없으면 긴 `ab-cd-…`를
 * 낱말 경계마다 끝까지 훑어 제곱 시간이 된다.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]+):([^\s@/]+)@/gi;

export const REDACTED = "[redacted]";

export function redact(text: string): string {
  let out = text;
  for (const block of BLOCKS) out = out.replace(block, REDACTED);
  for (const token of TOKENS) out = out.replace(token, REDACTED);
  out = out.replace(URL_CREDENTIALS, (_, head: string) => `${head}:${REDACTED}@`);
  out = out.replace(ASSIGNMENTS, (match: string, key: string, sep: string, quote: string, value: string) => {
    // 공백으로만 띄운 꼴("token rotation", "auth middleware", "Token Reduction")은 평범한 말이기 쉽다 — 프롬프트의 "왜"가
    // 망가지지 않게, 값이 비밀처럼 보일 때(따옴표로 감쌈, 글자·숫자 섞임, 아주 김)만 지운다. `=`·`:`로 붙인 값은 늘 지운다
    if (!sep.trim() && !quote && !looksSecret(value)) return match;
    return `${key}${sep.trim() ? sep : " "}${REDACTED}`;
  });
  return out;
}

/** 공백 뒤의 낱말이 비밀값처럼 보이는가 — 글자와 숫자가 섞였거나(hunter22, abcd1234), 24자 이상 */
function looksSecret(value: string): boolean {
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || value.length >= 24;
}

/** 지운 자리가 있는가 (테스트·로그용) */
export function wasRedacted(original: string, redacted: string): boolean {
  return original !== redacted;
}
