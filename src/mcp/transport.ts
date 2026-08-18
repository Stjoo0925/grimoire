/**
 * ② MCP 서버 — 전송 설정과 인증 게이트 (순수 로직, SDK 비의존).
 *
 * stdio(기본)는 클라이언트가 로컬에서 프로세스를 띄우는 형태라 인증이 필요 없다.
 * http는 개인 서버에 올려 원격에서 붙는 형태 — **토큰 없이는 뜨지 않는다**(PLANNING.md §7).
 * TLS는 범위 밖이며 리버스 프록시/터널이 담당한다.
 */
export type TransportMode = "stdio" | "http";

export const DEFAULT_HTTP_PORT = 8765;
export const MCP_PATH = "/mcp";

export interface TransportEnv {
  MCP_TRANSPORT?: string;
  MCP_PORT?: string;
  MCP_AUTH_TOKEN?: string;
  /** process.env를 그대로 넘길 수 있게 */
  [key: string]: string | undefined;
}

export interface TransportConfig {
  mode: TransportMode;
  /** http 모드에서만 의미 있음 */
  port: number;
  host: string;
  path: string;
  /** http 모드에서는 항상 값이 있다 (없으면 기동 거부) */
  authToken: string | null;
}

/**
 * env → 전송 설정. 모르는 값은 stdio로 본다.
 * http인데 MCP_AUTH_TOKEN이 없으면 여기서 막는다 — 개인 데이터를 토큰 없이 원격 노출하지 않는다.
 */
export function readTransportConfig(env: TransportEnv): TransportConfig {
  const mode: TransportMode =
    (env.MCP_TRANSPORT ?? "").trim().toLowerCase() === "http" ? "http" : "stdio";

  const token = env.MCP_AUTH_TOKEN?.trim() || null;
  if (mode === "http" && !token) {
    throw new Error(
      "[mcp] MCP_TRANSPORT=http 인데 MCP_AUTH_TOKEN이 비어 있습니다. " +
        "개인 데이터 보호 — 토큰 없이 원격에 노출할 수 없습니다. " +
        "긴 무작위 문자열을 MCP_AUTH_TOKEN에 넣고 다시 실행하세요.",
    );
  }

  const parsedPort = Number.parseInt(env.MCP_PORT ?? "", 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536
      ? parsedPort
      : DEFAULT_HTTP_PORT;

  return {
    mode,
    port,
    // 컨테이너에서 포트를 밖으로 내보내려면 0.0.0.0에 붙어야 한다.
    host: "0.0.0.0",
    path: MCP_PATH,
    authToken: mode === "http" ? token : null,
  };
}

/**
 * `Authorization: Bearer <token>` 검사.
 * 토큰이 null이면(=stdio) 항상 통과. 길이가 다르면 즉시 실패, 같으면 상수 시간 비교.
 */
export function isAuthorized(
  headerValue: string | string[] | undefined,
  token: string | null,
): boolean {
  if (!token) return true;
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof header !== "string") return false;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(match[1].trim(), token);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
