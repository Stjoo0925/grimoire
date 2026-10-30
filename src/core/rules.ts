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
 * 제목(# 꼴과 밑줄 꼴 모두)은 단위가 아니라 그 아래 단위의 맥락. 코드 블록은 빈 줄을 사이에 두어도 앞 단위의 범위에 붙고(내용은 본문에
 * 넣지 않는다), 앞 단위가 없으면 버린다. 코드 블록은 여는 것과 같은 문자로, 같거나 더 긴 울타리만 닫는다.
 */
export function parseRules(content: string): ParsedRules {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const { scope, skip } = frontmatter(lines);
  const units: RuleUnit[] = [];
  const headings: string[] = [];
  type Open = { line: number; endLine: number; indent: number | null; heading: string; parts: string[] };
  let current: Open | null = null as Open | null;
  /** 마지막으로 닫힌 단위(units 안의 그 객체) — 빈 줄 뒤의 코드 블록이 범위를 늘린다 */
  let previous: RuleUnit | null = null as RuleUnit | null;
  let fence: { char: string; length: number } | null = null as { char: string; length: number } | null;

  const close = () => {
    if (!current) return;
    const text = current.parts.join("\n").trim().slice(0, UNIT_MAX_CHARS);
    previous = null;
    if (text.replace(/\s/g, "").length >= UNIT_MIN_CHARS && units.length < RULE_UNITS_MAX) {
      previous = { line: current.line, endLine: current.endLine, heading: current.heading, text };
      units.push(previous);
    }
    current = null;
  };
  const extend = (number: number) => {
    if (current) current.endLine = number;
    else if (previous) previous.endLine = number;
  };

  for (let index = skip; index < lines.length; index++) {
    const raw = lines[index];
    const number = index + 1;
    if (fence) {
      extend(number);
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      extend(number);
      continue;
    }
    if (!raw.trim()) {
      close();
      continue;
    }
    const heading = HEADING.exec(raw);
    // 밑줄 꼴 제목("Title" 다음 줄 "====" 또는 "----") — 한 줄짜리 문단 바로 뒤에서만
    const underline = /^\s*(=+|-{2,})\s*$/.exec(raw);
    if (heading || (underline && current && current.indent === null && current.parts.length === 1)) {
      const level = heading ? heading[1].length : underline![1][0] === "=" ? 1 : 2;
      const title = heading ? heading[2] : current!.parts[0];
      current = null;
      previous = null;
      headings.length = level - 1;
      headings[level - 1] = title;
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
export async function blameLines(dir: string, file: string, signal?: AbortSignal): Promise<Map<number, BlameLine> | null> {
  blameStats.calls++;
  try {
    return parseBlame(await runGit(dir, ["blame", "--porcelain", "-w", "-M", "HEAD", "--", file], undefined, signal, BLAME_TIMEOUT_MS));
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * 이 파일을 건드린 커밋의 이력 순서 — sha → 순번(0이 가장 새것). 출처·최근 변경은 날짜가 아니라 이 순서로 고른다:
 * rebase·`git am`으로 쌓은 커밋은 committer-time이 같거나 거꾸로일 수 있다. 실패하면 빈 Map(날짜로 대신한다).
 */
export async function historyOrder(dir: string, file: string, signal?: AbortSignal): Promise<Map<string, number>> {
  try {
    const out = await runGit(dir, ["rev-list", "--topo-order", "--full-history", "HEAD", "--", file], undefined, signal, BLAME_TIMEOUT_MS);
    return new Map(out.split("\n").filter(Boolean).map((sha, index) => [sha.trim(), index]));
  } catch (error) {
    if (signal?.aborted) throw error;
    return new Map();
  }
}

/**
 * 단위의 출처(줄들 중 가장 이른 커밋 — 지금 글자가 처음 쓰인 때)와 최근 변경(가장 늦은 커밋). 줄 정보가 없으면 null.
 * 이르고 늦음은 이력 순서(historyOrder)로, 순서를 모르는 커밋끼리만 committer-time으로 견준다.
 */
export function unitHistory(unit: RuleUnit, blame: Map<number, BlameLine>, order: Map<string, number> = new Map()): { origin: string; last: string } | null {
  // 순번이 클수록 옛것. 순서를 모르면 날짜를 쓴다(순서를 아는 커밋보다 뒤로 미루지 않도록 같은 축에 두지 않는다)
  const older = (a: BlameLine, b: BlameLine) => {
    const [x, y] = [order.get(a.sha), order.get(b.sha)];
    return x !== undefined && y !== undefined ? x > y : a.time < b.time;
  };
  let origin: BlameLine | null = null;
  let latest: BlameLine | null = null;
  for (let line = unit.line; line <= unit.endLine; line++) {
    const entry = blame.get(line);
    if (!entry) continue;
    if (!origin || older(entry, origin)) origin = entry;
    if (!latest || older(latest, entry)) latest = entry;
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

/** 내용 안에서 text가 나오는 모든 자리의 줄 범위(1부터) — Edit의 old_string은 파일 안에서 하나뿐이지만 replace_all이면 여럿일 수 있다 */
function lineRanges(content: string, text: string): [number, number][] {
  const ranges: [number, number][] = [];
  if (!text) return ranges;
  const lineAt = (offset: number) => {
    let count = 1;
    for (let index = content.indexOf("\n"); index !== -1 && index < offset; index = content.indexOf("\n", index + 1)) count++;
    return count;
  };
  for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + text.length)) {
    ranges.push([lineAt(at), lineAt(at + text.length - 1)]);
  }
  return ranges;
}

/**
 * Edit·MultiEdit가 바꾸는 규칙 단위 — old_string을 지금 파일 내용에서 찾아 그 줄 범위와 겹치는 단위만. 글자 비교로 짐작하지 않는다
 * (짧은 낱말·표 구분선 같은 흔한 줄이 엉뚱한 단위에 걸렸다). 줄 번호는 지금 파일 기준 — 커밋 안 한 편집이 앞에 줄을 더했어도 맞다.
 * old_string이 지금 내용에 없으면(파일이 바뀌었으면) 아무것도.
 */
export function touchedUnits(content: string, oldStrings: string[]): RuleUnit[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const ranges = oldStrings.flatMap((old) => lineRanges(normalized, old.replace(/\r\n?/g, "\n")));
  if (ranges.length === 0) return [];
  return parseRules(normalized).units.filter((unit) => ranges.some(([start, end]) => unit.line <= end && unit.endLine >= start));
}

/** Write가 통째로 쓸 때 사라지거나 바뀌는 규칙 단위 — 지금 내용의 단위 중, 새 내용의 단위 가운데 같은 글자(공백만 다른 것 포함)가 없는 것 */
export function removedUnits(content: string, newContent: string): RuleUnit[] {
  const after = new Set(parseRules(newContent).units.map((unit) => squash(unit.text)));
  return parseRules(content).units.filter((unit) => !after.has(squash(unit.text)));
}
