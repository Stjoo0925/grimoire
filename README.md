# Grimoire

> "내가 예전에 이걸 어떻게 풀었더라?"에 **근거 링크와 함께** 답하는 로컬 개발 메모리.

Grimoire는 내 컴퓨터의 git 레포를 인덱싱해, Claude Code·Cursor·Claude Desktop 같은 AI 도구가
**MCP로 내 과거 커밋·변경 파일·diff·노트를 검색**하게 해 줍니다.

- 조직 레포 포함, 로컬에 clone된 레포라면 무엇이든. GitHub 토큰·rate limit 없음
- 결과마다 **근거**: 레포 · sha · 날짜 · 작성자 · 변경 파일 · 커밋 웹 링크
- **증분 동기화**: 새 커밋만 읽음. MCP 서버가 뜰 때 백그라운드로 자동 동기화
- 외부 API 호출 없음. 시맨틱 검색은 선택이며 로컬 Ollama만 사용

설계와 이전 버전에서 바뀐 점은 [PLANNING.md](./PLANNING.md)를 보세요.

## 빠른 시작

Node.js 20 이상과 git이 필요합니다.

```bash
npm install && npm run build
node dist/cli.js scan ~/work-dir              # 하위 git 레포를 찾아 모두 등록 + 인덱싱
node dist/cli.js install claude-code          # MCP 클라이언트에 연결 (아래 표 참고)
node dist/cli.js doctor                       # 연결 상태 점검
```

`npm link`를 하면 이후로는 `node dist/cli.js` 대신 `grimoire`로 부를 수 있습니다.

## MCP 연결

`grimoire install <client>`가 클라이언트 설정을 대신 써 줍니다.

| 클라이언트 | 명령 | 쓰는 곳 |
|---|---|---|
| Claude Code (모든 프로젝트) | `grimoire install claude-code` | `claude mcp add --scope user` 실행 |
| Claude Code (이 레포만) | `grimoire install claude-code --project .` | `./.mcp.json` |
| Claude Desktop | `grimoire install claude-desktop` | `claude_desktop_config.json` |
| Cursor | `grimoire install cursor` (`--project .`이면 이 레포만) | `~/.cursor/mcp.json` |

- 설정에는 **지금 실행 중인 node의 절대경로**가 들어갑니다. Claude Desktop·Cursor 같은 GUI 앱은 셸의 PATH를
  모르기 때문에 `"command": "node"`로 적으면 `spawn node ENOENT`로 연결이 안 됩니다. 또 SQLite 모듈은
  빌드할 때 쓴 node로만 열립니다. 그래서 node 버전을 바꿨다면 `install`을 다시 하세요.
- `GRIMOIRE_HOME`·`GRIMOIRE_ME`·`OLLAMA_HOST`·`OLLAMA_EMBED_MODEL`을 설정해 둔 상태라면 그 값도 같이 적혀,
  CLI와 MCP가 같은 DB를 보게 됩니다.
- 다른 서버 항목은 그대로 두고 `grimoire` 항목만 넣습니다. 기존 파일은 `.bak`으로 백업하고, JSON이 깨져 있으면
  건드리지 않고 멈춥니다. 무엇을 쓸지 먼저 보려면 `--dry-run`을 붙이세요.
- 설치한 뒤에는 클라이언트를 다시 시작하세요(Claude Desktop은 ⌘Q로 완전히 종료).

### 연결이 안 될 때 — `grimoire doctor`

node 버전과 SQLite 모듈, git, DB와 등록된 레포, 내 이메일, Ollama, 각 클라이언트에 적힌 설정(node 경로가
실제로 있는지, 지금 node와 같은지, 같은 DB를 보는지)을 점검하고 고치는 명령을 알려 줍니다.

### 레포 등록은 대화 중에도

아직 레포가 없으면 검색 결과에 안내(`hint`)가 실려, AI가 등록부터 하자고 말합니다.
`add_repo` 도구로 대화 중에 바로 등록할 수 있습니다("~/work-dir 아래 레포 전부 기억해 줘" → `scan: true`).
Claude Code에서는 지금 연 프로젝트 폴더가 git 레포이면 그 경로를 제안합니다.

### 도구

| 도구 | 하는 일 |
|---|---|
| `search_memory` | 커밋·노트 검색. `repo`·`author`(`me`)·`since`·`until`·`kind`·`limit` 필터 |
| `show_commit` | 커밋 하나의 전체 메시지·변경 파일·diff (로컬 레포에서 직접 읽음) |
| `get_repo_overview` | 기술 스택(매니페스트 기준)·분기별 활동·많이 건드린 디렉터리·주요 작성자·최근 주요 커밋 |
| `list_repos` | 인덱싱된 레포 목록 |
| `add_repo` | 레포(또는 `scan: true`로 폴더 아래 레포 전부) 등록 + 인덱싱 |
| `record_note` | 대화 중 배운 것·결정을 노트로 저장 → 이후 검색 대상 |

서버는 기동 직후 등록된 레포를 백그라운드로 동기화합니다. 끄려면 `GRIMOIRE_SYNC_ON_START=0`을 주세요.

## CLI

```bash
grimoire scan ~/work-dir          # 하위 git 레포를 찾아 모두 등록 + 인덱싱
grimoire add ~/code/some-repo     # 레포 하나 등록
grimoire sync                     # 새 커밋만 반영
grimoire repos                    # 레포 목록과 커밋 수

grimoire search "jwt refresh"                  # 검색
grimoire search "동시성 락" --author me --since 2024-01-01
grimoire show 2518bf75                         # 커밋 메시지 + 파일 + diff
grimoire overview please_readme                # 기술 스택·활동·많이 건드린 곳·최근 주요 커밋
grimoire note "결정: 세션 대신 JWT — 모바일 때문" --repo shop-api --tag decision
grimoire remove shop-api                       # 레포와 색인 삭제
```

데이터는 `~/.grimoire/grimoire.db`(SQLite) 하나에 있습니다. `GRIMOIRE_HOME`으로 위치를 바꿀 수 있습니다.

### "나"의 커밋

`--author me` / MCP `author: "me"`는 전역 `git config user.email`을 씁니다.
회사·개인 메일을 섞어 쓴다면 모두 적어 두세요(그 다음 `grimoire install`을 다시 하면 MCP 설정에도 들어갑니다).

```bash
export GRIMOIRE_ME="me@gmail.com,me@company.com"
```

## 시맨틱 검색 (선택)

키워드에 없는 표현("race condition" → "동시성 락" 커밋)까지 찾으려면 로컬 임베딩을 켭니다.

```bash
ollama pull nomic-embed-text
grimoire embed          # 의미 있는 커밋과 노트를 임베딩 (중간에 끊겨도 이어서 함)
```

이후 검색은 키워드(FTS5 bm25)와 코사인 순위를 RRF로 융합합니다. 모델에 닿지 못하면 키워드로
조용히 폴백합니다. 새 커밋이 들어오면 `grimoire embed`를 다시 돌리세요.
`OLLAMA_HOST`·`OLLAMA_EMBED_MODEL`로 주소와 모델을 바꿀 수 있습니다.

## 프라이버시

- Grimoire 자체는 외부로 아무것도 보내지 않습니다.
- **MCP로 외부 LLM 클라이언트에 연결하면 질의 결과(커밋 메시지·파일 경로·diff)는 그 LLM에 전달됩니다.**
  민감한 레포는 등록하지 말거나 `grimoire remove <repo>`로 빼세요.

## 개발

```bash
npm run typecheck
npm test            # 임시 git 레포로 인덱싱·검색·MCP 도구 검증 (네트워크 없음)
npm run e2e         # MCP 종단 하네스 (아래)
```

### MCP 종단 하네스 (`e2e/harness.ts`)

실제 클라이언트처럼 서버를 **별도 프로세스로 띄워 stdio로** 붙고, 고정 픽스처 레포로 시나리오 12단계를 검증합니다.
GUI 앱 환경(최소 PATH, cwd `/`)에서 연결 → 빈 DB 안내 → `add_repo` scan → 한국어 검색과 근거 → 작성자 필터 →
diff → 개요 → 노트 → 오류 처리 → 재시작 시 백그라운드 동기화 → stdout 오염 여부.

```bash
npm run e2e                                    # 빌드한 dist/cli.js
npm run e2e -- --config "$HOME/Library/Application Support/Claude/claude_desktop_config.json"   # 설치된 설정 그대로
npm run e2e -- --json                          # 결과 JSON
```

- `--config`는 클라이언트 설정에 적힌 `command`·`args`를 그대로 실행하므로, `grimoire install`이 쓴 설정이 실제로 뜨는지 확인할 수 있습니다.
- DB·HOME은 항상 임시 폴더로 바꿔 실행합니다. 실제 `~/.grimoire`와 내 레포는 건드리지 않습니다.
- 실패하면 종료 코드가 1입니다. 연결이 안 되면 거기서 멈추고, 서버 stderr를 함께 보여 줍니다.

### 에이전트 하네스 (`e2e/agent.ts`)

실제 Claude(`claude -p`)에게 **질문만** 주고, 알맞은 Grimoire 도구를 골라 쓰는지와 맞는 근거 커밋을 대는지 채점합니다.

| 사례 | 확인하는 것 |
|---|---|
| `onboarding` | 빈 DB에서 스스로 `add_repo`로 등록한 뒤 검색해, 맞는 커밋 sha를 대는지 |
| `recall` | 맞는 sha, 해결 방법(Redis), 작성자(동료 커밋인지)를 정확히 말하는지 |
| `no-memory` | 기억에 없는 것을 물으면 커밋을 지어내지 않고 없다고 말하는지 |

```bash
npm run e2e:agent                     # 세 사례 (한 번에 약 $0.2)
npm run e2e:agent -- --repeat 3       # 모델 응답 편차를 보려면
npm run e2e:agent -- --case recall --model sonnet
```

- Claude Code가 설치·로그인돼 있어야 합니다. macOS는 로그인 정보를 Keychain에 두므로, Keychain에 닿지 못하는
  샌드박스 셸에서 돌리면 "로그인돼 있지 않습니다"가 나옵니다. 일반 터미널에서 실행하세요.
- 내장 도구를 모두 끄므로(`--tools ""`) 에이전트가 git으로 픽스처를 직접 읽지 못합니다. 답의 근거는 Grimoire를 거친 것뿐입니다.
- DB는 임시 폴더를 쓰고, `--strict-mcp-config`로 사용자 MCP 설정은 무시합니다. 사례당 비용 상한은 $0.50입니다.

```
src/
  cli.ts            CLI 진입점
  mcp/              MCP 서버(stdio)와 도구 정의
  core/             단일 코어 — db · git · indexer · search · embed · overview · notes · identity
    tech/           매니페스트 파서와 기술 이름 정규화 사전
```
