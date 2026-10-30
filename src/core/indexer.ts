/**
 * 레포 등록과 증분 동기화.
 *
 * 동기화는 "git이 아는 sha 중 DB에 없는 것"만 읽어 넣는다. 그래서
 * - 몇 번을 돌려도 결과가 같고(멱등),
 * - rebase로 히스토리가 바뀌어도 새 sha만 더해진다(옛 sha는 근거로 남는다).
 * 커밋은 READ_BATCH개씩 따로 트랜잭션으로 넣는다 — 큰 레포의 첫 동기화가 쓰기 잠금을 오래 쥐어
 * 다른 grimoire 프로세스(다른 창·CLI)의 쓰기를 `database is locked`로 실패시키지 않게. 중간에 실패해도
 * 들어간 커밋은 멱등이라 다음 동기화가 이어 간다. 기준점(tips·head_tree)과 기술 스택·현재 코드는
 * 마지막 트랜잭션에서 함께 바꾼다 — 기준점이 앞서 나가 빠지는 커밋이 생기지 않게.
 */
import fs from "node:fs";
import path from "node:path";

import { refreshWhy, storeTrailers } from "./capture";
import { BLOB_BATCH_BYTES, extractRefNames, extractSymbols, headerComment, indexableFiles, listHeadTree, readBlobs, splitIdentifier, type CodeSymbol, type HeadFile } from "./code";
import { blameLines, historyOrder, isRuleFile, parseRules, RULE_FILES_MAX, unitHistory, type RuleUnit } from "./rules";
import { addCochange, changeKey, cochangeInput, extractImportSpecs, needsCochangeBackfill, rebuildCochange, resolveImportSpecs } from "./context";
import { deleteDoc, upsertDoc, pruneOrphanFts, type DB } from "./db";
import {
  headTree,
  listFiles,
  listNewShas,
  listShas,
  readCommits,
  readFileAtHead,
  refTips,
  mainRepoRoot,
  remoteUrl,
  throwIfCancelled,
  worktreeRoots,
  type GitCommit,
} from "./git";
import { isMeaningfulSubject } from "./meaningful";
import { canonicalTech, techCategory } from "./tech/canonical";
import { parseManifest } from "./tech/manifests";
import { agentSignal } from "./trailers";

/** 한 번에 git에서 읽어 올 커밋 수 */
const READ_BATCH = 500;
/**
 * 현재 코드 색인 규칙의 판 — 올리면 다음 동기화가 모든 파일을 한 번 다시 읽는다.
 * 1: 정의-참조 그래프(file_defs·file_refs)와 경로 별칭 import (0.10.0)
 */
export const CODE_VERSION = 1;
/** 규칙 색인 규칙의 판 — 이보다 낮은 레포는 트리가 그대로여도 규칙 파일을 한 번 다시 읽는다 (rules.ts, 마이그레이션 13) */
export const RULES_VERSION = 1;
/** 규칙 파일 blame을 한꺼번에 몇 개까지 띄우나 */
const BLAME_CONCURRENCY = 4;
/** 검색 문서에 넣는 변경 파일 경로 수 상한 (대량 이동 커밋이 색인을 부풀리지 않게) */
const DOC_PATHS_MAX = 200;
/** 기술 스택을 읽을 매니페스트 파일 수 상한 (모노레포 대비) */
const MANIFESTS_MAX = 40;
const MANIFEST_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
]);
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.venv|dist|build)\//;

export interface RepoRow {
  id: number;
  path: string;
  name: string;
  remote_url: string | null;
  added_at: string;
  synced_at: string | null;
  /** 지난 동기화의 ref 끝 커밋들 (JSON 배열) */
  tips?: string | null;
  /** 지난 동기화의 HEAD 트리 sha */
  head_tree?: string | null;
}

export interface SyncResult {
  repo: string;
  added: number;
  total: number;
  tech: number;
  /** 다시 읽은 코드 파일 수 (바뀐 것만) */
  files: number;
}

export async function addRepo(db: DB, dir: string, signal?: AbortSignal): Promise<RepoRow> {
  // 추가 작업 트리(git worktree)면 본 레포로 등록한다 — 커밋 저장소가 같아 따로 두면 같은 기억이 세션 수만큼 쌓인다
  const root = await mainRepoRoot(path.resolve(dir), signal);
  if (!root) throw new Error(`git 레포가 아닙니다: ${dir}`);

  const existing = db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as
    | RepoRow
    | undefined;
  if (existing) return existing;

  const remote = await remoteUrl(root, signal);
  throwIfCancelled(signal);
  // 다른 프로세스가 그 사이 같은 레포를 넣었을 수 있다 — 있으면 그대로 쓴다
  db.prepare(
    "INSERT OR IGNORE INTO repos (path, name, remote_url, added_at) VALUES (?, ?, ?, ?)",
  ).run(root, path.basename(root), remote, new Date().toISOString());
  return db.prepare("SELECT * FROM repos WHERE path = ?").get(root) as RepoRow;
}

export function removeRepo(db: DB, repo: RepoRow): void {
  db.transaction(() => {
    db.prepare("DELETE FROM repos WHERE id = ?").run(repo.id);
    pruneOrphanFts(db);
  })();
}

export function listRepos(db: DB): RepoRow[] {
  return db.prepare("SELECT * FROM repos ORDER BY name").all() as RepoRow[];
}

/**
 * 이름·경로·원격 URL 일부와 맞는 레포들. 정확한 이름·경로 일치가 있으면 그것 하나만.
 * 여럿이면 호출부가 후보를 보여 주고 고르게 한다 (findRepo는 모호하면 null).
 */
export function matchRepos(db: DB, query: string): RepoRow[] {
  const repos = listRepos(db);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = repos.find(
    (repo) => repo.name.toLowerCase() === q || repo.path.toLowerCase() === q,
  );
  if (exact) return [exact];
  return repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(q) ||
      repo.path.toLowerCase().includes(q) ||
      (repo.remote_url ?? "").toLowerCase().includes(q),
  );
}

/** 절대경로가 속한 등록 레포 (가장 긴 경로가 이기게). 상대경로나 레포 밖이면 undefined. */
export function repoOfPath(db: DB, target: string): RepoRow | undefined {
  if (!path.isAbsolute(target)) return undefined;
  const resolved = path.resolve(target);
  return listRepos(db)
    .filter((repo) => resolved === repo.path || resolved.startsWith(repo.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** 레포 폴더 안에 사는 git worktree — Claude Code가 세션마다 만드는 자리. 그 안의 파일은 레포 기준 경로로 색인돼 있다 */
const NESTED_WORKTREE = /^\.claude\/worktrees\/[^/]+\//;

/** 레포 안 경로를 색인과 같은 꼴(레포 기준, POSIX 구분자)로 */
export function relativeToRepo(repoPath: string, target: string): string {
  const relative = path.isAbsolute(target) ? path.relative(repoPath, path.resolve(target)) : target;
  return relative.split(path.sep).join("/").replace(/^\.\//, "").replace(NESTED_WORKTREE, "");
}

/** 있는 가장 가까운 폴더 (새로 만들 파일·폴더면 위로 올라간다) */
function existingDir(target: string): string | null {
  let dir = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // 아직 없음
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface RepoFile {
  repo: RepoRow;
  /** 색인과 같은 꼴의 레포 기준 경로 (폴더면 "" 또는 그 폴더 경로) */
  relative: string;
}

/** `.git` 파일의 "gitdir: <본 레포>/.git/worktrees/<이름>" — 추가 작업 트리의 표식 */
const WORKTREE_GITDIR = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?\s*$/m;

/**
 * 폴더가 속한 추가 작업 트리(git worktree)의 최상위와 본 레포 — git을 띄우지 않고 `.git` 파일만 읽는다.
 * 위로 올라가다 처음 만난 `.git`이 폴더면 평범한 레포(추가 작업 트리 아님), 파일이면 그 gitdir를 본다.
 * 서브모듈(gitdir이 .git/modules/x)이나 레포 밖이면 null. 훅은 편집마다 도니 프로세스 하나(Windows 20~40ms)도 아낀다.
 */
function linkedWorktree(dir: string): { top: string; main: string } | null {
  let current = dir;
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      // 없음 — 위로
    }
    if (stat?.isDirectory()) return null;
    if (stat?.isFile()) {
      let text: string;
      try {
        text = fs.readFileSync(dotGit, "utf8");
      } catch {
        return null;
      }
      const match = WORKTREE_GITDIR.exec(text);
      return match ? { top: current, main: path.resolve(current, match[1]) } : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 절대경로 → 등록 레포와 레포 기준 경로. git을 부르지 않는다 — 등록 레포 폴더 안(`.claude/worktrees/x/` 포함)이면
 * 경로만으로, 레포 밖에 만든 추가 작업 트리(git worktree)의 파일이면 그 `.git` 파일로 본 레포를 찾아 작업 트리 기준
 * 경로로 푼다 — 훅·file_context가 워크트리에서 일하는 세션에도 같은 기억을 쓰게. 해당 없으면 null.
 */
export async function resolveRepoFile(db: DB, target: string, _signal?: AbortSignal): Promise<RepoFile | null> {
  if (!path.isAbsolute(target)) return null;
  const direct = repoOfPath(db, target);
  if (direct) return { repo: direct, relative: relativeToRepo(direct.path, target) };
  const dir = existingDir(target);
  if (!dir) return null;
  // 심볼릭 링크·정션 너머(예: ~/code → /Volumes/work)로 연 파일 — 등록 경로는 git이 준 실제 경로라 그대로는 안 맞는다.
  // 있는 가장 가까운 폴더만 실제 경로로 바꿔 다시 본다 (시스템 호출 하나)
  const real = realDir(dir);
  if (real !== dir) {
    const realTarget = path.join(real, path.relative(dir, path.resolve(target)));
    const viaLink = repoOfPath(db, realTarget);
    if (viaLink) return { repo: viaLink, relative: relativeToRepo(viaLink.path, realTarget) };
  }
  const roots = linkedWorktree(real);
  if (!roots) return null;
  // gitdir이 상대경로면(git 2.48+) 링크 너머의 경로로 풀릴 수 있다 — 본 레포 경로도 실제 경로로
  const main = realDir(roots.main);
  const repo = repoOfPath(db, main);
  if (!repo || repo.path !== main) return null;
  return { repo, relative: path.relative(roots.top, path.join(real, path.relative(dir, path.resolve(target)))).split(path.sep).join("/") };
}

/** 폴더의 실제 경로(링크·정션·macOS /var → /private/var를 푼다). 못 풀면 그대로 */
function realDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * 등록된 레포 중 다른 레포의 추가 작업 트리인 것 — 예전 버전이 워크트리를 따로 등록했던 흔적 (doctor가 알린다).
 * 본 레포도 등록돼 있으면 같은 커밋이 두 번 색인돼 검색에 겹쳐 나온다.
 */
export async function worktreeRegistrations(db: DB): Promise<{ repo: RepoRow; main: string; mainRegistered: boolean }[]> {
  const repos = listRepos(db);
  const registered = new Set(repos.map((repo) => repo.path));
  const out: { repo: RepoRow; main: string; mainRegistered: boolean }[] = [];
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) continue;
    const roots = await worktreeRoots(repo.path);
    if (!roots || roots.main === roots.top || path.resolve(roots.top) !== path.resolve(repo.path)) continue;
    out.push({ repo, main: roots.main, mainRegistered: registered.has(roots.main) });
  }
  return out;
}

/** 이름·경로·원격 URL 일부로 레포 하나를 찾는다. 정확한 일치가 우선이고, 부분 일치가 여럿이면(모호) null. */
export function findRepo(db: DB, query: string): RepoRow | null {
  const matches = matchRepos(db, query);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 하위 디렉터리에서 git 레포를 찾는다 (레포 안으로는 더 내려가지 않는다).
 * limit을 주면 그보다 하나 더 찾은 데서 멈춘다 — 호출부가 "너무 많다"를 알 수 있을 만큼만 걷는다.
 */
export function discoverRepos(root: string, maxDepth = 4, limit = Infinity): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length > limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}

/**
 * 같은 레포의 동기화는 한 번에 하나만 — 기동 시 자동 동기화·작업 레포 등록·add_repo가 겹치면
 * 둘 다 같은 "새 sha"를 읽어 commit_files에 중복 행을 넣는다. 레포 경로별로 줄을 세운다.
 */
const syncing = new Map<string, Promise<SyncResult>>();

export function syncRepo(db: DB, repo: RepoRow, signal?: AbortSignal): Promise<SyncResult> {
  const previous = syncing.get(repo.path) ?? Promise.resolve(null);
  const next = previous.then(
    () => syncRepoNow(db, repo, signal),
    () => syncRepoNow(db, repo, signal),
  );
  syncing.set(repo.path, next);
  const clear = () => {
    if (syncing.get(repo.path) === next) syncing.delete(repo.path);
  };
  next.then(clear, clear);
  return next;
}

async function syncRepoNow(db: DB, repo: RepoRow, signal?: AbortSignal): Promise<SyncResult> {
  if (!fs.existsSync(repo.path)) {
    throw new Error(`레포 경로가 사라졌습니다: ${repo.path} (grimoire remove로 정리하세요)`);
  }

  // 넘겨받은 repo 행은 오래됐을 수 있다 — 기준점은 DB에서 다시 읽는다
  const saved = db.prepare("SELECT tips, head_tree, code_version, rules_version FROM repos WHERE id = ?").get(repo.id) as
    | { tips: string | null; head_tree: string | null; code_version: number; rules_version: number }
    | undefined;
  // 서로 기다릴 필요 없는 git 호출은 함께 띄운다 — 프로세스 띄우기가 호출마다 20ms 안팎이라(Windows),
  // 바뀐 것 없는 재동기화는 거의 이 셋이 전부다 (npm run perf: 재동기화 시간)
  const [tips, tree, remote] = await Promise.all([refTips(repo.path, signal), headTree(repo.path, signal), remoteUrl(repo.path, signal)]);
  const fresh = await newShas(db, repo, saved?.tips ?? null, tips, signal);

  // 커밋은 읽은 묶음마다 따로 쓴다 — 쓰기 잠금을 짧게 쥐고, 전 커밋을 메모리에 모아 두지 않는다.
  // 트랜잭션은 동기라 아래 기술 스택·코드 읽기와 겹쳐 돌아도 서로 섞이지 않는다
  const writeFresh = async (backfill: boolean) => {
    let added = 0;
    for (let start = 0; start < fresh.length; start += READ_BATCH) {
      const batch = await readCommits(repo.path, fresh.slice(start, start + READ_BATCH), signal);
      throwIfCancelled(signal);
      db.transaction(() => {
        for (const commit of batch) {
          // 실제로 들어간 커밋만 센다 — 동시에 돈 다른 sync가 먼저 넣은 커밋은 "새 커밋"이 아니다
          if (!insertCommit(db, repo, commit)) continue;
          added++;
          // 공변경은 새로 들어간 커밋만 더한다 — 옛 DB는 끝에 전체를 다시 만들므로 여기서는 건너뛴다
          if (!backfill) addCochange(db, repo.id, cochangeInput(commit, isMeaningfulSubject(commit.subject)));
        }
      })();
    }
    return added;
  };
  // HEAD 트리가 그대로면 현재 코드·기술 스택도 그대로다. 커밋·기술 스택·코드 읽기는 서로 독립이라 함께 돌린다
  // 코드 색인 규칙이 바뀐 레포(code_version < CODE_VERSION)는 트리가 그대로여도 한 번 다시 읽는다
  const treeChanged = tree === null || tree !== saved?.head_tree || (saved?.code_version ?? 0) < CODE_VERSION;
  // 옛 DB(마이그레이션 직후)면 있는 커밋으로 공변경 표를 끝에 다시 만들고, 아니면 새 커밋을 하나씩 더한다 (context.ts)
  const backfill = needsCochangeBackfill(db, repo.id);
  // 규칙 파일(rules.ts)은 트리가 바뀌었거나 규칙 색인이 처음(옛 DB)일 때만 본다 — HEAD 트리 목록은 코드와 한 번만 받는다
  const rulesStale = treeChanged || (saved?.rules_version ?? 0) < RULES_VERSION;
  const listing = treeChanged || rulesStale ? listHeadTree(repo.path, signal) : Promise.resolve([]);
  const [added, tech, code, rules] = await Promise.all([
    writeFresh(backfill),
    treeChanged ? readTechStack(repo.path, signal) : null,
    treeChanged ? readChangedCode(db, repo, listing, signal) : { changed: [], removed: [], present: new Set<string>() },
    rulesStale ? readChangedRules(db, repo, listing, signal) : null,
  ]);
  // git 실패를 기본값으로 삼키는 함수들이 있어, 취소됐으면 그 기본값을 쓰기 전에 멈춘다
  throwIfCancelled(signal);

  db.transaction(() => {
    if (backfill) rebuildCochange(db, repo.id);
    backfillChangeKeys(db, repo);
    backfillTrailers(db, repo);

    if (tech) {
      db.prepare("DELETE FROM repo_tech WHERE repo_id = ?").run(repo.id);
      const insertTech = db.prepare(
        "INSERT OR IGNORE INTO repo_tech (repo_id, tech, category, manifest_path, dev) VALUES (?, ?, ?, ?, ?)",
      );
      for (const item of tech) {
        insertTech.run(repo.id, item.tech, item.category, item.manifestPath, item.dev ? 1 : 0);
      }
    }

    applyCode(db, repo, code);
    if (treeChanged) db.prepare("UPDATE repos SET code_version = ? WHERE id = ?").run(CODE_VERSION, repo.id);
    if (rules) {
      applyRules(db, repo, rules);
      db.prepare("UPDATE repos SET rules_version = ? WHERE id = ?").run(RULES_VERSION, repo.id);
    }

    db.prepare("UPDATE repos SET synced_at = ?, remote_url = ?, tips = ?, head_tree = ? WHERE id = ?").run(
      new Date().toISOString(),
      remote,
      JSON.stringify(tips),
      tree,
      repo.id,
    );
  })();

  const count = (sql: string) => (db.prepare(sql).get(repo.id) as { n: number }).n;
  return {
    repo: repo.name,
    added,
    total: count("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?"),
    tech: count("SELECT COUNT(DISTINCT tech) AS n FROM repo_tech WHERE repo_id = ?"),
    files: code.changed.length,
  };
}

/**
 * DB에 없는 새 sha. ref 끝 커밋이 지난번과 같으면 git을 더 부르지 않고, 달라졌으면 그 뒤 커밋만 받는다.
 * 기준점이 없거나(첫 동기화·옛 DB) 지난 끝 커밋이 사라졌으면 전체 목록과 DB를 비교한다.
 */
async function newShas(
  db: DB,
  repo: RepoRow,
  savedTips: string | null,
  tips: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const previous = parseTips(savedTips);
  if (previous && previous.length === tips.length && previous.every((sha, index) => sha === tips[index])) return [];
  let candidates: string[] | null = null;
  if (previous && previous.length > 0) {
    try {
      candidates = await listNewShas(repo.path, previous, signal);
    } catch {
      throwIfCancelled(signal);
      candidates = null; // 지난 끝 커밋이 사라짐 → 전체 비교
    }
  }
  if (candidates === null) {
    const all = await listShas(repo.path, signal);
    // 목록을 받은 뒤에 읽는다 — 그 사이 다른 묶음이 들어갔어도 중복으로 읽지 않게
    const known = new Set(
      (db.prepare("SELECT sha FROM commits WHERE repo_id = ?").all(repo.id) as { sha: string }[]).map((row) => row.sha),
    );
    return all.filter((sha) => !known.has(sha));
  }
  // rebase로 같은 커밋이 다른 ref에서 다시 닿는 경우 등 — 이미 있는 것은 뺀다
  const exists = db.prepare("SELECT 1 FROM commits WHERE repo_id = ? AND sha = ?");
  return candidates.filter((sha) => !exists.get(repo.id, sha));
}

function parseTips(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** 바뀐 파일에서 미리 뽑아 둔 것 — 내용 자체는 들고 있지 않는다 */
interface ChangedFile {
  path: string;
  blob: string;
  lines: number;
  symbols: CodeSymbol[];
  header: string;
  /** import 지정자(원문) — 경로는 트랜잭션 안에서 HEAD 파일 집합으로 푼다 (context.ts) */
  imports: string[];
  /** 언급한 식별자 — 정의-참조 그래프 (code.ts extractRefNames) */
  refs: string[];
}

interface CodeChanges {
  changed: ChangedFile[];
  removed: string[];
  /** HEAD의 색인 대상 경로 전부 — import 대상을 푸는 데 쓴다 */
  present: Set<string>;
}

/** blob 크기 합계가 BLOB_BATCH_BYTES를 넘지 않게 나눈다 (cat-file 출력이 버퍼 하나에 올라오므로) */
export function blobBatches(files: HeadFile[], maxBytes = BLOB_BATCH_BYTES): HeadFile[][] {
  const batches: HeadFile[][] = [];
  let current: HeadFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && bytes + file.size > maxBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * HEAD의 파일 중 blob이 바뀐 것만 읽는다 (트랜잭션 밖 — git 호출이 느릴 수 있어서).
 * 묶음별로 읽어 심볼·머리 주석을 바로 뽑고 내용은 버린다 — 트랜잭션 안에서는 INSERT만 한다.
 */
async function readChangedCode(db: DB, repo: RepoRow, listing: Promise<HeadFile[]>, signal?: AbortSignal): Promise<CodeChanges> {
  const head = indexableFiles(await listing);
  const known = new Map(
    (db.prepare("SELECT path, blob FROM code_files WHERE repo_id = ?").all(repo.id) as { path: string; blob: string }[]).map(
      (row) => [row.path, row.blob],
    ),
  );
  // 코드 색인 규칙이 바뀌었으면(CODE_VERSION) 한 번은 전부 다시 읽는다 — blob은 그대로라 노트의 stale 판정은 흔들리지 않는다
  const version = (db.prepare("SELECT code_version FROM repos WHERE id = ?").get(repo.id) as { code_version: number } | undefined)?.code_version ?? 0;
  const stale = version < CODE_VERSION ? head : head.filter((file) => known.get(file.path) !== file.blob);
  // 같은 내용(blob)의 파일은 한 번만 읽는다
  const unique = [...new Map(stale.map((file) => [file.blob, file])).values()];
  const extracted = new Map<string, Omit<ChangedFile, "path" | "blob">>();
  for (const batch of blobBatches(unique)) {
    const contents = await readBlobs(repo.path, batch.map((file) => file.blob), signal);
    for (const file of batch) {
      const content = contents.get(file.blob) ?? "";
      extracted.set(file.blob, {
        lines: content.split("\n").length,
        symbols: extractSymbols(content),
        header: headerComment(content),
        imports: extractImportSpecs(file.path, content),
        refs: extractRefNames(content),
      });
    }
  }
  const present = new Set(head.map((file) => file.path));
  const empty = { lines: 1, symbols: [], header: "", imports: [], refs: [] };
  return {
    changed: stale.map((file) => ({ path: file.path, blob: file.blob, ...(extracted.get(file.blob) ?? empty) })),
    removed: [...known.keys()].filter((file) => !present.has(file)),
    present,
  };
}

function applyCode(db: DB, repo: RepoRow, code: CodeChanges): void {
  const upsert = db.prepare(
    `INSERT INTO code_files (repo_id, path, blob, lines, symbols, header) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, path) DO UPDATE SET blob = excluded.blob, lines = excluded.lines,
       symbols = excluded.symbols, header = excluded.header`,
  );
  const clearImports = db.prepare("DELETE FROM file_imports WHERE repo_id = ? AND path = ?");
  const insertImport = db.prepare("INSERT OR IGNORE INTO file_imports (repo_id, path, target) VALUES (?, ?, ?)");
  const clearDefs = db.prepare("DELETE FROM file_defs WHERE repo_id = ? AND path = ?");
  const insertDef = db.prepare("INSERT OR IGNORE INTO file_defs (repo_id, name, path) VALUES (?, ?, ?)");
  const clearRefs = db.prepare("DELETE FROM file_refs WHERE repo_id = ? AND path = ?");
  const insertRef = db.prepare("INSERT OR IGNORE INTO file_refs (repo_id, path, name) VALUES (?, ?, ?)");
  const now = new Date().toISOString();
  for (const file of code.changed) {
    const { symbols, header } = file;
    upsert.run(repo.id, file.path, file.blob, file.lines, JSON.stringify(symbols), header);
    // 레포 안 import만 — "누가 나를 쓰나"(usedBy)와 공변경의 import 이웃 신호 (context.ts)
    clearImports.run(repo.id, file.path);
    for (const target of resolveImportSpecs(file.path, file.imports, code.present)) insertImport.run(repo.id, file.path, target);
    // 정의-참조 그래프 — 라우트("GET /x")는 이름이 아니라 빼고, 자기가 정의한 이름은 참조에서 뺀다
    clearDefs.run(repo.id, file.path);
    clearRefs.run(repo.id, file.path);
    const defined = new Set(symbols.map((symbol) => symbol.name).filter((name) => !name.includes(" ")));
    for (const name of defined) insertDef.run(repo.id, name, file.path);
    for (const name of file.refs) if (!defined.has(name)) insertRef.run(repo.id, file.path, name);
    upsertDoc(db, {
      kind: "file",
      ref: file.path,
      repoId: repo.id,
      at: now,
      title: file.path,
      // 심볼 원형 + 낱말로 쪼갠 형태를 함께 넣어 "rate limit"·"ratelimit" 둘 다 걸리게 한다
      body: [repo.name, header, symbols.map((symbol) => `${symbol.name} ${splitIdentifier(symbol.name)}`).join(" ")]
        .filter(Boolean)
        .join("\n"),
      paths: `${file.path} ${splitIdentifier(file.path)}`,
    });
  }
  const remove = db.prepare("DELETE FROM code_files WHERE repo_id = ? AND path = ?");
  for (const file of code.removed) {
    remove.run(repo.id, file);
    clearImports.run(repo.id, file);
    clearDefs.run(repo.id, file);
    clearRefs.run(repo.id, file);
    deleteDoc(db, "file", file, repo.id);
  }
}

interface RuleFileChange {
  path: string;
  blob: string;
  scope: string;
  /** blame이 됐나 — 실패면 다음 동기화가 다시 읽는다 */
  complete: boolean;
  units: (RuleUnit & { origin: string | null; last: string | null })[];
}

interface RuleChanges {
  changed: RuleFileChange[];
  removed: string[];
}

/**
 * 규칙 파일 중 blob이 바뀐 것만 읽어 규칙 단위로 나누고, 단위마다 출처·최근 변경 커밋을 blame으로 구한다 (트랜잭션 밖).
 * 규칙 색인이 처음이면(rules_version) 전부 읽는다. 규칙 파일이 안 바뀐 동기화는 blame을 부르지 않는다.
 */
async function readChangedRules(db: DB, repo: RepoRow, listing: Promise<HeadFile[]>, signal?: AbortSignal): Promise<RuleChanges> {
  // 심볼릭 링크(AGENTS.md -> CLAUDE.md)는 뺀다 — blob 내용이 링크 대상 경로라 그것이 "규칙"으로 들어갔다. 대상 파일이 따로 색인된다
  const files = (await listing).filter((file) => !file.link && isRuleFile(file.path, file.size)).slice(0, RULE_FILES_MAX);
  const known = new Map(
    (db.prepare("SELECT path, blob, complete FROM rule_files WHERE repo_id = ?").all(repo.id) as { path: string; blob: string; complete: number }[]).map((row) => [
      row.path,
      row.complete ? row.blob : null,
    ]),
  );
  const version = (db.prepare("SELECT rules_version FROM repos WHERE id = ?").get(repo.id) as { rules_version: number } | undefined)?.rules_version ?? 0;
  const stale = version < RULES_VERSION ? files : files.filter((file) => known.get(file.path) !== file.blob);
  const contents = await readBlobs(repo.path, [...new Set(stale.map((file) => file.blob))], signal);
  const changed: RuleFileChange[] = [];
  for (let start = 0; start < stale.length; start += BLAME_CONCURRENCY) {
    const batch = stale.slice(start, start + BLAME_CONCURRENCY);
    changed.push(
      ...(await Promise.all(
        batch.map(async (file) => {
          const parsed = parseRules(contents.get(file.blob) ?? "");
          if (parsed.units.length === 0) return { path: file.path, blob: file.blob, scope: parsed.scope, complete: true, units: [] };
          const [blame, order] = await Promise.all([blameLines(repo.path, file.path, signal), historyOrder(repo.path, file.path, signal)]);
          const units = parsed.units.map((unit) => {
            const history = blame ? unitHistory(unit, blame, order) : null;
            return { ...unit, origin: history?.origin ?? null, last: history?.last ?? null };
          });
          return { path: file.path, blob: file.blob, scope: parsed.scope, complete: blame !== null, units };
        }),
      )),
    );
  }
  throwIfCancelled(signal);
  const present = new Set(files.map((file) => file.path));
  return { changed, removed: [...known.keys()].filter((file) => !present.has(file)) };
}

/** 규칙 색인을 갈아 끼운다 — 파일 단위로 지우고 다시 넣는다. 검색 문서 kind='rule', ref='경로:줄' */
function applyRules(db: DB, repo: RepoRow, changes: RuleChanges): void {
  const linesOf = db.prepare("SELECT line FROM rules WHERE repo_id = ? AND path = ?");
  const clear = db.prepare("DELETE FROM rules WHERE repo_id = ? AND path = ?");
  const insert = db.prepare(
    "INSERT INTO rules (repo_id, path, line, end_line, heading, text, origin_sha, last_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const upsertFile = db.prepare(
    `INSERT INTO rule_files (repo_id, path, blob, scope, complete) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, path) DO UPDATE SET blob = excluded.blob, scope = excluded.scope, complete = excluded.complete`,
  );
  const commit = db.prepare("SELECT subject, authored_at FROM commits WHERE repo_id = ? AND sha = ?");
  const drop = (file: string) => {
    for (const row of linesOf.all(repo.id, file) as { line: number }[]) deleteDoc(db, "rule", `${file}:${row.line}`, repo.id);
    clear.run(repo.id, file);
  };
  const now = new Date().toISOString();
  for (const file of changes.changed) {
    drop(file.path);
    upsertFile.run(repo.id, file.path, file.blob, file.scope, file.complete ? 1 : 0);
    for (const unit of file.units) {
      insert.run(repo.id, file.path, unit.line, unit.endLine, unit.heading, unit.text, unit.origin, unit.last);
      const origin = unit.origin ? (commit.get(repo.id, unit.origin) as { subject: string; authored_at: string } | undefined) : undefined;
      const [first, ...rest] = unit.text.split("\n");
      upsertDoc(db, {
        kind: "rule",
        ref: `${file.path}:${unit.line}`,
        repoId: repo.id,
        at: origin?.authored_at ?? now,
        title: first.slice(0, 120),
        // 제목·범위·들여온 커밋의 제목도 넣는다 — "왜 이 규칙"을 커밋에 쓴 말로 물어도 걸리게
        body: [first.length > 120 ? first : "", ...rest, unit.heading, file.scope, origin?.subject ?? ""].filter(Boolean).join("\n"),
        paths: `${file.path} ${splitIdentifier(file.path)}`,
      });
    }
  }
  for (const file of changes.removed) {
    drop(file);
    db.prepare("DELETE FROM rule_files WHERE repo_id = ? AND path = ?").run(repo.id, file);
  }
}

/** 옛 DB(마이그레이션 7 직후)의 커밋에 같은 변경 키를 채운다 — 한 번 채우면 새 커밋은 insertCommit이 넣는다 */
function backfillChangeKeys(db: DB, repo: RepoRow): void {
  const rows = db.prepare("SELECT sha, subject FROM commits WHERE repo_id = ? AND change_key IS NULL").all(repo.id) as { sha: string; subject: string }[];
  if (rows.length === 0) return;
  const filesOf = db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?");
  const set = db.prepare("UPDATE commits SET change_key = ? WHERE repo_id = ? AND sha = ?");
  for (const row of rows) {
    set.run(changeKey(row.subject, (filesOf.all(repo.id, row.sha) as { path: string }[]).map((item) => item.path)), repo.id, row.sha);
  }
}

/**
 * 옛 DB(마이그레이션 직후)의 커밋 본문에서 트레일러를 한 번 읽어 둔다 — 훅 없이도 "왜"가 생기는 재료 (capture.ts).
 * 레포당 한 번(repos.trailers_done). 새 커밋은 insertCommit이 그때그때 읽는다.
 */
function backfillTrailers(db: DB, repo: RepoRow): void {
  const done = (db.prepare("SELECT trailers_done FROM repos WHERE id = ?").get(repo.id) as { trailers_done: number } | undefined)?.trailers_done;
  if (done) return;
  const rows = db.prepare("SELECT sha, body FROM commits WHERE repo_id = ? AND body LIKE '%:%'").all(repo.id) as { sha: string; body: string }[];
  const mark = db.prepare("UPDATE commits SET agent_signal = ? WHERE repo_id = ? AND sha = ?");
  for (const row of rows) {
    const trailers = storeTrailers(db, repo.id, row.sha, row.body);
    if (trailers.length === 0) continue;
    const signal = agentSignal(trailers);
    if (signal) mark.run(signal, repo.id, row.sha);
    refreshWhy(db, repo.id, row.sha);
  }
  db.prepare("UPDATE repos SET trailers_done = 1 WHERE id = ?").run(repo.id);
}

/**
 * sha 하나를 git에서 읽어 넣는다 — 훅이 `git commit`을 감지했을 때, 다음 동기화를 기다리지 않고 바로 묶을 수 있게.
 * 이미 있으면 그대로. 돌려주는 값은 커밋의 변경 파일 경로.
 */
export async function indexCommitSha(db: DB, repo: RepoRow, sha: string): Promise<string[] | null> {
  const known = db.prepare("SELECT 1 FROM commits WHERE repo_id = ? AND sha = ?").get(repo.id, sha);
  if (known) {
    return (db.prepare("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ?").all(repo.id, sha) as { path: string }[]).map((row) => row.path);
  }
  const [commit] = await readCommits(repo.path, [sha]);
  if (!commit) return null;
  db.transaction(() => {
    if (insertCommit(db, repo, commit)) addCochange(db, repo.id, cochangeInput(commit, isMeaningfulSubject(commit.subject)));
  })();
  return commit.files.map((file) => file.path);
}

/** 커밋을 넣는다. 이미 있던 커밋이면 false (공변경을 두 번 세지 않게). */
function insertCommit(db: DB, repo: RepoRow, commit: GitCommit): boolean {
  const insertions = commit.files.reduce((sum, file) => sum + (file.insertions ?? 0), 0);
  const deletions = commit.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO commits
       (sha, repo_id, author_name, author_email, authored_at, subject, body,
        files_changed, insertions, deletions, meaningful, change_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    commit.sha,
    repo.id,
    commit.authorName,
    commit.authorEmail,
    commit.authoredAt,
    commit.subject,
    commit.body,
    commit.files.length,
    insertions,
    deletions,
    isMeaningfulSubject(commit.subject) ? 1 : 0,
    changeKey(commit.subject, commit.files.map((file) => file.path)),
  );
  // 이미 있던 커밋(다른 프로세스가 먼저 넣음)이면 파일·문서도 이미 같은 트랜잭션으로 들어가 있다 — 중복 행을 만들지 않는다
  if (inserted.changes === 0) return false;

  const insertFile = db.prepare(
    "INSERT INTO commit_files (repo_id, sha, path, insertions, deletions) VALUES (?, ?, ?, ?, ?)",
  );
  for (const file of commit.files) {
    insertFile.run(repo.id, commit.sha, file.path, file.insertions, file.deletions);
  }

  upsertDoc(db, {
    kind: "commit",
    ref: commit.sha,
    repoId: repo.id,
    at: commit.authoredAt,
    title: commit.subject,
    body: [repo.name, commit.body].filter(Boolean).join("\n"),
    paths: commit.files
      .slice(0, DOC_PATHS_MAX)
      .map((file) => file.path)
      .join(" "),
  });
  // 트레일러(Lore·QAC·플랫폼 꼬리표) → 커밋에 묶인 "왜"와 에이전트 커밋 판정 (capture.ts)
  const trailers = storeTrailers(db, repo.id, commit.sha, commit.body);
  if (trailers.length > 0) {
    const signal = agentSignal(trailers);
    if (signal) db.prepare("UPDATE commits SET agent_signal = ? WHERE repo_id = ? AND sha = ?").run(signal, repo.id, commit.sha);
    refreshWhy(db, repo.id, commit.sha);
  }
  return true;
}

interface TechItem {
  tech: string;
  category: string;
  manifestPath: string;
  dev: boolean;
}

/** HEAD의 의존성 매니페스트 → 정규화된 기술 목록 */
async function readTechStack(dir: string, signal?: AbortSignal): Promise<TechItem[]> {
  const manifests = (await listFiles(dir, signal))
    .filter((file) => MANIFEST_NAMES.has(path.posix.basename(file)) && !VENDORED.test(file))
    .slice(0, MANIFESTS_MAX);

  const items: TechItem[] = [];
  for (const manifestPath of manifests) {
    const content = await readFileAtHead(dir, manifestPath, signal);
    if (!content) continue;
    for (const dependency of parseManifest(manifestPath, content)) {
      const tech = canonicalTech(dependency.raw);
      if (!tech) continue;
      items.push({ tech, category: techCategory(tech), manifestPath, dev: dependency.dev });
    }
  }
  return items;
}
