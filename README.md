# Grimoire

> "내가 예전에 이걸 어떻게 풀었더라?"에 **근거 링크와 함께** 답하는 로컬 개발 메모리.

Grimoire는 내 컴퓨터의 git 레포를 인덱싱해, Claude Code·Cursor·Claude Desktop 같은 AI 도구가
**MCP로 내 과거 커밋·변경 파일·diff·노트를 검색**하게 해 줍니다.

- 조직 레포 포함, 로컬에 clone된 레포라면 무엇이든. GitHub 토큰·rate limit 없음
- 결과마다 **근거**: 레포 · sha · 날짜 · 작성자 · 변경 파일 · 커밋 웹 링크
- **증분 동기화**: 새 커밋만 읽음. MCP 서버가 뜰 때 백그라운드로 자동 동기화
- 외부 API 호출 없음. 시맨틱 검색은 선택이며 로컬 Ollama만 사용

설계와 이전 버전에서 바뀐 점은 [PLANNING.md](./PLANNING.md)를 보세요.

## 설치

Node.js 20 이상이 필요합니다.

```bash
npm install
npm run build
npm link        # 'grimoire' 명령을 전역에 연결 (선택)
```

## 사용

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
```

데이터는 `~/.grimoire/grimoire.db`(SQLite) 하나에 있습니다. `GRIMOIRE_HOME`으로 위치를 바꿀 수 있습니다.

### "나"의 커밋

`--author me` / MCP `author: "me"`는 전역 `git config user.email`을 씁니다.
회사·개인 메일을 섞어 쓴다면 모두 적어 두세요.

```bash
export GRIMOIRE_ME="me@gmail.com,me@company.com"
```

## MCP 연결

### Claude Code

```bash
claude mcp add grimoire -- node /절대/경로/grimoire/dist/cli.js mcp
```

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "node",
      "args": ["/절대/경로/grimoire/dist/cli.js", "mcp"],
      "env": { "GRIMOIRE_ME": "me@gmail.com" }
    }
  }
}
```

### 도구

| 도구 | 하는 일 |
|---|---|
| `search_memory` | 커밋·노트 검색. `repo`·`author`(`me`)·`since`·`until`·`kind`·`limit` 필터 |
| `show_commit` | 커밋 하나의 전체 메시지·변경 파일·diff (로컬 레포에서 직접 읽음) |
| `get_repo_overview` | 기술 스택(매니페스트 기준)·분기별 활동·많이 건드린 디렉터리·주요 작성자·최근 주요 커밋 |
| `list_repos` | 인덱싱된 레포 목록 |
| `record_note` | 대화 중 배운 것·결정을 노트로 저장 → 이후 검색 대상 |

서버는 기동 직후 등록된 레포를 백그라운드로 동기화합니다. 끄려면 `GRIMOIRE_SYNC_ON_START=0`을 주세요.

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
```

```
src/
  cli.ts            CLI 진입점
  mcp/              MCP 서버(stdio)와 도구 정의
  core/             단일 코어 — db · git · indexer · search · embed · overview · notes · identity
    tech/           매니페스트 파서와 기술 이름 정규화 사전
```
