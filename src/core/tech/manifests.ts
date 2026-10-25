/**
 * 기술 스택 — 결정론적 정적 분석.
 *
 * 의존성 매니페스트 원문 → 패키지 이름 목록. 비용 0, LLM 불필요.
 * 파서는 전부 "관대하게" 동작한다 — 깨진 파일이면 빈 배열을 주고 넘어간다.
 */

/** 매니페스트에서 뽑아낸 의존성 하나 */
export interface ParsedDependency {
  /** 매니페스트에 적힌 원래 이름 */
  raw: string;
  /** 개발 의존성인가 (weight를 낮게 준다) */
  dev: boolean;
}

const NOISE_PREFIXES = ["@types/", "types-", "eslint-config-", "eslint-plugin-"];

function isNoisePackage(name: string): boolean {
  return NOISE_PREFIXES.some((p) => name.startsWith(p));
}

function parsePackageJson(content: string): ParsedDependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const pkg = parsed as Record<string, unknown>;

  const out: ParsedDependency[] = [];
  const pick = (key: string, dev: boolean) => {
    const section = pkg[key];
    if (typeof section !== "object" || section === null) return;
    for (const name of Object.keys(section as Record<string, unknown>)) {
      if (!name || isNoisePackage(name)) continue;
      out.push({ raw: name, dev });
    }
  };
  pick("dependencies", false);
  pick("peerDependencies", false);
  pick("devDependencies", true);
  return out;
}

/** requirements.txt — `pkg==1.2.3`, `pkg[extra]>=1`, `-r other.txt` 등 */
function parseRequirementsTxt(content: string): ParsedDependency[] {
  const out: ParsedDependency[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.split("#")[0].trim();
    if (!trimmed) continue;
    // -r/-e/--flag 라인, URL 직접 설치는 건너뛴다.
    if (trimmed.startsWith("-") || /^[a-z]+\+?https?:/i.test(trimmed)) continue;
    const name = trimmed.split(/[<>=!~;\s[]/)[0].trim();
    if (name) out.push({ raw: name, dev: false });
  }
  return out;
}

/** TOML의 `key = ...` / `"key" = ...` 에서 key만 뽑는다 */
function tomlSectionKeys(lines: string[]): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    const trimmed = line.split("#")[0].trim();
    if (!trimmed) continue;
    const match = /^["']?([A-Za-z0-9_.\-@/]+)["']?\s*=/.exec(trimmed);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** 주어진 섹션 헤더 아래 라인들 (다음 [section]까지) */
function tomlSection(content: string, header: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(
    (l) => l.split("#")[0].trim() === `[${header}]`,
  );
  if (start < 0) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

/**
 * pyproject.toml — PEP 621 `[project] dependencies = [...]`와
 * poetry `[tool.poetry.dependencies]` 양쪽을 훑는다.
 */
function parsePyproject(content: string): ParsedDependency[] {
  const out: ParsedDependency[] = [];

  // [project] dependencies = ["fastapi>=0.1", "uvicorn"]  (여러 줄 가능)
  const arrayMatch = /dependencies\s*=\s*\[([\s\S]*?)\]/g;
  let match: RegExpExecArray | null;
  while ((match = arrayMatch.exec(content)) !== null) {
    for (const item of match[1].split(",")) {
      const quoted = /["']([^"']+)["']/.exec(item);
      if (!quoted) continue;
      const name = quoted[1].split(/[<>=!~;\s[]/)[0].trim();
      if (name) out.push({ raw: name, dev: false });
    }
  }

  for (const [header, dev] of [
    ["tool.poetry.dependencies", false],
    ["tool.poetry.group.dev.dependencies", true],
    ["tool.poetry.dev-dependencies", true],
  ] as const) {
    for (const key of tomlSectionKeys(tomlSection(content, header))) {
      if (key.toLowerCase() === "python") continue;
      out.push({ raw: key, dev });
    }
  }
  return out;
}

/** go.mod — require 블록/단일 require 라인의 모듈 경로 */
function parseGoMod(content: string): ParsedDependency[] {
  const out: ParsedDependency[] = [];
  let inBlock = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("//")[0].trim();
    if (!line) continue;
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const target = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
    if (!target) continue;
    const modulePath = target.split(/\s+/)[0];
    if (!modulePath || !modulePath.includes("/")) continue;
    // github.com/gin-gonic/gin → gin, .../v2 같은 메이저 접미사는 버린다.
    const segments = modulePath.split("/").filter((s) => !/^v\d+$/.test(s));
    const name = segments.at(-1);
    if (name) out.push({ raw: name, dev: line.includes("// indirect") });
  }
  return out;
}

/** Cargo.toml — [dependencies] / [dev-dependencies] */
function parseCargoToml(content: string): ParsedDependency[] {
  const out: ParsedDependency[] = [];
  for (const key of tomlSectionKeys(tomlSection(content, "dependencies"))) {
    out.push({ raw: key, dev: false });
  }
  for (const header of ["dev-dependencies", "build-dependencies"]) {
    for (const key of tomlSectionKeys(tomlSection(content, header))) {
      out.push({ raw: key, dev: true });
    }
  }
  return out;
}

const PARSERS: Record<string, (content: string) => ParsedDependency[]> = {
  "package.json": parsePackageJson,
  "requirements.txt": parseRequirementsTxt,
  "pyproject.toml": parsePyproject,
  "go.mod": parseGoMod,
  "Cargo.toml": parseCargoToml,
};

/** 매니페스트 하나를 파싱한다. 모르는 경로/깨진 내용이면 빈 배열. */
export function parseManifest(
  filePath: string,
  content: string,
): ParsedDependency[] {
  const base = filePath.split("/").at(-1) ?? filePath;
  const parser = PARSERS[base];
  if (!parser) return [];
  try {
    return parser(content);
  } catch {
    return [];
  }
}

/** 레포의 매니페스트 묶음 전체 → 의존성 (경로 정보 포함) */
export function parseManifests(
  manifests: Record<string, string> | undefined,
): { dependency: ParsedDependency; manifestPath: string }[] {
  if (!manifests) return [];
  const out: { dependency: ParsedDependency; manifestPath: string }[] = [];
  for (const [manifestPath, content] of Object.entries(manifests)) {
    for (const dependency of parseManifest(manifestPath, content)) {
      out.push({ dependency, manifestPath });
    }
  }
  return out;
}
