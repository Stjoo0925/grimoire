/**
 * 레포 규칙 — 규칙의 원본은 규칙 파일(CLAUDE.md·.claude/rules·.cursor/rules·AGENTS.md…)이다. grimoire는 규칙을 쓰지도
 * 고치지도 숨기지도 않고, 규칙 한 단위(목록 항목·문단)가 어느 커밋에서 들어왔고 언제 바뀌었는지만 안다 (docs/rules-research.md).
 *
 * 이 파일은 git·DB를 부르지 않는 순수 함수와 blame 한 번(blameLines)만 둔다. 색인은 indexer.ts, 보여 주기는 search·훅이 한다.
 */
import { runGit } from "./git";

/** 규칙 파일로 보는 경로(레포 기준 posix) — 클라이언트들이 실제로 읽는 위치만. 이름만 비슷한 파일(claude.md.bak, docs/rules.md)은 아니다 */
const RULE_FILE_PATTERNS: RegExp[] = [
  /(^|\/)(CLAUDE|AGENTS)\.md$/,
  /(^|\/)\.claude\/rules\/.+\.md$/,
  /(^|\/)\.cursor\/rules\/.+\.mdc?$/,
  /(^|\/)\.(cursorrules|windsurfrules)$/,
  /^\.windsurf\/rules\/.+\.md$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /^\.kiro\/steering\/.+\.md$/,
];

/** 규칙 파일 하나의 크기 상한과 레포 하나에서 보는 규칙 파일 수 */
export const RULE_FILE_MAX_BYTES = 200 * 1024;
export const RULE_FILES_MAX = 50;
/** 파일 하나에서 뽑는 규칙 단위 수 상한 */
export const RULE_UNITS_MAX = 300;
/** 이보다 짧은 단위는 규칙으로 보지 않는다 ("---", "TODO" 같은 것) */
const UNIT_MIN_CHARS = 8;
/** 규칙 단위 본문 상한 — 검색 본문에 들어간다 */
const UNIT_MAX_CHARS = 2000;
/** blame 한 번의 시간 상한 — 넘기면 그 파일의 출처는 모르는 채로 둔다 */
export const BLAME_TIMEOUT_MS = 10_000;

export function isRuleFile(file: string, size = 0): boolean {
  if (size > RULE_FILE_MAX_BYTES) return false;
  return RULE_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

export interface RuleUnit {
  /** 첫 줄 번호(1부터) */
  line: number;
  endLine: number;
  /** 위 제목들 — "Commits > Messages" */
  heading: string;
  /** 단위의 줄들(앞뒤 공백·목록 기호 정리) */
  text: string;
}

export interface ParsedRules {
  /** 프런트매터의 범위(paths·globs·applyTo·fileMatchPattern) — 보여 주기만 한다 */
  scope: string;
  units: RuleUnit[];
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const SCOPE_KEYS = new Set(["paths", "globs", "applyto", "filematchpattern"]);

/** 프런트매터를 떼고 범위 문자열을 얻는다. 닫는 "---"가 없으면 프런트매터로 보지 않는다 */
function frontmatter(lines: string[]): { scope: string; skip: number } {
  if (lines[0]?.trim() !== "---") return { scope: "", skip: 0 };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { scope: "", skip: 0 };
  const values: string[] = [];
  let collecting = false;
  for (const line of lines.slice(1, end)) {
    const key = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (key) {
      collecting = SCOPE_KEYS.has(key[1].toLowerCase());
      if (collecting && key[2].trim()) values.push(key[2].trim());
      continue;
    }
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (collecting && item) values.push(item[1].trim());
  }
  const scope = values
    .join(", ")
    .replace(/^\[|\]$/g, "")
    .replace(/["']/g, "")
    .trim();
  return { scope, skip: end + 1 };
}

/**
 * 마크다운을 규칙 단위로 나눈다 — 목록 항목 하나(더 깊이 들여쓴 하위 항목·이어지는 줄 포함)가 하나, 목록이 아닌 문단 하나가 하나.
 * 제목은 단위가 아니라 그 아래 단위의 맥락. 코드 블록은 앞 단위에 붙고, 앞 단위가 없으면 버린다.
 */
export function parseRules(content: string): ParsedRules {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const { scope, skip } = frontmatter(lines);
  const units: RuleUnit[] = [];
  const headings: string[] = [];
  type Open = { line: number; endLine: number; indent: number | null; heading: string; parts: string[] };
  let current: Open | null = null as Open | null;
  let last: Open | null = null as Open | null;
  let fence: string | null = null;

  const close = () => {
    if (!current) return;
    last = current;
    const text = current.parts.join("\n").trim().slice(0, UNIT_MAX_CHARS);
    if (text.replace(/\s/g, "").length >= UNIT_MIN_CHARS && units.length < RULE_UNITS_MAX) {
      units.push({ line: current.line, endLine: current.endLine, heading: current.heading, text });
    }
    current = null;
  };

  for (let index = skip; index < lines.length; index++) {
    const raw = lines[index];
    const number = index + 1;
    if (fence) {
      // 코드 블록 안 — 앞 단위의 범위만 늘린다(내용은 본문에 넣지 않는다)
      const owner = current ?? last;
      if (owner) owner.endLine = number;
      if (raw.trim().startsWith(fence)) fence = null;
      continue;
    }
    const opening = FENCE.exec(raw);
    if (opening) {
      fence = opening[1];
      const owner = current ?? last;
      if (owner) owner.endLine = number;
      continue;
    }
    if (!raw.trim()) {
      close();
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      close();
      last = null;
      headings.length = heading[1].length - 1;
      headings[heading[1].length - 1] = heading[2];
      continue;
    }
    const item = LIST_ITEM.exec(raw);
    const context = headings.filter(Boolean).join(" > ");
    if (item) {
      const indent = item[1].replace(/\t/g, "  ").length;
      // 지금 단위보다 깊이 들여쓴 항목은 하위 항목 — 같은 단위에 붙인다
      if (current && current.indent !== null && indent > current.indent) {
        current.parts.push(raw.trim());
        current.endLine = number;
        continue;
      }
      close();
      current = { line: number, endLine: number, indent, heading: context, parts: [item[2].trim()] };
      continue;
    }
    if (current) {
      // 이어지는 줄(목록 항목의 이어 쓴 줄, 문단의 다음 줄)
      current.parts.push(raw.trim());
      current.endLine = number;
      continue;
    }
    current = { line: number, endLine: number, indent: null, heading: context, parts: [raw.trim()] };
  }
  close();
  return { scope, units };
}

export interface BlameLine {
  sha: string;
  /** committer-time (초) — author-time은 rebase·cherry-pick 뒤에도 옛 날짜로 남아 순서를 거스를 수 있다 */
  time: number;
}

/** `git blame --porcelain` 출력 → 최종 줄 번호(1부터)마다 커밋. 같은 커밋의 둘째 묶음부터는 committer-time이 생략돼 앞에서 받은 값을 쓴다 */
export function parseBlame(out: string): Map<number, BlameLine> {
  const lines = new Map<number, BlameLine>();
  const times = new Map<string, number>();
  let sha: string | null = null;
  let final = 0;
  let count = 0;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: (\d+))?$/.exec(line);
    if (header) {
      sha = header[1];
      final = Number(header[2]);
      count = header[3] ? Number(header[3]) : count;
      continue;
    }
    if (!sha) continue;
    const time = /^committer-time (\d+)$/.exec(line);
    if (time) {
      times.set(sha, Number(time[1]));
      continue;
    }
    if (line.startsWith("\t")) {
      lines.set(final, { sha, time: times.get(sha) ?? 0 });
    }
  }
  return lines;
}

/** 테스트용: blame을 몇 번 불렀나 — 규칙 파일이 안 바뀐 재동기화는 0번이어야 한다 (rules-research §5-3) */
export const blameStats = { calls: 0 };

/**
 * HEAD 기준 파일의 줄별 커밋 — 그 줄의 지금 글자를 쓴 커밋. 공백만 바꾼 커밋은 건너뛰고(-w), 파일 안에서 옮긴 줄은 옮기기 전 커밋으로 본다(-M).
 * 실패·시간 초과는 빈 결과 — 출처를 모르는 채로 둔다.
 *
 * 더 거슬러 가지 않는다: `git log -L`로 줄 범위를 따라가면 파일을 통째로 고쳐 쓴 커밋을 지나 첫 커밋까지 가서, 실제 레포
 * (claude-code-action의 CLAUDE.md, 117줄 → 25줄 재작성)에서 규칙 대부분의 출처가 "Initial commit"이 됐다. git이 증명하는 것은
 * "이 글자를 쓴 커밋"까지다 (docs/rules-research.md §7).
 */
export async function blameLines(dir: string, file: string, signal?: AbortSignal): Promise<Map<number, BlameLine>> {
  blameStats.calls++;
  try {
    return parseBlame(await runGit(dir, ["blame", "--porcelain", "-w", "-M", "HEAD", "--", file], undefined, signal, BLAME_TIMEOUT_MS));
  } catch (error) {
    if (signal?.aborted) throw error;
    return new Map();
  }
}

/** 단위의 출처(줄들 중 가장 이른 커밋 — 지금 글자가 처음 쓰인 때)와 최근 변경(가장 늦은 커밋). 줄 정보가 없으면 null */
export function unitHistory(unit: RuleUnit, blame: Map<number, BlameLine>): { origin: string; last: string } | null {
  let origin: BlameLine | null = null;
  let latest: BlameLine | null = null;
  for (let line = unit.line; line <= unit.endLine; line++) {
    const entry = blame.get(line);
    if (!entry) continue;
    if (!origin || entry.time < origin.time) origin = entry;
    if (!latest || entry.time > latest.time) latest = entry;
  }
  return origin && latest ? { origin: origin.sha, last: latest.sha } : null;
}

/**
 * 규칙의 출처로 보여 줄 만한 커밋 제목인가 — 이유를 담지 않은 제목(병합·오타·형식·릴리스·버전 올림, GitHub 웹 편집기의 기본 "Update CLAUDE.md")만 뺀다.
 * meaningful.ts의 판정은 쓰지 않는다: 그것은 docs:·ci:·chore:를 모두 빼는데, 규칙 파일을 바꾸는 커밋은 대개 그 접두를 단다
 * (실제 레포에서 "ci: security hardening …"이 들인 규칙이 빠졌다).
 */
export function isRuleWorthCommit(subject: string): boolean {
  const text = subject.trim();
  if (text.length < 5) return false;
  if (/^merge\s+(branch|pull request|remote|commit|tag)\b/i.test(text)) return false;
  if (/^(style)(\([^)]*\))?!?\s*:/i.test(text)) return false;
  if (/^(chore|build)(\([^)]*\))?!?\s*:\s*(release|bump|version)\b/i.test(text)) return false;
  if (/^(wip\b|typo\b|오타|fix typo|formatting|format\b|lint\b|prettier\b|bump\b|version bump|initial commit|first commit|minor (fix|change))/i.test(text)) return false;
  if (/^update\s+\S+\.(md|mdc)$/i.test(text)) return false;
  return true;
}

/** 공백을 하나로 — 고치는 내용과 규칙 본문을 견줄 때 */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 단위의 줄 하나하나(목록 기호를 뗀) — 고치는 내용(old_string)과 겹치는지 볼 때 */
function unitLines(unit: RuleUnit): string[] {
  return unit.text
    .split("\n")
    .map((line) => squash(line.replace(LIST_ITEM, "$2")))
    .filter((line) => line.length >= UNIT_MIN_CHARS);
}

/** 고치는 내용을 규칙 본문과 같은 꼴로 — 줄마다 목록 기호를 떼고 공백을 하나로 (규칙 단위는 첫 줄의 목록 기호를 떼고 저장한다) */
function comparable(text: string): string {
  return squash(
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(LIST_ITEM, "$2"))
      .join("\n"),
  );
}

/** Edit의 old_string과 겹치는 규칙 단위 — 단위의 한 줄이 old_string 안에 있거나, old_string(줄의 일부여도)이 단위 안에 있으면 */
export function unitsTouchedBy(units: RuleUnit[], oldText: string): RuleUnit[] {
  const target = comparable(oldText);
  if (target.length < 3) return [];
  return units.filter((unit) => {
    const body = comparable(unit.text);
    return (target.length >= UNIT_MIN_CHARS && body.includes(target)) || unitLines(unit).some((line) => target.includes(line));
  });
}

/** Write로 통째로 쓸 때 새 내용에서 사라지는 규칙 단위 — 단위의 어느 줄이라도 새 내용에 없으면 바뀌거나 지워진 것이다 */
export function unitsRemovedBy(units: RuleUnit[], newContent: string): RuleUnit[] {
  const after = comparable(newContent);
  return units.filter((unit) => unitLines(unit).some((line) => !after.includes(line)));
}
