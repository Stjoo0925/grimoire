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
  costUsd: number | null;
  usage: Usage | null;
  ms: number;
  error?: string;
}

export interface ClaudeOptions {
  prompt: string;
  cwd: string;
  /** --mcp-config 파일 (없으면 빈 설정으로 MCP를 모두 끈다) */
  mcpConfig: string;
  /** --tools 값 ("" = 내장 도구 전부 끔) */
  tools: string;
  allowedTools: string[];
  model?: string;
  budgetUsd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export function runClaude(options: ClaudeOptions): Promise<AgentRun> {
  const args = [
    "-p",
    options.prompt,
    "--mcp-config",
    options.mcpConfig,
    "--strict-mcp-config",
    "--tools",
    options.tools,
    "--allowedTools",
    ...options.allowedTools,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--max-budget-usd",
    options.budgetUsd ?? "0.50",
    ...(options.model ? ["--model", options.model] : []),
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ answer: "", tools: [], calls: [], turns: null, costUsd: null, usage: null, ms: Date.now() - started, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const run: AgentRun = { answer: "", tools: [], calls: [], turns: null, costUsd: null, usage: null, ms: Date.now() - started };
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
          const u = event.usage ?? {};
          run.usage = {
            input: u.input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
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
