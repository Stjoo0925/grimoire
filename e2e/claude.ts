/**
 * `claude -p` 실행기 — 에이전트 하네스와 벤치가 같이 쓴다.
 *
 * stream-json 출력에서 쓴 도구, 최종 답, 턴 수, 비용, 토큰 사용량을 뽑는다.
 * macOS는 로그인 정보가 Keychain에 있어, Keychain에 닿지 못하는 샌드박스 셸에서는 "로그인 안 됨"이 난다.
 */
import { spawn } from "node:child_process";

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface AgentRun {
  answer: string;
  tools: string[];
  /** 도구 호출 인자 (진단용 — 무엇을 검색했나) */
  calls: { name: string; input: unknown }[];
  turns: number | null;
  /** 청구 비용 추정(total_cost_usd) — 서브에이전트 포함 */
  costUsd: number | null;
  /** 결과의 usage (서브에이전트 제외) */
  usage: Usage | null;
  /** modelUsage 합계 (서브에이전트 포함) — 벤치는 이쪽을 쓴다 (docs/enhancement-plan.md §3-4) */
  modelUsage: Usage | null;
  /** costUsd 중 캐시 쓰기 몫 (추정, cacheWriteCost) */
  cacheWriteUsd: number | null;
  /** success | error_max_turns | error_max_budget_usd | error_during_execution … */
  subtype: string | null;
  apiMs: number | null;
  ms: number;
  error?: string;
}

export interface ClaudeOptions {
  prompt: string;
  cwd: string;
  /** --mcp-config 파일 (없으면 빈 설정으로 MCP를 모두 끈다) */
  mcpConfig: string;
  /** --tools 값 ("" = 내장 도구 전부 끔). undefined면 플래그를 넘기지 않는다(내장 도구 기본값) */
  tools?: string;
  allowedTools: string[];
  maxTurns?: number;
  model?: string;
  budgetUsd?: string;
  timeoutMs?: number;
  /** --settings 파일 — 이 실행에만 더할 설정(훅 등). 사용자 settings.json과 합쳐진다 */
  settings?: string;
  /**
   * --bare: 훅·CLAUDE.md·사용자 MCP를 모두 끈 채 시작. 문서상 구독 로그인이 아니라 ANTHROPIC_API_KEY로 돌아 **토큰당 과금**된다.
   * 기본은 끔 — 구독(Pro/Max) 사용량으로 돈다. 대신 사용자 설정이 섞이므로 호출부가 env로 막을 것을 막는다.
   */
  bare?: boolean;
  /** claude 프로세스에 더할 환경 변수 (그 아래에서 도는 훅도 물려받는다) */
  env?: Record<string, string>;
  /** 작업 폴더 안 파일을 고치게 할 때 */
  permissionMode?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** 입력 단가를 1로 둔 가격 비율 — 캐시 쓰기(5분 TTL) 1.25, 캐시 읽기 0.1, 출력 5. 현행 Claude 모델이 모두 이 비율이다 */
const PRICE_WEIGHT: Usage = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

/**
 * 청구 비용 중 캐시 쓰기 몫 — 결과에는 모델별 총액만 있으므로, 모델마다 총액을 토큰 수 × 가격 비율로 나눠 쓰기 몫을 뗀다.
 * 콜드 캐시(그 세션의 첫 실행이 공통 머리말을 새로 쓰는 것)가 비용비를 흔들어, 벤치는 이 몫을 뺀 비용도 따로 낸다.
 */
export function cacheWriteCost(parts: { usage: Usage; costUsd: number }[]): number | null {
  if (parts.length === 0) return null;
  let total = 0;
  for (const { usage, costUsd } of parts) {
    const weighted = (Object.keys(PRICE_WEIGHT) as (keyof Usage)[]).reduce((sum, key) => sum + usage[key] * PRICE_WEIGHT[key], 0);
    if (weighted > 0) total += (costUsd * usage.cacheWrite * PRICE_WEIGHT.cacheWrite) / weighted;
  }
  return +total.toFixed(6);
}

export function runClaude(options: ClaudeOptions): Promise<AgentRun> {
  const args = [
    "-p",
    options.prompt,
    "--mcp-config",
    options.mcpConfig,
    "--strict-mcp-config",
    ...(options.tools !== undefined ? ["--tools", options.tools] : []),
    "--allowedTools",
    ...options.allowedTools,
    ...(options.maxTurns ? ["--max-turns", String(options.maxTurns)] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--max-budget-usd",
    options.budgetUsd ?? "0.50",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.settings ? ["--settings", options.settings] : []),
    ...(options.bare ? ["--bare"] : []),
    ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(options.env ?? {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const empty = (): AgentRun => ({ answer: "", tools: [], calls: [], turns: null, costUsd: null, usage: null, modelUsage: null, cacheWriteUsd: null, subtype: null, apiMs: null, ms: Date.now() - started });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ...empty(), error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const run: AgentRun = empty();
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_use") {
              run.tools.push(block.name);
              run.calls.push({ name: block.name, input: block.input });
            }
          }
        } else if (event.type === "result") {
          run.answer = typeof event.result === "string" ? event.result : "";
          run.turns = event.num_turns ?? null;
          run.costUsd = event.total_cost_usd ?? null;
          run.subtype = event.subtype ?? null;
          run.apiMs = event.duration_api_ms ?? null;
          const u = event.usage ?? {};
          run.usage = {
            input: u.input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
          // modelUsage는 서브에이전트까지 합친 값 — 캐시 생성·읽기가 청구액의 대부분이라 이쪽으로 센다
          const models = Object.values(event.modelUsage ?? {}) as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }[];
          const perModel = models.map((m) => ({
            usage: { input: m.inputTokens ?? 0, cacheWrite: m.cacheCreationInputTokens ?? 0, cacheRead: m.cacheReadInputTokens ?? 0, output: m.outputTokens ?? 0 },
            costUsd: m.costUSD,
          }));
          if (perModel.length > 0) {
            run.modelUsage = perModel.reduce(
              (sum, m) => ({
                input: sum.input + m.usage.input,
                cacheWrite: sum.cacheWrite + m.usage.cacheWrite,
                cacheRead: sum.cacheRead + m.usage.cacheRead,
                output: sum.output + m.usage.output,
              }),
              { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
            );
          }
          // 모델별 비용이 있으면 모델마다(단가가 다르다), 없으면 총액과 합계 토큰으로 나눈다
          const priced = perModel.filter((m): m is { usage: Usage; costUsd: number } => typeof m.costUsd === "number");
          const totals = run.modelUsage ?? run.usage;
          run.cacheWriteUsd = cacheWriteCost(priced.length === perModel.length && priced.length > 0 ? priced : run.costUsd !== null && totals ? [{ usage: totals, costUsd: run.costUsd }] : []);
          if (event.is_error) {
            const reason = run.answer.trim() || event.subtype || "unknown";
            run.error = /not logged in|\/login/i.test(reason)
              ? "Claude Code에 로그인돼 있지 않습니다 — 터미널에서 claude를 실행해 /login 하세요"
              : `claude 오류: ${reason.slice(0, 300)}`;
          }
        }
      }
      if (code !== 0 && !run.error) run.error = `claude 종료 코드 ${code}: ${stderr.trim().slice(0, 500)}`;
      resolve(run);
    });
  });
}
