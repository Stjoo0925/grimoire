/** 유닛 테스트용 고정 스냅샷 (실제 사용자 데이터는 절대 쓰지 않는다) */
import type {
  CollectionSnapshot,
  Commit,
  Repo,
} from "../src/lib/collector/types";

export const PACKAGE_JSON = JSON.stringify({
  name: "spellbook",
  dependencies: {
    next: "15.0.0",
    react: "19.0.0",
    "@tanstack/react-query": "^5",
    "@types/lodash": "^4",
  },
  devDependencies: { typescript: "^5", jest: "^29" },
});

export const REQUIREMENTS_TXT = `# 주석
fastapi==0.111.0
uvicorn[standard]>=0.29
sqlalchemy ; python_version >= "3.9"
-r dev-requirements.txt
`;

export const PYPROJECT_TOML = `[project]
name = "grimoire"
dependencies = ["fastapi>=0.111", "pydantic"]

[tool.poetry.dependencies]
python = "^3.11"
redis = "^5.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
`;

export const GO_MOD = `module github.com/user/grimoire

go 1.22

require (
	github.com/gin-gonic/gin v1.10.0
	github.com/redis/go-redis/v9 v9.5.1 // indirect
)

require github.com/spf13/cobra v1.8.0
`;

export const CARGO_TOML = `[package]
name = "grimoire"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio = "1"

[dev-dependencies]
criterion = "0.5"
`;

function commit(
  repoFullName: string,
  message: string,
  authoredAt: string,
): Commit {
  return {
    sha: `${repoFullName}-${message}`.slice(0, 40),
    repoFullName,
    message,
    authoredAt,
    authorLogin: "mage",
  };
}

const repoA: Repo = {
  id: "1",
  name: "spellbook",
  fullName: "mage/spellbook",
  description: "실시간 주문서",
  primaryLanguage: "TypeScript",
  languages: { TypeScript: 8000, CSS: 2000 },
  isPrivate: false,
  isFork: false,
  stars: 3,
  createdAt: "2024-01-05T00:00:00.000Z",
  pushedAt: "2024-06-01T00:00:00.000Z",
  readme: "# spellbook\n실시간 동기화를 다룬다.",
  htmlUrl: "https://example.invalid/mage/spellbook",
  topics: ["Realtime", "knowledge_graph", "react", "awesome"],
  manifests: { "package.json": PACKAGE_JSON },
};

const repoB: Repo = {
  id: "2",
  name: "familiar",
  fullName: "mage/familiar",
  description: null,
  primaryLanguage: "Python",
  languages: { Python: 5000 },
  isPrivate: true,
  isFork: false,
  stars: 0,
  createdAt: "2023-04-01T00:00:00.000Z",
  pushedAt: "2023-12-01T00:00:00.000Z",
  readme: null,
  htmlUrl: "https://example.invalid/mage/familiar",
  topics: ["realtime", "knowledge-graph"],
  manifests: { "requirements.txt": REQUIREMENTS_TXT },
};

/** topics/manifests가 없는 구버전(schemaVersion 1) 레포 */
const legacyRepo: Repo = {
  id: "3",
  name: "old-tome",
  fullName: "mage/old-tome",
  description: null,
  primaryLanguage: "Go",
  languages: { Go: 1000 },
  isPrivate: false,
  isFork: false,
  stars: 0,
  createdAt: "2022-02-02T00:00:00.000Z",
  pushedAt: "2022-03-03T00:00:00.000Z",
  readme: null,
  htmlUrl: "https://example.invalid/mage/old-tome",
};

export const SNAPSHOT: CollectionSnapshot = {
  schemaVersion: 2,
  login: "mage",
  collectedAt: "2024-06-02T00:00:00.000Z",
  repos: [repoA, repoB, legacyRepo],
  commits: [
    commit("mage/spellbook", "feat: 실시간 동기화 추가", "2024-01-10T00:00:00.000Z"),
    commit("mage/spellbook", "Merge branch 'main' into dev", "2024-02-10T00:00:00.000Z"),
    commit("mage/spellbook", "chore: deps 정리", "2024-02-11T00:00:00.000Z"),
    commit("mage/spellbook", "fix: 메모리 누수 수정", "2024-05-10T00:00:00.000Z"),
    commit("mage/familiar", "feat: 크롤러 파이프라인", "2023-05-10T00:00:00.000Z"),
    commit("mage/familiar", "오타", "2023-05-11T00:00:00.000Z"),
    commit("mage/old-tome", "initial commit", "2022-02-02T00:00:00.000Z"),
  ],
  contributions: [],
  stats: {
    repoCount: 3,
    privateRepoCount: 1,
    commitCount: 7,
    languageCount: 4,
    contributionCount: 0,
    firstCommitAt: "2022-02-02T00:00:00.000Z",
    lastCommitAt: "2024-05-10T00:00:00.000Z",
  },
  partial: false,
};

/** schemaVersion 1 (topics/manifests 없음) 스냅샷 */
export const LEGACY_SNAPSHOT: CollectionSnapshot = {
  login: "mage",
  collectedAt: "2023-01-01T00:00:00.000Z",
  repos: [legacyRepo],
  commits: [commit("mage/old-tome", "feat: 첫 주문", "2022-02-02T00:00:00.000Z")],
  contributions: [],
  stats: {
    repoCount: 1,
    privateRepoCount: 0,
    commitCount: 1,
    languageCount: 1,
    contributionCount: 0,
    firstCommitAt: "2022-02-02T00:00:00.000Z",
    lastCommitAt: "2022-02-02T00:00:00.000Z",
  },
  partial: false,
};
