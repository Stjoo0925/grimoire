#!/usr/bin/env node
/**
 * ② MCP 서버 진입점 (PLANNING.md §5 ②, KNOWLEDGE_GRAPH.md §8).
 *
 * 전송은 env로 고른다.
 *   MCP_TRANSPORT=stdio (기본) — Claude Desktop/Cursor가 이 프로세스를 직접 띄운다
 *   MCP_TRANSPORT=http         — 개인 서버에 올려 원격에서 붙는다 (MCP_AUTH_TOKEN 필수)
 *
 * 프라이버시(PLANNING.md §7): 이 서버를 외부 LLM 클라이언트에 연결하면 **질의된 서브그래프는
 * 그 LLM에 노출된다.** 서버 자체는 외부 API를 호출하지 않는다 — 읽는 것은 ./data 뿐이다.
 *
 * 도구 구현은 tools.ts(그리고 search/project/learning)에 있고 여기는 배선만 한다.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveContext, type McpContext } from "./context";
import { startHttpTransport } from "./http";
import { callTool, TOOLS } from "./tools";
import { readTransportConfig } from "./transport";

const SERVER_NAME = "grimoire-knowledge-graph";
const SERVER_VERSION = "0.1.0";

/**
 * 컨텍스트(데이터 디렉터리 + login)는 한 번만 푼다. 그래프 파일은 호출마다 다시 읽는다.
 * 동시 호출이 겹쳐도 한 번만 풀도록 결과가 아니라 Promise를 캐시한다.
 */
let contextPromise: Promise<McpContext> | null = null;
function currentContext(): Promise<McpContext> {
  if (!contextPromise) {
    contextPromise = resolveContext(process.env, __dirname, process.cwd())
      .then((context) => {
        console.error(`[mcp] ${context.login} 그래프를 엽니다 (${context.dataDir})`);
        return context;
      })
      .catch((error) => {
        // 실패는 캐시하지 않는다 — 그래프를 만든 뒤 다시 부르면 성공해야 한다.
        contextPromise = null;
        throw error;
      });
  }
  return contextPromise;
}

export function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const context = await currentContext();
      const payload = await callTool(context, name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    } catch (error) {
      // 프로토콜을 죽이지 않고 사람이 읽을 수 있는 한국어 안내를 돌려준다.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const config = readTransportConfig(process.env);

  if (config.mode === "http") {
    await startHttpTransport(createMcpServer, config);
    console.error(
      `[mcp] ${SERVER_NAME} v${SERVER_VERSION} HTTP 대기 중 — ` +
        `http://${config.host}:${config.port}${config.path} (Bearer 토큰 필요, TLS는 리버스 프록시 담당)`,
    );
    return;
  }

  await createMcpServer().connect(new StdioServerTransport());
  // stdout은 JSON-RPC 전용이다 — 로그는 반드시 stderr로.
  console.error(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} stdio 대기 중`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
