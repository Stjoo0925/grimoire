/**
 * 업그레이드 점검 — 옛 빌드로 만든 DB를 지금 소스로 열어, 사용자가 겪을 업그레이드를 처음부터 끝까지 확인한다.
 *
 *   npm run upgrade-check -- --from <옛 dist>     예: npm 전역에 깔린 지난 릴리스의 dist 폴더
 *   npm run upgrade-check -- --from <옛 dist> --repo <레포>   색인할 레포 (기본: 이 레포)
 *
 * 임시 폴더에서만 돈다 — 실제 ~/.grimoire는 열지 않는다(열면 마이그레이션이 돈다).
 * 옛 빌드로: 레포 등록·동기화, 비밀이 섞인 노트, 옛 규칙으로 걸러진 프롬프트를 남긴다.
 * 지금 소스로: 마이그레이션 → 동기화 뒤 스키마 버전, 공변경 재계산, change_key, 비밀 지우기, 검색이 맞는지 본다.
 * 하나라도 어긋나면 종료 코드 1. 릴리스 전에 지난 릴리스 dist를 --from으로 준다.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import { tempDir } from "../tests/helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SECRET_URL_PASSWORD = "upgradepw123";
const SECRET_KEY = "upgrade_key_value99";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { from: { type: "string" }, repo: { type: "string" } } });
  if (!values.from) {
    console.error("--from <옛 dist 폴더>가 필요합니다 (예: npm 전역에 깔린 지난 릴리스의 dist)");
    return 2;
  }
  const oldDist = path.resolve(values.from);
  const newDist = path.resolve(__dirname, "..", "src");
  const repoDir = path.resolve(values.repo ?? path.join(__dirname, "..", ".."));
  const file = path.join(tempDir("grimoire-upgrade-"), "grimoire.db");
  const load = (dist: string, name: string) => require(path.join(dist, name));

  // 1) 옛 빌드
  const old = { db: load(oldDist, "core/db"), indexer: load(oldDist, "core/indexer"), notes: load(oldDist, "core/notes"), capture: load(oldDist, "core/capture") };
  let oldVersion: number;
  {
    const db = old.db.openDb(file);
    const repo = await old.indexer.addRepo(db, repoDir);
    await old.indexer.syncRepo(db, repo);
    old.notes.addNote(db, { text: `원인: DATABASE_URL=postgres://app:${SECRET_URL_PASSWORD}@db/x 로 풀 고갈`, tags: ["auth", "token"], source: "mcp" });
    old.capture.recordPrompt(db, "upgrade-session", repo.id, `OPENAI_API_KEY=${SECRET_KEY} 로 결제 재시도 고쳐`);
    oldVersion = db.pragma("user_version") as number;
    db.close();
  }

  // 2) 지금 소스
  const now = { db: load(newDist, "core/db"), indexer: load(newDist, "core/indexer"), context: load(newDist, "core/context"), search: load(newDist, "core/search") };
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const started = Date.now();
  const db = now.db.openDb(file);
  const migrateMs = Date.now() - started;
  const repo = now.indexer.listRepos(db)[0];
  const version = db.pragma("user_version") as number;
  check("마이그레이션", version > oldVersion, `${oldVersion} → ${version} (${migrateMs}ms)`);
  await now.indexer.syncRepo(db, repo);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  check("공변경 재계산", count("SELECT COUNT(*) AS n FROM cochange") > 0 && !now.context.needsCochangeBackfill(db, repo.id), `쌍 ${count("SELECT COUNT(*) AS n FROM cochange")}개`);
  check("change_key", count("SELECT COUNT(*) AS n FROM commits WHERE change_key IS NULL") === 0, `빈 키 ${count("SELECT COUNT(*) AS n FROM commits WHERE change_key IS NULL")}개`);
  const stored = (db.prepare("SELECT text FROM notes UNION ALL SELECT text FROM session_events").all() as { text: string }[]).map((row) => row.text).join("\n");
  check("저장된 비밀 지움", !stored.includes(SECRET_URL_PASSWORD) && !stored.includes(SECRET_KEY), stored.includes(SECRET_KEY) || stored.includes(SECRET_URL_PASSWORD) ? "남아 있음" : "없음");
  const tags = (db.prepare("SELECT tags FROM notes").get() as { tags: string }).tags;
  check("노트 태그 보존", tags === "auth token", tags);
  check("검색에서 비밀 사라짐", now.search.search(db, SECRET_URL_PASSWORD).hits.length === 0, `${now.search.search(db, SECRET_URL_PASSWORD).hits.length}건`);
  check("나머지 말은 검색됨", now.search.search(db, "풀 고갈").hits.length > 0, `${now.search.search(db, "풀 고갈").hits.length}건`);
  db.close();

  for (const item of checks) console.log(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`);
  const failed = checks.filter((item) => !item.ok).length;
  console.log(failed === 0 ? `\n${checks.length}/${checks.length} 통과` : `\n${failed}개 실패`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  },
);
