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
- **Before you edit** (Claude Code hooks, opt-in): the notes bound to the file, the *why* bound to its commits, the files and tests that usually change with it, in a few lines, once per file per session — only what history knows and the code doesn't
- **What else should change** (`impact`): give it the changed files (or nothing, for the uncommitted changes) and optionally the task in words; it ranks the files that likely need to change too, with reasons — imports (aliases included), definition→reference links, co-change history, tests, and the notes bound to them. On 864 replayed real changes, a truly co-changed file is in the top 5 for 59% of queries (64% with the task), against 36% for an import graph alone. With Claude Code, the `/grimoire-impact` skill runs it before a commit
- **Notes bound to files**: `record_note` with `paths` keeps a decision, constraint or lesson on the files it concerns; it shows up before those files are edited and is flagged once the file has changed since. Without `paths`, the note binds to the source files changed in the working tree (up to 5; `paths: []` opts out), and the response says so (`autoBound`)
- **The why, bound to the commit**: commit trailers (`Constraint:`, `Rejected:`, `Tested:`, `Why:`…) and, with hooks on, the prompt you gave the agent, the checks it ran and the edits it dropped, all attached to the sha and searchable in your own words
- **Why a rule exists**: the rules stay in your rule files (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/`, `.cursor/rules/`, `.github/copilot-instructions.md`, `.kiro/steering/`…) and Grimoire never writes or copies them. It indexes each rule (a list item or paragraph) with the commit that wrote its current text (`git blame`) and that commit's *why*, so `search_memory` (`kind: rule`) answers "why do we have this rule?". Right before an agent edits a rule file, the hook names where the rules it is changing came from, and notes that mention a rule file are flagged stale once it changes
- No LLM, no embedding model, no GPU: search is keyword-based (SQLite FTS5) and the AI you already use does the reading

See [docs/PLANNING.md](./docs/PLANNING.md) (Korean) for the design and what changed from earlier versions, [docs/improvement-plan.md](./docs/improvement-plan.md) (Korean) for the research-based roadmap, [docs/enhancement-plan.md](./docs/enhancement-plan.md) (Korean) for the core value and the plan to make it useful during agent coding (commit-bound "why", edit-time hooks, co-change, task benchmark), [docs/signal-design.md](./docs/signal-design.md) (Korean) for why grimoire is the memory of the *why*, [docs/impact-research.md](./docs/impact-research.md) (Korean) for the research, measurements and dead ends behind `impact`, and [docs/rules-research.md](./docs/rules-research.md) (Korean) for repo rules.

## Quick start

Requires Node.js 22.13+ and git. SQLite is Node's built-in `node:sqlite`, so there is no native module to build.

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
| Claude Code (all projects) | `grimoire install claude-code` | runs `claude mcp add --scope user`, plus read-only tool permissions in `~/.claude/settings.json` |
| Claude Code (this repo only) | `grimoire install claude-code --project .` | `./.mcp.json` |
| Claude Desktop | `grimoire install claude-desktop` | `claude_desktop_config.json` |
| Cursor | `grimoire install cursor` (`--project .` for this repo only) | `~/.cursor/mcp.json` |
| Codex | `grimoire install codex` | `~/.codex/config.toml` (`$CODEX_HOME` if set) |

- The config contains the **absolute path of the node currently running**. GUI apps like Claude Desktop and Cursor
  don't see your shell's PATH, so `"command": "node"` fails with `spawn node ENOENT`. If you switch
  node versions, run `install` again so the config points at the node you use now.
- If `GRIMOIRE_HOME`, `GRIMOIRE_ME`, `GRIMOIRE_AUTO_ADD`, `GRIMOIRE_SYNC_ON_START`, `GRIMOIRE_UPDATE_CHECK`, `GRIMOIRE_CAPTURE` or `GRIMOIRE_COCHANGE_MAX_FILES` are set, they are written too,
  so the CLI and MCP server see the same DB.
- Other server entries are left alone; only the `grimoire` entry is added. The existing file is backed up as `.bak`,
  and if its JSON is broken Grimoire stops without touching it. Add `--dry-run` to preview what would be written.
- For Codex, only the `[mcp_servers.grimoire]` tables in `config.toml` are replaced; every other line, comment and line ending stays as it was.
  The read-only tools get `approval_mode = "approve"`. If the `codex` command is installed, Grimoire asks Codex to read the new config back,
  and if Codex rejects it (an older Codex that doesn't know a key), the file is restored. The Claude Code hooks don't apply to Codex.
- For Claude Code (all projects), the read-only tools (`search_memory`, `show_commit`, `get_repo_overview`, `list_repos`)
  are added to `permissions.allow` in `~/.claude/settings.json` (under `CLAUDE_CONFIG_DIR` if set), so searches don't ask for approval.
  Tools that write (`add_repo`, `record_note`) are left out. Existing rules and keys stay as they are, and the file is backed up as `.bak` the same way.
- Claude Desktop keeps its config in a different place depending on OS, install type and version. Grimoire picks the folder the app is actually using:
  - `CLAUDE_USER_DATA_DIR`, if set (any OS)
  - macOS: `~/Library/Application Support/Claude/`
  - Windows, in this order, taking the first that is in use: `%LOCALAPPDATA%\Claude-Data\<package>\` (Store/MSIX 3.1623+),
    `%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\Claude\` (older MSIX), `%APPDATA%\Claude\` (standard installer)
  - Linux: `~/.config/Claude/`

  `grimoire doctor` warns when Grimoire is only in an old file the app no longer reads.
- Restart the client after installing (fully quit Claude Desktop with ⌘Q).

### When it won't connect — `grimoire doctor`

Checks the Grimoire version (whether a new release is out), the node version and built-in SQLite (FTS5), git, the DB and registered repos, your email, and the config
each client has (whether the node path exists, matches the current node, and points at the same DB), and tells you the command to fix it.
With hooks installed it also checks that they point at this install and see the same data folder, counts hook errors from the last 7 days in `hook.log`,
and flags repos whose co-change history still needs a rebuild after an upgrade (`grimoire sync`) or worktrees an older version registered separately.

### The project you're working in is registered automatically

Claude Code and Cursor start the MCP server in the open project folder. If that folder is in a git repo that isn't
registered yet, Grimoire **registers it on startup and syncs it before any other repo**. Your first search waits
(up to 15 seconds) for that first index, so you never need `add_repo` for the project you have open.

- Results from the current repo are **ranked first** (other repos still show up), and responses include `current: "<repo>"`.
- Set `GRIMOIRE_AUTO_ADD=0` to turn this off. Then, if the current repo isn't registered, the `hint` says so instead of staying silent.
- Skipped when the repo root is your home directory or `/` (dotfile repos and the like).
- When the server isn't started in a repo (a global config launched from `/` or your home folder), Grimoire asks the client for its workspace folders (MCP roots) and uses the first one that is a git repo. Clients that don't support roots, like Claude Desktop, need repos registered as described below.

### Registering repos mid-conversation

With no repos yet, results carry a `hint`, so the AI suggests registering first.
The `add_repo` tool registers right from the conversation ("remember every repo under ~/work-dir" → `scan: true`).
Indexing a whole folder can take a while, so clients that ask for progress get an update per repo.

### Tools

| Tool | What it does |
|---|---|
| `search_memory` | Searches current code files, commits and notes at once. Filters: `repo`, `author` (`me`), `since`, `until`, `kind` (`file`, `commit`, `note`, `rule`), `limit` (default 8). A `rule` hit gives the rule's `file:line`, its text, the commit that wrote it (`added`, with its `why` when captured) and the last commit that changed it (`changed`) if different. `detail`: `index` (default, a compact list), `summary` (on request: the top 3 commits also carry their full message and the functions they changed), `full` (also the top commit's diff) |
| `show_commit` | Message, changed files and diff of a commit (read straight from the local repo). The diff defaults to 120 lines; `paths` narrows it to specific files. `shas` (up to 5) returns several commits in one call, 40 diff lines each by default. Carries `why` (prompts, checks, dropped edits, trailers) when the commit has any |
| `file_context` | What to know before editing a file: the `notes` bound to it (with `stale` when the file changed after the note), its recent commits, the `why` bound to them, files and tests that usually change with it (co-change mined from history, plus name-matched tests), who imports it, and whether it has had many fixes lately. Candidates to check, not instructions. Returns only `recent` and `worth: false` when there is nothing more to say |
| `impact` | Before a review or commit: files a change likely affects, ranked, each with its reasons — import neighbors (relative paths and aliases like `@/x`, two hops), definition→reference links (a file uses a symbol another defines — works for C# and other import-less languages), files that usually change with it (co-change history), name-matched tests, same folder and same-named files in sibling folders — plus notes bound to them. `paths` defaults to the uncommitted changes. Pass `intent` (the task, in words) to also pull in files that past commits on the same subject touched — changes that cut across layers are found this way, not by structure. Replaying 864 real changes across 6 repos (time-split), a file that truly changed alongside lands in the top 5 for 59% of queries (64% with intent), against 36% for an import graph alone (`npm run impactbench`, `docs/impact-research.md`). Also `grimoire impact [file...] [--intent "…"]` |
| `get_repo_overview` | Tech stack (from manifests), quarterly activity, most-touched directories, top authors, recent notable commits |
| `list_repos` | Indexed repos |
| `add_repo` | Register + index a repo (or, with `scan: true`, every repo under a folder). Scanning `/`, a folder right under it, your home or anything above it, or a folder with more than 50 repos goes through `grimoire scan` in the terminal |
| `record_note` | Save a decision, constraint or lesson as a note → searchable afterwards. `paths` binds it to the files it concerns (repo-relative or absolute; paths written in the text are picked up too): the note is shown before those files are edited, and marked stale once they change |

Responses are minimal to save tokens: 10-char shas, dates to the day, `me` for your own commits, and the commit link prefix per repo (`links`) sent only once.
Fields the answer doesn't need (local paths, scores, emails) are dropped. Tool descriptions are short English and only say *when* to use each tool, since tool definitions ride along with every request in every session where the server is on. Read-only tools carry `readOnlyHint`, and `add_repo` carries `idempotentHint`, so clients can tell which calls are safe.
What piles up in the conversation context is the cost. The "response size budget" step in `npm run e2e` (260 chars per search hit, 2600 chars of tool definitions, 500 chars of description text) keeps the format from growing back.
The CLI shows the full, unslimmed results.

### Before you edit — Claude Code hooks (opt-in)

The agent never asks what it doesn't know it's missing. With hooks installed, Grimoire tells it at the only moment that matters — right before it edits a file:

```bash
grimoire install claude-code --hooks          # writes hooks into ~/.claude/settings.json (other hooks are kept, .bak backup)
grimoire install claude-code --remove-hooks   # takes them out again
grimoire context src/core/search.ts           # the same card in the terminal
```

What the `PreToolUse` hook injects (one fact per line, 400 chars at most):

```
Grimoire: src/core/search.ts
Notes: #25 "decision: keep rerank synchronous" (2026-10-27) · #12 "constraint: FTS5 only, no embeddings" (2026-10-20, file changed since)
Why (a1b2c3d4e5): "search got slow, get p95 under 20ms" · verified: npm run eval
Co-changes: src/core/db.ts (4/5, strong, imports) · src/mcp/tools.ts (3/5)
Tests: tests/search.test.ts
```

- Only for files in a registered repo, only source files, **once per file per session** (again after HEAD changes). The hook says only what history knows and the code doesn't: notes bound to the file, the why bound to its commits, co-changes and tests. Recent commits, importers and fix counts are left to `file_context` and `grimoire context` — reading the file and `git log` tells the agent that much already. If there is nothing of the first kind, it says nothing at all. (A benchmark of the earlier "file card" that included those lines showed no measurable gain — see `docs/signal-design.md`.)
- `Co-changes` are mined from history as association rules over commits (merge and >10-file commits excluded, confidence ≥ 0.5 as a filter, most recent first, incremental on every sync). Set `GRIMOIRE_COCHANGE_MAX_FILES=20` (then `grimoire sync`) for repos whose commits routinely touch more than 10 files. `Tests` are name-matched pairs first (`foo.ts` ↔ `foo.test.ts`, `test_foo.py`, `foo_test.go`), then tests that change together with the file. `Fixes(90d)` appears only when 2+ fix commits make up 30%+ of the file's recent commits, with the shas.
- `SessionStart` (startup, clear, compact) adds one line saying the memory is there (`search_memory` for "where/how/why did I…", `record_note` with paths for decisions) plus files edited but never committed in earlier sessions. Set `GRIMOIRE_START_SUMMARY=1` to also get your last 3 commits here with their *why* (off by default: `git log` tells the agent that, and it cost context every session).
- Edits, checks and commits made by **subagents** are recorded too and bound to the session's commits; only prompts are taken from the main agent (a subagent's words are not the user's).
- The **first failing check** in a session (a failing `npm test`, `pytest`, …) triggers one more hook message: what past commits on the files you're editing recorded — their why, what verified them, what was edited then dropped, `Rejected:`/`Constraint:` trailers. Once per session; sessions that never get stuck pay nothing.
- **Right before `git commit`** (`PreToolUse` on Bash): files that have almost always changed together with one of the files being committed (co-change confidence ≥ 90% over 5+ commits) but are untouched in the working tree — three at most, once per set of files. It is deliberately quiet: replaying history, it fired on 2.5% of complete commits, and when it fired, 58% of the time it named the file that had been left out. (A looser rule based on the impact score fired on half of all complete commits.) The agent knows the task and decides. Hooks installed by an older version are brought up to date by themselves (see below).
- **Right before a rule file is edited** (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/…` and the other rule files): for each rule the edit changes or removes, the commit that wrote it and its *why*, one line each, three at most — plus the notes bound to that file. It does not repeat the rule text (your client already loads it), and it stays silent for edits that touch no rule or rules whose commit subject carries no reason (`Update CLAUDE.md`, merges, formatting, releases). Each rule once per session.
- **Updates bring the integration along.** `grimoire update` runs the old version's code, so it cannot rewrite your hooks. Instead, the new version's `SessionStart` hook notices settings from an older version and, in the background, rewrites them for this version (same `hook.js`, same `--env` values, other hooks and settings untouched) and installs the `/grimoire-impact` skill — effective from the next session. It only does this when the hook that runs is the one registered in `settings.json`, never adds a skill you removed with `--remove-skills`, and `GRIMOIRE_AUTO_SETUP=0` turns it off.
- The hook is a separate light entry point (`dist/hook.js`), always exits 0, logs errors to `~/.grimoire/hook.log` (capped at 512KB), and never syncs inline — at session start it may spawn a background `grimoire sync` it doesn't wait for (see below). It waits at most 1.5s for the DB write lock, so it can't hit Claude Code's hook timeout. `GRIMOIRE_HOOKS=0` turns injection off; `grimoire doctor` checks the hook entry.
- **Git worktrees** (Claude Code opens each session in `.claude/worktrees/<session>`) share the main repo's memory: a worktree is registered as its main repo, never as a repo of its own, and files in a worktree outside the repo folder are resolved to the same paths (by reading its `.git` file — no git process per edit). Files opened through a symlink or junction (e.g. `~/code` → another disk) resolve to the registered repo too. A commit made in a worktree is bound to that worktree's HEAD. `grimoire doctor` flags worktrees that an older version registered separately.
- **The same change counted once**: a PR squash-merged into main leaves the same change twice (the branch commit and the `(#N)` commit). Co-change, fix counts and recent commits fold them by subject and file set, and the *why* recorded on the branch commit is found from the squash commit too.

### Before you commit — Claude Code skill (opt-in)

Agents call Grimoire reliably when told *when* to, and almost never on their own for impact checks. The skill is that explicit entry point: it tells Claude to run the `impact` tool once the change is ready (before a commit, a diff review or a PR, or when you ask "did I miss anything"), open only the plausible top candidates, and say which files it checked and why it left the others alone. Candidates are never edit instructions.

```bash
grimoire install claude-code --skills          # writes ~/.claude/skills/grimoire-impact/SKILL.md (nothing else in ~/.claude is touched)
grimoire install claude-code --remove-skills   # deletes only that folder
```

Claude picks it by its description, or you call it as `/grimoire-impact`. `grimoire doctor` reports whether it is installed and warns when its content differs from what this version would write (after an update the hook refreshes it; see below).

**Codex and Cursor** get the same skill in `~/.agents/skills`, the user skill folder both read. Their copy names the tool by server (`impact` on the `grimoire` MCP server) and falls back to `grimoire impact --intent "…"` in a shell when the MCP server isn't connected:

```bash
grimoire install codex --skills                # writes ~/.agents/skills/grimoire-impact/SKILL.md
grimoire install codex --remove-skills         # deletes only that folder
```

`install cursor --skills` writes the same file, unless the Claude Code skill is already there (Cursor reads `~/.claude/skills` too, so a second copy would only duplicate it). In Codex you can also call it as `$grimoire-impact`. They have no session hook, so after an update the new version's MCP server refreshes an installed copy when it starts its background work (`GRIMOIRE_AUTO_SETUP=0` turns this off); it never installs one you didn't ask for.

### The why, bound to the commit

A commit records *what* changed. The reason — what you asked for, what you tried and threw away, how you checked it — disappears when the chat window closes. Grimoire attaches it to the sha two ways, so that later you find the commit with the words you used at the time (search results carry a one-line `why`, `show_commit` the full record):

1. **Commit trailers, no hooks needed.** The last paragraph of a commit message in `Key: value` form is parsed the way `git interpret-trailers` does: Lore (`Constraint`, `Rejected: alternative | reason`, `Directive`, `Tested`, `Not-tested`, …), QAC (`Agent`, `Mode`, `What`, `Why`) and platform trailers (`Claude-Session`, `Agent-Logs-Url`, `Co-Authored-By`, …). Values are free text; unknown keys are kept. `Co-Authored-By: Claude…`, `Claude-Session`, `Agent-Logs-Url` or `Agent:` mark the commit as agent-made. Older databases are back-filled once per repo on the next sync.
2. **Session capture, with hooks on.** `UserPromptSubmit` stores your prompt (not slash commands, not subagents' prompts); `PostToolUse` stores test/lint/typecheck commands with their outcome and the line hashes of each edit. When a `git commit` succeeds, everything since the previous commit is bound to the new sha: prompts (up to 10, 1,000 chars each), checks (up to 20), and *dropped* files — edited in the session but with none of those lines in the commit. The commit is indexed immediately; no need to wait for the next sync.

Privacy: capture is on only when you installed the hooks (`GRIMOIRE_CAPTURE=0` turns it off while keeping injection). Before anything is stored, `<private>…</private>` blocks, pasted content, API tokens/keys/JWTs, `password=…`-style values (including prefixed names like `OPENAI_API_KEY=…`) and passwords in connection strings are replaced with `[redacted]` — the same rule applies to notes, and records stored by older versions are cleaned once on upgrade. Tool output is never stored except the last 300 chars of a failing check. Records that never get bound to a commit are deleted after 14 days. Everything stays in your local SQLite file — nothing is written into git.

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
With `detail: "summary"`, search results show them as `changed` ("webhook.ts: dedupeWebhookEvent"). The default stays the compact list: in the offline eval, summary made responses 66% larger without significantly raising how often one search was enough to answer (docs/improvement-plan.md §7).
The names are also searchable, but only to fill in when titles, bodies and paths give too few results (for example a function that no longer exists anywhere). Mixing them into the main ranking made search 2–3× slower without a significant accuracy gain in the offline eval (see docs/improvement-plan.md §7).

The server syncs registered repos in the background right after it starts, then fills in the diff pass. The repo you're working in is re-synced before a search when 15 seconds have passed, so a commit you just made is searchable. With hooks installed, the SessionStart hook also starts a background `grimoire sync` for the session's repo when it was last synced more than 10 minutes ago (or its co-change history is empty after an upgrade) — the hook itself doesn't wait. Set `GRIMOIRE_SYNC_ON_START=0` to turn off both.

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
grimoire context src/core/search.ts            # before editing: recent commits, why, co-changed files/tests, importers
grimoire impact                                 # what else the uncommitted changes likely touch (or: grimoire impact <file...>); registers and syncs the repo it runs in, like the MCP server
grimoire impact src/api.ts --intent "add a column to the export"   # also pull in files past commits on the same task touched
grimoire note "Decision: JWT over sessions — because of mobile" --repo shop-api --tag decision
grimoire remove shop-api                       # delete a repo and its index
grimoire update                                # move to the latest release (see Updating)
grimoire install claude-code --hooks           # context before edits + session capture (see above)
grimoire install claude-code --skills          # /grimoire-impact: check impact before a commit, review or PR (see above)
grimoire install codex --skills                # the same skill for Codex and Cursor (~/.agents/skills)
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

- Installed from npm: runs `npm install -g --prefer-online @stjoo0925/grimoire@<new version>` (`--prefer-online` so a release that just came out isn't missed by a stale local npm cache).
- Installed from a clone: fast-forwards to the release tag, then runs `npm install` and `npm run build`. If there are uncommitted changes or it can't fast-forward, nothing is changed and the update stops.

Restart your MCP client afterwards. The install is replaced in place, so the MCP config doesn't need to be rewritten.

The Claude Code integration follows by itself: the update runs the old version's code, so the first Claude Code session after it lets the new hook bring your hook settings up to this version and install the `/grimoire-impact` skill in the background (same `hook.js`, same `--env` values, other settings untouched; effective from the next session). A skill you removed with `--remove-skills` stays removed, and `GRIMOIRE_AUTO_SETUP=0` turns this off. `grimoire setup-refresh` does the same by hand.

New versions are checked once a day (recorded in `~/.grimoire/update.json`) and announced like this:

- **MCP**: once per session, in the `hint` of a `search_memory` or `list_repos` response, so the AI tells you
- **CLI**: one line on stderr after a command finishes (`--json` output is untouched)
- **`grimoire doctor`**: current and latest version

Set `GRIMOIRE_UPDATE_CHECK=0` to turn it off (run `grimoire install` again afterwards to put it in the MCP config too).

## Privacy

- The only request Grimoire makes to the outside is the daily update check (asking the GitHub API for the latest release version). No repos, commits or queries are sent, and `GRIMOIRE_UPDATE_CHECK=0` turns it off.
- **When connected to an external LLM client over MCP, query results (commit messages, file paths, diffs) are passed to that LLM.**
  Don't register sensitive repos, or take them out with `grimoire remove <repo>`.
- The DB is created readable only by you (`chmod 600`) on macOS/Linux. On Windows chmod has no effect and the DB relies on the NTFS permissions of your user profile (`%USERPROFILE%\.grimoire`), so don't point `GRIMOIRE_HOME` at a shared folder.

### Security scanner alerts

Scanners such as Socket flag the published package with a few supply-chain alerts. None of them is a vulnerability, and here is where each comes from:

- **Network access** — the MCP SDK (`@modelcontextprotocol/server`) bundles HTTP transport and OAuth helpers that call `fetch`. Grimoire only uses the stdio transport, so that code never runs.
- **URL strings** — the MCP SDK carries JSON Schema meta-schema IDs (`json-schema.org/...`) as plain identifiers, never fetched. The other hit is Grimoire's own update check against `api.github.com`, described above.
- **AI-detected code anomaly** — `zod` (a dependency of the MCP SDK) builds its object parsers with `new Function` for speed. The generated code comes from schemas defined in source, not from user input.

There is no install script (`postinstall`), and nothing else leaves your machine.

## Development

```bash
npm run typecheck
npm test            # indexing, search and MCP tools against temp git repos (no network)
npm run e2e         # end-to-end MCP harness (below)
npm run e2e:agent   # agent harness (below, calls real Claude)
npm run bench       # pinpoint benchmark (below, calls real Claude)
npm run perf        # speed A/B of two builds on your indexed repos (docs/perf-loop.md, no model calls)
npm run upgrade-check -- --from <old dist>   # build a DB with the last release, open it with this source: migrations, co-change rebuild, redaction (temp folder only)
npm run taskbench   # task benchmark: with vs without Grimoire on real fix tasks (below, calls real Claude)
npm run eval -- --cochange   # offline: does co-change predict the files that change together? (time split)
npm run impactbench -- --repo <path> --ratio 0.7   # offline: does impact rank the files that changed together? (time split, no model calls)
npm run usage -- --since 2026-10-20                # read-only: grimoire tool/skill use in your Claude Code sessions and the 48-hour re-touch rate
```

### End-to-end MCP harness (`e2e/harness.ts`)

Starts the server **as a separate process over stdio**, like a real client, and runs a 20-step scenario against fixed fixture repos:
connect in a GUI-app environment (minimal PATH, cwd `/`) → empty-DB hint → `add_repo` scan → Korean search with evidence → response size budget →
author filter → diff and `paths`-narrowed diff → overview → notes → error handling → background sync on restart → workspace auto-registration →
the `PreToolUse` hook (silent when there is nothing to say, co-changes after three coupled commits, once per session, broken stdin, latency) →
session capture bound to a commit and found again by the prompt's words → no stdout pollution.

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
| `cochange` | Built-in tools on, inside a repo where `refresh.ts` and `session.ts` always change together: asked to change only `refresh.ts`, does it mention or check `session.ts`? Run with `--no-hooks` for the control group |

```bash
npm run e2e:agent                     # all cases (subscription usage; ~$0.2 API-equivalent per run)
npm run e2e:agent -- --repeat 3       # to see variance between runs
npm run e2e:agent -- --case recall --model sonnet
```

- Claude Code must be installed and logged in. macOS keeps the login in Keychain, so a sandboxed shell that can't reach
  Keychain reports "not logged in". Run it from a normal terminal.
- All built-in tools are off (`--tools ""`), so the agent can't read the fixtures with git. Its only evidence is what came through Grimoire.
- The DB is a temp folder and `--strict-mcp-config` ignores your MCP settings. Runs on your subscription login by default (no extra charge, uses plan limits); `--bare` switches to an API key and per-token billing. The `--max-budget-usd` cap is $0.50 per case.

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

### Task benchmark (`e2e/taskbench.ts`)

The pinpoint benchmark asks "can it name the sha". This one asks what the plan is actually about: **does an agent fix a real bug cheaper, with fewer regressions, when Grimoire is there?** (docs/enhancement-plan.md §3-4)

```bash
npm run taskbench -- --mine --repo ~/work/foo --test "npm test" --limit 40     # mine fail-to-pass fix commits → bench/tasks.local.json
npm run taskbench -- --run --tasks bench/tasks.local.json --seeds 3             # bare vs grimoire, paired
```

- **Mining** keeps a fix commit only if the test patch alone fails on the parent (3 runs) and the whole commit passes (3 runs) — flaky tests are dropped. Filters: non-merge, 1–15 files, ≥1 test file and ≥1 source file, ≤100 non-test lines, no dependency-file changes. Expect roughly 5–10% of test-touching commits to qualify. Then edit each task's `prompt` into a symptom description (the default is the commit subject, which may leak the fix).
- **Running** gives `claude -p` the prompt in a fresh worktree at the parent commit. By default it runs on your Claude subscription login (Pro/Max): no extra charge, but it uses your plan's usage limits, and the `$` in the results is only the API-equivalent estimate. Your own `~/.claude` settings apply equally to both modes; a globally installed Grimoire hook is switched off with `GRIMOIRE_HOOKS=0` so it can't leak into the control group or capture benchmark prompts into your real database. `--bare` gives a cleaner comparison with all user settings off, but per the docs it needs `ANTHROPIC_API_KEY` and is billed per token. In `grimoire` mode the temp index sees only commits up to the parent (time masking) and the edit-time hook is passed via `--settings`. Scoring applies the real test patch (`pass`), then the parent's tests (`p2p_broken`), and compares edited files with the real fix (`stray`, `missed`), plus billed cost from `total_cost_usd`/`modelUsage`, turns, reverted edits and churn ratio.
- Each run also records **whether Grimoire actually reached the agent**: how many times the hook injected context (per event, with chars and files, via `GRIMOIRE_HOOK_TRACE`) and how many Grimoire MCP tools it called. In `grimoire` mode the hooks are the same set `grimoire install claude-code --hooks` writes, with capture on in the temp database only. The summary splits paired runs into those Grimoire touched and those it didn't — a cost gap on untouched pairs is run-to-run noise, not Grimoire — and warns if a hook injected anything into the control group.
- **Prompt cache**: the shared prompt prefix (tools and system prompt) differs per mode and is cached across runs, so without care the first run of a mode alone pays to write it — about twice the cost of the other runs in the pilot, which flipped the cost ratio depending on run order. Before measuring, `--warmup N` (default 1, `0` to skip) sends each mode a short unscored prompt with the same tools, MCP and hooks. Each run also records its estimated cache-write share (`cacheWriteUsd`, split per model by price ratio: write 1.25 / read 0.1 / output 5 × input), and the summary reports `costNoWrite` and the paired `costRatioNoWriteOk` next to the billed figures.
- The summary pairs runs per task and seed; cost and turns are compared on pairs both modes solved (`_ok`), with a Wilcoxon signed-rank p. The acceptance criteria are fixed before looking (§3-4): pass rate not lower, no more regressions, and billed cost or turns down 15%+ or `missed`/`p2p_broken` significantly down. Size: a pilot of 10 tasks × 1 seed is 20 runs; the full 40 × 3 × 2 is 240 runs and will eat a large share of a subscription's usage limits.

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

The [CI workflow](.github/workflows/ci.yml) runs typecheck, tests, the end-to-end MCP harness and a package-contents check on Ubuntu (node 22, 24) and macOS (node 22) for every push to main and every PR.

- The update check calls the GitHub API without auth, so **the repo must be public** for other users to see new versions.
- If you change the DB schema, only append a step to `MIGRATIONS` in `src/core/db.ts`. Editing an existing step breaks existing users' DBs.

## Layout

```
src/
  cli.ts            CLI entry point
  mcp/              MCP server (stdio), tool definitions, response slimming (format)
  core/             the single core — db · git · indexer · code · search · terms · overview · notes · identity · update ·
                    context (file context, co-change) · impact (what else changes) · capture (session → commit) · note-autobind
    tech/           manifest parsers and tech name normalization dictionary
  setup/            install · doctor · update · hooks · hook-config (light, used by the hook) · skills · refresh (after-update setup)
e2e/                end-to-end harness · agent harness · bench · shared fixture and claude runner
tests/              unit and integration tests (temp git repos, no network)
```

## License

[MIT](./LICENSE)
