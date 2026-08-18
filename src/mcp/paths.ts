/**
 * ② MCP 서버 — 데이터 위치·login 해석 (순수 로직).
 *
 * `./data`가 유일한 진실이다 (PLANNING.md §5 원칙 1).
 * 호스트에서 `node dist-mcp/mcp/server.js`로 돌리든 컨테이너에서 `/app`을 cwd로 돌리든
 * 같은 규칙으로 데이터 디렉터리를 찾는다 — 호스트 경로를 코드에 박지 않는다.
 */
import path from "node:path";

export interface McpEnv {
  /** 어떤 사용자의 그래프를 열 것인가 */
  GRIMOIRE_LOGIN?: string;
  /** 데이터 디렉터리를 직접 지정 (컨테이너/테스트용) */
  GRIMOIRE_DATA_DIR?: string;
  /** process.env를 그대로 넘길 수 있게 */
  [key: string]: string | undefined;
}

/** `data/graph/{login}.json`의 `{login}` 규칙 — 경로 조작 차단 (storage.ts와 동일) */
export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_PATTERN.test(login);
}

/**
 * 데이터 디렉터리 후보를 우선순위대로 돌려준다.
 *   1. `GRIMOIRE_DATA_DIR` (컨테이너에서 볼륨 위치를 바꿀 때)
 *   2. `{cwd}/data` — 컨테이너(cwd=/app)와 `npm run mcp` 둘 다 여기에 맞는다
 *   3. `{모듈 위치}/../../data` — 클라이언트가 엉뚱한 cwd로 띄웠을 때의 보루
 *      (dist-mcp/mcp/paths.js → dist-mcp → 프로젝트 루트)
 */
export function dataDirCandidates(env: McpEnv, moduleDir: string, cwd: string): string[] {
  const candidates: string[] = [];
  if (env.GRIMOIRE_DATA_DIR) candidates.push(path.resolve(env.GRIMOIRE_DATA_DIR));
  candidates.push(path.join(path.resolve(cwd), "data"));
  candidates.push(path.resolve(moduleDir, "..", "..", "data"));
  return [...new Set(candidates)];
}

export function graphDir(dataDir: string): string {
  return path.join(dataDir, "graph");
}

export function graphFile(dataDir: string, login: string): string {
  if (!isValidLogin(login)) throw new Error(`[mcp] 유효하지 않은 login: ${login}`);
  return path.join(graphDir(dataDir), `${login}.json`);
}

export function snapshotFile(dataDir: string, login: string): string {
  if (!isValidLogin(login)) throw new Error(`[mcp] 유효하지 않은 login: ${login}`);
  return path.join(dataDir, `${login}.json`);
}

/**
 * 어떤 login의 그래프를 열지 결정한다.
 *   - `GRIMOIRE_LOGIN`이 있으면 그것 (후보에 없으면 있는 것들을 알려주며 실패)
 *   - 없고 후보가 정확히 하나면 그것
 *   - 그 외에는 한국어 안내와 함께 실패
 */
export function pickLogin(candidates: string[], envLogin?: string): string {
  const available = [...candidates].sort();
  const wanted = envLogin?.trim();

  if (wanted) {
    if (!isValidLogin(wanted)) {
      throw new Error(
        `[mcp] GRIMOIRE_LOGIN 값이 GitHub 로그인 형식이 아닙니다: "${wanted}"`,
      );
    }
    if (available.length > 0 && !available.includes(wanted)) {
      throw new Error(
        `[mcp] "${wanted}"의 그래프를 찾지 못했습니다. ` +
          `data/graph 안에 있는 것: ${available.join(", ")}. ` +
          `웹앱에서 그래프를 먼저 생성하거나 GRIMOIRE_LOGIN을 바꿔 주세요.`,
      );
    }
    return wanted;
  }

  if (available.length === 1) return available[0];

  if (available.length === 0) {
    throw new Error(
      "[mcp] data/graph 에 그래프 JSON이 없습니다. " +
        "웹앱(npm run dev)에서 수집 → 그래프 생성을 먼저 실행하세요.",
    );
  }

  throw new Error(
    `[mcp] 그래프가 여러 개라 하나를 고를 수 없습니다: ${available.join(", ")}. ` +
      "GRIMOIRE_LOGIN 환경변수로 지정해 주세요.",
  );
}
