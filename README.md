# Grimoire

> "내 커밋들이 마법서가 되어 꽂히고, 서로 연결되어 말을 거는 **살아있는 마법 도서관**"

개발자의 GitHub 이력을 **탑다운 도서관 방**으로 그려내는 **관찰형 게임**입니다. 커밋 내역을 메모리 삼아 **지식그래프**를 짓고, 그 위를 **사서 NPC**가 걸어다니며 일합니다.

- 레포 = 마법서 한 권 (책등 색 = 주 언어), 언어별 **책장**(가구)에 꽂힘
- 커밋 = 마법서의 페이지 — 최근 커밋된 책을 사서가 걸어가 꽂는다(말풍선 = 작업 로그)
- README = 서문 / 사서에게 물으면 언급된 책의 책장으로 걸어가 가리키며 발광

전체 기획은 [PLANNING.md](./PLANNING.md) 참고.

> 현재 상태: **1~5-a 구현 완료.** GitHub OAuth → 수집(`data/{login}.json`) → 지식그래프 생성(`data/graph/{login}.json`, LLM 없이도 성립) → **탑다운 방 UI + 사서 NPC** → 키워드+임베딩 하이브리드 검색 → **MCP 서버로 Claude Desktop/Cursor/원격 노출**까지 동작합니다.

## 3층 아키텍처

```
┌─────────────────────────────────────┐
│ ③ 인터랙티브 도서관 (Experience)      │  src/components/library/
│    2D 서재 UI + AI 사서              │
├─────────────────────────────────────┤
│ ② 지식그래프 (Brain)                 │  src/lib/graph/
│    커밋·README → AI 추출 → 노드/엣지  │
├─────────────────────────────────────┤
│ ① 수집기 (Collector)                 │  src/lib/collector/
│    GitHub API (OAuth 인증)           │
└─────────────────────────────────────┘
```

| 계층 | 위치 | 내용 |
|---|---|---|
| ① 수집기 | `src/lib/collector/` | `types.ts` (Repo/Commit/ContributionDay/CollectionSnapshot), `github.ts` (REST+GraphQL 페처), `storage.ts` (`data/{login}.json` 소장) |
| ② 지식그래프 | `src/lib/graph/` | `types.ts` (온톨로지: Project/Tech/Concept/Problem/Period, 엣지 USES·ABOUT·SOLVED·LEARNED·DEVELOPED·RELATED_TO·DEPENDS_ON), `manifests.ts`·`commits.ts`·`canonical.ts`·`deterministic.ts` (결정론적 파이프라인), `extractors/` (ollama·claude 스위치), `merge.ts`, `builder.ts`, `storage.ts` (`data/graph/{login}.json`) |
| ② MCP 서버 | `src/mcp/` | `server.ts` (stdio/HTTP 배선), `tools.ts` (도구 3종), `search.ts`·`project.ts`·`learning.ts` (순수 로직), `paths.ts`·`context.ts`·`storage.ts` (`./data` 접근), `transport.ts`·`http.ts` (전송·인증) |
| ③ 도서관 UI | `src/components/library/` | `Bookshelf.tsx`, `Book.tsx` (자리표시) |
| 인증 | `src/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts` | Auth.js v5 + GitHub OAuth |

## 기술 스택

Next.js 15 (App Router) · TypeScript · Tailwind CSS v4 · Auth.js (next-auth v5)

## 시작하기

### 1. 의존성 설치

```bash
npm install
```

### 2. GitHub OAuth App 등록

1. GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**
2. 아래처럼 입력합니다.
   - **Application name**: `Grimoire (local)`
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github`
3. 생성 후 **Client ID**를 복사하고, **Generate a new client secret**으로 시크릿을 발급받아 복사합니다. (시크릿은 최초 1회만 보입니다)

요청 스코프는 `read:user` + `repo` 입니다 — private 레포를 포함한 본인 전체 이력에 접근하고 시간당 5,000회 rate limit을 확보하기 위함입니다. 토큰은 서버 세션에만 보관됩니다.

### 3. 환경 변수 설정

`.env.example`을 `.env.local`로 복사한 뒤 값을 채웁니다.

```bash
cp .env.example .env.local     # PowerShell: Copy-Item .env.example .env.local
```

```dotenv
AUTH_SECRET=              # npx auth secret 으로 생성
AUTH_GITHUB_ID=           # OAuth App의 Client ID
AUTH_GITHUB_SECRET=       # OAuth App의 Client Secret

GRAPH_EXTRACTOR=auto      # none | ollama | claude | auto (아래 "지식그래프" 참고)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b-instruct   # 초기 기본값. 화면의 ⚙ 모델 설정에서 고르면 그쪽이 우선합니다
```

`AUTH_SECRET`은 다음 명령으로 생성할 수 있습니다.

```bash
npx auth secret
```

`.env*` 파일은 `.gitignore`에 포함되어 있습니다. 실제 값을 커밋하지 마세요.

### 4. 개발 서버 실행

```bash
npm run dev
```

http://localhost:3000 에서 "GitHub로 로그인" 버튼으로 OAuth 흐름을 확인할 수 있습니다.

### 5. 수집

로그인하면 **수집하기** 버튼이 나타납니다. 누르면 서버에서 한 번에 전체 수집(레포 → 언어·README·커밋 → 잔디)을 돌리고 결과를 `data/{login}.json`에 저장한 뒤 요약(책 수·총 커밋·수집 기간·언어 종수·잔디 총 기여·마지막 수집 시각)을 보여줍니다. 레포 수에 따라 수 분이 걸릴 수 있습니다.

잔여 rate limit이 50회 아래로 떨어지면 수집을 중단하고 스냅샷을 `partial`로 표시합니다(모아둔 데이터는 그대로 저장). `data/`는 `.gitignore` 대상입니다.

### 6. 지식그래프 만들기

수집이 끝나면 **그래프 생성하기** 버튼이 활성화됩니다. 소장된 스냅샷(`data/{login}.json`)만 읽어
지식그래프를 굽고 `data/graph/{login}.json`에 저장합니다 — **GitHub API를 다시 부르지 않습니다.**

파이프라인 (KNOWLEDGE_GRAPH.md §4):

1. **정적 분석** — `package.json`·`requirements.txt`·`pyproject.toml`·`go.mod`·`Cargo.toml` 파싱,
   언어 통계 → `Tech` 노드 + `USES(source:"static")`, 자명한 의존은 `DEPENDS_ON`
2. **토픽** — 레포 토픽을 정규화해 `Concept` + `ABOUT` (기술로 알려진 토픽은 `Tech` + `USES(source:"topics")`)
3. **커밋** — merge/chore/오타 커밋을 걷어내고 레포별로 묶어 다이제스트 생성,
   날짜 → `Period` + `DEVELOPED`, 기술별 최초 등장 → `LEARNED {firstCommitDate}`
4. **엔티티 정규화** — `react`/`reactjs`/`React.js` → `tech-react` 로 일원화
5. **개념 연결** — 같은 레포에 함께 등장한 `Concept`끼리 `RELATED_TO {strength}`
6. **(선택) LLM 추출** — 개념·해결한 문제·학습 시점을 뽑아 위 그래프에 **합류**시킴

1~5는 **항상** 돌기 때문에 LLM이 없어도 그래프가 나옵니다.

#### 추출기 3티어와 프라이버시

> **원칙(PLANNING.md §7): 내 커밋·README·private 레포는 외부 LLM API로 전송하지 않는다.**

| `GRAPH_EXTRACTOR` | 동작 | 데이터 전송 |
|---|---|---|
| `none` | 정적 분석만. **오류가 아니라 정식 티어** — 온톨로지의 상당 부분이 이것만으로 성립 | 없음 |
| `ollama` | 로컬 Ollama(아래 "모델 고르기", 기본 `qwen2.5:7b-instruct`)로 Concept·Problem·Learned 추출 | 이 컴퓨터 안에서만 |
| `claude` | Anthropic API 사용. **커밋 다이제스트와 README 발췌가 외부로 전송됨** | ⚠ Anthropic API |
| `auto`(기본) | Ollama가 떠 있으면 `ollama`, 아니면 `none` | 없음 / 로컬 |

- `auto`는 **`ANTHROPIC_API_KEY`가 설정돼 있어도 `claude`를 선택하지 않습니다.** 외부 전송은
  `GRAPH_EXTRACTOR=claude`를 직접 적어 넣은 경우에만 일어납니다(유닛 테스트로 고정).
- `ollama`인데 데몬이 없으면 오류 대신 `none`으로 내려가고, 화면에 사유를 표시합니다.
- 레포 하나의 LLM 추출이 실패하면 건너뛰고 그래프를 `partial`로 표시합니다.
- 화면에는 어떤 추출기를 썼는지 배지로 표시되며, `none`이면 로컬 Ollama 안내가 함께 뜹니다.

옛 스냅샷(토픽·매니페스트 없이 수집)도 그대로 그래프가 만들어집니다 — 노드가 적어질 뿐이며,
화면이 "다시 수집하기"를 권합니다.

### 하이브리드 검색 켜기 (5-a)

사서·MCP 검색은 임베딩이 있으면 **키워드 + 시맨틱 하이브리드**로 동작합니다("동시성 이슈"처럼
정확한 단어가 없어도 걸림). 융합 품질을 위해 세 가지를 적용합니다:
(1) 흔한 토큰("데이터")의 약한 매칭은 IDF로 억제, (2) 약한 매칭만 있는 노드는 융합에서
키워드 순위를 못 받고 시맨틱으로만 경쟁(노이즈가 코사인 최상위 답을 누르지 못하게),
(3) 한글 조사 제거("지식그래프와"→"지식그래프"). 켜는 법:

```bash
docker exec grimoire-ollama ollama pull nomic-embed-text   # ~300MB, 로컬 전용
```

받은 뒤 **그래프 생성하기를 한 번 더** 실행하면 노드 임베딩이 그래프 JSON에 구워집니다.
같은 텍스트는 재빌드 때 벡터를 재사용하고, 모델이 없으면 키워드 검색으로 조용히 폴백합니다.

### 헤드리스 임베딩 (CLI, PLANNING §5 ③)

이미 만들어 둔 그래프에 로그인 없이 임베딩만 굽는 진입점입니다. LLM 재추출 없이
노드 벡터만 채우므로 기존 개념·문제를 건드리지 않고, 임베딩은 순차 배치라
`OLLAMA_KEEP_ALIVE`·동시성 문제와 무관합니다.

```bash
GRIMOIRE_LOGIN=<아이디> npm run graph:embed
```

`OLLAMA_HOST`·`OLLAMA_EMBED_MODEL`은 웹앱과 동일하게 해석됩니다. GitHub API는 건드리지 않습니다.

> **그래프 전체 재생성**(LLM 재추출)은 웹 UI "그래프 생성하기"를 쓰세요. 배치 추출은
> `OLLAMA_KEEP_ALIVE`를 **양수**로 둔 환경에서 돌려야 합니다 — `0`이면 동시 요청이 모델을
> 서로 올렸다 내리며 타임아웃 나므로, compose의 `llm` 프로파일에서 그 값을 확인하세요.

### 모델 고르기 (화면에서)

씬 상단 HUD의 **⚙ 설정** 버튼을 누르면 뜨는 오버레이에서 사서 답변과 그래프 추출에 쓸 로컬
모델을 고릅니다. `.env.local`을 고칠 필요가 없습니다.

- 고른 값은 `data/settings.json`에 저장되며 **`OLLAMA_MODEL` 환경변수보다 우선합니다.**
  해석 순서는 어디서나 동일합니다: `data/settings.json` → `OLLAMA_MODEL` → 기본값(`qwen2.5:7b-instruct`).
- 패널은 Ollama 연결 상태, 지금 쓰는 모델, `ollama list`에 해당하는 설치된 모델 목록을 보여 줍니다.
- 바꾸면 **다음 사서 질문**과 **다음 그래프 생성**부터 적용됩니다. 이미 만들어 둔 그래프는 그대로입니다.
- Ollama가 꺼져 있으면 선택 UI가 잠기고 `docker compose --profile llm up -d` 안내가 뜹니다.
- 설치되지 않은 권장 모델은 패널의 **내려받기** 버튼으로 받을 수 있습니다. `ollama pull`이 끝날 때까지
  응답을 붙잡으므로(회선에 따라 수 분~수십 분) 그동안 "모델을 내려받는 중" 상태가 유지됩니다.
  받고 나면 자동으로 그 모델이 선택됩니다.

권장 모델과 하드웨어 기준:

| 모델 | 내려받는 크기 | 권장 하드웨어 |
|---|---|---|
| `qwen2.5:7b-instruct` (기본) | 약 4.7GB | VRAM 8GB급 — RTX 3060 Ti / 4060, 노트북 3060(6GB)도 이쪽 |
| `qwen2.5:14b-instruct` (고품질) | 약 9GB | **VRAM 12GB 이상** — RTX 3060 데스크톱 12GB / 3090 / 4070 이상 |

- RTX 3060 **데스크톱 12GB**는 14B가 약 10.5GB로 올라가 통째로 들어갑니다.
  반면 3060 Ti(8GB)·노트북 3060(6GB)은 14B가 VRAM을 넘겨 CPU로 밀려나며 크게 느려지므로 7B를 유지하세요.
- GPU가 없어도 동작하지만 CPU 추론은 느립니다 — 사서 응답 대기 상한은 90초, 그래프 추출은 180초입니다.

## MCP 서버 — 세컨드 브레인 (Claude Desktop / Cursor / 원격)

구운 지식그래프를 **MCP(Model Context Protocol) 서버**로 열어, 외부 AI 클라이언트가 내 커밋 이력을
직접 조회하게 합니다 (PLANNING.md §5 ②, KNOWLEDGE_GRAPH.md §8). 웹앱과 **같은 `./data`** 를 읽으므로
따로 수집할 필요가 없고, Next.js/React 코드는 전혀 로드하지 않는 독립 프로세스입니다.

### 도구 3종

| 도구 | 인자 | 하는 일 |
|---|---|---|
| `query_grimoire_graph` | `query`, `limit`(기본 8·최대 25), `hops`(1~2·기본 1) | 키워드를 정규화(`React.js` → `tech-react`)해 노드를 찾고 점수순(정확 > 접두 > 부분, 연결 차수로 소폭 가산) 시드에서 1~2홉 서브그래프를 돌려줍니다. Problem은 `solutionSummary`를 항상 포함 |
| `get_project_history` | `project` (부분 일치 가능) | 그 책의 메타(주 언어·공개 여부·날짜) + 사용 기술(USES 출처 포함) + 개념 + 해결한 문제 + 개발 시기 + 커밋 통계(총 수·첫/마지막 커밋·최근 메시지 20개). 스냅샷이 없으면 그래프만으로 답하고 사유를 밝힘 |
| `record_new_learning` | `name`, `kind`(`tech`\|`concept`), `note?`, `relatedProject?` | 새로 배운 것을 그래프에 기록. 이미 있으면 `already known`으로 알리고 메모만 갱신. 프로젝트에 `USES`/`ABOUT`, 현재 분기 `Period`에서 `LEARNED`를 잇고 임시 파일 + rename으로 원자적 저장 |

`record_new_learning`이 만든 노드/엣지는 `meta.source = "mcp"`로 표시되며, 웹앱에서 **그래프를 다시 구워도 보존**됩니다(빌더가 MERGE).

### 프라이버시 ⚠

> **이 서버를 외부 LLM 클라이언트(Claude Desktop 등)에 연결하면, 질의된 서브그래프만큼은 그 LLM에 노출됩니다** (PLANNING.md §7).
> private 레포 이름·커밋 메시지도 응답에 포함될 수 있습니다. 완전 폐쇄가 필요하면 로컬 LLM 클라이언트에 연결하세요.
> 서버 자체는 어떤 외부 API도 호출하지 않습니다 — 읽고 쓰는 것은 `./data` 뿐입니다.

### 빌드와 실행 (호스트)

```bash
npm run mcp:build   # tsconfig.mcp.json → dist-mcp/mcp/server.js (CommonJS)
npm run mcp         # 빌드 후 stdio로 실행 (보통은 클라이언트가 알아서 띄웁니다)
```

**어떤 그래프를 여는가**: `GRIMOIRE_LOGIN`이 있으면 그 사용자, 없고 `data/graph/`에 파일이 하나뿐이면 그것,
여러 개면 후보를 나열하며 오류로 알려줍니다. 데이터 디렉터리는 `GRIMOIRE_DATA_DIR` → 실행 위치의 `./data`
→ `dist-mcp` 옆의 `data` 순으로 찾습니다(호스트 경로를 코드에 박지 않습니다).

#### Claude Desktop (`claude_desktop_config.json`)

Windows는 `%APPDATA%\Claude\claude_desktop_config.json`, macOS는 `~/Library/Application Support/Claude/claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "node",
      "args": ["D:\\Grimoire\\dist-mcp\\mcp\\server.js"],
      "env": {
        "GRIMOIRE_LOGIN": "Stjoo0925",
        "GRIMOIRE_DATA_DIR": "D:\\Grimoire\\data"
      }
    }
  }
}
```

#### Cursor (`~/.cursor/mcp.json`, 프로젝트별은 `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "node",
      "args": ["D:\\Grimoire\\dist-mcp\\mcp\\server.js"],
      "env": { "GRIMOIRE_LOGIN": "Stjoo0925" }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add grimoire --env GRIMOIRE_LOGIN=Stjoo0925 -- node D:\Grimoire\dist-mcp\mcp\server.js
```

### 컨테이너로 실행 (stdio)

```bash
docker build --target mcp -t grimoire-mcp:local .
```

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "D:\\Grimoire\\data:/app/data",
        "-e", "GRIMOIRE_LOGIN=Stjoo0925",
        "grimoire-mcp:local"
      ]
    }
  }
}
```

- stdio는 `docker run -i`의 표준입출력으로 그대로 흐릅니다(추가 설정 불필요).
- 이미지의 작업 디렉터리는 `/app`이고 서버는 **cwd 기준으로 `./data`** 를 찾으므로,
  볼륨을 `/app/data`에 마운트하면 됩니다. 다른 곳에 붙이려면 `-e GRIMOIRE_DATA_DIR=/app/app-data`처럼 지정하세요.
- 나중에 데이터를 named volume으로 옮겨도 서버 코드는 그대로입니다.

### 원격(개인 서버) — Streamable HTTP

```bash
# .env 에 MCP_AUTH_TOKEN(긴 무작위 문자열)과 GRIMOIRE_LOGIN을 채운 뒤
docker compose --profile mcp up -d --build     # 8765 포트, /mcp 경로
```

- `MCP_TRANSPORT=http`이고 `MCP_AUTH_TOKEN`이 비어 있으면 **서버가 기동을 거부합니다** — 토큰 없는 원격 노출 금지(PLANNING.md §7).
- 모든 요청은 `Authorization: Bearer <토큰>`이 필요하며, 없으면 401입니다. (`/health`만 인증 없이 200)
- **TLS는 범위 밖입니다** — 앞단의 리버스 프록시나 터널이 담당합니다. 포트를 그대로 인터넷에 열지 마세요.

Cloudflare Tunnel (권장 — 열어 둘 포트가 없습니다):

```bash
cloudflared tunnel --url http://localhost:8765
# 또는 고정 도메인: cloudflared tunnel route dns <tunnel> grimoire.example.com
```

Caddy 리버스 프록시 (`Caddyfile`, 자동 HTTPS):

```
grimoire.example.com {
    reverse_proxy localhost:8765
}
```

클라이언트 등록:

```bash
# Claude Code
claude mcp add --transport http grimoire https://grimoire.example.com/mcp \
  --header "Authorization: Bearer <토큰>"
```

- **claude.ai / Claude Desktop**: 설정 → 커넥터 → "커스텀 커넥터 추가"에 `https://grimoire.example.com/mcp`를 넣고
  Authorization 헤더에 `Bearer <토큰>`을 지정합니다.
- **Cursor**: `~/.cursor/mcp.json`에

  ```json
  {
    "mcpServers": {
      "grimoire": {
        "url": "https://grimoire.example.com/mcp",
        "headers": { "Authorization": "Bearer <토큰>" }
      }
    }
  }
  ```

### 알려진 한계

- 검색은 **키워드 + 로컬 임베딩 하이브리드**입니다(5-a). `nomic-embed-text`가 있고 그래프에 임베딩이 구워져 있으면 키워드 순위와 코사인 순위를 RRF로 융합해 "동시성 이슈" 같은 표현이 정확한 단어 없이도 걸립니다. 임베딩이 없으면 키워드 검색으로 조용히 폴백합니다. 2홉 Cypher(KNOWLEDGE_GRAPH.md §5)는 5-b(Neo4j/Qdrant, 보류)에서 붙습니다.
- 온톨로지상 `LEARNED`는 `Period → Tech`지만, MCP로 기록한 **Concept에도** 시점 기록을 위해 `LEARNED`를 붙입니다.
- HTTP 모드는 무상태(stateless)입니다 — 서버→클라이언트 스트리밍(GET SSE)과 세션 삭제(DELETE)는 지원하지 않고 `POST /mcp`만 받습니다.

## Docker

`docker-compose.yml`은 프로파일 조립식입니다(PLANNING.md §5). 어떤 조합이든 `./data`를 공유하므로
호스트에서 `npm run dev`로 만든 스냅샷·그래프를 컨테이너가 그대로 읽습니다.

| 시나리오 | 명령 | 구성 |
|---|---|---|
| 웹만 (도커 없이) | `npm run dev` | 호스트 Next.js. 추출기는 `auto` → 로컬 Ollama 있으면 사용 |
| 웹 컨테이너만 | `docker compose --profile app up -d --build` | `web` (3000) |
| 풀 로컬 | `docker compose --profile app --profile llm up -d --build` | `web` + `ollama` (11434) |
| MCP 원격 노출 | `docker compose --profile mcp up -d --build` | `mcp` (8765, Bearer 토큰 필수 — 위 MCP 절 참고) |
| DB까지 전부 | `docker compose --profile app --profile llm --profile db up -d --build` | + `neo4j`(7474/7687), `qdrant`(6333/6334) |
| **GPU 가속 (선택)** | 위 명령에 `-f docker-compose.yml -f docker-compose.gpu.yml` 추가 | `ollama`가 NVIDIA GPU 사용 |

- `web`은 `.env.local`을 `env_file`로 읽습니다(커밋 금지). 컨테이너 안에서는 `OLLAMA_HOST=http://ollama:11434`가 주입됩니다.
- `ollama` 컨테이너는 **기동 시 `OLLAMA_MODEL`을 자동으로 내려받습니다**(볼륨에 이미 있으면 즉시 통과).
  수동으로 하려면 `docker exec grimoire-ollama ollama pull qwen2.5:7b-instruct`.
  첫 실행은 모델 다운로드로 수 GB·수 분이 걸립니다.
  compose의 `OLLAMA_MODEL`은 **이 자동 내려받기에만** 쓰입니다 — 앱이 실제로 부를 모델은
  화면의 ⚙ 모델 설정(`data/settings.json`)이 결정합니다.
- NVIDIA GPU 가속은 **선택사항**입니다 — `docker-compose.gpu.yml` 오버레이를 `-f`로 얹으면 켜집니다.
  매번 치기 싫으면 `.env`에 `COMPOSE_FILE=docker-compose.yml;docker-compose.gpu.yml`(Windows, Linux는 `:` 구분).
  GPU 없는 머신은 오버레이 없이 그대로 CPU 동작 (Windows GPU는 Docker Desktop + WSL2 + NVIDIA 드라이버 필요).
- `db` 프로파일(Neo4j/Qdrant)은 **2차 준비용이며 지금 코드는 사용하지 않습니다**. 1차 저장은 JSON(`./data`)입니다.
  비밀번호는 `.env`의 `NEO4J_PASSWORD`에서 옵니다.
- 볼륨은 전부 `./data/db/{ollama,neo4j,qdrant}` 아래로 모읍니다 — `.gitignore`의 `/data` 규칙에 이미 포함됩니다.

### 컨테이너에서의 OAuth 콜백

포트를 `3000:3000`으로 그대로 노출하므로 GitHub OAuth App의 콜백 URL
`http://localhost:3000/api/auth/callback/github`이 그대로 동작합니다. 다른 포트/호스트로 띄운다면
`.env.local`에 `AUTH_URL`(또는 구버전 `NEXTAUTH_URL`)을 실제 접속 주소로 지정하고
OAuth App의 콜백 URL도 같이 바꾸세요.

### 그 외 명령

```bash
npm run build   # 프로덕션 빌드 (standalone 출력 — Docker 이미지가 이걸 씁니다)
npm start       # 빌드 결과 실행
npm run lint      # ESLint
npm run test      # 지식그래프·MCP 순수 로직 유닛 테스트 (네트워크 없음)
npm run mcp:build # MCP 서버 트랜스파일 → dist-mcp/
npm run mcp       # MCP 서버 실행 (stdio)
```

## 로드맵 (MVP)

1. GitHub OAuth 로그인 → 본인 전체 레포·커밋 수집·저장 ✅
2. 지식그래프: 정적 분석 + (선택) 로컬 LLM 추출 → JSON 그래프 ✅
3. MCP 서버로 그래프 노출 (Claude Desktop/Cursor, stdio + 원격 HTTP) ✅
4. 2D 도서관 뷰: 책장 + 책 클릭 → 상세 + 관련 책 하이라이트
5. AI 사서 채팅 (GraphRAG 질의응답)
