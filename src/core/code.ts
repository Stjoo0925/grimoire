/**
 * 현재 코드 색인 — HEAD의 소스 파일마다 경로·최상위 심볼(줄 번호)·머리 주석을 검색 문서로 만든다.
 *
 * "그 코드 어디 있지?"에 AI가 프로젝트를 순회하지 않고 한 번에 파일과 줄을 짚게 하려는 것이다.
 * 심볼은 언어별 정규식으로 뽑는다(파서 없이 빠르게, 틀려도 검색 재료일 뿐이다).
 * 증분: 파일별 blob sha를 기억해 바뀐 파일만 다시 읽는다.
 */
import { execFile } from "node:child_process";
import path from "node:path";

import { runGit } from "./git";

/** 색인할 소스 확장자 */
export const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".rb", ".php", ".cs",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".scala", ".sql", ".sh", ".dart", ".ex", ".exs",
]);
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.venv|dist|build|out|\.next|coverage|generated|__generated__)\//;
const MINIFIED = /\.min\.(js|css)$/;
/** 이보다 큰 파일은 생성물일 가능성이 높아 건너뛴다 */
export const MAX_FILE_BYTES = 200 * 1024;
/** 레포 하나에서 색인할 파일 수 상한 */
export const MAX_FILES = 8000;
/** 파일 하나에서 뽑는 심볼 수 상한 */
const MAX_SYMBOLS = 150;
const HEADER_CHARS = 300;

export interface CodeSymbol {
  name: string;
  line: number;
}

export interface HeadFile {
  path: string;
  blob: string;
  size: number;
}

export function isIndexable(file: string, size: number): boolean {
  if (size > MAX_FILE_BYTES || VENDORED.test(file) || MINIFIED.test(file)) return false;
  return SOURCE_EXT.has(path.posix.extname(file).toLowerCase());
}

/** HEAD 트리의 색인 대상 파일 (경로·blob sha·크기) */
export async function listHeadFiles(dir: string): Promise<HeadFile[]> {
  let out: string;
  try {
    out = await runGit(dir, ["ls-tree", "-r", "-l", "-z", "HEAD"]);
  } catch {
    return []; // 커밋이 없는 레포
  }
  const files: HeadFile[] = [];
  for (const entry of out.split("\0")) {
    // "<mode> blob <sha> <size>\t<path>"
    const match = /^\d+ blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/.exec(entry);
    if (!match) continue;
    const size = Number(match[2]);
    if (isIndexable(match[3], size)) files.push({ path: match[3], blob: match[1], size });
  }
  return files.slice(0, MAX_FILES);
}

/** blob 여러 개를 git cat-file --batch 한 번으로 읽는다 */
export async function readBlobs(dir: string, blobs: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  if (blobs.length === 0) return contents;
  const out = await runGitBuffer(dir, ["cat-file", "--batch"], blobs.join("\n") + "\n");
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = out.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match) {
      offset = headerEnd + 1; // "missing" 등
      continue;
    }
    const size = Number(match[2]);
    const start = headerEnd + 1;
    contents.set(match[1], out.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  return contents;
}

function runGitBuffer(dir: string, args: string[], input: string): Promise<Buffer> {
  // runGit은 utf8 문자열을 돌려주지만 cat-file은 크기 단위가 바이트라 버퍼가 필요하다
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: dir, maxBuffer: 512 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} 실패 (${dir}): ${String(stderr).trim() || error.message}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

/** 언어 무관 선언 패턴 — 줄 단위로 맞춘다 */
const DECLARATIONS: RegExp[] = [
  // JS/TS
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  // Python
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  // Go
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/,
  // Rust
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  // Java / Kotlin / Swift / C#
  /^\s*(?:public|private|protected|internal|open|data|sealed|abstract|static|final|\s)*\s*(?:class|interface|object|struct|record)\s+([A-Za-z_]\w*)/,
  /^\s*(?:public|private|protected|internal|override|suspend|static|\s)*\s*fun\s+([A-Za-z_]\w*)/,
  // Ruby / PHP
  /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/,
];
/** HTTP 라우트 — express/fastify/flask/spring 등 흔한 꼴 */
const ROUTES: RegExp[] = [
  /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/i,
  /@(?:app|router|bp|blueprint)\.(get|post|put|patch|delete|route)\(\s*["']([^"']+)["']/i,
  /@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
];
const NOISE = new Set(["if", "for", "while", "switch", "return", "constructor", "default", "function", "main", "init", "__init__"]);

export function extractSymbols(content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS; index++) {
    const line = lines[index];
    if (line.length > 400) continue;
    for (const pattern of ROUTES) {
      const match = pattern.exec(line);
      if (match) {
        const name = `${match[1].toUpperCase()} ${match[2]}`;
        if (!seen.has(name)) {
          seen.add(name);
          symbols.push({ name, line: index + 1 });
        }
        break;
      }
    }
    for (const pattern of DECLARATIONS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match[1];
      if (!NOISE.has(name) && !seen.has(name)) {
        seen.add(name);
        symbols.push({ name, line: index + 1 });
      }
      break;
    }
  }
  return symbols;
}

/** 파일 맨 앞(첫 15줄 안)의 설명 주석 */
export function headerComment(content: string): string {
  const head = content.split("\n").slice(0, 15);
  const collected: string[] = [];
  let inBlock = false;
  for (const raw of head) {
    const line = raw.trim();
    if (!inBlock && /^(\/\*\*?|"""|''')/.test(line)) {
      inBlock = !/(\*\/|"""|''')\s*$/.test(line.slice(3));
      collected.push(line.replace(/^(\/\*\*?|"""|''')/, "").replace(/(\*\/|"""|''')$/, ""));
      continue;
    }
    if (inBlock) {
      if (/(\*\/|"""|''')\s*$/.test(line)) inBlock = false;
      // 닫는 표시를 먼저 떼야 " */"가 "/"로 남지 않는다
      collected.push(line.replace(/(\*\/|"""|''')$/, "").replace(/^\*\s?/, ""));
      continue;
    }
    if (/^(\/\/|#(?!!)|--)/.test(line)) {
      collected.push(line.replace(/^(\/\/+|#+|--)\s?/, ""));
      continue;
    }
    if (line === "" && collected.length === 0) continue;
    if (/^#!/.test(line) || /^["']use (strict|client|server)["'];?$/.test(line)) continue;
    break;
  }
  return collected.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, HEADER_CHARS);
}

/** camelCase·snake_case·kebab-case → 낱말 ("requireFirestoreRateLimit" → "require firestore rate limit") */
export function splitIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./$]+/g, " ")
    .toLowerCase()
    .trim();
}
