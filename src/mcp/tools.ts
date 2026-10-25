/**
 * MCP 도구 정의와 실행 (SDK 배선과 분리).
 *
 *   search_memory      — 과거 커밋·노트 검색 (근거 목록)
 *   show_commit        — 커밋 하나의 메시지·파일·diff
 *   get_repo_overview  — 레포의 기술 스택·활동·많이 건드린 곳·최근 주요 커밋
 *   list_repos         — 인덱싱된 레포 목록
 *   add_repo           — 레포(또는 디렉터리 아래 레포 전부) 등록 + 인덱싱
 *   record_note        — 대화 중 배운 것·결정을 노트로 남김
 *
 * 등록된 레포가 하나도 없으면 결과에 `hint`를 실어, AI가 사용자에게 등록 방법을 안내하게 한다.
 * 새 버전이 있으면 세션에 한 번 같은 `hint`로 업데이트를 알린다.
 */
import fs from "node:fs";
import path from "node:path";

import type { DB } from "../core/db";
import { resolveAuthors } from "../core/identity";
import { addRepo, discoverRepos, findRepo, listRepos, syncRepo } from "../core/indexer";
import { addNote } from "../core/notes";
import { commitDetail, repoOverview, repoSummaries } from "../core/overview";
import { search } from "../core/search";
import { slimCommit, slimOverview, slimRepos, slimSearch } from "./format";

export interface ToolContext {
  db: DB;
  /** 내 작성자 이메일 */
  me: string[];
  /** 서버의 작업 디렉터리 — Claude Code는 보통 열려 있는 프로젝트 폴더다 */
  cwd: string;
  /** 새 버전 안내 — 세션에 한 번만 문자열을 돌려준다 (서버가 채움) */
  updateHint?: () => string | undefined;
}

/** 레포가 없을 때 AI가 사용자에게 전할 안내. 레포가 있으면 undefined. */
export function emptyHint(context: ToolContext): string | undefined {
  if (listRepos(context.db).length > 0) return undefined;
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
 */
export const TOOLS = [
  {
    name: "search_memory",
    description:
      "내 코드의 핀포인트 검색: 현재 코드 파일(심볼:줄)·과거 커밋·노트를 한 번에. \"X 어디 있지?\" \"예전에 X 어떻게 했지?\" 둘 다. 결과의 파일:줄·sha를 근거로 인용.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        repo: { type: "string" },
        author: { type: "string", description: "me | 이메일" },
        since: { type: "string", description: "YYYY-MM-DD" },
        until: { type: "string", description: "YYYY-MM-DD" },
        kind: { type: "string", enum: ["file", "commit", "note"] },
        limit: { type: "number", description: "기본 8" },
      },
      required: ["query"],
    },
  },
  {
    name: "show_commit",
    description: "커밋의 메시지·변경 파일·diff. diff는 앞부분만 — 특정 파일은 paths로.",
    inputSchema: {
      type: "object",
      properties: {
        sha: { type: "string" },
        repo: { type: "string" },
        paths: { type: "array", items: { type: "string" }, description: "파일 경로 일부" },
        max_diff_lines: { type: "number", description: "기본 120" },
      },
      required: ["sha"],
    },
  },
  {
    name: "get_repo_overview",
    description: "레포 개요: 기술 스택·활동 기간·많이 건드린 곳·최근 주요 커밋.",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "list_repos",
    description: "인덱싱된 레포 목록.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_repo",
    description: "사용자가 원하는 로컬 git 레포 등록·인덱싱. scan: true면 폴더 아래 레포 전부.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, scan: { type: "boolean" } },
      required: ["path"],
    },
  },
  {
    name: "record_note",
    description: "배운 것·결정을 노트로 저장 (이후 검색됨). 사용자가 기억해 두라고 할 때.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "첫 줄이 제목" },
        repo: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

type Args = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class ToolError extends Error {}

/** 검색 결과 기본 개수 — 응답 토큰을 아끼려고 코어 기본값(10)보다 작게 */
const SEARCH_LIMIT = 8;

/** 도구를 실행하고 JSON 직렬화 가능한(간결한) 결과를 돌려준다. 잘못된 인자는 ToolError. */
export async function callTool(context: ToolContext, name: string, args: Args = {}): Promise<unknown> {
  const { db, me } = context;
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
      const result = await search(db, query, {
        repoId: repoFilter(args.repo)?.id,
        authors,
        since: str(args.since),
        until: str(args.until),
        kind,
        limit: num(args.limit) ?? SEARCH_LIMIT,
      });
      return withHint(slimSearch(result, me));
    }
    case "show_commit": {
      const sha = str(args.sha);
      if (!sha) throw new ToolError("sha가 필요합니다");
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((item): item is string => typeof item === "string")
        : typeof args.paths === "string"
          ? [args.paths]
          : [];
      const detail = await commitDetail(db, sha, {
        repoId: repoFilter(args.repo)?.id,
        maxDiffLines: num(args.max_diff_lines),
        paths,
      });
      if ("error" in detail) throw new ToolError([detail.error, ...(detail.candidates ?? [])].join("\n"));
      return slimCommit(detail, me);
    }
    case "get_repo_overview": {
      const repo = repoFilter(args.repo);
      if (!repo) throw new ToolError("repo가 필요합니다");
      return slimOverview(repoOverview(db, repo, me));
    }
    case "list_repos":
      return withHint({ me, repos: slimRepos(repoSummaries(db, me)) });
    case "add_repo": {
      const target = str(args.path);
      if (!target) throw new ToolError("path가 필요합니다");
      const dir = path.resolve(context.cwd, target.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      if (!fs.existsSync(dir)) throw new ToolError(`경로가 없습니다: ${dir}`);
      const dirs = args.scan === true ? discoverRepos(dir) : [dir];
      if (dirs.length === 0) throw new ToolError(`git 레포를 찾지 못했습니다: ${dir}`);
      const added: unknown[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const repoDir of dirs) {
        try {
          added.push(await syncRepo(db, await addRepo(db, repoDir)));
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
