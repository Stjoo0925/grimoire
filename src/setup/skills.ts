/**
 * `grimoire install claude-code --skills` — Claude Code 스킬을 `~/.claude/skills/grimoire-impact/SKILL.md`에 쓴다.
 *
 * 훅이 자동으로 끼어드는 것과 달리, 에이전트가 "커밋 전·리뷰·PR" 같은 때에 `impact`를 부르게 하는 명시적 진입점이다.
 * 쓰는 것은 그 폴더 하나뿐이다 — `~/.claude`의 다른 것은 건드리지 않는다. 내용이 다를 때만 `.bak`을 남기고 덮는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function skillFile(home = os.homedir()): string {
  return path.join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
}

export interface SkillInstallOptions {
  home?: string;
  dryRun?: boolean;
  remove?: boolean;
}

export interface SkillInstallResult {
  file: string;
  backup: string | null;
  unchanged: boolean;
}

export function installSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const file = skillFile(options.home);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (options.remove) {
    if (current === null) return { file, backup: null, unchanged: true };
    if (!options.dryRun) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return { file, backup: null, unchanged: false };
  }
  if (current === SKILL_CONTENT) return { file, backup: null, unchanged: true };
  if (options.dryRun) return { file, backup: null, unchanged: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (current !== null) {
    backup = `${file}.bak`;
    fs.writeFileSync(backup, current);
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, SKILL_CONTENT);
  fs.renameSync(temp, file);
  return { file, backup, unchanged: false };
}

/** 설치 상태 (doctor용): 없음 / 같음 / 이 버전이 쓰는 것과 다름 */
export function skillState(home = os.homedir()): "missing" | "current" | "stale" {
  const file = skillFile(home);
  if (!fs.existsSync(file)) return "missing";
  try {
    return fs.readFileSync(file, "utf8") === SKILL_CONTENT ? "current" : "stale";
  } catch {
    return "stale";
  }
}
