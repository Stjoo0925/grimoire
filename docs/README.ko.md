# Grimoire

[![CI](https://github.com/Stjoo0925/grimoire/actions/workflows/ci.yml/badge.svg)](https://github.com/Stjoo0925/grimoire/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@stjoo0925/grimoire)](https://www.npmjs.com/package/@stjoo0925/grimoire)

[English](../README.md) | **한국어**

> "내가 예전에 이걸 어떻게 풀었더라?" "그 코드 어디 있지?"에 **근거와 함께** 답하는 로컬 개발 메모리.

Grimoire는 내 컴퓨터의 git 레포를 인덱싱해, Claude Code·Cursor·Claude Desktop 같은 AI 도구가
**MCP로 내 과거 커밋·변경 파일·diff·노트와 현재 코드(파일·심볼:줄)를 한 번에 검색**하게 해 줍니다.
AI가 프로젝트를 일일이 열어 보거나 git log를 뒤지지 않고, 한 번의 검색으로 파일과 커밋을 짚게 하려는 것입니다.

- 조직 레포 포함, 로컬에 clone된 레포라면 무엇이든. GitHub 토큰·rate limit 없음
- 결과마다 **근거**: 커밋이면 레포 · sha · 날짜 · 작성자 · 변경 파일 · 커밋 링크, 코드면 파일 경로 · 심볼:줄 · 마지막으로 건드린 커밋
- **증분 동기화**: 새 커밋과 바뀐 파일만 읽음. MCP 서버가 뜰 때 백그라운드로 자동 동기화
- 한국어 질문도 영어 식별자에 닿도록 흔한 개발 용어를 영어로 확장("충돌" → `conflict`, "횟수 제한" → `rate limit`)
- 응답은 토큰을 아끼는 최소 형태. 대화 컨텍스트에 쌓이는 양이 곧 비용이라서
- LLM·임베딩 모델·GPU 필요 없음: 검색은 키워드(SQLite FTS5)로 하고, 찾은 근거를 읽는 건 이미 쓰는 AI가 합니다

설계와 이전 버전에서 바뀐 점은 [PLANNING.md](./PLANNING.md)를, 연구에 기반한 개선 로드맵은 [improvement-plan.md](./improvement-plan.md)를 보세요.

## 빠른 시작

Node.js 20 이상과 git이 필요합니다.

```bash
npm install -g @stjoo0925/grimoire
grimoire scan ~/work-dir              # 하위 git 레포를 찾아 모두 등록 + 인덱싱
grimoire install claude-code          # MCP 클라이언트에 연결 (아래 표 참고)
grimoire doctor                       # 연결 상태 점검
```

소스에서 쓰려면 clone한 뒤 `npm install && npm run build && npm link`를 하세요.

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
- `GRIMOIRE_HOME`·`GRIMOIRE_ME`·`GRIMOIRE_AUTO_ADD`·`GRIMOIRE_UPDATE_CHECK`를 설정해 둔 상태라면 그 값도 같이 적혀,
  CLI와 MCP가 같은 DB를 보게 됩니다.
- 다른 서버 항목은 그대로 두고 `grimoire` 항목만 넣습니다. 기존 파일은 `.bak`으로 백업하고, JSON이 깨져 있으면
  건드리지 않고 멈춥니다. 무엇을 쓸지 먼저 보려면 `--dry-run`을 붙이세요.
- 설치한 뒤에는 클라이언트를 다시 시작하세요(Claude Desktop은 ⌘Q로 완전히 종료).

### 연결이 안 될 때 — `grimoire doctor`

Grimoire 버전(새 릴리스가 있는지), node 버전과 SQLite 모듈, git, DB와 등록된 레포, 내 이메일, 각 클라이언트에 적힌 설정(node 경로가
실제로 있는지, 지금 node와 같은지, 같은 DB를 보는지)을 점검하고 고치는 명령을 알려 줍니다.

### 작업 중인 프로젝트는 자동 등록

Claude Code와 Cursor는 MCP 서버를 지금 연 프로젝트 폴더에서 띄웁니다. 그 폴더가 git 레포이고 아직 등록 전이면
Grimoire가 **서버를 띄울 때 바로 등록하고, 다른 레포보다 먼저 동기화**합니다. 첫 검색은 그 첫 인덱싱을
(최대 15초) 기다렸다가 답하므로, 열어 둔 프로젝트에는 `add_repo`가 필요 없습니다.

- 현재 레포의 결과를 **앞으로 당깁니다**(다른 레포 결과도 같이 나옵니다). 응답에는 `current: "<레포>"`가 붙습니다.
- 끄려면 `GRIMOIRE_AUTO_ADD=0`. 꺼 둔 상태에서 현재 레포가 등록돼 있지 않으면, 조용히 빠지지 않고 `hint`로 알립니다.
- 레포 최상위가 홈 디렉터리나 `/`이면(닷파일 레포 등) 건너뜁니다.
- Claude Desktop은 프로젝트 폴더가 없어서(서버를 `/`에서 띄움) 아래처럼 직접 등록합니다.

### 레포 등록은 대화 중에도

아직 레포가 없으면 검색 결과에 안내(`hint`)가 실려, AI가 등록부터 하자고 말합니다.
`add_repo` 도구로 대화 중에 바로 등록할 수 있습니다("~/work-dir 아래 레포 전부 기억해 줘" → `scan: true`).

### 도구

| 도구 | 하는 일 |
|---|---|
| `search_memory` | 현재 코드 파일·커밋·노트를 한 번에 검색. `repo`·`author`(`me`)·`since`·`until`·`kind`(`file`·`commit`·`note`)·`limit`(기본 8) 필터. `detail`: `summary`(기본, 상위 커밋 3개에 본문 전체와 바뀐 함수), `index`(목록만), `full`(1위 커밋 diff까지) |
| `show_commit` | 커밋 하나의 메시지·변경 파일·diff (로컬 레포에서 직접 읽음). diff는 기본 120줄이고, `paths`로 특정 파일만 볼 수 있음 |
| `get_repo_overview` | 기술 스택(매니페스트 기준)·분기별 활동·많이 건드린 디렉터리·주요 작성자·최근 주요 커밋 |
| `list_repos` | 인덱싱된 레포 목록 |
| `add_repo` | 레포(또는 `scan: true`로 폴더 아래 레포 전부) 등록 + 인덱싱. 루트·홈 전체 스캔은 터미널의 `grimoire scan`으로 |
| `record_note` | 대화 중 배운 것·결정을 노트로 저장 → 이후 검색 대상 |

응답은 토큰을 아끼도록 최소 형태로 보냅니다. sha는 10자, 날짜는 일까지, 작성자는 내 커밋이면 `me`로 표시하고, 커밋 링크는 레포별 접두(`links`)를 한 번만 보냅니다.
로컬 경로·점수·이메일처럼 답에 쓰지 않는 필드는 뺍니다. 도구 설명도 "언제 쓰는지"만 짧게 둡니다. 도구 정의는 서버가 켜진 모든 세션의 매 요청에 실리기 때문입니다.
대화 컨텍스트에 쌓이는 양이 곧 비용입니다. `npm run e2e`의 "응답 크기 예산" 단계(검색 결과 건당 260자, 도구 정의 2600자)가 형식이 다시 커지는 것을 막습니다.
CLI는 줄이지 않은 전체 결과를 보여 줍니다.

### 현재 코드 색인

커밋 이력과 함께 각 레포 **HEAD의 소스 파일**도 색인합니다. 파일마다 경로, 최상위 심볼(함수·클래스 등)과 줄 번호, 머리 주석을 검색 문서로 만듭니다.

- 대상: `.ts`·`.tsx`·`.js`·`.py`·`.go`·`.rs`·`.java`·`.kt`·`.swift`·`.rb`·`.php`·`.cs`·`.c/.cpp`·`.sql`·`.sh`·`.dart` 등의 소스 파일
- 제외: `node_modules`·`vendor`·`dist`·`build`·`.next`·`generated` 같은 생성물·외부 코드, `.min.js`, 200KB 넘는 파일. 레포당 최대 8,000개
- 심볼은 언어별 정규식으로 뽑습니다(파서 없음). `rateLimit`은 `rate limit`으로도 걸리도록 낱말로 쪼개 함께 넣습니다
- 증분: 파일별 blob sha를 기억해 바뀐 파일만 다시 읽고, 사라진 파일은 색인에서 지웁니다
- 검색 결과(`kind: "file"`)에는 질의와 맞는 심볼 `이름:줄`, 파일 줄 수, 그 파일을 마지막으로 건드린 커밋이 붙습니다
- `author`·`since`·`until` 필터를 주면 이력에 대한 질문으로 보고 코드 파일은 결과에서 뺍니다

### 커밋이 바꾼 것

커밋 메타를 색인한 뒤, 두 번째 단계에서 커밋마다 diff(소스 파일만)를 읽어 추가·수정·삭제된 함수·클래스·타입 이름을 남깁니다.
검색 결과에 `changed`("webhook.ts: dedupeWebhookEvent")로 실리므로, AI가 diff를 열지 않고도 "예전에 어떻게 풀었지?"에 답할 때가 많습니다.
이 이름들도 검색되지만, 제목·본문·경로만으로 결과가 모자랄 때 채우는 데만 씁니다(지금은 어디에도 없는 지워진 함수 등). 순위에 섞으면 검색이 2~3배 느려지는데, 오프라인 평가에서 정확도 이득은 아직 유의하지 않습니다(docs/improvement-plan.md §7).

서버는 기동 직후 등록된 레포를 백그라운드로 동기화하고, 이어서 diff 단계를 채웁니다. 작업 중인 레포는 검색 전에 15초가 지났으면 다시 동기화하므로 방금 만든 커밋도 검색됩니다. 기동 시 동기화를 끄려면 `GRIMOIRE_SYNC_ON_START=0`을 주세요.

### 검색 품질 재기

`npm run eval`은 레포를 임시 DB에 색인하고 모델 호출 없이 `search()`를 채점합니다. 커밋 제목으로 그 커밋이 건드린 파일을 찾는 과제와, `bench/eval.local.json`에 손으로 쓴 질문(`{ "root": "~/work-dir", "questions": [{ "id", "type": "history" | "location", "q", "expect": ["sha나 경로 일부"] }] }`)을 씁니다. Acc@k·MRR·검색 지연·색인 시간을 보여 주고, `--save --label x`면 `bench/results/`에 남깁니다.

## CLI

```bash
grimoire scan ~/work-dir          # 하위 git 레포를 찾아 모두 등록 + 인덱싱
grimoire add ~/code/some-repo     # 레포 하나 등록
grimoire sync                     # 새 커밋과 바뀐 코드 파일만 반영
grimoire repos                    # 레포 목록과 커밋 수

grimoire search "jwt refresh"                  # 검색
grimoire search "동시성 락" --author me --since 2024-01-01
grimoire show 2518bf75                         # 커밋 메시지 + 파일 + diff (기본 120줄)
grimoire show 2518bf75 --path route.ts         # 경로 일부가 맞는 파일의 diff만 (--lines n으로 늘리기)
grimoire overview please_readme                # 기술 스택·활동·많이 건드린 곳·최근 주요 커밋
grimoire note "결정: 세션 대신 JWT — 모바일 때문" --repo shop-api --tag decision
grimoire remove shop-api                       # 레포와 색인 삭제
grimoire update                                # 최신 릴리스로 올리기 (아래 '업데이트')
```

데이터는 `~/.grimoire/grimoire.db`(SQLite) 하나에 있습니다. `GRIMOIRE_HOME`으로 위치를 바꿀 수 있습니다.

### "나"의 커밋

`--author me` / MCP `author: "me"`는 전역 `git config user.email`을 씁니다.
회사·개인 메일을 섞어 쓴다면 모두 적어 두세요(그 다음 `grimoire install`을 다시 하면 MCP 설정에도 들어갑니다).

```bash
export GRIMOIRE_ME="me@gmail.com,me@company.com"
```

## 시맨틱 검색이 없는 이유

예전에는 로컬 모델(Ollama)로 커밋을 임베딩해, 표현이 달라도 걸리게 하는 기능이 있었습니다. 지금은 뺐습니다.
검색어를 만드는 쪽이 AI이고, AI는 한 번에 못 찾으면 스스로 말을 바꿔 다시 찾습니다. 한국어·영어 엇갈림은
용어 사전(`src/core/terms.ts`)이 메우고, 핀포인트 벤치도 키워드 검색만으로 6/6이었습니다. 덕분에 따로 설치할 것
(Ollama와 모델)이 없어지고, DB가 약 3배 커지는 일과 검색이 느려지는 일도 없어졌습니다.

## 업데이트

새 버전은 [GitHub 릴리스](https://github.com/Stjoo0925/grimoire/releases)로 나오고, npm에도 같은 버전으로 배포됩니다.

```bash
grimoire update            # 최신 릴리스로 올리기
grimoire update --check    # 확인만
grimoire update --dry-run  # 무엇을 실행할지만 보기
```

- npm으로 설치했다면 `npm install -g @stjoo0925/grimoire@<새 버전>`을 실행합니다.
- clone으로 설치했다면 릴리스 태그로 fast-forward한 뒤 `npm install`·`npm run build`를 합니다. 커밋하지 않은 변경이 있거나 fast-forward가 안 되면 아무것도 바꾸지 않고 멈춥니다.

업데이트한 뒤에는 MCP 클라이언트를 다시 시작하세요. 같은 자리를 갈아 끼우므로 MCP 설정은 다시 쓸 필요가 없습니다.

새 버전은 하루 한 번 확인하고(`~/.grimoire/update.json`에 기록), 이렇게 알립니다.

- **MCP**: 세션마다 한 번, `search_memory`·`list_repos` 응답의 `hint`에 실려 AI가 사용자에게 전합니다
- **CLI**: 명령이 끝난 뒤 stderr에 한 줄 (`--json` 출력은 그대로)
- **`grimoire doctor`**: 지금 버전과 최신 버전

끄려면 `GRIMOIRE_UPDATE_CHECK=0`을 주세요(설정해 둔 뒤 `grimoire install`을 다시 하면 MCP 설정에도 들어갑니다).

## 프라이버시

- Grimoire가 외부로 보내는 요청은 하루 한 번의 업데이트 확인(GitHub API에 최신 릴리스 버전 조회)뿐입니다. 레포·커밋·질의 내용은 보내지 않으며, `GRIMOIRE_UPDATE_CHECK=0`으로 끌 수 있습니다.
- **MCP로 외부 LLM 클라이언트에 연결하면 질의 결과(커밋 메시지·파일 경로·diff)는 그 LLM에 전달됩니다.**
  민감한 레포는 등록하지 말거나 `grimoire remove <repo>`로 빼세요.

## 개발

```bash
npm run typecheck
npm test            # 임시 git 레포로 인덱싱·검색·MCP 도구 검증 (네트워크 없음)
npm run e2e         # MCP 종단 하네스 (아래)
npm run e2e:agent   # 에이전트 하네스 (아래, 실제 Claude 호출)
npm run bench       # 핀포인트 벤치 (아래, 실제 Claude 호출)
```

### MCP 종단 하네스 (`e2e/harness.ts`)

실제 클라이언트처럼 서버를 **별도 프로세스로 띄워 stdio로** 붙고, 고정 픽스처 레포로 시나리오 14단계를 검증합니다.
GUI 앱 환경(최소 PATH, cwd `/`)에서 연결 → 빈 DB 안내 → `add_repo` scan → 한국어 검색과 근거 → 응답 크기 예산 →
작성자 필터 → diff와 `paths`로 고른 diff → 개요 → 노트 → 오류 처리 → 재시작 시 백그라운드 동기화 → stdout 오염 여부.

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

### 핀포인트 벤치 (`e2e/bench.ts`)

같은 질문을 세 방식으로 풀게 해, 누가 더 빨리·싸게 정확한 위치(sha나 파일)를 대는지 잽니다.

| 모드 | 에이전트가 쓸 수 있는 것 |
|---|---|
| `grimoire` | Grimoire MCP만 (내장 도구 끔) |
| `history` | git 명령만 (`log`·`show`·`grep`) |
| `explore` | Read·Grep·Glob만 (프로젝트 파일 직접 순회) |

```bash
npm run bench -- --questions bench/questions.local.json
npm run bench -- --questions bench/questions.local.json --modes grimoire --only conflict,ratelimit --repeat 2
```

- 질문 파일 형식: `{ "root": "~/work-dir", "questions": [{ "id", "type", "q", "expect": ["정답 sha나 파일명 일부", …] }] }`.
  `expect`의 문자열이 모두 답에 들어 있으면 맞은 것으로 봅니다.
- 질문은 내 레포 기준이라 `bench/*.local.json`으로 두고, 결과는 `bench/results/<시각>.json`에 남깁니다. 둘 다 git에 올라가지 않습니다.
- `grimoire` 모드는 `root` 아래 레포를 임시 DB에 새로 인덱싱해서 씁니다. 실제 `~/.grimoire`는 건드리지 않습니다.

### 릴리스 내기

버전과 배포는 [릴리스 워크플로](.github/workflows/release.yml)가 맡습니다. 사람이 하는 일은 **릴리스 PR을 머지하는 것뿐**입니다.

1. 커밋 메시지는 [Conventional Commits](https://www.conventionalcommits.org/ko/)로 씁니다(`feat: …`, `fix(search): …`, 깨지는 변경은 `feat!: …`).
2. main에 push될 때마다 [release-please](https://github.com/googleapis/release-please)가 지난 릴리스 이후 커밋을 모아 `chore: release vX.Y.Z` PR을 열어 두고 갱신합니다. 이 PR이 `package.json` 버전과 `CHANGELOG.md`를 올립니다.
   - 1.0 전에는 `feat` → minor, `fix`·`perf` → patch, 깨지는 변경도 minor입니다. `docs`·`chore`·`ci`·`test`·`refactor`만 있으면 릴리스하지 않습니다.
3. 내보낼 때가 되면 그 PR을 머지합니다. 그러면 테스트·e2e → 패키지 파일(`.tgz`) 한 번 만들기 → npm 배포 → `vX.Y.Z` 태그 → GitHub 릴리스 → GitHub Packages 순서로 나갑니다.
   - **같은 `.tgz`**가 npm(provenance 포함), 릴리스 Assets(`.sha256` 함께), GitHub Packages(`npm.pkg.github.com`)에 올라갑니다.
   - 릴리스 노트는 자동으로 채웁니다: CHANGELOG 섹션 + 릴리스 PR 머지 뒤 배포 전에 들어간 사용자 대상 커밋(예: 배포를 고친 수정) + 설치 방법.

업데이트 확인은 GitHub 릴리스를 보고 `grimoire update`는 그 버전을 npm에서 받거나 태그로 fast-forward하므로, 릴리스는 태그와 npm이 준비된 뒤에 맨 마지막으로 만듭니다.
도중에 실패하면 Actions에서 다시 실행하세요. 태그·npm 버전·GitHub 릴리스를 각각 확인해 없는 것만 만들고, 항상 태그가 가리키는 커밋(태그 전이면 머지 커밋)에서 만들어 npm 내용이 태그와 같습니다. npm을 태그보다 먼저 내므로 배포가 실패해도 아무것도 남지 않습니다.

**처음 한 번 해 둘 것**
- npmjs.com → `@stjoo0925/grimoire` → Settings → Trusted Publisher → GitHub Actions에 `Stjoo0925` / `grimoire` / `release.yml`을 등록합니다. 토큰 없이 OIDC로 배포하고(2FA 계정에서도 동작) provenance가 붙습니다.
- GitHub → Settings → Actions → General → Workflow permissions에서 **Allow GitHub Actions to create and approve pull requests**를 켭니다. 꺼져 있으면 release-please가 릴리스 PR을 열지 못합니다.
- release-please용 토큰을 넣습니다. 기본 Actions 토큰으로 연 PR에서는 CI가 돌지 않아, 아래 main 보호 때문에 릴리스 PR을 머지할 수 없습니다.
  GitHub → Settings → Developer settings → Fine-grained tokens에서 이 레포만 고르고 **Contents·Pull requests·Issues: Read and write** 권한으로 만든 뒤 시크릿으로 넣으세요: `gh secret set RELEASE_PLEASE_TOKEN`

**main은 보호돼 있습니다.** 직접 push는 막혀 있고 PR로만 들어갑니다.
- CI 네 작업과 PR 제목 검사를 통과해야 머지됩니다. 관리자는 급할 때 PR에서 이를 건너뛰고 머지할 수 있습니다.
- 머지는 squash만 됩니다. **squash 커밋 제목 = PR 제목**이고 그것이 CHANGELOG 한 줄이 되므로, PR 제목을 `feat: …`·`fix(search): …`처럼 Conventional Commits로 씁니다([PR 제목 검사](.github/workflows/pr-title.yml)가 확인합니다).
- 머지된 브랜치는 자동으로 지워집니다.

[CI 워크플로](.github/workflows/ci.yml)는 main push와 PR마다 Ubuntu(node 20·22·24)와 macOS(node 22)에서 타입 검사·테스트·MCP 종단 하네스·패키지 내용을 확인합니다.

- 업데이트 확인은 로그인 없이 GitHub API를 부르므로, **레포가 public이어야** 다른 사용자에게 새 버전이 보입니다.
- DB 스키마를 바꿨다면 `src/core/db.ts`의 `MIGRATIONS`에 단계를 덧붙이기만 하세요. 이미 있는 단계를 고치면 기존 사용자 DB와 어긋납니다.

## 구조

```
src/
  cli.ts            CLI 진입점
  mcp/              MCP 서버(stdio)·도구 정의·응답 다이어트(format)
  core/             단일 코어 — db · git · indexer · code · search · terms · overview · notes · identity · update
    tech/           매니페스트 파서와 기술 이름 정규화 사전
  setup/            install · doctor · update 명령
e2e/                종단 하네스(harness) · 에이전트 하네스(agent) · 벤치(bench) · 공용 픽스처와 claude 실행기
tests/              단위·통합 테스트 (임시 git 레포, 네트워크 없음)
```

## 라이선스

[MIT](../LICENSE)
