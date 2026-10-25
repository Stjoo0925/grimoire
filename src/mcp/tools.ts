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
import type { DB } from "../core/db";
import { resolveAuthors } from "../core/identity";
import { indexCommitCode } from "../core/diffs";
import { addRepo, discoverRepos, findRepo, listRepos, syncRepo } from "../core/indexer";
import { addNote } from "../core/notes";
import { commitDetail, repoOverview, repoSummaries } from "../core/overview";
import { search, type SearchHit } from "../core/search";
import { slimCommit, slimOverview, slimRepos, slimSearch, type Detail } from "./format";
import { waitForWorkspace, type Workspace } from "./workspace";

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
 * 확인 없이 불러도 되는지 판단하는 힌트다(읽기 도구는 readOnlyHint, add_repo는 같은 경로면 다시 불러도 같다).
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
    description: "Commit message, files, diff head; paths filters.",
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
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    },
    annotations: { idempotentHint: false },
  },
] as const;

/** detail=full에서 1위 커밋에 붙이는 diff 줄 수 */
const FULL_DIFF_LINES = 120;

async function topDiff(db: DB, hit: SearchHit) {
  const repo = hit.repoPath ? (db.prepare("SELECT id FROM repos WHERE path = ?").get(hit.repoPath) as { id: number } | undefined) : undefined;
  // 질문과 맞는 순서로 정렬된 변경 파일 중 소스 파일 앞쪽만
  const paths = hit.files.filter((file) => isIndexable(file, 0)).slice(0, 3);
  const detail = await commitDetail(db, hit.ref, { repoId: repo?.id, maxDiffLines: FULL_DIFF_LINES, paths });
  if ("error" in detail || !detail.patch) return undefined;
  return {
    sha: hit.ref.slice(0, 10),
    patch: detail.patch,
    ...(detail.patchTruncated ? { truncated: `${FULL_DIFF_LINES}/${detail.patchLines}줄 — 나머지는 show_commit` } : {}),
  };
}

/** MCP로 scan하기엔 너무 넓은 곳: 파일 시스템 루트와 홈 디렉터리 자체 */
function isTooBroad(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir());
}

export type ToolName = (typeof TOOLS)[number]["name"];

type Args = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class ToolError extends Error {}

/** show_commit shas: 한 번에 받는 커밋 수와 커밋당 기본 diff 줄 수 */
const MAX_SHAS = 5;
const MULTI_DIFF_LINES = 40;

/** 검색 결과 기본 개수 — 응답 토큰을 아끼려고 코어 기본값(10)보다 작게 */
const SEARCH_LIMIT = 8;

/** 도구를 실행하고 JSON 직렬화 가능한(간결한) 결과를 돌려준다. 잘못된 인자는 ToolError. */
export async function callTool(context: ToolContext, name: string, args: Args = {}): Promise<unknown> {
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
    const repo = findRepo(db, query);
    if (!repo) throw new ToolError(`레포를 찾지 못했습니다: ${query}. list_repos로 목록을 확인하세요.`);
    return repo;
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
      const diff = top ? await topDiff(db, top) : undefined;
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
        const detail = await commitDetail(db, sha!, { repoId, maxDiffLines: num(args.max_diff_lines), paths });
        if ("error" in detail) throw new ToolError([detail.error, ...(detail.candidates ?? [])].join("\n"));
        return slimCommit(detail, me);
      }
      // 여러 커밋 한 번에 — 검색 결과 상위 몇 개를 왕복 없이 비교할 때. 응답이 커지지 않게 커밋당 diff를 줄인다
      const commits = await Promise.all(
        shas.map(async (item) => {
          const detail = await commitDetail(db, item, { repoId, maxDiffLines: num(args.max_diff_lines) ?? MULTI_DIFF_LINES, paths });
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
      const dir = path.resolve(context.cwd, target.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      if (!fs.existsSync(dir)) throw new ToolError(`경로가 없습니다: ${dir}`);
      // 루트·홈 전체 스캔은 너무 넓다 — 결과 속 주입된 지시를 따른 AI가 모든 레포를 긁어 가는 길을 막는다
      if (args.scan === true && isTooBroad(dir)) {
        throw new ToolError(`${dir} 전체를 스캔하지는 않습니다. 레포들이 든 하위 폴더를 지정하거나, 터미널에서 'grimoire scan ${dir}'를 실행하세요.`);
      }
      const dirs = args.scan === true ? discoverRepos(dir) : [dir];
      if (dirs.length === 0) throw new ToolError(`git 레포를 찾지 못했습니다: ${dir}`);
      const added: unknown[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const repoDir of dirs) {
        try {
          const repo = await addRepo(db, repoDir);
          added.push(await syncRepo(db, repo));
          // diff 식별자는 뒤에서 — 등록 응답을 붙잡지 않는다
          indexCommitCode(db, repo).catch((error) => console.error(`[grimoire] ${repo.name} diff 색인 실패`, error));
        } catch (error) {
          failed.push({ path: repoDir, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (added.length === 0) throw new ToolError(failed.map((item) => item.error).join("\n"));
      return { added, failed };
    }
    case "record_note": {
      const text = str(args.text);
      if (!text) throw new ToolError("text가 필요합니다");
      const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : [];
      const note = addNote(db, { text, repoId: repoFilter(args.repo)?.id ?? null, tags, source: "mcp" });
      return { recorded: true, id: note.id, createdAt: note.created_at };
    }
    default:
      throw new ToolError(`알 수 없는 도구: ${name}`);
  }
}
