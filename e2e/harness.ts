/**
 * MCP 종단 하네스 — 실제 클라이언트가 하는 그대로 서버를 띄워 시나리오를 검증한다.
 *
 *   npm run e2e                         빌드한 dist/cli.js를 GUI 앱 환경(최소 PATH, cwd /)으로 실행
 *   npm run e2e -- --config <파일>      클라이언트 설정 파일(예: Claude Desktop)에 적힌 명령 그대로 실행
 *   npm run e2e -- --json               결과를 JSON으로
 *
 * 어떤 모드든 DB와 HOME은 임시 폴더로 갈아 끼운다 — 실제 ~/.grimoire와 사용자 레포는 건드리지 않는다.
 * 레포도 임시로 만든 고정 픽스처라 결과가 매번 같다.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { addCommit, tempDir } from "../tests/helpers";

import { makeFixture, ME } from "./fixture";

/**
 * GUI 앱(Claude Desktop·Cursor)이 MCP 서버에 넘기는 수준의 PATH.
 * Windows의 GUI 앱은 레지스트리의 사용자·시스템 PATH를 그대로 받으므로 지금 PATH를 쓴다 — POSIX 경로로는 git을 못 찾는다.
 */
const GUI_PATH = process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin:/usr/sbin:/sbin";
const CONNECT_BUDGET_MS = 5_000;
const SYNC_WAIT_MS = 10_000;
const EXPECTED_TOOLS = ["search_memory", "show_commit", "file_context", "get_repo_overview", "list_repos", "add_repo", "record_note"];
const READ_TOOLS = ["search_memory", "show_commit", "file_context", "get_repo_overview", "list_repos"];
/**
 * 도구 설명 글(도구·인자 description) 예산 — 설명이 다시 길어지는 것을 막는 용도다.
 * 영어로 옮기기 전 한국어 설명이 392자(도구 288 + 인자 104)였고, 영어판은 뜻이 잡히게 쓰고 약간의 여유를 둔다.
 */
const TOOL_TEXT_BUDGET = 500; // 420(도구 6개) + file_context 한 문장

interface ServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface StepResult {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

class Check extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Check(message);
}

/* ── 서버 실행 ─────────────────────────────────────────── */

function specFromConfig(file: string): ServerSpec {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, ServerSpec> };
  const spec = parsed.mcpServers?.grimoire;
  if (!spec) throw new Error(`${file}에 grimoire 항목이 없습니다 — 먼저 grimoire install을 하세요`);
  return spec;
}

function builtSpec(): ServerSpec {
  const cli = path.resolve(__dirname, "..", "..", "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error(`${cli}가 없습니다 — npm run build를 먼저 하세요`);
  return { command: process.execPath, args: [cli, "mcp"] };
}

interface Session {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

async function connect(
  spec: ServerSpec,
  sandbox: { home: string; data: string },
  extraEnv: Record<string, string> = {},
  /** 서버를 띄울 폴더 — Claude Desktop은 "/", Claude Code·Cursor는 열린 프로젝트 폴더 */
  cwd = "/",
): Promise<Session> {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd,
    // 설정에 적힌 env는 살리되 DB·HOME·"나"는 샌드박스 값으로 덮는다
    env: {
      ...(spec.env ?? {}),
      PATH: GUI_PATH,
      HOME: sandbox.home,
      // Windows의 os.homedir()는 HOME이 아니라 USERPROFILE을 본다. SDK가 실제 USERPROFILE·APPDATA·LOCALAPPDATA를
      // 물려주므로 샌드박스 값으로 덮어 실제 사용자 설정에 닿지 않게 한다
      ...(process.platform === "win32"
        ? {
            USERPROFILE: sandbox.home,
            APPDATA: path.join(sandbox.home, "AppData", "Roaming"),
            LOCALAPPDATA: path.join(sandbox.home, "AppData", "Local"),
          }
        : {}),
      GRIMOIRE_HOME: sandbox.data,
      GRIMOIRE_ME: ME,
      // 하네스는 네트워크에 닿지 않는다 — 업데이트 확인은 단위 테스트에서 본다
      GRIMOIRE_UPDATE_CHECK: "0",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const client = new Client({ name: "grimoire-e2e", version: "1" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`연결 실패: ${error instanceof Error ? error.message : error}\n서버 stderr:\n${stderr.trim() || "(없음)"}`);
  }
  return { client, stderr: () => stderr, close: () => client.close() };
}

async function call(session: Session, name: string, args: Record<string, unknown> = {}) {
  const result = (await session.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = result.content[0]?.text ?? "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 오류 응답은 평문이다
  }
  return { isError: Boolean(result.isError), text, json };
}

/* ── 시나리오 ──────────────────────────────────────────── */

async function runScenario(spec: ServerSpec): Promise<StepResult[]> {
  const fixture = makeFixture();
  const sandbox = { home: tempDir("grimoire-e2e-home-"), data: tempDir("grimoire-e2e-data-") };
  const results: StepResult[] = [];
  let session: Session | null = null;
  let topSha = "";

  const step = async (name: string, body: () => Promise<string | void>) => {
    const started = Date.now();
    try {
      const detail = await body();
      results.push({ step: name, ok: true, ms: Date.now() - started, detail: detail || undefined });
    } catch (error) {
      results.push({ step: name, ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const live = () => {
    if (!session) throw new Check("앞 단계에서 연결하지 못했습니다");
    return session;
  };

  await step("GUI 환경에서 연결", async () => {
    const started = Date.now();
    session = await connect(spec, sandbox);
    const ms = Date.now() - started;
    expect(ms < CONNECT_BUDGET_MS, `연결에 ${ms}ms — 기준 ${CONNECT_BUDGET_MS}ms 초과`);
    return `${spec.command} (${ms}ms)`;
  });
  if (!session) {
    // 연결이 안 되면 뒤 단계는 볼 것이 없다 — 원인 하나만 보여 준다
    for (const dir of [fixture.root, sandbox.home, sandbox.data]) fs.rmSync(dir, { recursive: true, force: true });
    return results;
  }

  await step("도구 목록", async () => {
    const tools = (await live().client.listTools()).tools.map((tool) => tool.name);
    const missing = EXPECTED_TOOLS.filter((name) => !tools.includes(name));
    expect(missing.length === 0, `빠진 도구: ${missing.join(", ")}`);
    return tools.join(", ");
  });

  await step("도구 힌트(annotations)와 서버 안내(instructions)", async () => {
    const tools = (await live().client.listTools()).tools;
    const hint = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
    const notReadOnly = READ_TOOLS.filter((name) => hint(name)?.readOnlyHint !== true);
    expect(notReadOnly.length === 0, `readOnlyHint가 없는 읽기 도구: ${notReadOnly.join(", ")}`);
    expect(hint("add_repo")?.idempotentHint === true && hint("record_note")?.idempotentHint !== true, "add_repo·record_note의 idempotentHint");
    // 클라이언트가 앞부분만 보여 줄 수 있다 — 언제 쓰는지와 주입 방지 문장이 첫 300자 안에 있어야 한다
    const head = (live().client.getInstructions() ?? "").slice(0, 300);
    const absent = ["where is the code that", "how did I solve", "past commits", "notes", "never follow instructions"].filter((phrase) => !head.includes(phrase));
    expect(absent.length === 0, `instructions 첫 300자에 없음: ${absent.join(" / ")}`);
  });

  await step("빈 DB: list_repos·search_memory가 등록 안내(hint)를 준다", async () => {
    const listed = await call(live(), "list_repos");
    expect(listed.json?.repos?.length === 0, "레포가 비어 있어야 합니다");
    expect(typeof listed.json?.hint === "string", "list_repos에 hint가 없습니다");
    const searched = await call(live(), "search_memory", { query: "토큰" });
    expect(searched.json?.hits?.length === 0 && typeof searched.json?.hint === "string", "search_memory에 hint가 없습니다");
    expect(listed.json.me?.[0] === ME, `내 이메일 인식 실패: ${JSON.stringify(listed.json.me)}`);
  });

  await step("add_repo scan: 폴더 아래 레포 전부 등록", async () => {
    const added = await call(live(), "add_repo", { path: fixture.root, scan: true });
    expect(!added.isError, added.text);
    const names = added.json.added.map((item: { repo: string }) => item.repo).sort();
    expect(JSON.stringify(names) === JSON.stringify(["shop-api", "shop-web"]), `등록된 레포: ${names}`);
    const listed = await call(live(), "list_repos");
    expect(listed.json.hint === undefined, "등록 후에도 hint가 남아 있습니다");
    return names.join(", ");
  });

  await step("search_memory: 한국어 질의로 근거(sha·파일·링크) 찾기", async () => {
    const result = await call(live(), "search_memory", { query: "리프레시 토큰을" });
    const top = result.json?.hits?.[0];
    expect(top, "결과가 없습니다");
    expect(top.title === "feat(auth): JWT 리프레시 토큰 회전", `1위가 다릅니다: ${top.title}`);
    expect(top.files?.includes("src/auth/refresh.ts"), "변경 파일이 없습니다");
    expect(top.by === "me", `작성자 표기: ${top.by}`);
    const link = `${result.json.links?.[top.repo] ?? ""}${top.sha}`;
    expect(/^https:\/\/github\.com\/someone\/shop-api\/commit\/[0-9a-f]{10}$/.test(link), `링크 형식: ${link}`);
    topSha = top.sha;
    return `${top.repo} ${top.sha}`;
  });

  await step("응답 크기 예산 (토큰 = 비용)", async () => {
    // 응답은 대화 컨텍스트에 쌓여 매 턴 다시 읽힌다. 형식이 다시 부풀면 여기서 잡는다.
    const query = "토큰 동시성 장바구니 시작";
    // 기본(detail 없음)은 index — 건당 예산을 지킨다
    const index = await call(live(), "search_memory", { query });
    const perHit = index.text.length / Math.max(1, index.json.hits.length);
    expect(perHit < 260, `검색 결과(index) 건당 ${Math.round(perHit)}자 — 예산 260자`);
    // summary는 요청할 때만 — 상위 커밋 3개에 본문·바뀐 함수를 더 싣는다. show_commit 한 번(diff 120줄)보다 작아야 남는 장사다
    const summary = await call(live(), "search_memory", { query, detail: "summary" });
    expect(summary.text.length < 3000, `검색 응답(summary) ${summary.text.length}자 — 예산 3000자`);
    const listed = (await live().client.listTools()).tools;
    const tools = JSON.stringify(listed);
    expect(tools.length < 2600, `도구 정의 ${tools.length}자 — 예산 2600자`);
    // 설명 글은 따로 — annotations·인자 같은 구조가 늘어도 설명이 다시 길어지지 않게
    const text = listed.reduce(
      (sum, tool) =>
        sum +
        (tool.description ?? "").length +
        Object.values((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>).reduce((n, prop) => n + (prop.description ?? "").length, 0),
      0,
    );
    expect(text <= TOOL_TEXT_BUDGET, `도구 설명 글 ${text}자 — 예산 ${TOOL_TEXT_BUDGET}자`);
    return `index 건당 ${Math.round(perHit)}자 · summary ${summary.text.length}자 · 도구 정의 ${tools.length}자(설명 ${text}자)`;
  });

  await step("search_memory: author=me 필터", async () => {
    const all = await call(live(), "search_memory", { query: "동시성" });
    const mine = await call(live(), "search_memory", { query: "동시성", author: "me" });
    // 전체 검색은 동료 커밋 + 현재 파일(lock.ts)까지, '나'로 좁히면 이력만 보고 동료 커밋은 빠진다
    const commits = all.json.hits.filter((hit: { sha?: string }) => hit.sha);
    expect(commits.length === 1, `전체 검색의 커밋 ${commits.length}건`);
    expect(mine.json.hits.length === 0, "동료 커밋이나 파일이 '나'로 걸렸습니다");
  });

  await step("show_commit: 로컬 레포에서 diff 읽기", async () => {
    const detail = await call(live(), "show_commit", { sha: topSha.slice(0, 8) });
    expect(!detail.isError, detail.text);
    expect(detail.json.diff?.includes("+  return 'rotated';"), "diff에 기대한 줄이 없습니다");
    expect(detail.json.body.includes("refresh token"), "커밋 본문이 없습니다");
    expect(detail.json.files?.[0] === "src/auth/refresh.ts +3 -0", `파일 표기: ${detail.json.files?.[0]}`);
    expect(!detail.json.diff.startsWith("commit "), "git show 헤더가 중복으로 들어 있습니다");
  });

  await step("show_commit paths: 고른 파일의 diff만", async () => {
    const api = await call(live(), "search_memory", { query: "프로젝트 시작" });
    const sha = api.json.hits.find((hit: { title: string }) => hit.title === "feat: 프로젝트 시작")?.sha;
    expect(sha, "프로젝트 시작 커밋을 못 찾았습니다");
    const picked = await call(live(), "show_commit", { sha, paths: ["package"] });
    expect(picked.json.diff?.includes("package.json"), "고른 파일 diff가 없습니다");
    const none = await call(live(), "show_commit", { sha, paths: ["nope.ts"] });
    expect(!none.json.diff && /일치하는 파일이 없습니다/.test(none.json.note ?? ""), `없는 경로 응답: ${none.text}`);
  });

  await step("show_commit shas: 여러 커밋을 한 번에", async () => {
    const api = await call(live(), "search_memory", { query: "프로젝트 시작" });
    const start = api.json.hits.find((hit: { title: string }) => hit.title === "feat: 프로젝트 시작")?.sha;
    const both = await call(live(), "show_commit", { shas: [topSha, start, "0000000000"] });
    expect(!both.isError, both.text);
    const commits = both.json.commits as { sha: string; error?: string; diff?: string }[];
    expect(commits.length === 3, `커밋 ${commits.length}개`);
    expect(commits[0].sha === topSha && commits[1].sha === start, "순서대로");
    expect(typeof commits[2].error === "string", "없는 sha는 그 자리에 error");
    const many = await call(live(), "show_commit", { shas: ["a1", "a2", "a3", "a4", "a5", "a6"] });
    expect(many.isError === true, "6개 이상은 거절");
    const none = await call(live(), "show_commit", {});
    expect(none.isError === true, "sha도 shas도 없으면 거절");
  });

  await step("get_repo_overview: 기술 스택과 디렉터리", async () => {
    const overview = await call(live(), "get_repo_overview", { repo: "shop-api" });
    const tech = Object.values(overview.json.tech as Record<string, string>).join(", ");
    expect(/express/i.test(tech), `기술: ${tech}`);
    expect(/(^| )src\/auth\(/.test(overview.json.dirs), `디렉터리: ${overview.json.dirs}`);
    // 픽스처 3개 중 동료 커밋 1개를 뺀 2개가 "나"
    expect(overview.json.commits === 3 && overview.json.mine === 2, `커밋 ${overview.json.commits} / 내 커밋 ${overview.json.mine}`);
  });

  await step("record_note → 검색에 바로 걸림", async () => {
    const recorded = await call(live(), "record_note", { text: "결정: 토큰 저장은 httpOnly 쿠키", repo: "shop-api", tags: ["decision"] });
    expect(recorded.json?.recorded === true, recorded.text);
    const found = await call(live(), "search_memory", { query: "httpOnly 쿠키", kind: "note" });
    expect(found.json.hits[0]?.title === "결정: 토큰 저장은 httpOnly 쿠키", "노트가 검색되지 않습니다");
  });

  await step("잘못된 인자는 isError로 (서버는 살아 있음)", async () => {
    const bad = await call(live(), "get_repo_overview", { repo: "없는-레포" });
    expect(bad.isError && bad.text.includes("찾지 못했습니다"), `응답: ${bad.text}`);
    const missing = await call(live(), "add_repo", { path: "/definitely/not/here" });
    expect(missing.isError, "없는 경로가 오류가 아닙니다");
    const alive = await call(live(), "list_repos");
    expect(alive.json.repos.length === 2, "오류 뒤 서버 상태가 이상합니다");
  });

  await step("재시작 시 백그라운드 동기화로 새 커밋 반영", async () => {
    await live().close();
    session = null;
    addCommit(fixture.api, {
      message: "feat: 결제 웹훅 서명 검증",
      files: { "src/pay/webhook.ts": "export const verify = true;\n" },
      email: ME,
      date: "2024-07-01T10:00:00+09:00",
    });
    session = await connect(spec, sandbox);
    const deadline = Date.now() + SYNC_WAIT_MS;
    for (;;) {
      const found = await call(live(), "search_memory", { query: "웹훅 서명" });
      if (found.json.hits.length > 0) return `${SYNC_WAIT_MS - (deadline - Date.now())}ms 만에 반영`;
      if (Date.now() > deadline) throw new Check(`${SYNC_WAIT_MS}ms 안에 새 커밋이 검색되지 않았습니다`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  await step("프로젝트 폴더에서 뜨면 그 레포를 자동 등록하고 current로 우선", async () => {
    // Claude Code처럼 프로젝트(하위 폴더) 안에서, 빈 DB로 띄운다 — add_repo 없이 바로 검색돼야 한다
    // 픽스처는 임시 폴더에 있어 기본값으로는 건너뛰므로 GRIMOIRE_AUTO_ADD=1로 강제한다(아래에서 기본값도 확인)
    const fresh = { home: sandbox.home, data: tempDir("grimoire-e2e-ws-") };
    const projectSession = await connect(spec, fresh, { GRIMOIRE_AUTO_ADD: "1" }, path.join(fixture.web, "src"));
    try {
      const found = await call(projectSession, "search_memory", { query: "장바구니" });
      expect(found.json.current === "shop-web", `current: ${found.json.current}`);
      expect(found.json.hits.length > 0 && found.json.hint === undefined, `자동 등록 안 됨: ${found.text}`);
      expect(projectSession.stderr().includes("작업 중인 프로젝트를 등록합니다"), "등록 로그가 없습니다");
    } finally {
      await projectSession.close();
    }
    // 끄면, 그리고 기본값에서 임시 폴더면 등록하지 않는다
    const off = { home: sandbox.home, data: tempDir("grimoire-e2e-ws-off-") };
    try {
      const variants: Record<string, string>[] = [{ GRIMOIRE_AUTO_ADD: "0" }, {}];
      for (const extra of variants) {
        const session = await connect(spec, off, extra, fixture.web);
        try {
          const listed = await call(session, "list_repos");
          expect(listed.json.repos.length === 0 && listed.json.current === undefined, `등록되면 안 됨(${JSON.stringify(extra)}): ${listed.text}`);
        } finally {
          await session.close();
        }
      }
    } finally {
      for (const dir of [fresh.data, off.data]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await step("연결 확인처럼 곧 끝나는 실행은 아무것도 등록하지 않음", async () => {
    // claude mcp list처럼: 띄우고 도구 목록만 보고 바로 끈다
    const quick = { home: sandbox.home, data: tempDir("grimoire-e2e-quick-") };
    try {
      const session = await connect(spec, quick, { GRIMOIRE_AUTO_ADD: "1" }, fixture.api);
      await session.client.listTools();
      await session.close();
      const checker = await connect(spec, quick, { GRIMOIRE_AUTO_ADD: "0" });
      try {
        const listed = await call(checker, "list_repos");
        expect(listed.json.repos.length === 0, `연결 확인에서 등록됨: ${listed.text}`);
      } finally {
        await checker.close();
      }
    } finally {
      fs.rmSync(quick.data, { recursive: true, force: true });
    }
  });

  await step("stdout 오염 없음 (로그는 stderr로만)", async () => {
    // stdout에 로그가 섞이면 위 단계들의 JSON-RPC가 이미 깨졌을 것이다. 여기서는 stderr 로그가 실제로 나왔는지만 본다.
    expect(live().stderr().includes("[grimoire] MCP 서버 시작"), "서버 시작 로그가 stderr에 없습니다");
  });

  if (session) await (session as Session).close();
  for (const dir of [fixture.root, sandbox.home, sandbox.data]) fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

/* ── 진입점 ────────────────────────────────────────────── */

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { config: { type: "string" }, json: { type: "boolean" } },
  });
  const spec = values.config ? specFromConfig(path.resolve(values.config)) : builtSpec();
  const mode = values.config ? `설정 파일 ${values.config}` : "빌드한 dist/cli.js";

  const started = Date.now();
  const results = await runScenario(spec);
  const failed = results.filter((result) => !result.ok);

  if (values.json) {
    process.stdout.write(JSON.stringify({ mode, spec, ok: failed.length === 0, results }, null, 2) + "\n");
  } else {
    process.stdout.write(`Grimoire MCP e2e — ${mode}\n\n`);
    for (const result of results) {
      process.stdout.write(`${result.ok ? "✓" : "✗"} ${result.step}  (${result.ms}ms)\n`);
      if (result.detail) process.stdout.write(`    ${result.detail.split("\n").join("\n    ")}\n`);
    }
    process.stdout.write(
      `\n${results.length - failed.length}/${results.length} 통과 · ${Date.now() - started}ms\n`,
    );
  }
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  },
);
