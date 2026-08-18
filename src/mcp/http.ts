/**
 * ② MCP 서버 — Streamable HTTP 전송 (개인 서버 배치용).
 *
 * 요청마다 Server + Transport를 새로 만드는 무상태(stateless) 방식이다 — 세션 상태가 없어
 * 컨테이너 재시작/다중 클라이언트에 강하다. 모든 요청은 Bearer 토큰을 통과해야 한다.
 * TLS는 여기서 하지 않는다 — Caddy/Cloudflare Tunnel 같은 리버스 프록시가 앞에 선다.
 */
import http from "node:http";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { isAuthorized, type TransportConfig } from "./transport";

/** 본문 상한 (JSON-RPC 요청은 작다) */
const MAX_BODY_BYTES = 1_000_000;

export interface HttpServerHandle {
  server: http.Server;
  close(): Promise<void>;
}

/**
 * @param createServer 요청 1건을 처리할 MCP Server 인스턴스를 새로 만드는 팩토리
 */
export async function startHttpTransport(
  createServer: () => Server,
  config: TransportConfig,
): Promise<HttpServerHandle> {
  const httpServer = http.createServer((req, res) => {
    void handle(req, res, createServer, config).catch((error) => {
      console.error("[mcp] HTTP 처리 실패", error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return {
    server: httpServer,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  createServer: () => Server,
  config: TransportConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // 헬스체크는 인증 없이 (그래프 내용은 전혀 노출하지 않는다)
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== config.path) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  if (!isAuthorized(req.headers.authorization, config.authToken)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="grimoire"');
    sendJson(res, 401, {
      error: "unauthorized",
      message: "[mcp] Authorization: Bearer <MCP_AUTH_TOKEN> 헤더가 필요합니다.",
    });
    return;
  }

  if (req.method !== "POST") {
    // 무상태 모드라 서버→클라 스트림(GET)과 세션 종료(DELETE)는 쓰지 않는다.
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("[mcp] 요청 본문이 너무 큽니다.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("[mcp] JSON 파싱 실패");
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
