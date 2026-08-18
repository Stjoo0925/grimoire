/**
 * ③ 인터랙티브 도서관 — 책등 색 (주 언어 = 마법 계열).
 *
 * 알려진 언어는 고정 색을, 모르는 언어는 이름 해시로 결정론적 HSL을 준다.
 * (같은 언어는 언제나 같은 색 — 새로고침해도 서가가 흔들리지 않는다)
 */

/** 주요 언어 고정 색 — GitHub 언어 색 계열을 어두운 서재 톤에 맞춰 쓴다 */
export const LANGUAGE_COLORS: Record<string, string> = {
  typescript: "#3178c6",
  javascript: "#c9a227",
  python: "#3776ab",
  java: "#b07219",
  kotlin: "#a97bff",
  swift: "#f05138",
  go: "#00add8",
  rust: "#c56d3f",
  c: "#6a737d",
  "c++": "#f34b7d",
  "c#": "#178600",
  php: "#7a7fb8",
  ruby: "#8f2f30",
  dart: "#00b4ab",
  html: "#c1502e",
  css: "#7a4fbf",
  scss: "#b7527f",
  vue: "#41b883",
  svelte: "#ff3e00",
  shell: "#4f8a4f",
  powershell: "#2f5f9e",
  dockerfile: "#2496ed",
  lua: "#2c2d72",
  scala: "#b8352a",
  elixir: "#5b4177",
  haskell: "#5e5086",
  r: "#276dc3",
  "objective-c": "#438eff",
  "jupyter notebook": "#a3612b",
  makefile: "#5c7d5c",
  "vim script": "#199f4b",
  solidity: "#5b6069",
  zig: "#c47b2b",
  perl: "#4a5f8a",
};

/** 언어를 모를 때(=null) 쓰는 무채색 책등 */
export const UNKNOWN_LANGUAGE_COLOR = "#57534e";

/** 문자열 → 32bit 해시 (djb2 변형, 결정론적) */
function hash(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * 주 언어 → 책등 색.
 * 고정 표에 없으면 이름 해시로 HSL을 만든다 (채도·명도는 어두운 서재 톤 안에 가둔다).
 */
export function languageColor(language: string | null | undefined): string {
  if (!language) return UNKNOWN_LANGUAGE_COLOR;
  const key = language.trim().toLowerCase();
  if (!key) return UNKNOWN_LANGUAGE_COLOR;
  const known = LANGUAGE_COLORS[key];
  if (known) return known;
  const h = hash(key);
  const hue = h % 360;
  const saturation = 32 + (h % 23); // 32~54%
  const lightness = 34 + ((h >> 3) % 12); // 34~45%
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
