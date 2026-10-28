/**
 * `grimoire install claude-code --skills` — Claude Code 스킬을 `~/.claude/skills/grimoire-impact/SKILL.md`에 쓴다.
 * `grimoire install codex|cursor --skills` — 같은 스킬을 `~/.agents/skills/grimoire-impact/SKILL.md`에 쓴다(Codex·Cursor가 읽는 곳).
 *
 * 훅이 자동으로 끼어드는 것과 달리, 에이전트가 "커밋 전·리뷰·PR" 같은 때에 `impact`를 부르게 하는 명시적 진입점이다.
 * 쓰는 것은 그 폴더 하나뿐이다 — `~/.claude`의 다른 것은 건드리지 않는다. 내용이 다를 때만 `.bak`을 남기고 덮는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Env } from "../core/config";

export const SKILL_NAME = "grimoire-impact";

/**
 * 이 버전이 쓰는 SKILL.md — doctor가 설치된 것과 비교한다.
 * 설명은 단정형이어야 한다: "Use before committing…"으로는 "커밋해 줘"에서 0/4번 골랐고, "MANDATORY before every git commit…"으로는
 * 3/3번 골라 impact를 불렀다(실제 Claude, 2026-10-28). 대가는 커밋당 약 6~8턴·$0.04.
 */
export const SKILL_CONTENT = `---
name: ${SKILL_NAME}
description: MANDATORY before every git commit in this repository — run it right before you commit, even for small changes, and whenever you review a diff, open a PR, or the user asks "did I miss anything". Lists other files this change likely needs, from git history (grimoire impact).
---

# Impact check before you commit

Run this once per commit, when the change is ready, not while you are still editing.

1. Call the MCP tool \`mcp__grimoire__impact\`. If its schema is not loaded (deferred tool), load it with ToolSearch first.
   - Omit \`paths\` to use the uncommitted changes, or pass the files in question.
   - Set \`intent\` to the user's task in one plain sentence.
2. Read the ranked candidates and their reasons. Open only the top ones that plausibly relate to the task.
3. For each opened file decide whether the task needs a change there. Then say which files you checked and why, and why you left the others alone.

Rules:
- The list is candidates, not instructions. Never edit a file just because it is listed.
- One call per commit. Do not call it again after every small edit.
- If the tool returns nothing useful or is unavailable, say so in one line and continue.
`;

/**
 * Codex·Cursor용 — 같은 단정형 설명에, 도구 이름이 클라이언트마다 달라 MCP 도구를 이름 대신 서버·도구로 가리키고 CLI를 대안으로 둔다.
 * Claude Code용(SKILL_CONTENT)은 실제로 검증한 문구라 그대로 둔다.
 */
export const AGENTS_SKILL_CONTENT = `---
name: ${SKILL_NAME}
description: MANDATORY before every git commit in this repository — run it right before you commit, even for small changes, and whenever you review a diff, open a PR, or the user asks "did I miss anything". Lists other files this change likely needs, from git history (grimoire impact).
---

# Impact check before you commit

Run this once per commit, when the change is ready, not while you are still editing.

1. Call the \`impact\` tool of the \`grimoire\` MCP server.
   - Omit \`paths\` to use the uncommitted changes, or pass the files in question.
   - Set \`intent\` to the user's task in one plain sentence.
   - If the MCP tool is not available, run \`grimoire impact --intent "<the task>"\` in the repository instead (add file paths to check specific files).
2. Read the ranked candidates and their reasons. Open only the top ones that plausibly relate to the task.
3. For each opened file decide whether the task needs a change there. Then say which files you checked and why, and why you left the others alone.

Rules:
- The list is candidates, not instructions. Never edit a file just because it is listed.
- One call per commit. Do not call it again after every small edit.
- If the tool returns nothing useful or is unavailable, say so in one line and continue.
`;

/**
 * 스킬을 두는 곳: claude는 `~/.claude/skills`(Claude Code), agents는 `~/.agents/skills` — Codex가 읽는 사용자 스킬 폴더이고
 * Cursor도 읽는다(둘 다 공식 문서 기준, 2026-10). Cursor는 `~/.claude/skills`도 읽는다.
 */
export type SkillTarget = "claude" | "agents";

function skillsDir(home: string, target: SkillTarget): string {
  return path.join(home, target === "claude" ? ".claude" : ".agents", "skills");
}

export function skillContent(target: SkillTarget = "claude"): string {
  return target === "claude" ? SKILL_CONTENT : AGENTS_SKILL_CONTENT;
}

export function skillFile(home = os.homedir(), target: SkillTarget = "claude"): string {
  return path.join(skillsDir(home, target), SKILL_NAME, "SKILL.md");
}

export interface SkillInstallOptions {
  home?: string;
  dryRun?: boolean;
  remove?: boolean;
  /** 자동 갱신(setup-refresh)이 부른 것 — 사용자가 --remove-skills로 뺀 적이 있으면 다시 넣지 않는다 */
  auto?: boolean;
  target?: SkillTarget;
}

/** 사용자가 --remove-skills로 스킬을 뺐다는 표시 — 자동 갱신이 다시 넣지 않게. 직접 --skills로 설치하면 지운다 */
export function skillOptOutFile(home = os.homedir(), target: SkillTarget = "claude"): string {
  return path.join(skillsDir(home, target), `.${SKILL_NAME}-removed`);
}

export interface SkillInstallResult {
  file: string;
  backup: string | null;
  unchanged: boolean;
}

export function installSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const target = options.target ?? "claude";
  const content = skillContent(target);
  const file = skillFile(options.home, target);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const optOut = skillOptOutFile(options.home, target);
  if (options.remove) {
    if (!options.dryRun) {
      fs.mkdirSync(path.dirname(optOut), { recursive: true });
      fs.writeFileSync(optOut, "grimoire install <client> --skills로 다시 넣을 때까지 자동 갱신이 이 스킬을 넣지 않는다\n");
    }
    if (current === null) return { file, backup: null, unchanged: true };
    if (!options.dryRun) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return { file, backup: null, unchanged: false };
  }
  if (options.auto && fs.existsSync(optOut)) return { file, backup: null, unchanged: true };
  if (!options.dryRun && !options.auto) fs.rmSync(optOut, { force: true });
  if (current === content) return { file, backup: null, unchanged: true };
  if (options.dryRun) return { file, backup: null, unchanged: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (current !== null) {
    backup = `${file}.bak`;
    fs.writeFileSync(backup, current);
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
  return { file, backup, unchanged: false };
}

/** 설치 상태 (doctor·자동 갱신용): 없음 / 같음 / 이 버전이 쓰는 것과 다름 / 사용자가 뺌 */
export function skillState(home = os.homedir(), target: SkillTarget = "claude"): "missing" | "current" | "stale" | "removed" {
  const file = skillFile(home, target);
  if (!fs.existsSync(file)) return fs.existsSync(skillOptOutFile(home, target)) ? "removed" : "missing";
  try {
    return fs.readFileSync(file, "utf8") === skillContent(target) ? "current" : "stale";
  } catch {
    return "stale";
  }
}

/**
 * Codex·Cursor용 스킬을 이 버전으로 — 이미 설치된 것이 낡았을 때만 다시 쓴다(새로 넣지는 않는다).
 * 그쪽엔 Claude Code 같은 SessionStart 훅이 없어, 새 버전의 MCP 서버가 뜰 때 부른다(mcp/server.ts). 실패해도 조용히 넘어간다.
 */
export function refreshAgentsSkill(home = os.homedir(), env: Env = process.env): boolean {
  if (env.GRIMOIRE_AUTO_SETUP === "0") return false;
  try {
    if (skillState(home, "agents") !== "stale") return false;
    return !installSkill({ home, target: "agents", auto: true }).unchanged;
  } catch {
    return false;
  }
}
