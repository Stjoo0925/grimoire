/**
 * 업데이트 뒤 Claude Code 연동을 이 버전에 맞추는 자동 갱신 — `grimoire setup-refresh`.
 *
 * `grimoire update`는 옛 버전의 코드가 돌아 새 버전의 훅 이벤트·matcher나 스킬을 쓰지 못한다. 그래서 새 버전의 SessionStart 훅이
 * 낡은 설정을 알아보면(hook-config.ts의 setupNeeded — 가볍게, 훅 안에서) 이 명령을 떼어 낸 프로세스로 띄운다(hook.ts). 다음 세션부터 새 설정이 쓰인다.
 *
 * - 훅을 설치한 사용자(Claude Code 연동을 고른 사용자)만 대상이다. 훅 명령은 지금 설치의 hook.js와, 설치 때 적힌 환경 변수 그대로.
 * - 스킬도 함께 넣는다. 사용자가 --remove-skills로 뺀 적이 있으면 넣지 않는다(skills.ts의 표시 파일).
 * - `GRIMOIRE_AUTO_SETUP=0`이면 하지 않는다.
 */
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";
import { readInstalledHooks, settingsPath } from "./hook-config";
import { hookCommandEnv, installHooks } from "./hooks";
import { installSkill } from "./skills";

export interface RefreshResult {
  hooks: "updated" | "unchanged" | "skipped";
  skill: "installed" | "unchanged" | "skipped";
}

/** 낡은 훅 설정을 이 버전으로 다시 쓰고 스킬을 넣는다. 훅이 없으면(연동을 고르지 않았으면) 아무것도 하지 않는다 */
export async function refreshIntegrations(options: { cliDir: string; env?: Env; home?: string }): Promise<RefreshResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const installed = readInstalledHooks(settingsPath(home));
  if (env.GRIMOIRE_AUTO_SETUP === "0" || installed.length === 0) return { hooks: "skipped", skill: "skipped" };
  // 훅 명령의 환경 변수는 설치 때 적힌 것 그대로 — 이 프로세스의 환경(떼어 낸 프로세스가 받은 GRIMOIRE_UPDATE_CHECK=0 등)을 섞지 않는다
  const hooks = await installHooks({ hookPath: path.join(options.cliDir, "hook.js"), env: hookCommandEnv(installed[0].command), home });
  const skill = installSkill({ home, auto: true });
  return { hooks: hooks.unchanged ? "unchanged" : "updated", skill: skill.unchanged ? "unchanged" : "installed" };
}
