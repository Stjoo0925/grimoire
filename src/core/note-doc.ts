/**
 * 노트의 검색 문서 칸과 경로 손질 — notes.ts(새 노트)와 capture.ts(마이그레이션의 옛 노트 정리)가 같이 쓴다.
 * db.ts를 부르지 않는 순수 함수로 따로 둔다(db.ts → capture.ts → notes.ts → db.ts 순환을 피한다).
 */
export const NOTE_TITLE_MAX = 120;

/** 제목은 첫 줄(넘치면 자름), 본문은 제목에 다 못 담긴 첫 줄 + 나머지 줄 + 태그 */
export function noteDocFields(text: string, tags: string): { title: string; body: string } {
  const [firstLine, ...rest] = text.split("\n");
  return {
    title: firstLine.slice(0, NOTE_TITLE_MAX),
    body: [firstLine.length > NOTE_TITLE_MAX ? firstLine : "", ...rest, tags].filter(Boolean).join("\n"),
  };
}

/** 묶기의 출처 — 사람이 준 경로(given), 본문에 적힌 경로(text), 작업 폴더의 바뀐 파일(auto). 추정(auto)은 그렇다고 보여야 한다 (docs/feature-audit.md F4) */
export type NoteBindHow = "given" | "text" | "auto";

/** 노트에 묶인 파일 하나 — blob은 묶을 때 HEAD에 있던 내용의 git blob(모르면 null). how가 없는 옛 노트는 given으로 읽는다 */
export interface NotePath {
  path: string;
  blob: string | null;
  how?: NoteBindHow;
}

/** 본문에서 레포 파일처럼 보이는 토큰 — 확장자가 붙은 낱말(폴더 구분자 포함 가능) */
const PATH_TOKEN = /[\w@-][\w@./-]*\.[A-Za-z][\w]{0,7}/g;

/** 경로를 레포 기준 posix 꼴로 — 역슬래시, 앞의 "./", 끝의 ":줄번호"를 뗀다 */
export function normalizeNotePath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(:\d+)?$/, "")
    .replace(/^\/+/, "");
}

/** 본문에 적힌 경로 중 이 레포에 있는 파일(known = code_files의 경로) */
export function pathsInText(text: string, known: Set<string>): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const candidate = normalizeNotePath(match[0]).replace(/[.,;:)]+$/, "");
    if (known.has(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

/** 본문에서 커밋 sha처럼 보이는 토큰(7~40자 16진수). 경로·낱말에 붙은 것은 빼고, 레포와 맞는지는 호출부(notes.ts)가 본다 */
const SHA_TOKEN = /(?<![\w./-])[0-9a-f]{7,40}(?![\w./-])/gi;
export function shasInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SHA_TOKEN)) {
    const token = match[0].toLowerCase();
    // 숫자만인 토큰(이슈 번호·타임스탬프)은 sha가 아니다
    if (/^\d+$/.test(token) || found.includes(token)) continue;
    found.push(token);
  }
  return found;
}

/** 검색 문서의 paths 칸 — 경로와 파일 이름(확장자 없이)을 함께 넣어 "search.ts"로도 "search"로도 걸리게 */
export function notePathsField(paths: NotePath[]): string {
  return paths.map((item) => `${item.path} ${item.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? ""}`).join(" ");
}

export function parseNotePaths(json: string | null | undefined): NotePath[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is NotePath => Boolean(item) && typeof (item as NotePath).path === "string") : [];
  } catch {
    return [];
  }
}
