# Grimoire

**English** | [한국어](./README.ko.md)

> A local dev memory that answers "How did I solve this before?" and "Where is that code?" **with evidence**.

Grimoire indexes the git repos on your machine so that AI tools like Claude Code, Cursor and Claude Desktop can
**search your past commits, changed files, diffs and notes, plus your current code (files and symbol:line), in one shot over MCP**.
The goal is to let the AI point at the right file and commit with a single search instead of opening files one by one or digging through `git log`.

- Works with any repo cloned locally, including org repos. No GitHub token, no rate limits
- **Evidence** for every result: repo · sha · date · author · changed files · commit link for commits; file path · symbol:line · last commit that touched it for code
- **Incremental sync**: only new commits and changed files are read. Syncs in the background when the MCP server starts
- Korean queries reach English identifiers: common dev terms are expanded to English ("충돌" → `conflict`, "횟수 제한" → `rate limit`)
- Responses are kept minimal, because whatever lands in the conversation context is what you pay for
- No external API calls. Semantic search is optional and uses local Ollama only

See [PLANNING.md](./PLANNING.md) (Korean) for the design and what changed from earlier versions.

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
- If `GRIMOIRE_HOME`, `GRIMOIRE_ME`, `OLLAMA_HOST`, `OLLAMA_EMBED_MODEL` or `GRIMOIRE_UPDATE_CHECK` are set, they are written too,
  so the CLI and MCP server see the same DB.
- Other server entries are left alone; only the `grimoire` entry is added. The existing file is backed up as `.bak`,
  and if its JSON is broken Grimoire stops without touching it. Add `--dry-run` to preview what would be written.
- Restart the client after installing (fully quit Claude Desktop with ⌘Q).

### When it won't connect — `grimoire doctor`

Checks the Grimoire version (whether a new release is out), the node version and SQLite module, git, the DB and registered repos, your email, Ollama, and the config
each client has (whether the node path exists, matches the current node, and points at the same DB), and tells you the command to fix it.

### Registering repos mid-conversation

With no repos yet, results carry a `hint`, so the AI suggests registering first.
The `add_repo` tool registers right from the conversation ("remember every repo under ~/work-dir" → `scan: true`).
In Claude Code, if the open project folder is a git repo, that path is suggested.

### Tools

| Tool | What it does |
|---|---|
| `search_memory` | Searches current code files, commits and notes at once. Filters: `repo`, `author` (`me`), `since`, `until`, `kind` (`file`, `commit`, `note`), `limit` (default 8) |
| `show_commit` | Message, changed files and diff of one commit (read straight from the local repo). The diff defaults to 120 lines; `paths` narrows it to specific files |
| `get_repo_overview` | Tech stack (from manifests), quarterly activity, most-touched directories, top authors, recent notable commits |
| `list_repos` | Indexed repos |
| `add_repo` | Register + index a repo (or, with `scan: true`, every repo under a folder) |
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

The server syncs registered repos in the background right after it starts. Set `GRIMOIRE_SYNC_ON_START=0` to turn this off.

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

## Semantic search (optional)

To find wording that isn't in the keywords ("race condition" → a "동시성 락" commit), turn on local embeddings.

```bash
ollama pull nomic-embed-text
grimoire embed          # embed meaningful commits and notes (resumes if interrupted)
```

Even without embeddings, Korean queries get English words added from a dictionary of common dev terms (`src/core/terms.ts`).
With embeddings on, search fuses keyword (FTS5 bm25) and cosine rankings with RRF. If the model can't be reached it quietly
falls back to keywords. Run `grimoire embed` again after new commits come in.
Change the address and model with `OLLAMA_HOST` and `OLLAMA_EMBED_MODEL`.

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

The update check looks at the latest GitHub release, and `grimoire update` either installs that version from npm (npm installs) or fast-forwards to that tag (clones).
So **publish to npm and cut the GitHub release with the same version**, and tag a commit on `main`. Publish to npm first, then create the release, so nobody is told about a version they can't install yet.

```bash
npm version minor                           # bump package.json + commit + v0.3.0 tag (the MCP server version is read from it)
git push origin main --follow-tags
npm publish                                 # prepublishOnly rebuilds dist from scratch and runs the tests
gh release create v0.3.0 --generate-notes   # note anything users need to do
```

- The update check calls the GitHub API without auth, so **the repo must be public** for other users to see new versions.
- If you change the DB schema, only append a step to `MIGRATIONS` in `src/core/db.ts`. Editing an existing step breaks existing users' DBs.

## Layout

```
src/
  cli.ts            CLI entry point
  mcp/              MCP server (stdio), tool definitions, response slimming (format)
  core/             the single core — db · git · indexer · code · search · terms · embed · overview · notes · identity · update
    tech/           manifest parsers and tech name normalization dictionary
  setup/            install · doctor · update commands
e2e/                end-to-end harness · agent harness · bench · shared fixture and claude runner
tests/              unit and integration tests (temp git repos, no network)
```

## License

[MIT](./LICENSE)
