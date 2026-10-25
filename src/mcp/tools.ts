/**
 * MCP 도구 정의와 실행 (SDK 배선과 분리).
 *
 *   search_memory      — 과거 커밋·노트 검색 (근거 목록)
 *   show_commit        — 커밋 하나의 메시지·파일·diff
 *   get_repo_overview  — 레포의 기술 스택·활동·많이 건드린 곳·최근 주요 커밋
 *   list_repos         — 인덱싱된 레포 목록
 *   record_note        — 대화 중 배운 것·결정을 노트로 남김 (유일한 쓰기 경로)
 */
import type { DB } from "../core/db";
import { resolveAuthors } from "../core/identity";
import { findRepo } from "../core/indexer";
import { addNote } from "../core/notes";
import { commitDetail, repoOverview, repoSummaries } from "../core/overview";
import { search } from "../core/search";

export interface ToolContext {
  db: DB;
  /** 내 작성자 이메일 */
  me: string[];
}

const DATE_HINT = "ISO 날짜 (예: 2024-01-01)";

export const TOOLS = [
  {
    name: "search_memory",
    description:
      "개발자의 과거 git 커밋과 노트를 검색합니다. '예전에 X를 어떻게 구현/해결했지?', '어느 레포에서 Y를 썼지?' 같은 질문에 쓰세요. " +
      "결과는 근거(레포·sha·날짜·작성자·변경 파일·커밋 링크)이며, 자세한 내용은 show_commit으로 diff를 보세요. " +
      "키워드는 기술명·파일명·한국어/영어 단어 모두 됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "찾을 내용 (예: 'jwt refresh token', '동시성 락')" },
        repo: { type: "string", description: "레포 이름으로 좁히기 (부분 일치)" },
        author: { type: "string", description: "'me'(기본: 전체) 또는 이메일. 내 작업만 보려면 'me'" },
        since: { type: "string", description: `이 날짜 이후 — ${DATE_HINT}` },
        until: { type: "string", description: `이 날짜 이전 — ${DATE_HINT}` },
        kind: { type: "string", enum: ["commit", "note"], description: "문서 종류" },
        limit: { type: "number", description: "결과 수 (기본 10, 최대 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "show_commit",
    description:
      "커밋 하나의 전체 메시지, 변경 파일, diff를 로컬 레포에서 읽어 옵니다. search_memory 결과의 sha를 넘기세요.",
    inputSchema: {
      type: "object",
      properties: {
        sha: { type: "string", description: "커밋 sha (7자 이상 접두 가능)" },
        repo: { type: "string", description: "같은 sha가 여러 레포에 있을 때 레포 이름" },
        max_diff_lines: { type: "number", description: "diff 최대 줄 수 (기본 400, 최대 3000)" },
      },
      required: ["sha"],
    },
  },
  {
    name: "get_repo_overview",
    description:
      "레포 하나의 개요: 기술 스택(매니페스트 기준), 분기별 활동, 많이 건드린 디렉터리, 주요 작성자, 최근 주요 커밋.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "레포 이름 또는 경로 (부분 일치)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "list_repos",
    description: "인덱싱된 레포 목록과 커밋 수·기간을 돌려줍니다.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "record_note",
    description:
      "대화 중 알게 된 것·내린 결정·해결 방법을 노트로 남깁니다. 이후 search_memory에서 커밋과 함께 검색됩니다. " +
      "사용자가 기억해 두라고 하거나 중요한 결정을 내렸을 때 쓰세요.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "노트 내용 (첫 줄이 제목)" },
        repo: { type: "string", description: "관련 레포 이름 (선택)" },
        tags: { type: "array", items: { type: "string" }, description: "태그 (선택)" },
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

/** 도구를 실행하고 JSON 직렬화 가능한 결과를 돌려준다. 잘못된 인자는 ToolError. */
export async function callTool(context: ToolContext, name: string, args: Args = {}): Promise<unknown> {
  const { db, me } = context;

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
      const kind = args.kind === "commit" || args.kind === "note" ? args.kind : undefined;
      const authors = resolveAuthors(str(args.author), me);
      if (authors && authors.length === 0) {
        throw new ToolError("내 이메일을 알 수 없습니다. GRIMOIRE_ME 또는 git config user.email을 설정하세요.");
      }
      return search(db, query, {
        repoId: repoFilter(args.repo)?.id,
        authors,
        since: str(args.since),
        until: str(args.until),
        kind,
        limit: num(args.limit),
      });
    }
    case "show_commit": {
      const sha = str(args.sha);
      if (!sha) throw new ToolError("sha가 필요합니다");
      return commitDetail(db, sha, {
        repoId: repoFilter(args.repo)?.id,
        maxDiffLines: num(args.max_diff_lines),
      });
    }
    case "get_repo_overview": {
      const repo = repoFilter(args.repo);
      if (!repo) throw new ToolError("repo가 필요합니다");
      return repoOverview(db, repo, me);
    }
    case "list_repos":
      return { me, repos: repoSummaries(db, me) };
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
