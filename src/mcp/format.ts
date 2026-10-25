/**
 * MCP 응답 다이어트 — 코어 결과를 AI 클라이언트에 넘길 최소 형태로 줄인다.
 *
 * 도구 응답은 그대로 대화 컨텍스트에 쌓여 매 턴 다시 읽히므로, 토큰이 곧 비용이다.
 *  - 답에 쓰지 않는 필드(로컬 경로·점수·매칭 출처·이메일)는 뺀다
 *  - sha는 10자, 날짜는 YYYY-MM-DD
 *  - 커밋 링크는 레포별 접두(`links`)를 한 번만 주고, 각 결과는 sha만 싣는다
 *  - 작성자는 내 커밋이면 "me", 아니면 이름만
 * CLI는 코어의 전체 결과를 그대로 쓴다.
 */
import type { CommitDetail, RepoOverview, RepoSummary } from "../core/overview";
import type { SearchHit, SearchResult } from "../core/search";

const SHA = 10;
const FILES_PER_HIT = 4;
const SNIPPET_CHARS = 140;
const FILES_PER_COMMIT = 30;

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/** "Name <email>" → 내 이메일이면 "me", 아니면 이름 */
export function who(author: string | null, me: string[]): string | null {
  if (!author) return null;
  const match = /^(.*) <(.+)>$/.exec(author);
  if (!match) return author;
  return me.includes(match[2].toLowerCase()) ? "me" : match[1];
}

/** 커밋 웹 링크에서 sha를 떼어 레포별 접두로 쓴다 */
function linkPrefix(url: string | null, sha: string): string | null {
  return url && url.endsWith(sha) ? url.slice(0, -sha.length) : null;
}

function snippet(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > SNIPPET_CHARS ? cleaned.slice(0, SNIPPET_CHARS) + "…" : cleaned;
}

export function slimSearch(result: SearchResult, me: string[]) {
  const links: Record<string, string> = {};
  const hits = result.hits.map((hit: SearchHit) => {
    if (hit.kind === "file") {
      // 현재 코드의 위치: 파일 + 심볼:줄. 마지막으로 건드린 커밋도 붙여 이력과 잇는다
      return {
        file: hit.ref,
        repo: hit.repo,
        at: hit.symbols && hit.symbols.length > 0 ? hit.symbols : undefined,
        lines: hit.lines,
        last: hit.lastCommit ? `${hit.lastCommit.sha.slice(0, SHA)} ${day(hit.lastCommit.date)} ${hit.lastCommit.title}` : undefined,
      };
    }
    if (hit.kind === "note") {
      return { note: Number(hit.ref), date: day(hit.date), title: hit.title, body: snippet(hit.snippet), repo: hit.repo ?? undefined };
    }
    const prefix = linkPrefix(hit.url, hit.ref);
    if (hit.repo && prefix) links[hit.repo] = prefix;
    const more = hit.filesChanged !== null && hit.filesChanged > FILES_PER_HIT ? hit.filesChanged - FILES_PER_HIT : 0;
    return {
      repo: hit.repo,
      sha: hit.ref.slice(0, SHA),
      date: day(hit.date),
      by: who(hit.author, me),
      title: hit.title,
      files: [...hit.files.slice(0, FILES_PER_HIT), ...(more > 0 ? [`+${more}`] : [])],
      body: snippet(hit.snippet),
    };
  });
  return {
    hits,
    ...(Object.keys(links).length > 0 ? { links } : {}),
  };
}

export function slimCommit(detail: CommitDetail, me: string[]) {
  const files = detail.files.slice(0, FILES_PER_COMMIT).map((file) =>
    file.insertions === null ? `${file.path} (binary)` : `${file.path} +${file.insertions} -${file.deletions}`,
  );
  if (detail.files.length > FILES_PER_COMMIT) files.push(`… ${detail.files.length - FILES_PER_COMMIT}개 더`);
  const shownLines = detail.patch ? detail.patch.split("\n").length : 0;
  return {
    repo: detail.repo,
    sha: detail.sha.slice(0, SHA),
    url: detail.url ?? undefined,
    date: day(detail.date),
    by: who(detail.author, me),
    subject: detail.subject,
    body: detail.body || undefined,
    files,
    diff: detail.patch ?? undefined,
    ...(detail.patchTruncated
      ? { truncated: `diff ${shownLines}/${detail.patchLines}줄만 보냄 — paths로 파일을 고르거나 max_diff_lines를 늘리세요` }
      : {}),
    ...(detail.patchNote ? { note: detail.patchNote } : {}),
  };
}

export function slimOverview(overview: RepoOverview) {
  const sha = overview.recentCommits[0]?.sha;
  const prefix = sha ? linkPrefix(overview.recentCommits[0].url, sha) : null;
  return {
    repo: overview.name,
    commits: overview.commits,
    mine: overview.mine,
    period: `${day(overview.firstCommit)} ~ ${day(overview.lastCommit)}`,
    tech: Object.fromEntries(overview.tech.map((group) => [group.category, group.items.join(", ")])),
    activity: overview.activity.map((bucket) => `${bucket.period}:${bucket.commits}`).join(" "),
    dirs: overview.topDirectories.map((dir) => `${dir.path}(${dir.commits})`).join(" "),
    authors: overview.topAuthors.map((author) => `${author.author.replace(/ <.*>$/, "")}(${author.commits})`).join(" "),
    recent: overview.recentCommits.map((commit) => `${commit.sha.slice(0, SHA)} ${day(commit.date)} ${commit.subject}`),
    ...(prefix ? { link: prefix } : {}),
  };
}

export function slimRepos(repos: RepoSummary[]) {
  return repos.map((repo) => ({
    name: repo.name,
    commits: repo.commits,
    mine: repo.mine,
    period: `${day(repo.firstCommit)} ~ ${day(repo.lastCommit)}`,
  }));
}
