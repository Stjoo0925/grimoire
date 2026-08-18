/**
 * 사용자 설정 — 순수 로직 유닛 테스트.
 * 모델 해석 순서(settings → env → 기본값), 모델 이름 검증 패턴, 설정/태그 파싱만 검사한다
 * (파일 I/O·네트워크 없음).
 *
 *   npm run test
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_OLLAMA_MODEL } from "../src/lib/graph/extractors/ollama";
import {
  MODEL_NAME_MAX,
  SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  isValidModelName,
  parseSettings,
  parseTagsResponse,
  resolveOllamaHost,
  resolveOllamaModel,
} from "../src/lib/settings";

/* ── 1. 모델 해석 순서 ────────────────────────────────────────── */

test("모델 해석: settings → OLLAMA_MODEL env → 기본값", () => {
  // 1순위: 화면에서 고른 값
  assert.equal(
    resolveOllamaModel({ schemaVersion: 1, ollamaModel: "qwen2.5:14b-instruct" }, {
      OLLAMA_MODEL: "llama3:8b",
    }),
    "qwen2.5:14b-instruct",
  );

  // 2순위: env (설정 파일에 값이 없을 때만)
  assert.equal(
    resolveOllamaModel({ schemaVersion: 1 }, { OLLAMA_MODEL: "llama3:8b" }),
    "llama3:8b",
  );

  // 3순위: 기본값
  assert.equal(resolveOllamaModel({ schemaVersion: 1 }, {}), DEFAULT_OLLAMA_MODEL);
  assert.equal(resolveOllamaModel(null, {}), DEFAULT_OLLAMA_MODEL);
  assert.equal(resolveOllamaModel(undefined, {}), DEFAULT_OLLAMA_MODEL);
});

test("모델 해석: 빈 문자열·공백 env는 없는 것으로 본다", () => {
  assert.equal(resolveOllamaModel(null, { OLLAMA_MODEL: "" }), DEFAULT_OLLAMA_MODEL);
  assert.equal(
    resolveOllamaModel(null, { OLLAMA_MODEL: "   " }),
    DEFAULT_OLLAMA_MODEL,
  );
  assert.equal(
    resolveOllamaModel(null, { OLLAMA_MODEL: " llama3:8b " }),
    "llama3:8b",
  );
});

test("모델 해석: 설정 파일에 이상한 값이 들어 있으면 env로 내려간다", () => {
  const broken = { schemaVersion: 1, ollamaModel: "rm -rf /" };
  assert.equal(
    resolveOllamaModel(broken, { OLLAMA_MODEL: "llama3:8b" }),
    "llama3:8b",
  );
  assert.equal(resolveOllamaModel(broken, {}), DEFAULT_OLLAMA_MODEL);
});

test("호스트 해석: OLLAMA_HOST → 기본값, 끝 슬래시 제거", () => {
  assert.equal(
    resolveOllamaHost({ OLLAMA_HOST: "http://ollama:11434/" }),
    "http://ollama:11434",
  );
  assert.equal(resolveOllamaHost({}), "http://localhost:11434");
});

/* ── 2. 모델 이름 검증 (pull 주입 방지) ───────────────────────── */

test("모델 이름: 정상 태그만 통과한다", () => {
  for (const ok of [
    "qwen2.5:7b-instruct",
    "qwen2.5:14b-instruct",
    "llama3",
    "nomic-embed-text",
    "hf.co/user/repo:Q4_K_M",
    "registry.local/ns/model:tag",
  ]) {
    assert.equal(isValidModelName(ok), true, ok);
  }
});

test("모델 이름: 쉘 메타문자·공백·빈 값은 거부한다", () => {
  for (const bad of [
    "",
    "   ",
    "qwen 7b",
    "model; rm -rf /",
    "model && curl evil.sh",
    "model|tee",
    "model$(whoami)",
    "model`id`",
    "model'x'",
    'model"x"',
    "model\nother",
    "모델",
    "a".repeat(MODEL_NAME_MAX + 1),
  ]) {
    assert.equal(isValidModelName(bad), false, JSON.stringify(bad));
  }

  assert.equal(isValidModelName(null), false);
  assert.equal(isValidModelName(42), false);
  assert.equal(isValidModelName(undefined), false);
});

/* ── 3. 설정 파싱 ─────────────────────────────────────────────── */

test("설정 파싱: 이상한 입력은 기본값으로 떨어진다", () => {
  assert.deepEqual(parseSettings(null), defaultSettings());
  assert.deepEqual(parseSettings("nope"), defaultSettings());
  assert.deepEqual(parseSettings([]), defaultSettings());
  assert.deepEqual(parseSettings({}), {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  });
});

test("설정 파싱: 유효한 모델만 살리고 스키마 버전을 보존한다", () => {
  assert.deepEqual(
    parseSettings({ schemaVersion: 3, ollamaModel: "qwen2.5:14b-instruct" }),
    { schemaVersion: 3, ollamaModel: "qwen2.5:14b-instruct" },
  );

  // 검증에 걸린 모델은 아예 저장 대상이 아니다
  assert.deepEqual(parseSettings({ ollamaModel: "bad model" }), {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  });
  assert.deepEqual(parseSettings({ schemaVersion: 0 }), {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  });
});

/* ── 4. /api/tags 응답 파싱 ───────────────────────────────────── */

test("태그 파싱: 이름 기준 정렬 + 형태가 어긋난 항목 제거", () => {
  const parsed = parseTagsResponse({
    models: [
      { name: "qwen2.5:7b-instruct", size: 4_700_000_000 },
      { name: "llama3:8b" },
      { model: "nomic-embed-text", size: "big" },
      { size: 1 },
      null,
      "nope",
    ],
  });

  assert.deepEqual(parsed, [
    { name: "llama3:8b", sizeBytes: null },
    { name: "nomic-embed-text", sizeBytes: null },
    { name: "qwen2.5:7b-instruct", sizeBytes: 4_700_000_000 },
  ]);
});

test("태그 파싱: models가 없으면 빈 목록", () => {
  assert.deepEqual(parseTagsResponse(null), []);
  assert.deepEqual(parseTagsResponse({}), []);
  assert.deepEqual(parseTagsResponse({ models: "x" }), []);
});
