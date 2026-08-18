/**
 * ③ 인터랙티브 도서관 — 서재의 공기.
 *
 * 촛불 비네트(네 귀퉁이 은은한 호박빛) + 떠다니는 불티 몇 톨.
 * 전부 CSS(transform/opacity)로만 움직여 레이아웃을 밀지 않고,
 * 좌표는 index에서 결정론적으로 뽑아 SSR/CSR 결과가 어긋나지 않는다
 * (렌더 시점 Math.random 금지 — hydration mismatch의 원인).
 * prefers-reduced-motion이면 불티는 사라지고 비네트만 정지 상태로 남는다.
 */

/** 불티 수 — DOM을 가볍게 유지한다 */
const MOTE_COUNT = 16;

/** 황금비로 흩어 놓으면 규칙적이지 않으면서도 항상 같은 자리다 */
const GOLDEN = 0.6180339887;

interface Mote {
  left: number;
  top: number;
  size: number;
  drift: number;
  duration: number;
  delay: number;
  peak: number;
}

const MOTES: Mote[] = Array.from({ length: MOTE_COUNT }, (_, index) => {
  const spread = (index * GOLDEN) % 1;
  const wobble = (index * GOLDEN * 3) % 1;
  return {
    left: Math.round(spread * 9600) / 100, // 0~96vw
    top: Math.round((62 + wobble * 36) * 100) / 100, // 화면 아래쪽에서 피어오른다
    size: 1 + (index % 3),
    drift: Math.round((wobble * 120 - 60) * 10) / 10, // -60~60px 옆으로 흐른다
    duration: 16 + (index % 5) * 4.5,
    delay: -Math.round(spread * 2000) / 100, // 음수 지연 = 시작부터 흩어져 있다
    peak: 0.3 + wobble * 0.45,
  };
});

export function AmbientScene() {
  return (
    <div className="ambient-layer" aria-hidden>
      <div className="ambient-vignette" />
      {MOTES.map((mote, index) => (
        <span
          key={index}
          className="ambient-mote"
          style={
            {
              left: `${mote.left}vw`,
              top: `${mote.top}vh`,
              width: `${mote.size}px`,
              height: `${mote.size}px`,
              "--mote-drift": `${mote.drift}px`,
              "--mote-duration": `${mote.duration}s`,
              "--mote-delay": `${mote.delay}s`,
              "--mote-peak": mote.peak.toFixed(2),
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

export default AmbientScene;
