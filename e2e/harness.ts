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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { addCommit, makeRepo, tempDir } from "../tests/helpers";

const ME = "me@example.com";
/** GUI 앱(Claude Desktop·Cursor)이 MCP 서버에 넘기는 수준의 PATH */
const GUI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const CONNECT_BUDGET_MS = 5_000;
const SYNC_WAIT_MS = 10_000;
const EXPECTED_TOOLS = ["search_memory", "show_commit", "get_repo_overview", "list_repos", "add_repo", "record_note"];

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

/* ── 픽스처 ─────────────────────────────────────────────── */

interface Fixture {
  root: string;
  api: string;
  web: string;
}

function makeFixture(): Fixture {
  const api = makeRepo(
    [
      {
        message: "feat: 프로젝트 시작",
        files: { "package.json": JSON.stringify({ dependencies: { express: "^4" } }) },
        date: "2023-01-10T10:00:00+09:00",
      },
      {
        message: "feat(auth): JWT 리프레시 토큰 회전\n\n만료 직전에 refresh token을 새로 발급하고 이전 토큰을 폐기한다.",
        files: { "src/auth/refresh.ts": "export function rotate() {\n  return 'rotated';\n}\n" },
        email: ME,
        date: "2023-05-02T10:00:00+09:00",
      },
      {
        message: "fix: 재고 차감 동시성 문제를 Redis 분산 락으로 해결",
        files: { "src/order/lock.ts": "export const lock = 'redlock';\n" },
        email: "teammate@example.com",
        date: "2024-02-03T10:00:00+09:00",
      },
    ],
    "shop-api",
  );
  const web = makeRepo(
    [
      {
        message: "feat: 장바구니 화면",
        files: { "package.json": JSON.stringify({ dependencies: { react: "^18" } }), "src/Cart.tsx": "export {}\n" },
        email: ME,
        date: "2024-03-01T10:00:00+09:00",
      },
    ],
    "shop-web",
  );
  // 두 레포를 한 폴더 아래로 모아 scan 대상으로 쓴다
  const root = tempDir("grimoire-e2e-");
  const apiLink = path.join(root, "shop-api");
  const webLink = path.join(root, "shop-web");
  fs.renameSync(api, apiLink);
  fs.renameSync(web, webLink);
  return { root, api: apiLink, web: webLink };
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

async function connect(spec: ServerSpec, sandbox: { home: string; data: string }, extraEnv: Record<string, string> = {}): Promise<Session> {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: "/",
    // 설정에 적힌 env는 살리되 DB·HOME·"나"는 샌드박스 값으로 덮는다
    env: {
      ...(spec.env ?? {}),
      PATH: GUI_PATH,
      HOME: sandbox.home,
      GRIMOIRE_HOME: sandbox.data,
      GRIMOIRE_ME: ME,
      // 샌드박스에 Ollama가 있을 리 없지만, 혹시 있더라도 결과가 흔들리지 않게 닿지 않는 주소로
      OLLAMA_HOST: "http://127.0.0.1:9",
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
    expect(/^https:\/\/github\.com\/someone\/shop-api\/commit\/[0-9a-f]{40}$/.test(top.url ?? ""), `링크 형식: ${top.url}`);
    topSha = top.ref;
    return `${top.repo} ${top.ref.slice(0, 8)}`;
  });

  await step("search_memory: author=me 필터", async () => {
    const all = await call(live(), "search_memory", { query: "동시성" });
    const mine = await call(live(), "search_memory", { query: "동시성", author: "me" });
    expect(all.json.hits.length === 1, `전체 검색 ${all.json.hits.length}건`);
    expect(mine.json.hits.length === 0, "동료 커밋이 '나'로 걸렸습니다");
  });

  await step("show_commit: 로컬 레포에서 diff 읽기", async () => {
    const detail = await call(live(), "show_commit", { sha: topSha.slice(0, 8) });
    expect(!detail.isError, detail.text);
    expect(detail.json.patch?.includes("+  return 'rotated';"), "diff에 기대한 줄이 없습니다");
    expect(detail.json.body.includes("refresh token"), "커밋 본문이 없습니다");
  });

  await step("get_repo_overview: 기술 스택과 디렉터리", async () => {
    const overview = await call(live(), "get_repo_overview", { repo: "shop-api" });
    const tech = overview.json.tech.flatMap((group: { items: string[] }) => group.items);
    expect(tech.some((item: string) => item.toLowerCase().includes("express")), `기술: ${tech}`);
    expect(overview.json.topDirectories.some((dir: { path: string }) => dir.path === "src/auth"), "src/auth가 없습니다");
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
