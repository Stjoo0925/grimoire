/**
 * MCP 도구 정의와 실행 (SDK 배선과 분리).
 *
 *   search_memory      — 과거 커밋·노트 검색 (근거 목록)
 *   show_commit        — 커밋(sha 하나 또는 shas 최대 5개)의 메시지·파일·diff
 *   get_repo_overview  — 레포의 기술 스택·활동·많이 건드린 곳·최근 주요 커밋
 *   list_repos         — 인덱싱된 레포 목록
 *   add_repo           — 레포(또는 디렉터리 아래 레포 전부) 등록 + 인덱싱
 *   record_note        — 대화 중 배운 것·결정을 노트로 남김
 *
 * 등록된 레포가 하나도 없으면 결과에 `hint`를 실어, AI가 사용자에게 등록 방법을 안내하게 한다.
 * 새 버전이 있으면 세션에 한 번 같은 `hint`로 업데이트를 알린다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isIndexable } from "../core/code";
import { isBusyError, type DB } from "../core/db";
import { resolveAuthors } from "../core/identity";
import { indexCommitCode } from "../core/diffs";
import { CancelledError } from "../core/git";
import { addRepo, discoverRepos, listRepos, matchRepos, syncRepo } from "../core/indexer";
import { addNote, TAG_CHARS, TAGS_MAX } from "../core/notes";
import { commitDetail, repoOverview, repoSummaries } from "../core/overview";
import { search, type SearchHit } from "../core/search";
import { slimCommit, slimOverview, slimRepos, slimSearch, type Detail } from "./format";
import { waitForWorkspace, type Background, type Workspace } from "./workspace";

export interface ToolContext {
  db: DB;
  /** 내 작성자 이메일 */
  me: string[];
  /** 서버의 작업 디렉터리 — Claude Code는 보통 열려 있는 프로젝트 폴더다 */
  cwd: string;
  /** 새 버전 안내 — 세션에 한 번만 문자열을 돌려준다 (서버가 채움) */
  updateHint?: () => string | undefined;
  /** 작업 중인 프로젝트 (서버가 채움, workspace.ts) */
  workspace?: Workspace;
  /** 요청이 끝난 뒤에도 도는 작업(add_repo의 diff 색인)의 종료 신호·추적 (서버가 채움) */
  background?: Background;
}

/** 새 작업 레포의 첫 인덱싱을 검색이 기다려 주는 상한 */
const WORKSPACE_WAIT_MS = 15_000;
/** 검색 전 작업 레포 재동기화를 기다려 주는 상한 (새 커밋 몇 개면 이 안에 끝난다) */
const REFRESH_WAIT_MS = 2_000;

/** 레포가 없을 때 AI가 사용자에게 전할 안내. 레포가 있으면 undefined. */
export function emptyHint(context: ToolContext): string | undefined {
  const repos = listRepos(context.db);
  const root = context.workspace?.root;
  if (repos.length > 0) {
    // 자동 등록을 끈 채 작업 중인 레포가 빠져 있으면 알린다 — 말하지 않으면 AI도 모른다
    if (root && !repos.some((repo) => repo.path === root)) {
      return `지금 작업 중인 레포(${root})는 Grimoire에 등록돼 있지 않아 검색에서 빠집니다 — add_repo {"path": "${root}"}로 등록할 수 있습니다.`;
    }
    return undefined;
  }
  const cwdIsRepo = fs.existsSync(path.join(context.cwd, ".git"));
  return [
    "아직 인덱싱된 레포가 없습니다.",
    cwdIsRepo
      ? `지금 작업 디렉터리(${context.cwd})가 git 레포입니다 — add_repo {"path": "${context.cwd}"}로 바로 등록할 수 있습니다.`
      : "사용자에게 어떤 폴더의 레포를 기억시킬지 물어본 뒤 add_repo로 등록하세요 (여러 레포가 든 폴더는 scan: true).",
    "터미널에서는 'grimoire scan <폴더>'로도 등록할 수 있습니다.",
  ].join(" ");
}

/**
 * 도구 정의는 이 서버가 켜진 모든 세션의 매 요청에 실린다(사용자 범위 설치면 모든 프로젝트).
 * 설명은 "언제 쓰는지"만 짧게 — 길어지면 Grimoire를 안 쓰는 대화까지 비용을 문다.
 * 영어로 쓴다: 같은 뜻이면 토큰이 적고, 영어로 묻는 세션에서도 도구를 고르게. annotations는 클라이언트가
 * 확인 없이 불러도 되는지 판단하는 힌트다(읽기 도구는 readOnlyHint, add_repo는 같은 경로면 다시 불러도 같다. record_note는 부를 때마다 노트가 생겨 MCP 기본값(idempotentHint 없음 = false) 그대로 둔다).
 */
export const TOOLS = [
  {
    name: "search_memory",
    description:
      "Find code (file symbol:line), past commits, notes. 'Where is X?' 'How did I do X?' Cite file:line/sha.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        repo: { type: "string" },
        author: { type: "string", description: "me | email" },
        since: { type: "string", format: "date" },
        until: { type: "string", format: "date" },
        kind: { type: "string", enum: ["file", "commit", "note"] },
        limit: { type: "number", description: "default 8" },
        detail: { type: "string", enum: ["index", "summary", "full"], description: "summary: +bodies, changed fns; full: +diff" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "show_commit",
    description: "Message, files, diff of a commit (sha) or up to 5 (shas); paths narrows diff.",
    inputSchema: {
      type: "object",
      properties: {
        sha: { type: "string" },
        shas: { type: "array", items: { type: "string" }, description: "up to 5" },
        repo: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        max_diff_lines: { type: "number", description: "120; 40 per sha" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_repo_overview",
    description: "Repo stack, activity, hotspots, key commits.",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_repos",
    description: "Indexed repos.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_repo",
    description: "Index a repo the user names; scan: all inside.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, scan: { type: "boolean" } },
      required: ["path"],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: "record_note",
    description: "Save a note the user asks to keep.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "line 1 = title" },
        repo: { type: "string" },
        tags: { type: "array", items: { type: "string", maxLength: TAG_CHARS }, maxItems: TAGS_MAX },
      },
      required: ["text"],
    },
  },
] as const;

/** detail=full에서 1위 커밋에 붙이는 diff 줄 수 */
const FULL_DIFF_LINES = 120;

async function topDiff(db: DB, hit: SearchHit, signal?: AbortSignal) {
  const repo = hit.repoPath ? (db.prepare("SELECT id FROM repos WHERE path = ?").get(hit.repoPath) as { id: number } | undefined) : undefined;
  // 질문과 맞는 순서로 정렬된 변경 파일 중 소스 파일 앞쪽만
  const paths = hit.files.filter((file) => isIndexable(file, 0)).slice(0, 3);
  const detail = await commitDetail(db, hit.ref, { repoId: repo?.id, maxDiffLines: FULL_DIFF_LINES, paths, signal });
  if ("error" in detail || !detail.patch) return undefined;
  return {
    sha: hit.ref.slice(0, 10),
    patch: detail.patch,
    ...(detail.patchTruncated ? { truncated: `${FULL_DIFF_LINES}줄 넘음 — 나머지는 show_commit` } : {}),
  };
}

/** MCP scan 한 번으로 등록하는 레포 수 상한 — 넘으면 터미널 grimoire scan으로 안내한다 */
export const MAX_SCAN_REPOS = 50;

/**
 * MCP로 scan하기엔 너무 넓은 곳: 파일 시스템 루트, 루트 바로 아래(/home·/opt·C:\Users·D:\x),
 * 홈 디렉터리와 그 조상(~/.. 등). 터미널 grimoire scan은 사용자가 직접 치는 명령이라 막지 않는다.
 */
export function isTooBroad(dir: string): boolean {
  // Windows 경로는 대소문자를 가리지 않는다
  const norm = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  const resolved = norm(dir);
  const root = norm(path.parse(resolved).root);
  if (resolved === root || path.dirname(resolved) === root) return true;
  const home = norm(os.homedir());
  return home === resolved || home.startsWith(resolved.endsWith(path.sep) ? resolved : resolved + path.sep);
}

export type ToolName = (typeof TOOLS)[number]["name"];

type Args = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class ToolError extends Error {}

const BUSY_MESSAGE = "다른 grimoire 프로세스가 DB를 쓰는 중입니다. 잠시 후 다시 시도하세요.";
const CANCELLED_MESSAGE = "요청이 취소되었습니다";
/** record_note가 DB 잠금에 걸렸을 때 다시 해 보는 횟수와 간격 */
const NOTE_RETRIES = 2;
const NOTE_RETRY_MS = 200;

/** 원인 사슬(cause)까지 보며 조건에 맞는 오류가 있는가 */
function causedBy(error: unknown, test: (error: Error & { code?: unknown; syscall?: unknown; killed?: unknown }) => boolean): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (test(current)) return true;
    current = current.cause;
  }
  return false;
}

const isCancelled = (error: unknown) => causedBy(error, (item) => item instanceof CancelledError || item.name === "AbortError");

/**
 * 도구 오류 → 클라이언트(AI)에 보낼 문장. ToolError와 알려진 원인(DB 잠금·git 없음·출력 초과·시간 초과·취소)은
 * 사용자용 문장으로, 나머지는 내부 메시지를 그대로 내보내지 않고 일반 문장으로 바꾼다(전체 오류는 서버가 stderr에 남긴다).
 * known=false면 예상하지 못한 오류다.
 */
export function describeError(error: unknown): { message: string; known: boolean } {
  if (error instanceof ToolError) return { message: error.message, known: true };
  if (isCancelled(error)) return { message: CANCELLED_MESSAGE, known: true };
  if (causedBy(error, isBusyError)) return { message: BUSY_MESSAGE, known: true };
  if (causedBy(error, (item) => item.code === "ENOENT" && String(item.syscall ?? "").startsWith("spawn"))) {
    return { message: "git을 찾을 수 없습니다 — git을 설치하고 PATH에 있는지 확인하세요 (grimoire doctor).", known: true };
  }
  if (causedBy(error, (item) => item.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || item.code === "ENOBUFS")) {
    return { message: "출력이 너무 커서 읽지 못했습니다 — paths·max_diff_lines로 범위를 좁혀 보세요.", known: true };
  }
  if (causedBy(error, (item) => item.killed === true)) {
    // 명령마다 상한이 달라(GIT_TIMEOUT_MS·GIT_BULK_TIMEOUT_MS) 숫자는 적지 않는다
    return { message: "git이 시간 안에 끝나지 않아 멈췄습니다. 잠시 후 다시 시도하세요.", known: true };
  }
  return { message: "내부 오류 — 서버 로그(stderr)를 확인하세요.", known: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** show_commit shas: 한 번에 받는 커밋 수와 커밋당 기본 diff 줄 수 */
const MAX_SHAS = 5;
const MULTI_DIFF_LINES = 40;

/** 검색 결과 기본 개수 — 응답 토큰을 아끼려고 코어 기본값(10)보다 작게 */
const SEARCH_LIMIT = 8;

/**
 * 도구를 실행하고 JSON 직렬화 가능한(간결한) 결과를 돌려준다. 잘못된 인자는 ToolError.
 * signal은 이 요청의 취소 신호다 — 이 요청을 위해 부르는 git에만 넘기고, 뒤에서 계속 도는 작업에는 넘기지 않는다.
 * DB 잠금(다른 grimoire 프로세스가 쓰는 중)과 취소는 ToolError로 바꿔 알린다.
 */
export async function callTool(context: ToolContext, name: string, args: Args = {}, signal?: AbortSignal): Promise<unknown> {
  try {
    return await runTool(context, name, args, signal);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (isCancelled(error)) throw new ToolError(CANCELLED_MESSAGE, { cause: error });
    if (causedBy(error, isBusyError)) throw new ToolError(BUSY_MESSAGE, { cause: error });
    throw error;
  }
}

async function runTool(context: ToolContext, name: string, args: Args, signal: AbortSignal | undefined): Promise<unknown> {
  const { db, me } = context;
  // 새 작업 레포가 첫 인덱싱 중이면 (상한 안에서) 기다렸다가 답한다
  const current = await waitForWorkspace(context.workspace, WORKSPACE_WAIT_MS);
  const withHint = <T extends object>(result: T): T & { hint?: string } => {
    const hint = [emptyHint(context), context.updateHint?.()].filter(Boolean).join(" ");
    return hint ? { ...result, hint } : result;
  };

  const repoFilter = (value: unknown) => {
    const query = str(value);
    if (!query) return undefined;
    const matches = matchRepos(db, query);
    if (matches.length === 0) throw new ToolError(`레포를 찾지 못했습니다: ${query}. list_repos로 목록을 확인하세요.`);
    if (matches.length > 1) {
      // 조용히 첫 번째를 고르면 엉뚱한 레포를 보거나 노트를 남긴다 — 후보를 보여 주고 고르게 한다
      throw new ToolError(`'${query}'와 맞는 레포가 여럿입니다: ${matches.map((repo) => repo.name).join(", ")}. 정확한 이름을 주세요.`);
    }
    return matches[0];
  };

  switch (name) {
    case "search_memory": {
      const query = str(args.query);
      if (!query) throw new ToolError("query가 필요합니다");
      const kind = args.kind === "commit" || args.kind === "note" || args.kind === "file" ? args.kind : undefined;
      const authors = resolveAuthors(str(args.author), me);
      if (authors && authors.length === 0) {
        throw new ToolError("내 이메일을 알 수 없습니다. GRIMOIRE_ME 또는 git config user.email을 설정하세요.");
      }
      if (current) await context.workspace?.refresh?.(current, REFRESH_WAIT_MS);
      const result = await search(db, query, {
        repoId: repoFilter(args.repo)?.id,
        authors,
        since: str(args.since),
        until: str(args.until),
        kind,
        limit: num(args.limit) ?? SEARCH_LIMIT,
        preferRepoId: current?.id,
      });
      // 기본은 index — summary는 응답이 66% 커지는데 한 번에 답할 수 있는 비율은 유의하게 늘지 않았다 (docs/improvement-plan.md §7)
      const detail: Detail = args.detail === "summary" || args.detail === "full" ? args.detail : "index";
      const slim = slimSearch(result, me, detail);
      // full: 1위 커밋의 diff를 소스 파일 위주로 붙인다 — show_commit을 따로 부르지 않게
      const top = detail === "full" ? result.hits.find((hit) => hit.kind === "commit") : undefined;
      const diff = top ? await topDiff(db, top, signal) : undefined;
      return withHint({ ...(current ? { current: current.name } : {}), ...slim, ...(diff ? { diff } : {}) });
    }
    case "show_commit": {
      const sha = str(args.sha);
      const listed = Array.isArray(args.shas) ? args.shas.map(str).filter((item): item is string => item !== undefined) : [];
      // sha와 shas를 함께 주면 합친다
      const shas = listed.length > 0 ? [...new Set([...(sha ? [sha] : []), ...listed])] : [];
      if (!sha && shas.length === 0) throw new ToolError("sha 또는 shas가 필요합니다");
      if (shas.length > MAX_SHAS) throw new ToolError(`shas는 ${MAX_SHAS}개까지입니다`);
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((item): item is string => typeof item === "string")
        : typeof args.paths === "string"
          ? [args.paths]
          : [];
      const repoId = repoFilter(args.repo)?.id;
      if (shas.length === 0) {
        const detail = await commitDetail(db, sha!, { repoId, maxDiffLines: num(args.max_diff_lines), paths, signal });
        if ("error" in detail) throw new ToolError([detail.error, ...(detail.candidates ?? [])].join("\n"));
        return slimCommit(detail, me);
      }
      // 여러 커밋 한 번에 — 검색 결과 상위 몇 개를 왕복 없이 비교할 때. 응답이 커지지 않게 커밋당 diff를 줄인다
      const commits = await Promise.all(
        shas.map(async (item) => {
          const detail = await commitDetail(db, item, { repoId, maxDiffLines: num(args.max_diff_lines) ?? MULTI_DIFF_LINES, paths, signal });
          return "error" in detail ? { sha: item, error: [detail.error, ...(detail.candidates ?? [])].join("\n") } : slimCommit(detail, me);
        }),
      );
      return { commits };
    }
    case "get_repo_overview": {
      const repo = repoFilter(args.repo);
      if (!repo) throw new ToolError("repo가 필요합니다");
      return slimOverview(repoOverview(db, repo, me));
    }
    case "list_repos":
      return withHint({ me, ...(current ? { current: current.name } : {}), repos: slimRepos(repoSummaries(db, me)) });
    case "add_repo": {
      const target = str(args.path);
      if (!target) throw new ToolError("path가 필요합니다");
      const dir = path.resolve(context.cwd, target.replace(/^~(?=$|[\\/])/, os.homedir()));
      if (!fs.existsSync(dir)) throw new ToolError(`경로가 없습니다: ${dir}`);
      // 루트·홈 전체 스캔은 너무 넓다 — 결과 속 주입된 지시를 따른 AI가 모든 레포를 긁어 가는 길을 막는다
      if (args.scan === true && isTooBroad(dir)) {
        throw new ToolError(`${dir} 전체를 스캔하지는 않습니다. 레포들이 든 하위 폴더를 지정하거나, 터미널에서 'grimoire scan ${dir}'를 실행하세요.`);
      }
      const dirs = args.scan === true ? discoverRepos(dir, undefined, MAX_SCAN_REPOS) : [dir];
      if (dirs.length === 0) throw new ToolError(`git 레포를 찾지 못했습니다: ${dir}`);
      // 도구 호출 하나가 수백 레포를 색인하며 분 단위로 붙잡히지 않게
      if (dirs.length > MAX_SCAN_REPOS) {
        throw new ToolError(`${dir} 아래 레포가 ${MAX_SCAN_REPOS}개를 넘습니다. 더 좁은 폴더를 지정하거나, 터미널에서 'grimoire scan ${dir}'를 실행하세요.`);
      }
      const added: unknown[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const repoDir of dirs) {
        try {
          const repo = await addRepo(db, repoDir, signal);
          added.push(await syncRepo(db, repo, signal));
          // diff 식별자는 뒤에서 — 등록 응답을 붙잡지 않는다. 이 요청이 취소돼도 멈추지 않고 서버 종료 때만 멈춘다
          const job = indexCommitCode(db, repo, context.background?.signal).catch((error) =>
            console.error(`[grimoire] ${repo.name} diff 색인 실패 —`, error instanceof Error ? error.message : error),
          );
          context.background?.track?.(job);
        } catch (error) {
          if (isCancelled(error) || causedBy(error, isBusyError)) throw error;
          failed.push({ path: repoDir, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (added.length === 0) throw new ToolError(failed.map((item) => item.error).join("\n"));
      return { added, failed };
    }
    case "record_note": {
      const text = str(args.text);
      if (!text) throw new ToolError("text가 필요합니다");
      if (args.tags !== undefined && !Array.isArray(args.tags)) throw new ToolError("tags는 문자열 배열이어야 합니다");
      // 상한(TAGS_MAX개·TAG_CHARS자)을 넘으면 오류 대신 자른다 — 거대한 배열을 끝까지 훑지도 않는다
      const tags = (args.tags ?? []).slice(0, TAGS_MAX).filter((tag): tag is string => typeof tag === "string");
      const repoId = repoFilter(args.repo)?.id ?? null;
      // 다른 grimoire 프로세스가 쓰는 중이면 잠깐 뒤 다시 — 사용자가 남기라고 한 노트라 바로 실패시키지 않는다
      for (let attempt = 0; ; attempt++) {
        try {
          const note = addNote(db, { text, repoId, tags, source: "mcp" });
          return { recorded: true, id: note.id, createdAt: note.created_at };
        } catch (error) {
          if (!isBusyError(error) || attempt >= NOTE_RETRIES) throw error;
          await sleep(NOTE_RETRY_MS);
        }
      }
    }
    default:
      throw new ToolError(`알 수 없는 도구: ${name}`);
  }
}
