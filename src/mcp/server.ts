/**
 * MCP 서버 (stdio) — `grimoire mcp`로 띄운다.
 *
 * 기동 직후 등록된 레포를 백그라운드로 증분 동기화한다(`GRIMOIRE_SYNC_ON_START=0`이면 끔).
 * 질의는 그동안에도 받는다 — DB가 WAL이라 읽기와 쓰기가 서로 막지 않는다.
 *
 * 프라이버시: 외부 요청은 하루 한 번의 업데이트 확인(GitHub 릴리스 버전 조회)뿐이고
 * `GRIMOIRE_UPDATE_CHECK=0`이면 끈다. 연결한 AI 클라이언트에는 질의 결과(커밋 메시지·파일 경로·diff)가 전달된다.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { dbPath } from "../core/config";
import { openDb } from "../core/db";
import { myEmails } from "../core/identity";
import { listRepos, syncRepo } from "../core/indexer";
import { pendingUpdate, refreshUpdateCache, updateHint, VERSION } from "../core/update";
import { callTool, ToolError, TOOLS, type ToolContext } from "./tools";

const SERVER_NAME = "grimoire";

export async function runMcpServer(env = process.env): Promise<void> {
  const db = openDb(dbPath(env));
  let updateNotified = false;
  const context: ToolContext = {
    db,
    me: await myEmails(env),
    cwd: process.cwd(),
    updateHint: () => {
      if (updateNotified) return undefined;
      const update = pendingUpdate(env);
      if (!update) return undefined;
      updateNotified = true;
      return updateHint(update);
    },
  };

  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: "이 개발자의 로컬 git 이력·노트 검색. 답에는 레포와 커밋 sha를 근거로 밝힐 것.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callTool(context, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof ToolError)) console.error(`[grimoire] ${request.params.name} 실패`, error);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(`[grimoire] MCP 서버 시작 (${dbPath(env)})`);

  if (env.GRIMOIRE_SYNC_ON_START !== "0") {
    void backgroundSync(context);
  }
  // 하루 한 번만 실제로 묻는다. 결과는 다음 search_memory·list_repos의 hint로 나간다.
  void refreshUpdateCache({ env });
}

async function backgroundSync(context: ToolContext): Promise<void> {
  for (const repo of listRepos(context.db)) {
    try {
      const result = await syncRepo(context.db, repo);
      if (result.added > 0) console.error(`[grimoire] ${repo.name}: 새 커밋 ${result.added}개`);
    } catch (error) {
      console.error(`[grimoire] ${repo.name} 동기화 건너뜀 —`, error instanceof Error ? error.message : error);
    }
  }
}
