/**
 * ③ 인터랙티브 도서관 — 마법서 등급(rarity).
 *
 * 쌓인 페이지(커밋) 수로 흔한 책 → 전설의 책까지 나눈다.
 * 게임의 아이템 등급처럼 액자 색만 달라지고 정보는 그대로다.
 */
export type Rarity = "common" | "rare" | "epic" | "legendary";

const THRESHOLDS: ReadonlyArray<{ min: number; rarity: Rarity }> = [
  { min: 600, rarity: "legendary" },
  { min: 200, rarity: "epic" },
  { min: 60, rarity: "rare" },
  { min: 0, rarity: "common" },
];

/** 등급별 상징색 — 석재 / 청색 / 보라 / 금색 */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#a8a29e",
  rare: "#60a5fa",
  epic: "#a78bfa",
  legendary: "#fbbf24",
};

export function rarityOf(commitCount: number): Rarity {
  return (
    THRESHOLDS.find((step) => commitCount >= step.min)?.rarity ?? "common"
  );
}

/**
 * 책 id에서 뽑는 아주 작은 기울기(±1.5deg).
 * 결정론적이라 SSR/CSR이 같고, 일부 책은 0deg로 반듯하게 선다.
 */
export function tiltOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 100000;
  }
  const bucket = hash % 7; // 0,1,2 → 반듯 / 나머지 → 좌우로 살짝
  if (bucket < 3) return 0;
  const magnitude = 0.5 + ((hash >> 3) % 3) * 0.5; // 0.5 / 1.0 / 1.5
  return bucket % 2 === 0 ? magnitude : -magnitude;
}
