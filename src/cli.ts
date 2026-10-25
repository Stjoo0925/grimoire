#!/usr/bin/env node
/**
 * grimoire CLI — 레포 등록·동기화·검색과 MCP 서버 기동.
 *
 *   grimoire add <path...>      레포 등록 + 인덱싱
 *   grimoire scan <dir>         하위 git 레포를 찾아 모두 등록
 *   grimoire sync [repo]        증분 동기화 (새 커밋만)
 *   grimoire repos              등록된 레포
 *   grimoire search <query>     검색
 *   grimoire show <sha>         커밋 상세 + diff
 *   grimoire overview <repo>    레포 개요
 *   grimoire note <text>        노트 남기기
 *   grimoire embed              로컬 임베딩 채우기 (선택, Ollama)
 *   grimoire remove <repo>      레포와 색인 삭제
 *   grimoire mcp                MCP 서버 (stdio)
 */
import { parseArgs } from "node:util";

import { dbPath, embedModel } from "./core/config";
import { openDb, type DB } from "./core/db";
import { embedPending } from "./core/embed";
import { myEmails, resolveAuthors } from "./core/identity";
import { addRepo, discoverRepos, findRepo, listRepos, removeRepo, syncRepo, type RepoRow } from "./core/indexer";
import { addNote } from "./core/notes";
import { commitDetail, repoOverview, repoSummaries } from "./core/overview";
import { search } from "./core/search";
import { runMcpServer } from "./mcp/server";

const HELP = `grimoire — 로컬 git 이력을 AI 코딩 도구의 기억으로

사용법:
  grimoire add <path...>          레포 등록 + 인덱싱
  grimoire scan <dir> [--depth n] 하위 git 레포를 찾아 모두 등록
  grimoire sync [repo]            증분 동기화 (새 커밋만)
  grimoire repos                  등록된 레포 목록
  grimoire search <query>         검색  [--repo r] [--author me|email] [--since d] [--until d] [--limit n] [--json]
  grimoire show <sha>             커밋 상세 + diff  [--repo r] [--lines n]
  grimoire overview <repo>        레포 개요  [--json]
  grimoire note <text>            노트 남기기  [--repo r] [--tag t ...]
  grimoire embed                  로컬 임베딩 채우기 (Ollama ${embedModel()})
  grimoire remove <repo>          레포와 색인 삭제
  grimoire mcp                    MCP 서버 (stdio)

데이터: ${dbPath()}
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "mcp") {
    await runMcpServer();
    return -1; // 서버가 stdio를 붙잡고 있으므로 종료하지 않는다
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      author: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      lines: { type: "string" },
      depth: { type: "string" },
      tag: { type: "string", multiple: true },
      json: { type: "boolean" },
    },
  });

  const db = openDb(dbPath());
  try {
    switch (command) {
      case "add":
        return await cmdAdd(db, positionals);
      case "scan":
        return await cmdAdd(db, discoverRepos(need(positionals[0], "디렉터리"), toInt(values.depth) ?? 4));
      case "sync":
        return await cmdSync(db, positionals[0] ? [requireRepo(db, positionals[0])] : listRepos(db));
      case "repos":
        return cmdRepos(db, await myEmails(), values.json);
      case "search":
        return await cmdSearch(db, positionals.join(" "), values);
      case "show": {
        const detail = await commitDetail(db, need(positionals[0], "sha"), {
          repoId: values.repo ? requireRepo(db, values.repo).id : undefined,
          maxDiffLines: toInt(values.lines),
        });
        if ("error" in detail) {
          console.error(detail.error);
          for (const candidate of detail.candidates ?? []) console.error(`  ${candidate}`);
          return 1;
        }
        print(`${detail.repo} ${detail.sha}${detail.url ? `\n${detail.url}` : ""}`);
        print(detail.patch ?? detail.patchNote ?? "");
        if (detail.patchTruncated) print("… (diff 일부만 표시 — --lines로 늘릴 수 있음)");
        return 0;
      }
      case "overview": {
        const overview = repoOverview(db, requireRepo(db, need(positionals[0], "repo")), await myEmails());
        if (values.json) return printJson(overview);
        print(`${overview.name}  (${overview.commits} commits, 내 커밋 ${overview.mine})  ${overview.path}`);
        print(`기간: ${day(overview.firstCommit)} ~ ${day(overview.lastCommit)}`);
        for (const group of overview.tech) print(`  [${group.category}] ${group.items.join(", ")}`);
        print("많이 건드린 곳: " + overview.topDirectories.map((dir) => `${dir.path}(${dir.commits})`).join(", "));
        print("최근 주요 커밋:");
        for (const commit of overview.recentCommits) print(`  ${day(commit.date)} ${commit.sha.slice(0, 8)} ${commit.subject}`);
        return 0;
      }
      case "note": {
        const note = addNote(db, {
          text: need(positionals.join(" "), "노트 내용"),
          repoId: values.repo ? requireRepo(db, values.repo).id : null,
          tags: values.tag,
          source: "cli",
        });
        print(`노트 #${note.id} 저장`);
        return 0;
      }
      case "embed": {
        print(`임베딩 중 (${embedModel()})…`);
        const result = await embedPending(db);
        if (!result.ok) {
          console.error(
            `임베딩 실패: ${result.reason}\n` +
              `  Ollama가 떠 있는지, 'ollama pull ${result.model}'을 했는지 확인하세요. (${result.embedded}개는 저장됨)`,
          );
          return 1;
        }
        print(`문서 ${result.embedded}개 임베딩 완료`);
        return 0;
      }
      case "remove": {
        const repo = requireRepo(db, need(positionals[0], "repo"));
        removeRepo(db, repo);
        print(`${repo.name} 삭제 (${repo.path})`);
        return 0;
      }
      default:
        console.error(`알 수 없는 명령: ${command}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } finally {
    db.close();
  }
}

async function cmdAdd(db: DB, paths: string[]): Promise<number> {
  if (paths.length === 0) throw new UsageError("레포 경로를 하나 이상 주세요");
  const repos: RepoRow[] = [];
  let failed = 0;
  for (const dir of paths) {
    try {
      repos.push(await addRepo(db, dir));
    } catch (error) {
      failed++;
      console.error(error instanceof Error ? error.message : error);
    }
  }
  return (await cmdSync(db, repos)) || (failed > 0 ? 1 : 0);
}

async function cmdSync(db: DB, repos: RepoRow[]): Promise<number> {
  if (repos.length === 0) {
    print("등록된 레포가 없습니다. grimoire add <path> 또는 grimoire scan <dir>로 시작하세요.");
    return 0;
  }
  let failed = 0;
  for (const repo of repos) {
    try {
      const result = await syncRepo(db, repo);
      print(`✓ ${result.repo}: 새 커밋 ${result.added} / 전체 ${result.total}, 기술 ${result.tech}`);
    } catch (error) {
      failed++;
      console.error(`✗ ${repo.name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

function cmdRepos(db: DB, me: string[], json?: boolean): number {
  const repos = repoSummaries(db, me);
  if (json) return printJson({ me, repos });
  if (repos.length === 0) print("등록된 레포가 없습니다.");
  for (const repo of repos) {
    print(
      `${repo.name.padEnd(28)} ${String(repo.commits).padStart(6)} commits (내 ${repo.mine})  ` +
        `${day(repo.firstCommit)} ~ ${day(repo.lastCommit)}  ${repo.path}`,
    );
  }
  print(`\n내 이메일: ${me.join(", ") || "(없음 — GRIMOIRE_ME로 지정)"}`);
  return 0;
}

async function cmdSearch(
  db: DB,
  query: string,
  values: { repo?: string; author?: string; since?: string; until?: string; limit?: string; json?: boolean },
): Promise<number> {
  const result = await search(db, need(query.trim(), "검색어"), {
    repoId: values.repo ? requireRepo(db, values.repo).id : undefined,
    authors: resolveAuthors(values.author, await myEmails()),
    since: values.since,
    until: values.until,
    limit: toInt(values.limit),
  });
  if (values.json) return printJson(result);
  if (result.semanticNote) console.error(`(${result.semanticNote})`);
  if (result.hits.length === 0) print("결과 없음");
  for (const hit of result.hits) {
    const where = hit.kind === "note" ? `note #${hit.ref}` : `${hit.repo} ${hit.ref.slice(0, 8)}`;
    print(`${day(hit.date)}  ${where}  ${hit.title}`);
    if (hit.files.length > 0) print(`    ${hit.files.slice(0, 4).join("  ")}${hit.files.length > 4 ? " …" : ""}`);
    if (hit.url) print(`    ${hit.url}`);
  }
  return 0;
}

class UsageError extends Error {}

function need(value: string | undefined, what: string): string {
  if (!value || !value.trim()) throw new UsageError(`${what}이(가) 필요합니다`);
  return value;
}

function requireRepo(db: DB, query: string): RepoRow {
  const repo = findRepo(db, query);
  if (!repo) throw new UsageError(`레포를 찾지 못했습니다: ${query} (grimoire repos로 확인)`);
  return repo;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "-");
const print = (line: string) => process.stdout.write(line + "\n");
const printJson = (value: unknown) => {
  print(JSON.stringify(value, null, 2));
  return 0;
};

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
