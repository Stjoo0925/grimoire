/**
 * 경로와 환경 설정.
 *
 * 상태는 전부 `GRIMOIRE_HOME`(기본 `~/.grimoire`) 아래 SQLite 파일 하나에 있다.
 * 외부 요청은 하루 한 번의 업데이트 확인뿐이다(update.ts, 끌 수 있음).
 */
import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

export function grimoireHome(env: Env = process.env): string {
  const configured = env.GRIMOIRE_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".grimoire");
}

export function dbPath(env: Env = process.env): string {
  return path.join(grimoireHome(env), "grimoire.db");
}
