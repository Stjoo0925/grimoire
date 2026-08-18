/**
 * ③ 관찰형 게임 — 사서 NPC의 일과표 (순수 로직).
 *
 * 사서는 서재를 돌아다니며 일한다: 최근에 페이지(커밋)가 늘어난 책을
 * 서가에 꽂고, 한가할 땐 먼지를 털거나 아무 책이나 꺼내 훑는다.
 * 여기서는 "무엇을 어떤 순서로 할지"만 결정론적으로 만든다 —
 * 걷기·타이밍·연출은 컴포넌트(NPCLibrarian)가 맡는다.
 * 난수·현재시각 없음: 같은 서재면 언제나 같은 일과다.
 */

export type NpcTaskType = "shelve" | "dust" | "browse";

export interface NpcTask {
  type: NpcTaskType;
  /** 대상 책 (BookView.id / data-book-id) */
  bookId: string;
  /** 말풍선에 띄울 근거 — shelve면 커밋 첫 줄 */
  note?: string;
}

/** 일과표에 넣을 최근 집필(shelve) 수 */
export const SHELVE_TASKS = 10;
/** 한가한 일(dust/browse) 수 */
export const IDLE_TASKS = 8;

/** 황금비 — 규칙적이지 않아 보이지만 항상 같은 순서를 만든다 */
const GOLDEN = 0.6180339887;

/** npc.ts가 BookView 전체를 몰라도 되도록 필요한 조각만 받는다 */
export interface NpcBookInput {
  id: string;
  name: string;
  lastCommitAt: string | null;
  recentCommits: Array<{ date: string; message: string }>;
  commitCount: number;
}

/**
 * 서재 → 사서의 일과표.
 * 1) 최근 집필된 책 순서로 shelve (커밋 첫 줄을 들고 간다)
 * 2) 사이사이에 dust/browse를 황금비 간격으로 끼워 넣어 단조로움을 깬다
 */
export function buildNpcScript(books: NpcBookInput[]): NpcTask[] {
  const byRecent = books
    .filter((book) => book.lastCommitAt !== null)
    .sort((a, b) => (b.lastCommitAt! < a.lastCommitAt! ? -1 : 1))
    .slice(0, SHELVE_TASKS);

  const shelves: NpcTask[] = byRecent.map((book) => ({
    type: "shelve",
    bookId: book.id,
    note: book.recentCommits[0]?.message,
  }));

  // 한가한 일 대상: 전체 책에서 황금비로 고르게 뽑는다 (shelve 대상과 겹쳐도 무방)
  const idle: NpcTask[] = [];
  if (books.length > 0) {
    for (let i = 0; i < IDLE_TASKS; i++) {
      const pick = Math.floor(((i + 1) * GOLDEN * books.length) % books.length);
      idle.push({
        type: i % 2 === 0 ? "dust" : "browse",
        bookId: books[pick].id,
      });
    }
  }

  // 교차 배치: shelve 2개마다 한가한 일 1개 — 일하는 사서처럼 보이게
  const script: NpcTask[] = [];
  let idleIndex = 0;
  shelves.forEach((task, index) => {
    script.push(task);
    if (index % 2 === 1 && idleIndex < idle.length) {
      script.push(idle[idleIndex++]);
    }
  });
  while (idleIndex < idle.length) script.push(idle[idleIndex++]);

  return script;
}

/** 걷는 거리(px) → 걸리는 시간(ms). 최소·최대를 물려 게임답게 일정한 보폭. */
export function walkDuration(distancePx: number): number {
  const SPEED = 90; // px/s — 서두르지 않는 사서
  return Math.min(6000, Math.max(600, Math.round((distancePx / SPEED) * 1000)));
}

/** 작업 종류별 머무는 시간(ms) — 연출 길이와 맞춘다 */
export const TASK_DWELL: Record<NpcTaskType, number> = {
  shelve: 2600,
  dust: 1900,
  browse: 3200,
};

/** 다음 일 전 잠깐의 숨 고르기(ms) */
export const TASK_PAUSE = 900;
