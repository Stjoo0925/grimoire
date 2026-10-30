/**
 * 영향 범위 — "이 파일들을 바꾸면 같이 봐야 할 곳"을 정적 구조와 이력을 합쳐 순위 매긴다.
 *
 *   import    import 그래프 이웃 (1홉 양방향, 2홉은 약하게) — 정적 구조. 상대 경로와 경로 별칭(@/x 등)
 *   ref       정의-참조 그래프 — 한쪽이 정의한 심볼 이름을 다른 쪽이 언급한다(Aider repo map). import 문이 없는 언어(C# 등)용
 *   cochange  같이 바뀌어 온 파일 (신뢰도) — 이력에만 있는 결합. 정적 그래프 도구(code-review-graph 등)에는 없다
 *   test      이름 규칙 짝 테스트
 *   dir       같은 디렉터리 — 혼자서는 기준선(가장 약함)이지만, 다른 근거가 없는 파일에도 후보를 내 합치면 recall이 오른다
 *   sibling   형제 폴더의 같은 이름 파일 (login/layout.tsx ↔ register/layout.tsx) — 라우트별로 같은 꼴을 맞추는 변경
 *   intent    작업 의도(문장)를 주면: 그 말로 찾은 과거 커밋이 건드린 파일 + 파일 검색. 구조·이력 순위와 RRF로 합친다.
 *             같은 개념을 여러 계층에서 고치는 변경은 구조로는 2홉 이웃 수백 개와 구별되지 않는다 — 다중 파일 fix 20개에서
 *             중앙 순위 22 → 6, 시간 분할 845질의에서 R@10 0.39 → 0.414 (p=0.016, 노트 #43). Ripple의 "의도로 정제"를 결정론으로.
 *
 * 근거마다 확률처럼 읽히는 점수를 주고 noisy-OR로 합친다(1 − Π(1 − p)) — 근거가 여럿이면 올라가되 1을 넘지 않고,
 * 점수 하나하나를 그대로 이유로 보여 줄 수 있다. 가중치는 e2e/impactbench.ts --grid로 훑었을 때 MRR이 0.38~0.39로 거의
 * 움직이지 않았다 — 성능을 가르는 것은 가중치가 아니라 어떤 근거를 켜느냐다.
 */
import path from "node:path";

import { cochangeOf, namedTests, TEST_PATH } from "./context";
import type { DB } from "./db";
import { runGit } from "./git";
import { notesForFile, type NoteHint } from "./notes";
import { buildMatchExpression } from "./search";

export type ImpactSource = "import" | "import2" | "ref" | "cochange" | "test" | "dir" | "sibling" | "intent";

export const IMPACT_SOURCES: ImpactSource[] = ["import", "import2", "ref", "cochange", "test", "dir", "sibling"];
/**
 * 기본으로 켜는 근거 — 전부. 이력 분할 평가(레포 6개, 질의 649개, e2e/impactbench.ts):
 * import+2홉만 0.336 → 공변경·테스트·폴더를 더하면 0.516 → 정의-참조·형제를 더하고 가중치를 고르면 0.573 (hit@5)
 */
export const DEFAULT_SOURCES: ImpactSource[] = ["import", "import2", "ref", "cochange", "test", "dir", "sibling"];

/**
 * 근거별 점수 — cochange는 신뢰도에 곱한다. ref는 혼자서는 가장 센 근거지만(hit@5 0.41) import와 같은 쌍을 겹쳐 세므로
 * 합칠 때는 약하게 둔다 — import가 없는 언어에서는 이것만으로도 후보 순위가 선다 (--grid, 다른 시간 분할로 확인)
 */
export const WEIGHTS: Record<ImpactSource, number> = {
  import: 0.2,
  import2: 0.1,
  cochange: 1,
  test: 0.5,
  dir: 0.05,
  ref: 0.05,
  sibling: 0.15,
  // 점수에는 넣지 않는다 — 순위만 RRF로 합친다 (점수 문턱을 쓰는 커밋 직전 알림이 흔들리지 않게)
  intent: 0,
};
/** RRF 상수 — 상위 몇 개가 순위를 좌우하나. 실험(fuse.js)과 같은 값 */
const INTENT_RRF_K = 20;
/** 의도 검색에서 보는 커밋·파일 수 */
const INTENT_COMMITS = 20;
const INTENT_FILES = 30;
/** 정의-참조: 이 수보다 많은 파일이 정의한 이름은 모호해서, 이 수보다 많은 파일이 언급하는 이름은 허브라서 뺀다 */
const REF_DEF_MAX = 3;
const REF_USE_MAX = 40;
/** 형제가 이보다 많으면(page.tsx가 라우트마다 있는 식) 잇는 힘이 없어 뺀다 */
const SIBLING_MAX = 8;
/** 공변경 근거의 최소 지지도 — 영향 범위는 놓치지 않는 쪽이 중요해 file_context(3)보다 낮다 */
const COCHANGE_MIN_SUPPORT = 2;
/** 2홉 이웃을 펼칠 1홉 이웃 수 상한 (허브 파일에서 폭발하지 않게) */
const HOP2_FANOUT = 30;

export interface ImpactReason {
  source: ImpactSource;
  /** 이 근거를 낸 바뀐 파일 */
  from: string;
  score: number;
  /** 사람이 읽는 한 줄: "imports a.ts", "co-changed 4/6" … */
  detail: string;
  /** cochange: 같이 바뀐 커밋 수 */
  support?: number;
}

export interface ImpactItem {
  path: string;
  score: number;
  test: boolean;
  reasons: ImpactReason[];
}

export interface Impact {
  changed: string[];
  items: ImpactItem[];
  /** 바뀐 파일과 영향받는 상위 파일에 묶인 노트 */
  notes: (NoteHint & { path: string })[];
}

export interface ImpactOptions {
  sources?: ImpactSource[];
  limit?: number;
  /** 노트는 상위 몇 개 파일까지 모으나 (0이면 안 모은다 — 평가용) */
  noteFiles?: number;
  /** 가중치 덮어쓰기 — 평가(e2e/impactbench.ts --grid)용 */
  weights?: Partial<Record<ImpactSource, number>>;
  /** 작업 의도(사용자의 요청·변경 계획) — 주면 그 말로 찾은 파일을 순위에 합친다 */
  intent?: string;
}

export function impactOf(db: DB, repoId: number, changed: string[], options: ImpactOptions = {}): Impact {
  const sources = new Set(options.sources ?? DEFAULT_SOURCES);
  const weight = { ...WEIGHTS, ...options.weights };
  const seeds = [...new Set(changed)];
  const seedSet = new Set(seeds);
  const found = new Map<string, ImpactReason[]>();
  const add = (target: string, reason: ImpactReason) => {
    if (seedSet.has(target) || reason.score <= 0) return;
    const list = found.get(target) ?? [];
    // 같은 근거·같은 출발 파일은 한 번만 (가장 센 것)
    const same = list.findIndex((item) => item.source === reason.source && item.from === reason.from);
    if (same >= 0) {
      if (list[same].score < reason.score) list[same] = reason;
    } else list.push(reason);
    found.set(target, list);
  };

  const importsOf = db.prepare("SELECT target AS other FROM file_imports WHERE repo_id = ? AND path = ?");
  const importersOf = db.prepare("SELECT path AS other FROM file_imports WHERE repo_id = ? AND target = ?");
  // 정의-참조 — 이름이 모호하거나(정의 파일 > REF_DEF_MAX) 허브면(언급 파일 > REF_USE_MAX) 뺀다.
  // 이 파일에 걸린 이름만 먼저 추리고(names), 이름마다 한 번만 센다 — 행마다 다시 세면 1천 파일 레포에서 질의당 20ms
  const refEdges = (namesSql: string, otherSql: string) =>
    db.prepare(
      `WITH names AS (${namesSql}),
            defs AS (SELECT name FROM file_defs WHERE repo_id = ? AND name IN (SELECT name FROM names) GROUP BY name HAVING COUNT(*) <= ?),
            uses AS (SELECT name FROM file_refs WHERE repo_id = ? AND name IN (SELECT name FROM defs) GROUP BY name HAVING COUNT(*) <= ?)
       ${otherSql}`,
    );
  const usesOf = refEdges(
    "SELECT name FROM file_refs WHERE repo_id = ? AND path = ?",
    "SELECT d.path AS other, d.name FROM file_defs d WHERE d.repo_id = ? AND d.name IN (SELECT name FROM uses) AND d.path <> ?",
  );
  const usedByOf = refEdges(
    "SELECT name FROM file_defs WHERE repo_id = ? AND path = ?",
    "SELECT f.path AS other, f.name FROM file_refs f WHERE f.repo_id = ? AND f.name IN (SELECT name FROM uses) AND f.path <> ?",
  );
  const neighbors = (file: string) => ({
    out: (importsOf.all(repoId, file) as { other: string }[]).map((row) => row.other),
    in: (importersOf.all(repoId, file) as { other: string }[]).map((row) => row.other),
  });

  for (const seed of seeds) {
    if (sources.has("import") || sources.has("import2")) {
      const hop1 = neighbors(seed);
      if (sources.has("import")) {
        for (const other of hop1.in) add(other, { source: "import", from: seed, score: weight.import, detail: `imports ${seed}` });
        for (const other of hop1.out) add(other, { source: "import", from: seed, score: weight.import, detail: `imported by ${seed}` });
      }
      if (sources.has("import2")) {
        const first = [...new Set([...hop1.in, ...hop1.out])].slice(0, HOP2_FANOUT);
        for (const middle of first) {
          const hop2 = neighbors(middle);
          for (const other of [...hop2.in, ...hop2.out]) {
            if (other === seed) continue;
            add(other, { source: "import2", from: seed, score: weight.import2, detail: `via ${middle}` });
          }
        }
      }
    }
    if (sources.has("ref")) {
      const names = new Map<string, { names: string[]; uses: boolean }>();
      const collect = (rows: { other: string; name: string }[], uses: boolean) => {
        for (const row of rows) {
          const entry = names.get(row.other) ?? { names: [], uses };
          entry.names.push(row.name);
          names.set(row.other, entry);
        }
      };
      const args = [repoId, seed, repoId, REF_DEF_MAX, repoId, REF_USE_MAX, repoId, seed];
      collect(usesOf.all(...args) as { other: string; name: string }[], true);
      collect(usedByOf.all(...args) as { other: string; name: string }[], false);
      for (const [other, entry] of names) {
        const shown = entry.names.slice(0, 2).join(", ");
        add(other, {
          source: "ref",
          from: seed,
          // 이름을 여럿 나누면 더 세다 — 셋에서 멈춘다
          score: 1 - (1 - weight.ref) ** Math.min(3, entry.names.length),
          detail: entry.uses ? `${seed} uses its ${shown}` : `uses ${shown} from ${seed}`,
        });
      }
    }
    if (sources.has("cochange")) {
      for (const item of cochangeOf(db, repoId, seed, { minSupport: COCHANGE_MIN_SUPPORT, minConfidence: 0, limit: 200 })) {
        add(item.path, {
          source: "cochange",
          from: seed,
          score: Math.min(1, item.confidence) * weight.cochange,
          detail: `co-changed with ${seed} ${item.support}× (${Math.round(item.confidence * 100)}%)`,
          support: item.support,
        });
      }
    }
    if (sources.has("test")) {
      for (const test of namedTests(db, repoId, seed).slice(0, 2)) add(test, { source: "test", from: seed, score: weight.test, detail: `test of ${seed}` });
    }
    if (sources.has("dir")) {
      const dir = path.posix.dirname(seed);
      const rows = db
        .prepare("SELECT path FROM code_files WHERE repo_id = ? AND path LIKE ? AND path NOT LIKE ? LIMIT 50")
        .all(repoId, `${dir}/%`, `${dir}/%/%`) as { path: string }[];
      for (const row of rows) add(row.path, { source: "dir", from: seed, score: weight.dir, detail: `same folder as ${seed}` });
    }
    if (sources.has("sibling")) {
      const siblings = siblingsOf(db, repoId, seed);
      if (siblings.length <= SIBLING_MAX) for (const other of siblings) add(other, { source: "sibling", from: seed, score: weight.sibling, detail: `same name as ${seed}` });
    }
  }

  const items: ImpactItem[] = [...found.entries()].map(([file, reasons]) => {
    reasons.sort((a, b) => b.score - a.score);
    const score = 1 - reasons.reduce((rest, reason) => rest * (1 - reason.score), 1);
    return { path: file, score: Math.round(score * 1000) / 1000, test: TEST_PATH.test(file), reasons };
  });
  // 점수 순, 같으면 근거 수, 그다음 경로 (결정론)
  items.sort((a, b) => b.score - a.score || b.reasons.length - a.reasons.length || a.path.localeCompare(b.path));
  const ranked = options.intent?.trim() ? withIntent(db, repoId, items, options.intent, seedSet) : items;
  const top = ranked.slice(0, options.limit ?? 20);

  const noteFiles = options.noteFiles ?? 5;
  const notes: Impact["notes"] = [];
  if (noteFiles > 0) {
    const seen = new Set<number>();
    for (const file of [...seeds, ...top.slice(0, noteFiles).map((item) => item.path)]) {
      for (const note of notesForFile(db, repoId, file)) {
        if (seen.has(note.id)) continue;
        seen.add(note.id);
        notes.push({ ...note, path: file });
      }
    }
  }
  return { changed: seeds, items: top, notes };
}

/**
 * 작업 의도로 찾은 파일 — 의도와 맞는 과거 커밋이 건드린 파일(커밋 순위대로)과 파일 검색을 RRF로. 지금 레포에 있는 파일만.
 * search()가 아니라 FTS 질의 하나로 커밋·파일을 함께 받는다: 경로만 필요해 발췌(snippet)·재정렬·한 번 더 부르기를 뺐다.
 * 1천 파일 레포에서 질의당 489ms → 5ms (search 두 번 대비), 순위 정확도는 impactbench +intent로 같은지 확인했다.
 */
export function intentFiles(db: DB, repoId: number, intent: string, exclude: Set<string> = new Set()): { path: string; detail: string }[] {
  const match = buildMatchExpression(intent);
  if (!match) return [];
  const hits = db
    .prepare(
      `SELECT d.kind, d.ref, c.subject FROM docs_fts f JOIN docs d ON d.id = f.rowid
         LEFT JOIN commits c ON d.kind = 'commit' AND c.repo_id = d.repo_id AND c.sha = d.ref
        WHERE docs_fts MATCH ? AND f.rank MATCH 'bm25(4.0, 1.0, 1.5, 0)' AND d.repo_id = ? AND d.kind IN ('commit', 'file')
        ORDER BY f.rank LIMIT ?`,
    )
    .all(`{title body paths}: (${match})`, repoId, INTENT_COMMITS + INTENT_FILES) as { kind: string; ref: string; subject: string | null }[];
  const exists = db.prepare("SELECT 1 FROM code_files WHERE repo_id = ? AND path = ?");
  const filesOf = db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?");
  const keep = (file: string) => !exclude.has(file) && exists.get(repoId, file) !== undefined;
  const fromCommits: { path: string; detail: string }[] = [];
  const fromFiles: { path: string; detail: string }[] = [];
  for (const hit of hits) {
    if (hit.kind === "file") {
      if (fromFiles.length < INTENT_FILES && keep(hit.ref)) fromFiles.push({ path: hit.ref, detail: "matches the task text" });
      continue;
    }
    const subject = hit.subject ?? "";
    const title = subject.length > 50 ? `${subject.slice(0, 49)}…` : subject;
    for (const row of filesOf.all(repoId, hit.ref) as { path: string }[]) {
      if (keep(row.path) && !fromCommits.some((item) => item.path === row.path)) fromCommits.push({ path: row.path, detail: `changed in ${hit.ref.slice(0, 7)} "${title}"` });
    }
  }
  const score = new Map<string, { value: number; detail: string }>();
  for (const list of [fromCommits, fromFiles]) {
    list.forEach((item, index) => {
      const entry = score.get(item.path) ?? { value: 0, detail: item.detail };
      entry.value += 1 / (INTENT_RRF_K + index + 1);
      score.set(item.path, entry);
    });
  }
  return [...score.entries()].sort((a, b) => b[1].value - a[1].value).map(([file, entry]) => ({ path: file, detail: entry.detail }));
}

/** 구조·이력 순위(items)와 의도 순위를 RRF로 합친다. 의도로만 찾은 파일은 점수 0, 근거 "intent"로 들어온다 */
function withIntent(db: DB, repoId: number, items: ImpactItem[], intent: string, seeds: Set<string>): ImpactItem[] {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const fused = new Map<string, number>();
  items.forEach((item, index) => fused.set(item.path, 1 / (INTENT_RRF_K + index + 1)));
  intentFiles(db, repoId, intent, seeds).forEach((found, index) => {
    fused.set(found.path, (fused.get(found.path) ?? 0) + 1 / (INTENT_RRF_K + index + 1));
    const item = byPath.get(found.path) ?? { path: found.path, score: 0, test: TEST_PATH.test(found.path), reasons: [] };
    item.reasons.push({ source: "intent", from: intent, score: 0, detail: found.detail });
    byPath.set(found.path, item);
  });
  return [...byPath.values()].sort((a, b) => (fused.get(b.path) ?? 0) - (fused.get(a.path) ?? 0) || a.path.localeCompare(b.path));
}

/** 형제 폴더의 같은 이름 파일 — 깊이가 같고, 마지막 두 폴더 이름 중 하나만 다르다 */
export function siblingsOf(db: DB, repoId: number, file: string): string[] {
  const parts = file.split("/");
  if (parts.length < 2) return [];
  const name = parts[parts.length - 1];
  const rows = db.prepare("SELECT path FROM code_files WHERE repo_id = ? AND path LIKE ? LIMIT 500").all(repoId, `%/${name}`) as { path: string }[];
  return rows
    .map((row) => row.path)
    .filter((other) => {
      if (other === file) return false;
      const theirs = other.split("/");
      if (theirs.length !== parts.length || theirs[theirs.length - 1] !== name) return false;
      const differ = parts.slice(0, -1).flatMap((segment, index) => (segment === theirs[index] ? [] : [index]));
      return differ.length === 1 && differ[0] >= parts.length - 3;
    });
}

/** 작업 폴더의 커밋 안 된 변경 (스테이징·수정·새 파일) — 레포 최상위 기준 경로 */
export async function workingChanges(dir: string, signal?: AbortSignal): Promise<string[]> {
  const top = (await runGit(dir, ["rev-parse", "--show-toplevel"], undefined, signal)).trim();
  const changed = await runGit(top, ["-c", "core.quotepath=off", "diff", "--name-only", "HEAD"], undefined, signal);
  const added = await runGit(top, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "--full-name"], undefined, signal);
  return [...new Set(`${changed}\n${added}`.split("\n").map((line) => line.trim()).filter(Boolean))];
}

/** 사람이 읽는 줄 — 점수, 경로, 근거 두 개까지 */
export function impactLines(impact: Impact, limit = 10): string[] {
  return impact.items.slice(0, limit).map((item) => {
    const more = item.reasons.length > 2 ? ` (+${item.reasons.length - 2})` : "";
    return `${item.score.toFixed(2)} ${item.path} — ${item.reasons.slice(0, 2).map((reason) => reason.detail).join("; ")}${more}`;
  });
}

export function formatImpact(impact: Impact, limit = 10): string {
  if (impact.changed.length === 0) return "바뀐 파일이 없습니다";
  const lines = [`Grimoire impact: ${impact.changed.join(", ")}`];
  if (impact.items.length === 0) lines.push("이력과 import에서 더 알려 줄 것이 없습니다");
  else lines.push(...impactLines(impact, limit));
  if (impact.notes.length > 0) lines.push(`Notes: ${impact.notes.map((note) => `#${note.id}${note.rule ? " rule" : ""} ${note.path} "${note.title}"${note.stale ? " (stale)" : ""}`).join(" · ")}`);
  return lines.join("\n");
}

/**
 * 커밋 직전 "빠진 짝" — 이 커밋의 파일 하나와 거의 늘 같이 바뀌어 왔는데(공변경 신뢰도 ≥ 0.9, 같이 바뀐 커밋 ≥ 5)
 * 작업 폴더에서 손대지 않은 파일. 영향 범위 점수(noisy-OR)로 문턱을 두면 커밋의 파일이 여럿일 때 근거가 쌓여 부풀어,
 * 이력으로 다시 돌린 평가에서 빠진 것 없는 커밋의 51%에 오경보를 냈다(빠진 파일은 17%만 되찾음). 이 규칙은 오경보 5.5%,
 * 알린 것의 43%가 그 변경의 파일, 빠진 파일의 3.4%를 되찾는다 — 드물게 울리고, 울리면 볼 만하다 (docs/impact-research.md §2).
 * 넣을지는 작업 의도를 아는 에이전트가 정한다.
 */
export const MISSING_MIN_CONFIDENCE = 0.9;
export const MISSING_MIN_SUPPORT = 5;
export const MISSING_MAX = 3;
/** 이보다 큰 커밋은 후보가 흩어져 알리지 않는다 */
export const MISSING_MAX_COMMIT_FILES = 30;

export function missingCompanions(db: DB, repoId: number, committed: string[], touched: Set<string>): ImpactItem[] {
  if (committed.length === 0 || committed.length > MISSING_MAX_COMMIT_FILES) return [];
  const strong = (item: ImpactItem) =>
    item.reasons.some((reason) => reason.source === "cochange" && reason.score >= MISSING_MIN_CONFIDENCE && (reason.support ?? 0) >= MISSING_MIN_SUPPORT);
  return impactOf(db, repoId, committed, { sources: ["cochange"], limit: 50, noteFiles: 0 })
    .items.filter((item) => strong(item) && !touched.has(item.path))
    .slice(0, MISSING_MAX);
}

/**
 * 커밋 직전 영향 후보 전부(실험용, GRIMOIRE_COMMIT_IMPACT=all) — 엄격한 "늘 같이" 규칙 대신 영향 범위 상위 후보를 이유와 함께 준다.
 * Ripple식 2단계: 넓게 내고, 작업 의도를 아는 에이전트가 거른다(오프라인에서 F1 0.16 → 0.26). 손대지 않은 파일만, 점수 문턱 아래는 뺀다.
 */
export const COMMIT_IMPACT_MIN_SCORE = 0.3;
export const COMMIT_IMPACT_MAX = 5;

export function commitImpact(db: DB, repoId: number, committed: string[], touched: Set<string>, intent?: string): ImpactItem[] {
  if (committed.length === 0 || committed.length > MISSING_MAX_COMMIT_FILES) return [];
  return impactOf(db, repoId, committed, { limit: 50, noteFiles: 0, intent })
    .items.filter((item) => (item.score >= COMMIT_IMPACT_MIN_SCORE || item.reasons.some((reason) => reason.source === "intent")) && !touched.has(item.path))
    .slice(0, COMMIT_IMPACT_MAX);
}

export const MISSING_HEAD = "Grimoire: files that usually change with this commit but are untouched — check if the task needs them:";
export const IMPACT_HEAD = "Grimoire impact of this commit — untouched files that may be affected (candidates, not instructions; change only what the task needs):";

export function formatMissing(items: ImpactItem[], budget: number, head = MISSING_HEAD): string {
  if (items.length === 0) return "";
  const lines = [head];
  for (const item of items) {
    const line = `- ${item.path} (${item.reasons.slice(0, 2).map((reason) => reason.detail).join("; ")})`;
    if ([...lines, line].join("\n").length > budget) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
