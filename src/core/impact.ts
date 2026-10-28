/**
 * 영향 범위 — "이 파일들을 바꾸면 같이 봐야 할 곳"을 정적 구조와 이력을 합쳐 순위 매긴다.
 *
 *   import    import 그래프 이웃 (1홉 양방향, 2홉은 약하게) — 정적 구조. 상대 경로와 경로 별칭(@/x 등)
 *   ref       정의-참조 그래프 — 한쪽이 정의한 심볼 이름을 다른 쪽이 언급한다(Aider repo map). import 문이 없는 언어(C# 등)용
 *   cochange  같이 바뀌어 온 파일 (신뢰도) — 이력에만 있는 결합. 정적 그래프 도구(code-review-graph 등)에는 없다
 *   test      이름 규칙 짝 테스트
 *   dir       같은 디렉터리 — 혼자서는 기준선(가장 약함)이지만, 다른 근거가 없는 파일에도 후보를 내 합치면 recall이 오른다
 *   sibling   형제 폴더의 같은 이름 파일 (login/layout.tsx ↔ register/layout.tsx) — 라우트별로 같은 꼴을 맞추는 변경
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

export type ImpactSource = "import" | "import2" | "ref" | "cochange" | "test" | "dir" | "sibling";

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
};
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
  const top = items.slice(0, options.limit ?? 20);

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
  if (impact.notes.length > 0) lines.push(`Notes: ${impact.notes.map((note) => `#${note.id} ${note.path} "${note.title}"${note.stale ? " (stale)" : ""}`).join(" · ")}`);
  return lines.join("\n");
}

/**
 * 커밋 직전 "빠진 짝" — 이 커밋의 파일들과 보통 같이 바뀌는데 작업 폴더에서 손대지 않은 파일.
 * 문턱은 이력 분할 평가에서 고른 값이다: 점수 0.8 이상만 알리면 알린 것의 57%가 실제로 같은 변경에 들어갔고(0.5면 30%),
 * 알림은 질의의 20%에서만 난다. 고르는 일은 작업 의도를 아는 에이전트에게 맡긴다 — 의도와 함께 거르면 F1이 0.16 → 0.26
 * (Ripple식 2단계, 노트 #31).
 */
export const MISSING_MIN_SCORE = 0.8;
export const MISSING_MAX = 3;
/** 이보다 큰 커밋은 후보가 흩어져 알리지 않는다 */
export const MISSING_MAX_COMMIT_FILES = 30;

export function missingCompanions(db: DB, repoId: number, committed: string[], touched: Set<string>): ImpactItem[] {
  if (committed.length === 0 || committed.length > MISSING_MAX_COMMIT_FILES) return [];
  return impactOf(db, repoId, committed, { limit: 50, noteFiles: 0 })
    .items.filter((item) => item.score >= MISSING_MIN_SCORE && !touched.has(item.path))
    .slice(0, MISSING_MAX);
}

export function formatMissing(items: ImpactItem[], budget: number): string {
  if (items.length === 0) return "";
  const head = "Grimoire: files that usually change with this commit but are untouched — check if the task needs them:";
  const lines = [head];
  for (const item of items) {
    const line = `- ${item.path} (${item.reasons.slice(0, 2).map((reason) => reason.detail).join("; ")})`;
    if ([...lines, line].join("\n").length > budget) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
