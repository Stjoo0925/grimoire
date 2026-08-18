/**
 * 사용자 설정 — `data/settings.json` (서버 전용).
 *
 * `.env.local`을 손으로 고치지 않고도 화면에서 로컬 LLM 모델을 고를 수 있게 한다.
 * 저장소는 `./data` 하나뿐이라는 원칙(PLANNING.md §5)을 따르고, `data/`는 이미 gitignore 대상이다.
 *
 * **해석 순서 (모델이 필요한 모든 곳에서 동일)**
 *   settings.ollamaModel → OLLAMA_MODEL 환경변수 → DEFAULT_OLLAMA_MODEL
 *
 * 외부 API는 여전히 관여하지 않는다 — 여기서 고르는 것은 이 컴퓨터의 Ollama 모델뿐이다
 * (PLANNING.md §7).
 *
 * Node fs를 쓰므로 서버에서만 import할 것.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
} from "./graph/extractors/ollama";

export { DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL };

/** 설정 파일 형식 버전 — 필드가 늘어나면 올린다. */
export const SETTINGS_SCHEMA_VERSION = 1;

export interface GrimoireSettings {
  schemaVersion: number;
  /** 사서 응답 합성·그래프 추출에 쓸 Ollama 모델 태그 */
  ollamaModel?: string;
}

export type Env = Record<string, string | undefined>;

/**
 * 허용되는 모델 태그 문자 — 영숫자/밑줄, 점, 하이픈, 콜론, 슬래시.
 * `ollama pull`에 넘어가므로 공백·따옴표·쉘 메타문자를 원천 차단한다.
 */
export const MODEL_NAME_PATTERN = /^[\w.\-:/]+$/;
/** 태그 길이 상한 (터무니없이 긴 입력 방지) */
export const MODEL_NAME_MAX = 128;

export function isValidModelName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MODEL_NAME_MAX &&
    MODEL_NAME_PATTERN.test(value)
  );
}

export function defaultSettings(): GrimoireSettings {
  return { schemaVersion: SETTINGS_SCHEMA_VERSION };
}

/** 파일에서 읽은 임의의 값 → 안전한 설정 객체. 이상한 값은 조용히 버린다. */
export function parseSettings(raw: unknown): GrimoireSettings {
  const settings = defaultSettings();
  if (!raw || typeof raw !== "object") return settings;

  const record = raw as Record<string, unknown>;
  if (
    typeof record.schemaVersion === "number" &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion > 0
  ) {
    settings.schemaVersion = record.schemaVersion;
  }
  if (isValidModelName(record.ollamaModel)) {
    settings.ollamaModel = record.ollamaModel;
  }
  return settings;
}

/**
 * 모델 해석 (순수 함수 — 유닛 테스트 대상).
 * settings.ollamaModel → env.OLLAMA_MODEL → DEFAULT_OLLAMA_MODEL
 */
export function resolveOllamaModel(
  settings: GrimoireSettings | null | undefined,
  env: Env = process.env,
): string {
  if (isValidModelName(settings?.ollamaModel)) return settings.ollamaModel;
  const fromEnv = env.OLLAMA_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_OLLAMA_MODEL;
}

/** 호스트는 아직 화면에서 고르지 않는다 — env → 기본값. */
export function resolveOllamaHost(env: Env = process.env): string {
  return (env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).replace(/\/$/, "");
}

const SETTINGS_DIR = path.join(process.cwd(), "data");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

export function settingsPath(): string {
  return SETTINGS_FILE;
}

/** 저장된 설정. 파일이 없거나 깨졌으면 기본값. */
export async function loadSettings(): Promise<GrimoireSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultSettings();
    }
    throw error;
  }
  try {
    return parseSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

/**
 * 부분 갱신 후 저장. 임시 파일에 쓰고 rename하므로
 * 중간에 죽어도 반쯤 쓰인 JSON이 남지 않는다.
 */
export async function saveSettings(
  patch: Partial<GrimoireSettings>,
): Promise<GrimoireSettings> {
  const current = await loadSettings();
  const next = parseSettings({
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  });

  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  const temp = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temp, SETTINGS_FILE);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return next;
}

/* ── 화면(설정 패널)이 쓰는 형태 ──────────────────────────────── */

export interface OllamaModelOption {
  /** 모델 태그 (예: qwen2.5:7b-instruct) */
  name: string;
  /** 디스크 크기(바이트). 모르면 null */
  sizeBytes: number | null;
}

export interface ModelOptionsResult {
  /** 로컬 Ollama에 닿았는가 */
  reachable: boolean;
  host: string;
  /** 지금 실제로 쓰이는 모델 (해석 순서 적용 결과) */
  current: string;
  /** 그 값이 화면에서 고른 것(settings.json)인가 */
  fromSettings: boolean;
  /** 설치되어 있는 모델 목록 (닿지 않으면 빈 배열) */
  models: OllamaModelOption[];
  /** 안내/오류 문구 (i18n 완료된 문장) */
  message: string | null;
}

export interface ModelActionResult {
  ok: boolean;
  /** 성공 시 새로 적용된 모델 */
  current: string | null;
  message: string;
}

/** `/api/tags` 응답 → 모델 목록. 형태가 어긋난 항목은 버린다 (순수 함수). */
export function parseTagsResponse(raw: unknown): OllamaModelOption[] {
  const models = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];

  const options: OllamaModelOption[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : typeof record.model === "string"
          ? record.model.trim()
          : "";
    if (!name) continue;
    options.push({
      name,
      sizeBytes:
        typeof record.size === "number" && Number.isFinite(record.size)
          ? record.size
          : null,
    });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/** 지금 써야 할 Ollama 모델 (설정 파일까지 반영한 최종값). */
export async function getOllamaModel(env: Env = process.env): Promise<string> {
  return resolveOllamaModel(await loadSettings(), env);
}
