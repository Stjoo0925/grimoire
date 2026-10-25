// GitHub 릴리스 노트를 만든다 — 지금 체크아웃된 커밋(= 배포 기준 커밋)에서 돈다.
//   node .github/scripts/release-notes.mjs <버전> [CHANGELOG.md]
//
// 1. CHANGELOG.md에서 그 버전의 섹션 (release-please가 릴리스 PR에 쓴 것)
//    머리글: "## [0.3.0](compare 링크) (2026-10-26)" 또는 "## 0.3.0 (2026-10-26)"
// 2. 릴리스 PR 머지 뒤 배포 시점까지 들어간 커밋 — 릴리스 PR의 CHANGELOG는 머지 전에 만들어지므로,
//    배포가 늦어지는 사이(예: 배포를 고치는 PR) 들어간 변경은 어느 노트에도 안 남는다. 그걸 여기서 채운다.
//    릴리스 PR 머지 커밋 = .release-please-manifest.json을 마지막으로 바꾼 커밋.
//    보이는 타입은 CHANGELOG와 같다(feat·fix·perf·revert, 그리고 깨지는 변경(!)이면 무엇이든).
// 3. 설치 — npm 명령, npm 페이지, 릴리스에 첨부되는 패키지 파일과 GitHub Packages
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
if (!version) {
  console.error("사용법: release-notes.mjs <버전> [CHANGELOG.md]");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const repoUrl = (process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}`
  : String(pkg.repository?.url ?? "")
).replace(/^git\+/, "").replace(/\.git$/, "");

function changelogSection() {
  const heading = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/;
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const start = lines.findIndex((line) => heading.exec(line)?.[1] === version);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && heading.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

const SECTIONS = { feat: "기능", fix: "버그 수정", perf: "성능", revert: "되돌림" };

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** 릴리스 PR 머지 뒤 들어간, 노트에 보일 커밋들 */
function laterCommits() {
  let releaseCommit;
  try {
    releaseCommit = git(["log", "-1", "--format=%H", "--", ".release-please-manifest.json"]);
  } catch {
    return [];
  }
  if (!releaseCommit) return [];
  const out = git(["log", "--reverse", "--format=%H%x1f%s", `${releaseCommit}..HEAD`]);
  const commits = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\x1f");
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    if (!match) continue;
    const [, type, scope, bang, rest] = match;
    if (!SECTIONS[type] && !bang) continue; // CHANGELOG에서 숨기는 타입(chore·ci·docs…)은 여기서도 숨긴다
    const pr = /\s*\(#(\d+)\)$/.exec(rest);
    const description = pr ? rest.slice(0, pr.index) : rest;
    commits.push({ sha, type, scope, breaking: Boolean(bang), description, pr: pr?.[1] });
  }
  return commits;
}

/** release-please CHANGELOG와 같은 꼴: "**scope:** 설명 ([#4](…)) ([af60b89](…))" */
function commitEntry(commit) {
  const scope = commit.scope ? `**${commit.scope}:** ` : "";
  const pr = commit.pr ? ` ([#${commit.pr}](${repoUrl}/issues/${commit.pr}))` : "";
  return `${scope}${commit.description}${pr} ([${commit.sha.slice(0, 7)}](${repoUrl}/commit/${commit.sha}))`;
}

const parts = [];
const section = changelogSection();
if (section) parts.push(section);

const later = laterCommits();
if (later.length > 0) {
  const lines = ["### 릴리스 PR 이후 함께 들어간 변경", ""];
  for (const commit of later) {
    const kind = commit.breaking ? "⚠ 깨지는 변경" : SECTIONS[commit.type];
    lines.push(`* [${kind}] ${commitEntry(commit)}`);
  }
  parts.push(lines.join("\n"));
}

const npmPage = `https://www.npmjs.com/package/${pkg.name}/v/${version}`;
parts.push(
  [
    "### 설치",
    "",
    "```bash",
    `npm install -g ${pkg.name}@${version}`,
    "```",
    "",
    `- npm: [${pkg.name}@${version}](${npmPage}) — GitHub Actions에서 빌드했다는 provenance가 붙어 있습니다`,
    "- 아래 Assets의 `.tgz`는 npm에 올라간 것과 같은 파일이고, `.sha256`으로 확인할 수 있습니다",
    `- GitHub Packages(\`npm.pkg.github.com\`)에도 같은 버전이 있습니다`,
  ].join("\n"),
);

process.stdout.write(`${parts.join("\n\n") || `v${version}`}\n`);
