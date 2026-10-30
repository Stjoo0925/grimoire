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
 *   grimoire remove <repo>      레포와 색인 삭제
 *   grimoire install <client>   MCP 클라이언트 설정 자동 작성
 *   grimoire doctor             연결 문제 진단
 *   grimoire update             최신 GitHub 릴리스로 올리기
 *   grimoire mcp                MCP 서버 (stdio)
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { dbPath } from "./core/config";
import { fileContext, formatFileContext } from "./core/context";
import { formatImpact, impactOf, workingChanges } from "./core/impact";
import { openDb, type DB } from "./core/db";
import { myEmails, resolveAuthors } from "./core/identity";
import { indexCommitCode } from "./core/diffs";
import { addRepo, discoverRepos, listRepos, matchRepos, relativeToRepo, removeRepo, resolveRepoFile, syncRepo, type RepoRow } from "./core/indexer";
import { parseNotePaths } from "./core/note-doc";
import { AUTO_BIND_MAX, autoBindPaths } from "./core/note-autobind";
import { addNote } from "./core/notes";
import { commitDetail, repoOverview, repoSummaries } from "./core/overview";
import { search } from "./core/search";
import { pendingUpdate, refreshUpdateCache, VERSION } from "./core/update";
import { runMcpServer } from "./mcp/server";
import { resolveWorkspaceRoot } from "./mcp/workspace";
import { doctor, formatChecks } from "./setup/doctor";
import { installHooks } from "./setup/hooks";
import { refreshIntegrations } from "./setup/refresh";
import { installSkill, skillFile, skillState } from "./setup/skills";
import { CLIENTS, install, InstallError, type ClientName } from "./setup/install";
import { runUpdate } from "./setup/update";

const HELP = `grimoire — 로컬 git 이력을 AI 코딩 도구의 기억으로

사용법:
  grimoire add <path...>          레포 등록 + 인덱싱
  grimoire scan <dir> [--depth n] 하위 git 레포를 찾아 모두 등록
  grimoire sync [repo]            증분 동기화 (새 커밋만)
  grimoire repos                  등록된 레포 목록
  grimoire search <query>         검색  [--repo r] [--author me|email] [--since d] [--until d] [--limit n] [--json]
  grimoire show <sha>             커밋 상세 + diff  [--repo r] [--lines n] [--path p ...]
  grimoire overview <repo>        레포 개요  [--json]
  grimoire context <file>         파일을 고치기 전에 볼 것 — 최근 커밋·왜·같이 바뀌는 파일/테스트  [--repo r] [--json]
  grimoire impact [file...]       바뀐 파일이 건드릴 곳 — import·공변경·테스트  (파일을 안 주면 커밋 안 된 변경)  [--intent "작업"] [--repo r] [--limit n] [--json]
  grimoire note <text>            노트 남기기  [--repo r] [--tag t ...] [--path f ...] [--supersedes id]
                                  (--path: 그 파일·폴더를 고치기 전에 노트가 보인다. --tag rule: 규칙, 먼저 보인다.
                                   --supersedes: 규칙이 바뀌었을 때 옛 노트를 이 노트로 갈아 끼운다 — 경로·태그는 물려받는다)
  grimoire remove <repo>          레포와 색인 삭제

MCP 연결:
  grimoire install <client>       설정 자동 작성  client: ${CLIENTS.join(" | ")}
                                  [--project <dir>] 프로젝트 범위  [--dry-run] 쓰지 않고 보기
                                  [--hooks] claude-code: 편집 직전 맥락 주입·세션 캡처 훅을 ~/.claude/settings.json에
                                  [--remove-hooks] 그 훅만 뺀다
                                  [--skills] 커밋 전·리뷰·PR 때 impact를 부르는 스킬 — claude-code: ~/.claude/skills, codex·cursor: ~/.agents/skills
                                  [--remove-skills] 그 스킬 폴더만 지운다
  grimoire doctor                 연결 문제 진단
  grimoire mcp                    MCP 서버 (stdio) — 보통 클라이언트가 직접 띄웁니다

업데이트 (GitHub 릴리스):
  grimoire update                 최신 릴리스로 올리고 다시 빌드  [--check] 확인만  [--dry-run] 할 일만 보기
                                  하루 한 번 자동 확인 — 끄려면 GRIMOIRE_UPDATE_CHECK=0

버전: ${VERSION}
데이터: ${dbPath()}
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // `grimoire impact --help`처럼 명령 뒤에 붙여도 도움말 — 에이전트가 처음 쓰는 명령을 이렇게 확인한다
  if (!command || command === "help" || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
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
      intent: { type: "string" },
      author: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      lines: { type: "string" },
      depth: { type: "string" },
      tag: { type: "string", multiple: true },
      path: { type: "string", multiple: true },
      supersedes: { type: "string" },
      json: { type: "boolean" },
      project: { type: "string" },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
      hooks: { type: "boolean" },
      "remove-hooks": { type: "boolean" },
      skills: { type: "boolean" },
      "remove-skills": { type: "boolean" },
    },
  });

  // DB를 열기 전에 처리한다 — SQLite를 못 열어도(오래된 Node) doctor·install은 돌아야 한다.
  if (command === "doctor") {
    const checks = await doctor({ cliPath: __filename });
    print(formatChecks(checks));
    return checks.some((check) => check.level === "fail") ? 1 : 0;
  }
  if (command === "install") {
    if (values.skills || values["remove-skills"]) return cmdInstallSkills(positionals[0], values["dry-run"], values["remove-skills"]);
    if (values.hooks || values["remove-hooks"]) return cmdInstallHooks(positionals[0], values["dry-run"], values["remove-hooks"]);
    return cmdInstall(positionals[0], values.project, values["dry-run"]);
  }
  if (command === "hook") {
    // 설치 명령은 dist/hook.js를 직접 가리킨다(가벼운 진입점). 여기는 수동 확인용 — 같은 코드를 돌린다.
    require("./hook");
    return -1;
  }
  if (command === "update") {
    return runUpdate({ check: values.check, dryRun: values["dry-run"] });
  }
  if (command === "setup-refresh") {
    // 보통은 새 버전의 SessionStart 훅이 낡은 설정을 보고 떼어 낸 프로세스로 부른다(setup/refresh.ts)
    const result = await refreshIntegrations({ cliDir: path.dirname(__filename) });
    print(`훅: ${result.hooks} · 스킬: ${result.skill}`);
    return 0;
  }

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
          paths: values.path,
        });
        if ("error" in detail) {
          console.error(detail.error);
          for (const candidate of detail.candidates ?? []) console.error(`  ${candidate}`);
          return 1;
        }
        print(`${detail.repo} ${detail.sha}${detail.url ? `\n${detail.url}` : ""}`);
        print(`${detail.author}  ${detail.date}\n\n    ${detail.subject}${detail.body ? `\n\n    ${detail.body.split("\n").join("\n    ")}` : ""}\n`);
        for (const file of detail.files) print(file.binary ? `  ${file.path}  (binary)` : file.insertions === null ? `  ${file.path}` : `  ${file.path}  +${file.insertions} -${file.deletions}`);
        print("");
        print(detail.patch ?? detail.patchNote ?? "");
        if (detail.patchTruncated) {
          print(`… (diff가 ${detail.patchLines - 1}줄보다 길어 일부만 표시 — --lines로 늘리거나 --path로 파일을 고르세요)`);
        }
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
      case "context": {
        const target = path.resolve(need(positionals[0], "파일 경로"));
        // 레포 밖 워크트리에서 불러도 본 레포의 기억을 쓴다 (resolveRepoFile)
        const located = values.repo ? null : await resolveRepoFile(db, target);
        const repo = values.repo ? requireRepo(db, values.repo) : located?.repo;
        if (!repo) throw new UsageError("어느 레포의 파일인지 알 수 없습니다 — --repo로 지정하세요");
        const context = fileContext(db, repo.id, located?.relative ?? relativeToRepo(repo.path, target));
        if (values.json) return printJson(context);
        print(formatFileContext(context, { me: await myEmails(), budget: 2000 }) || `${context.path}: 이력에서 더 알려 줄 것이 없습니다`);
        return 0;
      }
      case "impact": {
        const given = positionals.map((item) => path.resolve(item));
        const located = values.repo ? null : await resolveRepoFile(db, given[0] ?? process.cwd());
        let repo = values.repo ? requireRepo(db, values.repo) : located?.repo;
        // MCP 없이 CLI로만 부르는 에이전트(Codex 스킬의 대안 경로)는 레포를 등록·동기화해 줄 서버가 없다 — 여기서 한다.
        // 기준은 MCP 서버의 작업 레포 자동 등록과 같다(홈·루트·임시 폴더 제외, GRIMOIRE_AUTO_ADD=0이면 끔)
        if (!values.repo && process.env.GRIMOIRE_AUTO_ADD !== "0") {
          if (repo) await syncRepo(db, repo);
          else {
            const root = await resolveWorkspaceRoot(process.cwd());
            if (root) {
              console.error(`처음 보는 레포라 등록하고 색인합니다: ${root}`);
              repo = await addRepo(db, root);
              await syncRepo(db, repo);
            }
          }
        }
        if (!repo) throw new UsageError("어느 레포의 변경인지 알 수 없습니다 — 레포 안에서 부르거나 --repo로 지정하세요");
        const changed = given.length > 0 ? await Promise.all(given.map(async (item) => (await resolveRepoFile(db, item))?.relative ?? relativeToRepo(repo.path, item))) : await workingChanges(process.cwd());
        const impact = impactOf(db, repo.id, changed, { limit: Number.parseInt(values.limit ?? "10", 10) || 10, intent: values.intent });
        if (values.json) return printJson(impact);
        print(formatImpact(impact, impact.items.length));
        return 0;
      }
      case "note": {
        // --path가 있으면 레포가 필요하다 — --repo, 아니면 절대경로가 속한 레포, 아니면 현재 폴더의 레포
        const given = values.path ?? [];
        const located = values.repo ? null : await resolveRepoFile(db, given.find((item) => path.isAbsolute(item)) ?? process.cwd());
        const repo = values.repo ? requireRepo(db, values.repo) : given.length > 0 ? located?.repo : undefined;
        if (given.length > 0 && !repo) throw new UsageError("--path를 묶을 레포를 알 수 없습니다 — --repo로 지정하세요");
        const text = need(positionals.join(" "), "노트 내용");
        const supersedes = values.supersedes !== undefined ? Number.parseInt(values.supersedes, 10) : undefined;
        if (supersedes !== undefined && !Number.isInteger(supersedes)) throw new UsageError("--supersedes는 노트 번호여야 합니다");
        let bound = repo;
        let bindPaths: string[] | undefined = repo ? given.map((item) => (path.isAbsolute(item) ? relativeToRepo(repo.path, item) : item)) : [];
        let autoNote = "";
        // --path를 안 줬으면 지금 작업 폴더에서 바뀐 소스 파일에 묶는다 — 대신하는 노트가 있으면 그 노트의 경로를 물려받는다
        if (given.length === 0 && supersedes !== undefined) bindPaths = undefined;
        else if (given.length === 0) {
          const target = values.repo ? repo : (await resolveRepoFile(db, process.cwd()))?.repo;
          if (target) {
            const auto = await autoBindPaths(db, target.id, text, values.repo ? target.path : process.cwd());
            if (auto.paths.length > 0) {
              bound = target;
              bindPaths = auto.paths;
              autoNote = " [바뀐 파일에 자동으로 묶음]";
            } else if (auto.tooMany) autoNote = ` (바뀐 소스 파일이 ${AUTO_BIND_MAX}개를 넘어 파일에 묶지 않았습니다)`;
          }
        }
        const note = addNote(db, { text, repoId: bound?.id ?? null, tags: values.tag, paths: bindPaths, supersedes, source: "cli" });
        const paths = parseNotePaths(note.paths).map((item) => item.path);
        print(`노트 #${note.id} 저장${paths.length > 0 ? ` (파일: ${paths.join(", ")})` : ""}${supersedes !== undefined ? ` — #${supersedes} 대신` : ""}${autoNote}${note.redacted ? " (비밀로 보이는 값은 [redacted]로 바꿨습니다)" : ""}`);
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

async function cmdInstall(client: string | undefined, project: string | undefined, dryRun: boolean | undefined): Promise<number> {
  if (!client || !(CLIENTS as readonly string[]).includes(client)) {
    throw new UsageError(`클라이언트를 고르세요: ${CLIENTS.join(" | ")}`);
  }
  try {
    const result = await install(client as ClientName, {
      cliPath: __filename,
      project: project ? path.resolve(project) : undefined,
      dryRun,
    });
    const target = result.file ?? "claude CLI (사용자 범위)";
    if (dryRun) {
      print(`[dry-run] ${target}에 다음을 넣습니다:`);
      print(result.command ?? result.preview ?? JSON.stringify({ mcpServers: { grimoire: result.spec } }, null, 2));
      if (result.permissions) {
        print(
          result.permissions.added.length > 0
            ? `[dry-run] ${result.permissions.file}의 permissions.allow에 더합니다: ${result.permissions.added.join(", ")}`
            : `[dry-run] ${result.permissions.file}: 읽기 도구 권한이 이미 있습니다`,
        );
      }
      return 0;
    }
    print(result.unchanged ? `이미 같은 설정입니다: ${target}` : `✓ ${client}에 등록했습니다: ${target}`);
    if (result.command) print(`  실행: ${result.command}`);
    if (result.backup) print(`  이전 설정 백업: ${result.backup}`);
    if (result.permissions) {
      const { file, added, backup } = result.permissions;
      print(added.length > 0 ? `  읽기 도구 승인 생략: ${file}에 ${added.length}개 추가` : `  읽기 도구 권한: 이미 있음 (${file})`);
      if (backup) print(`  이전 설정 백업: ${backup}`);
    }
    if (result.approved) print(`  읽기 도구 승인 생략: ${result.approved.join(", ")}`);
    if (result.verified === false) print("  codex 명령을 찾지 못해 Codex가 설정을 읽는지는 확인하지 못했습니다.");
    print(`  node: ${result.spec.command}`);
    print(`  다음: ${result.next}`);
    print("  확인: grimoire doctor");
    return 0;
  } catch (error) {
    if (error instanceof InstallError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function cmdInstallHooks(client: string | undefined, dryRun: boolean | undefined, remove: boolean | undefined): Promise<number> {
  if (client !== "claude-code") throw new UsageError("훅은 claude-code에만 설치합니다: grimoire install claude-code --hooks");
  try {
    const result = await installHooks({ hookPath: path.join(path.dirname(__filename), "hook.js"), dryRun, remove });
    if (dryRun) {
      print(`[dry-run] ${result.file}의 hooks.${result.events.join("/")}에 ${remove ? "서 뺍니다" : "다음 명령을 넣습니다"}:`);
      if (!remove) print(`  ${result.command}`);
      return 0;
    }
    if (result.unchanged) print(`이미 같은 설정입니다: ${result.file}`);
    else if (remove) print(`✓ 훅을 뺐습니다: ${result.file}`);
    else {
      print(`✓ Claude Code 훅을 넣었습니다: ${result.file}`);
      print(`  이벤트: ${result.events.join(", ")}`);
      print(`  명령: ${result.command}`);
      print("  편집 직전에 그 파일의 최근 커밋·왜·같이 바뀌는 파일/테스트를 400자 안에 건넵니다. 끄려면 GRIMOIRE_HOOKS=0, 캡처만 끄려면 GRIMOIRE_CAPTURE=0.");
    }
    if (result.backup) print(`  이전 설정 백업: ${result.backup}`);
    print("  확인: grimoire doctor");
    return 0;
  } catch (error) {
    if (error instanceof InstallError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function cmdInstallSkills(client: string | undefined, dryRun: boolean | undefined, remove: boolean | undefined): number {
  if (client !== "claude-code" && client !== "codex" && client !== "cursor") {
    throw new UsageError("스킬은 claude-code · codex · cursor에 설치합니다: grimoire install <client> --skills");
  }
  const target = client === "claude-code" ? "claude" : "agents";
  // Cursor는 ~/.claude/skills도 읽는다 — Claude Code용이 이미 있으면 같은 이름을 하나 더 두지 않는다
  const claudeSkill = skillState(undefined, "claude");
  if (client === "cursor" && !remove && (claudeSkill === "current" || claudeSkill === "stale")) {
    print(`Cursor는 Claude Code 스킬 폴더도 읽어 이미 보입니다: ${skillFile(undefined, "claude")}`);
    return 0;
  }
  const result = installSkill({ dryRun, remove, target });
  if (dryRun) {
    print(`[dry-run] ${result.file} ${remove ? "폴더를 지웁니다" : result.unchanged ? "— 이미 같은 내용입니다" : "을 씁니다"}`);
    return 0;
  }
  if (result.unchanged) print(remove ? `설치돼 있지 않습니다: ${result.file}` : `이미 같은 스킬입니다: ${result.file}`);
  else if (remove) print(`✓ 스킬을 지웠습니다: ${path.dirname(result.file)}`);
  else {
    if (target === "claude") {
      print(`✓ Claude Code 스킬을 넣었습니다: ${result.file}`);
      print("  커밋·리뷰·PR 때 Claude가 고르거나, /grimoire-impact로 직접 부릅니다. 새 세션부터 보입니다.");
    } else {
      print(`✓ 스킬을 넣었습니다: ${result.file} (Codex·Cursor가 읽는 폴더)`);
      print(`  커밋·리뷰·PR 때 에이전트가 고르거나, ${client === "codex" ? "$grimoire-impact" : "/grimoire-impact"}로 직접 부릅니다. 새 세션부터 보입니다.`);
      print("  업데이트 뒤에는 새 버전의 grimoire MCP 서버가 뜰 때 이 파일을 맞춥니다.");
    }
  }
  if (result.backup) print(`  이전 파일 백업: ${result.backup}`);
  if (!remove) print("  확인: grimoire doctor");
  return 0;
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
      // diff 식별자는 메타 색인 뒤에 채운다 (MCP 서버는 같은 일을 뒤에서 한다)
      const code = await indexCommitCode(db, repo);
      print(`✓ ${result.repo}: 새 커밋 ${result.added} / 전체 ${result.total}, 기술 ${result.tech}${code > 0 ? `, diff 색인 ${code}` : ""}`);
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
  if (result.hits.length === 0) print("결과 없음");
  for (const hit of result.hits) {
    // 코드 파일: ref가 경로이고 date는 색인 시각이라 커밋과 다르게 보여 준다
    if (hit.kind === "file") {
      print(`${hit.repo}  ${hit.ref}${hit.lines ? `  (${hit.lines}줄)` : ""}`);
      if (hit.symbols && hit.symbols.length > 0) print(`    ${hit.symbols.join("  ")}`);
      if (hit.lastCommit) print(`    최근 변경: ${day(hit.lastCommit.date)} ${hit.lastCommit.sha.slice(0, 8)} ${hit.lastCommit.title}`);
      continue;
    }
    const where = hit.kind === "note" ? `note #${hit.ref}${hit.supersededBy ? ` (→ #${hit.supersededBy}로 바뀜)` : ""}` : `${hit.repo} ${hit.ref.slice(0, 8)}`;
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
  const matches = matchRepos(db, query);
  if (matches.length === 0) throw new UsageError(`레포를 찾지 못했습니다: ${query} (grimoire repos로 확인)`);
  if (matches.length > 1) {
    throw new UsageError(`'${query}'와 맞는 레포가 여럿입니다: ${matches.map((repo) => repo.name).join(", ")} — 정확한 이름을 주세요`);
  }
  return matches[0];
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

/** 끝나고 새 버전을 알려 줄 명령 — mcp(stdout이 통신로)·doctor·update는 따로 다룬다 */
const NOTICE_COMMANDS = new Set(["add", "scan", "sync", "repos", "search", "show", "overview", "note", "remove"]);

/** 명령과 나란히 하루 한 번 업데이트를 확인하고, 새 버전이 있으면 stderr로 한 줄 알린다 */
async function runWithUpdateNotice(argv: string[]): Promise<number> {
  const checking = NOTICE_COMMANDS.has(argv[0] ?? "") ? refreshUpdateCache({ timeoutMs: 1_500 }) : null;
  const code = await main(argv);
  if (checking) {
    await checking;
    const update = pendingUpdate();
    if (update) console.error(`\n새 버전 ${update.latest}이 있습니다 (지금 ${update.current}) — grimoire update`);
  }
  return code;
}

runWithUpdateNotice(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
