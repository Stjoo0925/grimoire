# Grimoire

[![CI](https://github.com/Stjoo0925/grimoire/actions/workflows/ci.yml/badge.svg)](https://github.com/Stjoo0925/grimoire/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@stjoo0925/grimoire)](https://www.npmjs.com/package/@stjoo0925/grimoire)

**English** | [한국어](./docs/README.ko.md)

> A local dev memory that answers "How did I solve this before?" and "Where is that code?" **with evidence**.

Grimoire indexes the git repos on your machine so that AI tools like Claude Code, Cursor and Claude Desktop can
**search your past commits, changed files, diffs and notes, plus your current code (files and symbol:line), in one shot over MCP**.
The goal is to let the AI point at the right file and commit with a single search instead of opening files one by one or digging through `git log`.

- Works with any repo cloned locally, including org repos. No GitHub token, no rate limits
- **Evidence** for every result: repo · sha · date · author · changed files · commit link for commits; file path · symbol:line · last commit that touched it for code
- **Incremental sync**: only new commits and changed files are read. Syncs in the background when the MCP server starts
- Korean queries reach English identifiers: common dev terms are expanded to English ("충돌" → `conflict`, "횟수 제한" → `rate limit`)
- Responses are kept minimal, because whatever lands in the conversation context is what you pay for
- No LLM, no embedding model, no GPU: search is keyword-based (SQLite FTS5) and the AI you already use does the reading

See [docs/PLANNING.md](./docs/PLANNING.md) (Korean) for the design and what changed from earlier versions, and [docs/improvement-plan.md](./docs/improvement-plan.md) (Korean) for the research-based roadmap.

## Quick start

Requires Node.js 20+ and git.

```bash
npm install -g @stjoo0925/grimoire
grimoire scan ~/work-dir              # find every git repo below, register + index
grimoire install claude-code          # connect an MCP client (see table below)
grimoire doctor                       # check the connection
```

To run from source, clone it and run `npm install && npm run build && npm link`.

## Connecting over MCP

`grimoire install <client>` writes the client config for you.

| Client | Command | Writes to |
|---|---|---|
| Claude Code (all projects) | `grimoire install claude-code` | runs `claude mcp add --scope user` |
| Claude Code (this repo only) | `grimoire install claude-code --project .` | `./.mcp.json` |
| Claude Desktop | `grimoire install claude-desktop` | `claude_desktop_config.json` |
| Cursor | `grimoire install cursor` (`--project .` for this repo only) | `~/.cursor/mcp.json` |

- The config contains the **absolute path of the node currently running**. GUI apps like Claude Desktop and Cursor
  don't see your shell's PATH, so `"command": "node"` fails with `spawn node ENOENT`. The SQLite module also only
  loads under the node it was built with. If you switch node versions, run `install` again.
- If `GRIMOIRE_HOME`, `GRIMOIRE_ME`, `GRIMOIRE_AUTO_ADD` or `GRIMOIRE_UPDATE_CHECK` are set, they are written too,
  so the CLI and MCP server see the same DB.
- Other server entries are left alone; only the `grimoire` entry is added. The existing file is backed up as `.bak`,
  and if its JSON is broken Grimoire stops without touching it. Add `--dry-run` to preview what would be written.
- Restart the client after installing (fully quit Claude Desktop with ⌘Q).

### When it won't connect — `grimoire doctor`

Checks the Grimoire version (whether a new release is out), the node version and SQLite module, git, the DB and registered repos, your email, and the config
each client has (whether the node path exists, matches the current node, and points at the same DB), and tells you the command to fix it.

### The project you're working in is registered automatically

Claude Code and Cursor start the MCP server in the open project folder. If that folder is in a git repo that isn't
registered yet, Grimoire **registers it on startup and syncs it before any other repo**. Your first search waits
(up to 15 seconds) for that first index, so you never need `add_repo` for the project you have open.

- Results from the current repo are **ranked first** (other repos still show up), and responses include `current: "<repo>"`.
- Set `GRIMOIRE_AUTO_ADD=0` to turn this off. Then, if the current repo isn't registered, the `hint` says so instead of staying silent.
- Skipped when the repo root is your home directory or `/` (dotfile repos and the like).
- Claude Desktop has no project folder (it starts the server in `/`), so register repos there as described below.

### Registering repos mid-conversation

With no repos yet, results carry a `hint`, so the AI suggests registering first.
The `add_repo` tool registers right from the conversation ("remember every repo under ~/work-dir" → `scan: true`).

### Tools

| Tool | What it does |
|---|---|
| `search_memory` | Searches current code files, commits and notes at once. Filters: `repo`, `author` (`me`), `since`, `until`, `kind` (`file`, `commit`, `note`), `limit` (default 8). `detail`: `summary` (default: the top 3 commits carry their full message and the functions they changed), `index` (list only), `full` (also the top commit's diff) |
| `show_commit` | Message, changed files and diff of one commit (read straight from the local repo). The diff defaults to 120 lines; `paths` narrows it to specific files |
| `get_repo_overview` | Tech stack (from manifests), quarterly activity, most-touched directories, top authors, recent notable commits |
| `list_repos` | Indexed repos |
| `add_repo` | Register + index a repo (or, with `scan: true`, every repo under a folder). Scanning `/` or your whole home goes through `grimoire scan` in the terminal |
| `record_note` | Save something learned or decided as a note → searchable afterwards |

Responses are minimal to save tokens: 10-char shas, dates to the day, `me` for your own commits, and the commit link prefix per repo (`links`) sent only once.
Fields the answer doesn't need (local paths, scores, emails) are dropped. Tool descriptions only say *when* to use each tool, since tool definitions ride along with every request in every session where the server is on.
What piles up in the conversation context is the cost. The "response size budget" step in `npm run e2e` (260 chars per search hit, 2600 chars of tool definitions) keeps the format from growing back.
The CLI shows the full, unslimmed results.

### Current code index

Alongside commit history, Grimoire indexes the **source files at HEAD** of each repo. Each file becomes a search document made of its path, top-level symbols (functions, classes, …) with line numbers, and its header comment.

- Included: source files such as `.ts`, `.tsx`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.cs`, `.c/.cpp`, `.sql`, `.sh`, `.dart`
- Excluded: generated and third-party code like `node_modules`, `vendor`, `dist`, `build`, `.next`, `generated`; `.min.js`; files over 200KB. At most 8,000 files per repo
- Symbols are extracted with per-language regexes (no parser). Identifiers are also split into words so `rateLimit` matches `rate limit`
- Incremental: the blob sha of each file is remembered, so only changed files are re-read and deleted files are removed from the index
- File results (`kind: "file"`) include the symbols matching the query as `name:line`, the file's line count, and the last commit that touched it
- With an `author`, `since` or `until` filter, the query is treated as a history question and code files are left out

### What each commit changed

After the commit metadata is indexed, a second pass reads each commit's diff (source files only) and records the functions, classes and types it added, changed or removed.
Search results show them as `changed` ("webhook.ts: dedupeWebhookEvent"), so the AI can often answer "how did I solve this?" without opening the diff.
The names are also searchable, but only to fill in when titles, bodies and paths give too few results (for example a function that no longer exists anywhere). Mixing them into the main ranking lowered accuracy in the offline eval.

The server syncs registered repos in the background right after it starts, then fills in the diff pass. The repo you're working in is re-synced before a search when 15 seconds have passed, so a commit you just made is searchable. Set `GRIMOIRE_SYNC_ON_START=0` to turn off the startup sync.

### Measuring search quality

`npm run eval` indexes your repos into a temporary DB and scores `search()` without calling any model: commit subjects against the files they touched, plus hand-written questions in `bench/eval.local.json` (`{ "root": "~/work-dir", "questions": [{ "id", "type": "history" | "location", "q", "expect": ["sha or path part"] }] }`). It reports Acc@k, MRR, search latency and index time. `--save --label x` keeps the result under `bench/results/`.

## CLI

```bash
grimoire scan ~/work-dir          # find every git repo below, register + index
grimoire add ~/code/some-repo     # register one repo
grimoire sync                     # pick up only new commits and changed code files
grimoire repos                    # repos and commit counts

grimoire search "jwt refresh"                  # search
grimoire search "동시성 락" --author me --since 2024-01-01
grimoire show 2518bf75                         # commit message + files + diff (120 lines by default)
grimoire show 2518bf75 --path route.ts         # diff of files whose path partly matches (--lines n for more)
grimoire overview please_readme                # tech stack, activity, hot spots, recent notable commits
grimoire note "Decision: JWT over sessions — because of mobile" --repo shop-api --tag decision
grimoire remove shop-api                       # delete a repo and its index
grimoire update                                # move to the latest release (see Updating)
```

All data lives in a single `~/.grimoire/grimoire.db` (SQLite). Change the location with `GRIMOIRE_HOME`.

### "My" commits

`--author me` / MCP `author: "me"` uses your global `git config user.email`.
If you commit with both work and personal emails, list them all (then run `grimoire install` again to put it in the MCP config too).

```bash
export GRIMOIRE_ME="me@gmail.com,me@company.com"
```

## Why there's no semantic search

Earlier versions could embed commits with a local model (Ollama) so that differently-worded questions still matched.
It was removed: the one writing the search queries is the AI, and when a search misses, it rewords and searches again
by itself. Korean–English mismatches are covered by the term dictionary (`src/core/terms.ts`), and the pinpoint
benchmark scored 6/6 with keyword search alone. Dropping it removed a second install (Ollama + model), a DB about
3× larger, and slower searches.

## Updating

New versions come out as [GitHub Releases](https://github.com/Stjoo0925/grimoire/releases) and are published to npm under the same version.

```bash
grimoire update            # move to the latest release
grimoire update --check    # only check
grimoire update --dry-run  # only show what would run
```

- Installed from npm: runs `npm install -g @stjoo0925/grimoire@<new version>`.
- Installed from a clone: fast-forwards to the release tag, then runs `npm install` and `npm run build`. If there are uncommitted changes or it can't fast-forward, nothing is changed and the update stops.

Restart your MCP client afterwards. The install is replaced in place, so the MCP config doesn't need to be rewritten.

New versions are checked once a day (recorded in `~/.grimoire/update.json`) and announced like this:

- **MCP**: once per session, in the `hint` of a `search_memory` or `list_repos` response, so the AI tells you
- **CLI**: one line on stderr after a command finishes (`--json` output is untouched)
- **`grimoire doctor`**: current and latest version

Set `GRIMOIRE_UPDATE_CHECK=0` to turn it off (run `grimoire install` again afterwards to put it in the MCP config too).

## Privacy

- The only request Grimoire makes to the outside is the daily update check (asking the GitHub API for the latest release version). No repos, commits or queries are sent, and `GRIMOIRE_UPDATE_CHECK=0` turns it off.
- **When connected to an external LLM client over MCP, query results (commit messages, file paths, diffs) are passed to that LLM.**
  Don't register sensitive repos, or take them out with `grimoire remove <repo>`.

## Development

```bash
npm run typecheck
npm test            # indexing, search and MCP tools against temp git repos (no network)
npm run e2e         # end-to-end MCP harness (below)
npm run e2e:agent   # agent harness (below, calls real Claude)
npm run bench       # pinpoint benchmark (below, calls real Claude)
```

### End-to-end MCP harness (`e2e/harness.ts`)

Starts the server **as a separate process over stdio**, like a real client, and runs a 14-step scenario against fixed fixture repos:
connect in a GUI-app environment (minimal PATH, cwd `/`) → empty-DB hint → `add_repo` scan → Korean search with evidence → response size budget →
author filter → diff and `paths`-narrowed diff → overview → notes → error handling → background sync on restart → no stdout pollution.

```bash
npm run e2e                                    # the built dist/cli.js
npm run e2e -- --config "$HOME/Library/Application Support/Claude/claude_desktop_config.json"   # the installed config as-is
npm run e2e -- --json                          # results as JSON
```

- `--config` runs the `command` and `args` from a client config verbatim, so you can verify that what `grimoire install` wrote actually starts.
- DB and HOME are always swapped for temp folders. Your real `~/.grimoire` and repos are never touched.
- Exits with code 1 on failure. If the connection fails it stops there and shows the server's stderr.

### Agent harness (`e2e/agent.ts`)

Gives real Claude (`claude -p`) **only a question** and scores whether it picks the right Grimoire tools and cites the right commit.

| Case | Checks |
|---|---|
| `onboarding` | Starting from an empty DB, registers repos with `add_repo` on its own, then searches and cites the right sha |
| `recall` | States the right sha, the fix (Redis) and the author (a teammate's commit) correctly |
| `no-memory` | Asked about something not in memory, says so instead of inventing a commit |

```bash
npm run e2e:agent                     # all three cases (about $0.2 per run)
npm run e2e:agent -- --repeat 3       # to see variance between runs
npm run e2e:agent -- --case recall --model sonnet
```

- Claude Code must be installed and logged in. macOS keeps the login in Keychain, so a sandboxed shell that can't reach
  Keychain reports "not logged in". Run it from a normal terminal.
- All built-in tools are off (`--tools ""`), so the agent can't read the fixtures with git. Its only evidence is what came through Grimoire.
- The DB is a temp folder and `--strict-mcp-config` ignores your MCP settings. Cost is capped at $0.50 per case.

### Pinpoint benchmark (`e2e/bench.ts`)

Has the same questions answered three ways and measures which one names the exact location (sha or file) faster and cheaper.

| Mode | What the agent may use |
|---|---|
| `grimoire` | Grimoire MCP only (built-in tools off) |
| `history` | git commands only (`log`, `show`, `grep`) |
| `explore` | Read, Grep, Glob only (walks the project files directly) |

```bash
npm run bench -- --questions bench/questions.local.json
npm run bench -- --questions bench/questions.local.json --modes grimoire --only conflict,ratelimit --repeat 2
```

- Question file format: `{ "root": "~/work-dir", "questions": [{ "id", "type", "q", "expect": ["part of the right sha or filename", …] }] }`.
  An answer counts as correct when it contains every string in `expect`.
- Questions are about your own repos, so keep them as `bench/*.local.json`; results go to `bench/results/<timestamp>.json`. Neither is committed to git.
- `grimoire` mode freshly indexes the repos under `root` into a temp DB. Your real `~/.grimoire` is never touched.

### Cutting a release

Versioning and publishing are handled by the [release workflow](.github/workflows/release.yml). **All you do is merge the release PR.**

1. Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix(search): …`, `feat!: …` for breaking changes).
2. On every push to main, [release-please](https://github.com/googleapis/release-please) collects the commits since the last release and keeps a `chore: release vX.Y.Z` PR open and up to date. That PR bumps the `package.json` version and `CHANGELOG.md`.
   - Before 1.0: `feat` → minor, `fix` and `perf` → patch, breaking changes → minor as well. Only `docs`, `chore`, `ci`, `test` or `refactor` commits produce no release.
3. When it's time to ship, merge that PR. It then goes out in this order: tests and e2e → package file (`.tgz`) built once → npm publish → `vX.Y.Z` tag → GitHub release → GitHub Packages.
   - The **same `.tgz`** goes to npm (with provenance), the release's Assets (plus a `.sha256`), and GitHub Packages (`npm.pkg.github.com`).
   - Release notes are filled in automatically: the CHANGELOG section, plus any user-facing commits that landed after the release PR was merged (e.g. a fix needed to ship), plus install instructions.

The update check looks at GitHub releases, and `grimoire update` installs that version from npm or fast-forwards to the tag, so the release is created last, once the tag and npm are ready.
If something fails midway, re-run it from Actions. The tag, the npm version and the GitHub release are each checked separately and only the missing ones are created, always from the tagged commit (or the merge commit before the tag exists), so npm content matches the tag. npm goes before the tag, so a failed publish leaves nothing behind.

**One-time setup**
- On npmjs.com → `@stjoo0925/grimoire` → Settings → Trusted Publisher → GitHub Actions, register `Stjoo0925` / `grimoire` / `release.yml`. Publishing then uses OIDC without a token (works with a 2FA account) and adds provenance.
- On GitHub → Settings → Actions → General → Workflow permissions, turn on **Allow GitHub Actions to create and approve pull requests**. Without it release-please can't open the release PR.
- Add a token for release-please. CI doesn't run on PRs opened with the default Actions token, so under the main protection below the release PR couldn't be merged.
  Create one under GitHub → Settings → Developer settings → Fine-grained tokens, limited to this repo with **Contents, Pull requests and Issues: Read and write**, then store it as a secret: `gh secret set RELEASE_PLEASE_TOKEN`

**main is protected.** Direct pushes are blocked; changes go in through PRs only.
- A PR merges only after the four CI jobs and the PR title check pass. Admins can bypass this from the PR in an emergency.
- Only squash merges are allowed. **The squash commit title is the PR title**, and it becomes a CHANGELOG line, so write PR titles as Conventional Commits like `feat: …` or `fix(search): …` (the [PR title check](.github/workflows/pr-title.yml) enforces this).
- Merged branches are deleted automatically.

The [CI workflow](.github/workflows/ci.yml) runs typecheck, tests, the end-to-end MCP harness and a package-contents check on Ubuntu (node 20, 22, 24) and macOS (node 22) for every push to main and every PR.

- The update check calls the GitHub API without auth, so **the repo must be public** for other users to see new versions.
- If you change the DB schema, only append a step to `MIGRATIONS` in `src/core/db.ts`. Editing an existing step breaks existing users' DBs.

## Layout

```
src/
  cli.ts            CLI entry point
  mcp/              MCP server (stdio), tool definitions, response slimming (format)
  core/             the single core — db · git · indexer · code · search · terms · overview · notes · identity · update
    tech/           manifest parsers and tech name normalization dictionary
  setup/            install · doctor · update commands
e2e/                end-to-end harness · agent harness · bench · shared fixture and claude runner
tests/              unit and integration tests (temp git repos, no network)
```

## License

[MIT](./LICENSE)
