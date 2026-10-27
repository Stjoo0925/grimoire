/**
 * 노트의 검색 문서 칸 — notes.ts(새 노트)와 capture.ts(마이그레이션 8의 옛 노트 정리)가 같이 쓴다.
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
