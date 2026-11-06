/**
 * 판단의 확인·뒤집기 (docs/memory-philosophy.md §3, docs/supersede-design.md §6 성공 기준).
 * 사건은 바뀌지 않고, 판단은 뒤집힐 수 있고, 확인은 쌓인다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { fileContext, formatFileContext } from "../src/core/context";
import { headSha } from "../src/core/git";
import { addRepo, syncRepo } from "../src/core/indexer";
import { addNote, deleteNote, noteFlags, notesCiting, notesForFile } from "../src/core/notes";
import { search } from "../src/core/search";
import { confirmationsOf, isSuperseded, recordVerdicts, resolveRef, reviewNotes, supersededMark } from "../src/core/supersede";
import { slimSearch } from "../src/mcp/format";
import { callTool } from "../src/mcp/tools";
import { addCommit, makeRepo, memoryDb } from "./helpers";

async function indexed(name: string) {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 시작", files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" }, date: "2024-01-01T10:00:00+09:00" }], name);
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  return { db, dir, repo };
}

test("resolveRef: #id·sha를 풀고, 없거나 다른 레포·여럿이면 오류", async () => {
  const { db, dir, repo } = await indexed("refs");
  const sha = (await headSha(dir))!;
  const note = addNote(db, { text: "결정 하나", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  assert.deepEqual(resolveRef(db, repo.id, `#${note.id}`), { kind: "note", ref: String(note.id) });
  assert.deepEqual(resolveRef(db, repo.id, sha.slice(0, 8)), { kind: "commit", ref: sha });
  assert.throws(() => resolveRef(db, repo.id, "#999"), /not found/);
  assert.throws(() => resolveRef(db, repo.id, "abcdef0123"), /not in this repo/);
  assert.throws(() => resolveRef(db, repo.id, "hello"), /neither/);
  assert.throws(() => resolveRef(db, null, sha.slice(0, 8)), /repo is needed/);
});

test("뒤집기: 사람 노트가 옛 노트를 뒤집으면 카드에서 옛것이 빠지고 새것에 replaces가 붙는다; 검색에는 남되 뒤로 가고 supersededBy가 붙는다", async () => {
  const { db, repo } = await indexed("sup");
  const old = addNote(db, { text: "결정: 캐시 TTL은 1시간으로 둔다", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const next = addNote(db, { text: "결정: 캐시 TTL은 5분으로 줄인다 — 1시간은 측정 실수였다", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const result = recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(next.id) }, targets: [{ kind: "note", ref: String(old.id) }], how: "note" });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.notes, []);

  const hints = notesForFile(db, repo.id, "src/a.ts");
  assert.deepEqual(hints.map((hint) => hint.id), [next.id], "뒤집힌 노트는 카드에서 빠진다");
  assert.deepEqual(hints[0].replaces, [old.id]);
  assert.equal(noteFlags(hints[0]), ` (replaces #${old.id})`);
  assert.match(formatFileContext(fileContext(db, repo.id, "src/a.ts"), { lean: true }), new RegExp(`replaces #${old.id}`));

  // 검색: 둘 다 나오되 뒤집힌 것이 뒤로, 표시가 붙는다
  const hits = search(db, "캐시 TTL", { kind: "note" }).hits;
  assert.deepEqual(hits.map((hit) => hit.ref), [String(next.id), String(old.id)]);
  assert.equal(hits[1].supersededBy, `#${next.id}`);
  assert.equal(hits[0].supersededBy, undefined);
  const slim = slimSearch(search(db, `#${old.id}`), []) as { hits: { superseded?: string }[] };
  assert.equal(slim.hits[0].superseded, `#${next.id}`, "번호로 바로 찾아도 뒤집혔다고 보인다");

  // 고리·자기 자신·이미 뒤집힌 대상
  assert.throws(() => recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(old.id) }, targets: [{ kind: "note", ref: String(next.id) }], how: "note" }), /already supersedes/);
  assert.throws(() => recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(next.id) }, targets: [{ kind: "note", ref: String(next.id) }], how: "note" }), /itself/);
  const third = addNote(db, { text: "결정: TTL은 10분", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const again = recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(third.id) }, targets: [{ kind: "note", ref: String(old.id) }], how: "note" });
  assert.match(again.notes[0], new RegExp(`#${old.id} is already superseded by #${next.id}`));
});

test("AI가 사람의 노트를 뒤집으면 숨기지 않고 둘 다 보이며 disputed로 표시한다; AI가 AI 노트를 뒤집으면 숨긴다", async () => {
  const { db, repo } = await indexed("dispute");
  const human = addNote(db, { text: "결정: 동기 호출로 둔다", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const ai = addNote(db, { text: "결정: 비동기로 바꾼다", repoId: repo.id, paths: ["src/a.ts"], source: "mcp" });
  recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(ai.id) }, targets: [{ kind: "note", ref: String(human.id) }], how: "note" });
  const hints = notesForFile(db, repo.id, "src/a.ts");
  assert.deepEqual(hints.map((hint) => hint.id).sort(), [human.id, ai.id].sort());
  const disputed = hints.find((hint) => hint.id === human.id)!;
  assert.equal(disputed.disputedBy, ai.id);
  assert.match(noteFlags(disputed), /disputed by #\d+ \(ai\)/);

  const aiOld = addNote(db, { text: "결정: 로그는 debug", repoId: repo.id, paths: ["src/b.ts"], source: "mcp" });
  const aiNew = addNote(db, { text: "결정: 로그는 info", repoId: repo.id, paths: ["src/b.ts"], source: "mcp" });
  recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(aiNew.id) }, targets: [{ kind: "note", ref: String(aiOld.id) }], how: "note" });
  assert.deepEqual(notesForFile(db, repo.id, "src/b.ts").map((hint) => hint.id), [aiNew.id]);
});

test("확인: stale이 풀리고, 확인 횟수가 붙고, 최근에 확인한 노트가 먼저 나온다", async () => {
  const { db, dir, repo } = await indexed("confirm");
  const older = addNote(db, { text: "결정: a는 상수", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = addNote(db, { text: "결정: a의 이름은 그대로", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  addCommit(dir, { message: "refactor: a 바꿈", files: { "src/a.ts": "export const a = 2;\n" } });
  await syncRepo(db, repo);
  assert.ok(notesForFile(db, repo.id, "src/a.ts").every((hint) => hint.stale), "파일이 바뀌어 둘 다 stale");
  assert.deepEqual(notesForFile(db, repo.id, "src/a.ts").map((hint) => hint.id), [newer.id, older.id]);

  const verdict = recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(newer.id) }, targets: [{ kind: "note", ref: String(older.id) }], how: "confirm" });
  assert.equal(verdict.applied[0].how, "confirm");
  const hints = notesForFile(db, repo.id, "src/a.ts");
  assert.deepEqual(hints.map((hint) => hint.id), [older.id, newer.id], "확인한 노트가 먼저");
  assert.equal(hints[0].stale, false, "확인하면 stale이 풀린다");
  assert.equal(hints[1].stale, true, "확인하지 않은 노트는 그대로");
  assert.equal(hints[0].confirmed?.count, 1);
  assert.match(noteFlags(hints[0]), /confirmed 1× \d{4}-\d\d-\d\d/);
  assert.equal(confirmationsOf(db, older.id).count, 1);
  assert.equal(isSuperseded(db, "note", String(older.id)), false, "확인은 뒤집기가 아니다");
});

test("record_note supersedes/confirms: 대상을 먼저 검증하고, paths 없이도 대상 노트의 파일을 물려받고, text 없이 confirms만으로도 남긴다", async () => {
  const { db, dir, repo } = await indexed("tool");
  const context = { db, me: [], cwd: dir };
  const old = (await callTool(context, "record_note", { text: "결정: 재시도 3회", repo: repo.name, paths: ["src/b.ts"] })) as { id: number };
  await assert.rejects(callTool(context, "record_note", { text: "x", repo: repo.name, supersedes: ["#999"] }), /not found/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes WHERE text = 'x'").get() as { n: number }).n, 0, "틀린 참조면 노트도 남지 않는다");

  const next = (await callTool(context, "record_note", { text: "결정: 재시도 5회 — 네트워크가 느린 환경이 생겼다", repo: repo.name, supersedes: [`#${old.id}`] })) as {
    id: number;
    paths?: string[];
    supersedes?: string[];
    autoBound?: boolean;
  };
  assert.deepEqual(next.supersedes, [`#${old.id}`]);
  assert.deepEqual(next.paths, ["src/b.ts"], "뒤집는 노트의 파일을 물려받는다");
  assert.equal(next.autoBound, undefined);
  assert.deepEqual(notesForFile(db, repo.id, "src/b.ts").map((hint) => hint.id), [next.id]);

  // 확인만: 노트를 만들지 않는다 — 스텁 노트가 카드 자리와 검색을 차지하지 않게
  const before = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  const confirmed = (await callTool(context, "record_note", { repo: repo.name, confirms: [String(next.id)] })) as { confirmed?: string[]; id?: number };
  assert.deepEqual(confirmed.confirmed, [`#${next.id}`]);
  assert.equal(confirmed.id, undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, before, "노트가 늘지 않는다");
  assert.deepEqual(notesForFile(db, repo.id, "src/b.ts").map((hint) => hint.id), [next.id]);
  assert.equal(notesForFile(db, repo.id, "src/b.ts")[0].confirmed?.count, 1);
  // 같은 에이전트가 다시 확인해도 쌓인다 (키에 at이 있다)
  await new Promise((resolve) => setTimeout(resolve, 5));
  await callTool(context, "record_note", { repo: repo.name, confirms: [String(next.id)] });
  assert.equal(confirmationsOf(db, next.id).count, 2);
  await assert.rejects(callTool(context, "record_note", { repo: repo.name }), /text/);
  await assert.rejects(callTool(context, "record_note", { repo: repo.name, supersedes: [`#${next.id}`] }), /이유/);
  await assert.rejects(callTool(context, "record_note", { text: "너무 많음", repo: repo.name, confirms: Array.from({ length: 11 }, (_, i) => `#${next.id + i}`) }), /at most 10/);
});

test("처음 색인할 때 이미 있는 revert도 판단으로 남는다 — 최신 커밋부터 들어와 원본이 아직 없어도", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 캐시\n\nWhy: 느려서", files: { "src/a.ts": "export const a = 1;\n" }, date: "2024-01-01T10:00:00+09:00" }], "firstrevert");
  const first = (await headSha(dir))!;
  addCommit(dir, { message: `Revert "feat: 캐시"\n\nThis reverts commit ${first}.`, files: { "src/a.ts": "export const a = 0;\n" }, date: "2024-02-01T10:00:00+09:00" });
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  assert.equal(isSuperseded(db, "commit", first), true, "한 번의 동기화로 revert가 기록된다");
  assert.equal(fileContext(db, repo.id, "src/a.ts").why, null, "되돌려진 커밋의 Why는 고르지 않는다");
});

test("고리: 사슬을 거쳐 나를 뒤집은 노트는 뒤집을 수 없다", async () => {
  const { db, repo } = await indexed("cycle");
  const a = addNote(db, { text: "A", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const b = addNote(db, { text: "B", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const c = addNote(db, { text: "C", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const ref = (note: { id: number }) => ({ kind: "note" as const, ref: String(note.id) });
  recordVerdicts(db, { repoId: repo.id, by: ref(b), targets: [ref(a)], how: "note" });
  recordVerdicts(db, { repoId: repo.id, by: ref(c), targets: [ref(b)], how: "note" });
  assert.throws(() => recordVerdicts(db, { repoId: repo.id, by: ref(a), targets: [ref(c)], how: "note" }), /through a chain/);
  assert.deepEqual(notesForFile(db, repo.id, "src/a.ts").map((hint) => hint.id), [c.id], "끝의 판단 하나는 남는다");
  assert.throws(() => recordVerdicts(db, { repoId: repo.id, by: { kind: "user", ref: "cli" }, targets: [ref(c)], how: "note" }), /needs a note or a commit/);
});

test("export는 판단 기록도 꺼내고, remove 뒤에도 살아남은 노트의 판단 기록은 남는다", async () => {
  const { removeRepo, exportRepoMemory, repoMemorySize } = await import("../src/core/indexer.js");
  const { db, repo } = await indexed("exportv");
  const old = addNote(db, { text: "옛 결정", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const next = addNote(db, { text: "새 결정", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(next.id) }, targets: [{ kind: "note", ref: String(old.id) }], how: "note" });
  recordVerdicts(db, { repoId: repo.id, by: { kind: "user", ref: "cli" }, targets: [{ kind: "note", ref: String(next.id) }], how: "confirm" });
  assert.equal(repoMemorySize(db, repo.id).verdicts, 2);
  const exported = exportRepoMemory(db, repo);
  assert.deepEqual(exported.verdicts.map((item) => item.how).sort(), ["confirm", "note"]);
  removeRepo(db, repo);
  assert.equal(isSuperseded(db, "note", String(old.id)), true, "노트가 살아남으면 그 판단도 남는다");
  assert.equal(confirmationsOf(db, next.id).count, 1);
});

test("최신 노트가 전부 뒤집혔어도 그 뒤의 멀쩡한 노트가 카드에 보인다", async () => {
  const { db, repo } = await indexed("many");
  const keep = addNote(db, { text: "지켜야 할 결정", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const sha = (db.prepare("SELECT sha FROM commits WHERE repo_id = ?").get(repo.id) as { sha: string }).sha;
  for (let i = 0; i < 13; i++) {
    const note = addNote(db, { text: `뒤집힐 ${i}`, repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
    recordVerdicts(db, { repoId: repo.id, by: { kind: "commit", ref: sha }, targets: [{ kind: "note", ref: String(note.id) }], how: "trailer" });
  }
  assert.deepEqual(notesForFile(db, repo.id, "src/a.ts").map((hint) => hint.id), [keep.id]);
});

test("커밋이 남기는 판단: git revert와 Supersedes: 트레일러가 커밋을 뒤집고, 뒤집힌 커밋의 의도는 카드의 Why에서 빠진다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 캐시 도입\n\nWhy: 응답이 느려서", files: { "src/a.ts": "export const a = 1;\n" }, date: "2024-01-01T10:00:00+09:00" }], "revert");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const first = (await headSha(dir))!;
  assert.equal(fileContext(db, repo.id, "src/a.ts").why?.sha, first);

  addCommit(dir, { message: `Revert "feat: 캐시 도입"\n\nThis reverts commit ${first}.\n\nWhy: 캐시가 오래된 값을 내보냈다`, files: { "src/a.ts": "export const a = 0;\n" }, date: "2024-02-01T10:00:00+09:00" });
  await syncRepo(db, repo);
  const revert = (await headSha(dir))!;
  assert.equal(isSuperseded(db, "commit", first), true);
  assert.equal(supersededMark(db, "commit", first), revert.slice(0, 10));
  const why = fileContext(db, repo.id, "src/a.ts").why;
  assert.equal(why?.sha, revert, "되돌려진 커밋의 의도는 고르지 않는다");

  addCommit(dir, { message: `feat: 캐시 다시, 검증 추가\n\nSupersedes: ${revert.slice(0, 10)}\nRevisit-when: 트래픽이 10배가 되면`, files: { "src/a.ts": "export const a = 3;\n" }, date: "2024-03-01T10:00:00+09:00" });
  await syncRepo(db, repo);
  const third = (await headSha(dir))!;
  assert.equal(isSuperseded(db, "commit", revert), true);
  const ctx = fileContext(db, repo.id, "src/a.ts");
  // 셋째 커밋에는 Why 트레일러가 없고 둘은 뒤집혔다 — 의도 후보가 없다
  assert.equal(ctx.why, null);
  // 검색에서는 뒤집힌 커밋이 뒤로 가고 표시가 붙는다
  const hits = search(db, "캐시").hits.filter((hit) => hit.kind === "commit");
  assert.equal(hits[0].ref, third);
  assert.ok(hits.slice(1).every((hit) => hit.supersededBy), JSON.stringify(hits.map((hit) => [hit.ref.slice(0, 7), hit.supersededBy])));
  const shown = (await callTool({ db, me: [], cwd: dir }, "show_commit", { sha: first.slice(0, 10) })) as { superseded?: string };
  assert.equal(shown.superseded, revert.slice(0, 10));
});

test("Revisit-when 트레일러는 카드의 Why 뒤에 따라 나온다", async () => {
  const db = memoryDb();
  const dir = makeRepo([{ message: "feat: 단일 인스턴스 캐시\n\nWhy: 인스턴스가 하나라 로컬 캐시가 가장 싸다\nRevisit-when: 인스턴스가 둘 이상이 되면", files: { "src/a.ts": "export const a = 1;\n" } }], "revisit");
  const repo = await addRepo(db, dir);
  await syncRepo(db, repo);
  const ctx = fileContext(db, repo.id, "src/a.ts");
  assert.equal(ctx.why?.revisit, "인스턴스가 둘 이상이 되면");
  assert.match(formatFileContext(ctx), /revisit when: 인스턴스가 둘 이상이 되면/);
});

test("근거 묶기: 본문의 sha가 이 레포 커밋이면 refs로 묶이고, show_commit과 검색 결과에 보인다", async () => {
  const { db, dir, repo } = await indexed("evidence");
  const sha = (await headSha(dir))!;
  const note = addNote(db, { text: `교훈: ${sha.slice(0, 10)}에서 a를 상수로 바꾼 뒤 b가 깨졌다 (이슈 #1234, 2024-01-01)`, repoId: repo.id, source: "cli" });
  assert.deepEqual(JSON.parse(note.refs), [sha]);
  assert.deepEqual(notesCiting(db, repo.id, sha).map((item) => item.id), [note.id]);
  const shown = (await callTool({ db, me: [], cwd: dir }, "show_commit", { sha: sha.slice(0, 10) })) as { notes?: string[] };
  assert.match(shown.notes![0], new RegExp(`^#${note.id} \\d{4}-\\d\\d-\\d\\d "교훈: `));
  const hit = search(db, "깨졌다", { kind: "note" }).hits[0];
  assert.deepEqual(hit.evidence, [sha.slice(0, 10)]);
  const none = addNote(db, { text: "근거 없는 말 abcdef1234", repoId: repo.id, source: "cli" });
  assert.deepEqual(JSON.parse(none.refs), [], "레포에 없는 sha는 묶지 않는다");
});

test("review: stale·추정 묶기·오래 확인 안 됨·근거 뒤집힘을 모아 보이고, 뒤집힌 노트는 뺀다; note rm은 판단 기록도 지운다", async () => {
  const { db, dir, repo } = await indexed("review");
  const first = (await headSha(dir))!;
  const staleNote = addNote(db, { text: "결정: a는 1", repoId: repo.id, paths: ["src/a.ts"], source: "cli" });
  const autoNote = addNote(db, { text: "메모", repoId: repo.id, autoPaths: ["src/b.ts"], source: "mcp" });
  const citing = addNote(db, { text: `교훈: ${first.slice(0, 10)} 때문에`, repoId: repo.id, paths: [], source: "cli" });
  const gone = addNote(db, { text: "결정: 옛것", repoId: repo.id, paths: ["src/b.ts"], source: "cli" });
  const replacement = addNote(db, { text: "결정: 새것", repoId: repo.id, paths: ["src/b.ts"], source: "cli" });
  recordVerdicts(db, { repoId: repo.id, by: { kind: "note", ref: String(replacement.id) }, targets: [{ kind: "note", ref: String(gone.id) }], how: "note" });
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 9;\n");
  addCommit(dir, { message: `Revert "feat: 시작"\n\nThis reverts commit ${first}.`, files: { "src/a.ts": "export const a = 9;\n" } });
  await syncRepo(db, repo);

  const items = reviewNotes(db, repo.id, { now: Date.now() + 100 * 86_400_000, days: 90 });
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.ok(byId.get(staleNote.id)?.reasons.some((reason) => reason.startsWith("stale: src/a.ts")));
  assert.ok(byId.get(autoNote.id)?.reasons.includes("bound only by guess (auto)"));
  assert.ok(byId.get(citing.id)?.reasons.some((reason) => reason.startsWith("cites overturned commit")));
  assert.ok(byId.get(replacement.id)?.reasons.some((reason) => /never confirmed \(\d+d old\)/.test(reason)));
  assert.equal(byId.has(gone.id), false, "뒤집힌 노트는 끝난 판단이다");
  assert.equal(reviewNotes(db, repo.id, { days: 90 }).some((item) => item.id === replacement.id), false, "방금 쓴 노트는 오래되지 않았다");

  assert.equal(deleteNote(db, replacement.id), true);
  assert.equal(isSuperseded(db, "note", String(gone.id)), false, "지운 노트가 남긴 뒤집기도 사라진다");
  assert.equal(deleteNote(db, 9999), false);
  assert.equal(search(db, `#${replacement.id}`).hits.some((hit) => hit.kind === "note" && hit.ref === String(replacement.id)), false);
});
