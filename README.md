# Grimoire

> "내 커밋들이 마법서가 되어 꽂히고, 서로 연결되어 말을 거는 **살아있는 마법 도서관**"

개발자의 GitHub 이력을 **마법 도서관**으로 시각화하고, 커밋 내역을 메모리 삼아 **지식그래프**를 구축해, AI 사서와 함께 탐험하는 **인터랙티브 2D 서재**입니다.

- 레포 = 마법서 한 권 (책등 색 = 주 언어)
- 커밋 = 마법서의 페이지
- 언어 = 서가 분류 / 잔디 = 수련 일지 / README = 서문

전체 기획은 [PLANNING.md](./PLANNING.md) 참고.

> 현재 상태: **① 수집기 + ② 지식그래프 구현 완료**. GitHub OAuth 로그인 → 레포·커밋·README·토픽·의존성 매니페스트 수집 → `data/{login}.json` 소장 → 지식그래프 생성(`data/graph/{login}.json`)까지 동작합니다. 그래프는 LLM 없이도(정적 분석만으로) 만들어집니다. ③ 도서관 UI는 아직 스텁입니다.

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
OLLAMA_MODEL=qwen2.5:7b-instruct
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
| `ollama` | 로컬 Ollama(`OLLAMA_MODEL`, 기본 `qwen2.5:7b-instruct`)로 Concept·Problem·Learned 추출 | 이 컴퓨터 안에서만 |
| `claude` | Anthropic API 사용. **커밋 다이제스트와 README 발췌가 외부로 전송됨** | ⚠ Anthropic API |
| `auto`(기본) | Ollama가 떠 있으면 `ollama`, 아니면 `none` | 없음 / 로컬 |

- `auto`는 **`ANTHROPIC_API_KEY`가 설정돼 있어도 `claude`를 선택하지 않습니다.** 외부 전송은
  `GRAPH_EXTRACTOR=claude`를 직접 적어 넣은 경우에만 일어납니다(유닛 테스트로 고정).
- `ollama`인데 데몬이 없으면 오류 대신 `none`으로 내려가고, 화면에 사유를 표시합니다.
- 레포 하나의 LLM 추출이 실패하면 건너뛰고 그래프를 `partial`로 표시합니다.
- 화면에는 어떤 추출기를 썼는지 배지로 표시되며, `none`이면 로컬 Ollama 안내가 함께 뜹니다.

옛 스냅샷(토픽·매니페스트 없이 수집)도 그대로 그래프가 만들어집니다 — 노드가 적어질 뿐이며,
화면이 "다시 수집하기"를 권합니다.

## Docker

`docker-compose.yml`은 프로파일 조립식입니다(PLANNING.md §5). 어떤 조합이든 `./data`를 공유하므로
호스트에서 `npm run dev`로 만든 스냅샷·그래프를 컨테이너가 그대로 읽습니다.

| 시나리오 | 명령 | 구성 |
|---|---|---|
| 웹만 (도커 없이) | `npm run dev` | 호스트 Next.js. 추출기는 `auto` → 로컬 Ollama 있으면 사용 |
| 웹 컨테이너만 | `docker compose --profile app up -d --build` | `web` (3000) |
| 풀 로컬 | `docker compose --profile app --profile llm up -d --build` | `web` + `ollama` (11434) |
| DB까지 전부 | `docker compose --profile app --profile llm --profile db up -d --build` | + `neo4j`(7474/7687), `qdrant`(6333/6334) |
| **GPU 가속 (선택)** | 위 명령에 `-f docker-compose.yml -f docker-compose.gpu.yml` 추가 | `ollama`가 NVIDIA GPU 사용 |

- `web`은 `.env.local`을 `env_file`로 읽습니다(커밋 금지). 컨테이너 안에서는 `OLLAMA_HOST=http://ollama:11434`가 주입됩니다.
- `ollama` 컨테이너는 **기동 시 `OLLAMA_MODEL`을 자동으로 내려받습니다**(볼륨에 이미 있으면 즉시 통과).
  수동으로 하려면 `docker exec grimoire-ollama ollama pull qwen2.5:7b-instruct`.
  첫 실행은 모델 다운로드로 수 GB·수 분이 걸립니다.
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
npm run lint    # ESLint
npm run test    # 지식그래프 결정론적 파이프라인 유닛 테스트 (네트워크 없음)
```

## 로드맵 (MVP)

1. GitHub OAuth 로그인 → 본인 전체 레포·커밋 수집·저장 ✅
2. 지식그래프: 정적 분석 + (선택) 로컬 LLM 추출 → JSON 그래프 ✅
3. MCP 서버로 그래프 노출 (Claude Desktop/Cursor)
4. 2D 도서관 뷰: 책장 + 책 클릭 → 상세 + 관련 책 하이라이트
5. AI 사서 채팅 (GraphRAG 질의응답)
