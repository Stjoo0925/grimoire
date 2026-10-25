/**
 * `grimoire doctor` — 연결이 안 될 때 원인을 한 번에 보여 준다.
 *
 * 각 점검은 독립적이다. 앞의 점검이 실패해도(예: SQLite 모듈 로드 실패) 나머지는 계속 돈다.
 */
import fs from "node:fs";

import { dbPath, embedModel, grimoireHome, ollamaHost, type Env } from "../core/config";
import { loadSqlite, openDb } from "../core/db";
import { runGit } from "../core/git";
import { myEmails } from "../core/identity";
import { listRepos } from "../core/indexer";
import { CLIENTS, configPath, hasCommand, readInstalled, run, SERVER_NAME } from "./install";

export type Level = "ok" | "warn" | "fail";

export interface Check {
  level: Level;
  title: string;
  detail?: string;
  /** 고치는 방법 */
  fix?: string;
}

export interface DoctorOptions {
  cliPath: string;
  env?: Env;
  home?: string;
  /** Ollama 점검에 쓰는 fetch (테스트 주입용) */
  fetchImpl?: typeof fetch;
}

const OLLAMA_TIMEOUT_MS = 1_500;

export async function doctor(options: DoctorOptions): Promise<Check[]> {
  const env = options.env ?? process.env;
  const checks: Check[] = [];

  // 1. Node와 네이티브 SQLite 모듈
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 20
      ? { level: "ok", title: `Node ${process.version}`, detail: process.execPath }
      : { level: "fail", title: `Node ${process.version} — 20 이상이 필요합니다`, detail: process.execPath },
  );
  let sqliteOk = false;
  try {
    loadSqlite();
    sqliteOk = true;
    checks.push({ level: "ok", title: "SQLite 모듈 로드", detail: `ABI ${process.versions.modules}` });
  } catch (error) {
    checks.push({
      level: "fail",
      title: "SQLite 모듈을 열지 못했습니다",
      detail: error instanceof Error ? error.message : String(error),
      fix: "npm rebuild better-sqlite3",
    });
  }

  // 2. git
  try {
    const version = (await runGit(process.cwd(), ["--version"])).trim();
    checks.push({ level: "ok", title: version });
  } catch {
    checks.push({ level: "fail", title: "git을 찾지 못했습니다", fix: "git을 설치하세요 (macOS: xcode-select --install)" });
  }

  // 3. DB와 레포
  const file = dbPath(env);
  if (sqliteOk) {
    try {
      const db = openDb(file);
      try {
        const repos = listRepos(db);
        const commits = (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number }).n;
        checks.push({ level: "ok", title: "데이터베이스", detail: `${file} (커밋 ${commits}개)` });
        if (repos.length === 0) {
          checks.push({
            level: "warn",
            title: "등록된 레포가 없습니다 — 연결돼도 검색 결과가 비어 있습니다",
            fix: "grimoire scan <폴더>  또는  grimoire add <레포>",
          });
        } else {
          const missing = repos.filter((repo) => !fs.existsSync(repo.path));
          checks.push({ level: "ok", title: `레포 ${repos.length}개 등록` });
          if (missing.length > 0) {
            checks.push({
              level: "warn",
              title: `경로가 사라진 레포 ${missing.length}개`,
              detail: missing.map((repo) => repo.path).join(", "),
              fix: missing.map((repo) => `grimoire remove ${repo.name}`).join("  /  "),
            });
          }
          const neverSynced = repos.filter((repo) => !repo.synced_at);
          if (neverSynced.length > 0) {
            checks.push({ level: "warn", title: `한 번도 동기화되지 않은 레포 ${neverSynced.length}개`, fix: "grimoire sync" });
          }
        }
        const embedded = (db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?").get(embedModel(env)) as { n: number }).n;
        checks.push(await ollamaCheck(env, embedded, options.fetchImpl));
      } finally {
        db.close();
      }
    } catch (error) {
      checks.push({
        level: "fail",
        title: "데이터베이스를 열지 못했습니다",
        detail: `${file}: ${error instanceof Error ? error.message : error}`,
        fix: `${grimoireHome(env)} 폴더 권한을 확인하거나 GRIMOIRE_HOME을 다른 곳으로 지정하세요`,
      });
    }
  }

  // 4. "나"
  const me = await myEmails(env);
  checks.push(
    me.length > 0
      ? { level: "ok", title: "내 이메일", detail: me.join(", ") }
      : {
          level: "warn",
          title: "내 이메일을 모릅니다 — author: \"me\" 필터가 안 됩니다",
          fix: 'git config --global user.email "me@example.com"  또는  GRIMOIRE_ME 설정',
        },
  );

  // 5. 클라이언트 설정
  checks.push(...(await clientChecks(options, env)));
  return checks;
}

async function ollamaCheck(env: Env, embedded: number, fetchImpl: typeof fetch = fetch): Promise<Check> {
  const host = ollamaHost(env);
  const model = embedModel(env);
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    const body = (await res.json()) as { models?: { name?: string }[] };
    const installed = (body.models ?? []).some((item) => item.name === model || item.name?.startsWith(`${model}:`));
    if (!installed) {
      return { level: "warn", title: `시맨틱 검색 꺼짐 — Ollama에 ${model}이 없습니다 (선택)`, fix: `ollama pull ${model} && grimoire embed` };
    }
    return embedded > 0
      ? { level: "ok", title: "시맨틱 검색", detail: `${model}, 임베딩 ${embedded}개` }
      : { level: "warn", title: "시맨틱 검색 준비됨 — 아직 임베딩이 없습니다 (선택)", fix: "grimoire embed" };
  } catch {
    return {
      level: "warn",
      title: "시맨틱 검색 꺼짐 — 로컬 Ollama에 닿지 않습니다 (선택, 키워드 검색은 정상)",
      detail: host,
      fix: `Ollama 설치 후 ollama pull ${model} && grimoire embed`,
    };
  }
}

async function clientChecks(options: DoctorOptions, env: Env): Promise<Check[]> {
  const checks: Check[] = [];
  let anyInstalled = false;

  for (const client of CLIENTS) {
    const file = configPath(client, { home: options.home });
    if (!file) continue;
    const spec = fs.existsSync(file) ? readInstalled(file) : null;
    if (!spec) continue;
    anyInstalled = true;
    checks.push(specCheck(client, file, spec, options.cliPath, env));
  }

  if (await hasCommand("claude")) {
    try {
      const listed = await run("claude", ["mcp", "get", SERVER_NAME]);
      anyInstalled = true;
      const wrongNode = !listed.includes(process.execPath);
      checks.push(
        wrongNode
          ? { level: "warn", title: "claude-code: 다른 node로 등록돼 있습니다", detail: listed.trim(), fix: "grimoire install claude-code" }
          : { level: "ok", title: "claude-code: 등록됨" },
      );
    } catch {
      // 등록 안 됨 — 아래 공통 안내로
    }
  }

  if (!anyInstalled) {
    checks.push({
      level: "warn",
      title: "어떤 MCP 클라이언트에도 아직 등록하지 않았습니다",
      fix: "grimoire install claude-code | claude-desktop | cursor",
    });
  }
  return checks;
}

function specCheck(
  client: string,
  file: string,
  spec: { command?: string; args?: string[]; env?: Record<string, string> },
  cliPath: string,
  env: Env,
): Check {
  const fix = `grimoire install ${client}`;
  if (!spec.command || !fs.existsSync(spec.command)) {
    return {
      level: "fail",
      title: `${client}: 실행 파일을 찾을 수 없습니다 ('${spec.command}')`,
      detail: `${file} — GUI 앱은 셸 PATH를 모르므로 node 절대경로가 필요합니다`,
      fix,
    };
  }
  const script = spec.args?.[0];
  if (!script || !fs.existsSync(script)) {
    return { level: "fail", title: `${client}: CLI 경로가 없습니다 ('${script}')`, detail: file, fix: `npm run build 후 ${fix}` };
  }
  if (spec.command !== process.execPath) {
    return {
      level: "warn",
      title: `${client}: 지금과 다른 node로 등록돼 있습니다 — SQLite 모듈이 안 맞으면 시작에 실패합니다`,
      detail: `${spec.command} (지금: ${process.execPath})`,
      fix,
    };
  }
  if ((spec.env?.GRIMOIRE_HOME ?? grimoireHome({})) !== grimoireHome(env)) {
    return {
      level: "warn",
      title: `${client}: CLI와 다른 데이터 폴더를 봅니다`,
      detail: `MCP: ${spec.env?.GRIMOIRE_HOME ?? grimoireHome({})} / CLI: ${grimoireHome(env)}`,
      fix,
    };
  }
  if (cliPath && script !== cliPath) {
    return { level: "warn", title: `${client}: 다른 위치의 grimoire를 가리킵니다`, detail: script, fix };
  }
  return { level: "ok", title: `${client}: 등록됨`, detail: file };
}

const ICON: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${ICON[check.level]} ${check.title}`);
    if (check.detail) lines.push(`    ${check.detail}`);
    if (check.fix) lines.push(`    → ${check.fix}`);
  }
  const fails = checks.filter((check) => check.level === "fail").length;
  const warns = checks.filter((check) => check.level === "warn").length;
  lines.push("", fails > 0 ? `문제 ${fails}개, 주의 ${warns}개` : warns > 0 ? `동작 가능, 주의 ${warns}개` : "모두 정상");
  return lines.join("\n");
}
