// CHANGELOG.md에서 한 버전의 섹션만 꺼내 GitHub 릴리스 노트로 쓴다.
//   node .github/scripts/release-notes.mjs 0.3.0 [CHANGELOG.md]
// release-please가 쓰는 머리글: "## [0.3.0](compare 링크) (2026-10-26)" 또는 "## 0.3.0 (2026-10-26)"
import fs from "node:fs";

const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
if (!version) {
  console.error("사용법: release-notes.mjs <버전> [CHANGELOG.md]");
  process.exit(2);
}

const heading = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/;
const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
const start = lines.findIndex((line) => heading.exec(line)?.[1] === version);
if (start < 0) {
  // CHANGELOG에 없으면 빈 노트 대신 짧은 안내 — 릴리스 자체는 막지 않는다
  process.stdout.write(`v${version}\n`);
  process.exit(0);
}
const end = lines.findIndex((line, index) => index > start && heading.test(line));
const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
process.stdout.write(`${body || `v${version}`}\n`);
