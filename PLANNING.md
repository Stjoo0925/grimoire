# Grimoire 기획서

> "내 커밋들이 마법서가 되어 꽂히고, 서로 연결되어 말을 거는 **살아있는 마법 도서관**"

## 1. 컨셉

**Grimoire(그리무아르)** — 개발자의 GitHub 이력을 **마법 도서관**으로 시각화하고, 커밋 내역을 메모리 삼아 **지식그래프**를 구축해, AI 사서와 함께 탐험하는 **인터랙티브 2D 서재**.

- 레포 = 마법서 한 권 (책등 색 = 주 언어)
- 커밋 = 마법서의 페이지 / 집필 기록
- 언어 = 마법 계열 / 서가 분류
- 잔디 = 수련 일지 / 열람 달력
- README = 서문 / 마법서 해제(解題)

## 2. 3층 아키텍처

```
┌─────────────────────────────────────┐
│ ③ 인터랙티브 도서관 (Experience)      │
│    2D 서재 UI + AI 사서              │
├─────────────────────────────────────┤
│ ② 지식그래프 (Brain)                 │
│    커밋·README → AI 추출 → 노드/엣지  │
├─────────────────────────────────────┤
│ ① 수집기 (Collector)                 │
│    GitHub API (OAuth 인증)           │
└─────────────────────────────────────┘
```

## 3. 층별 상세

### ① 수집기 — GitHub API + OAuth

- **인증: GitHub OAuth 로그인** (본인 public + private 전체 접근)
  - OAuth App 등록 (GitHub Settings → Developer settings)
  - 스코프: `read:user` + `repo`
  - 토큰은 서버 세션에만 보관, private 데이터는 본인에게만 표시
  - rate limit 5,000회/시간 자동 확보
- 수집 데이터: `repos`, `commits`, `languages`, README, GraphQL 잔디(`contributionsCollection`)
- **수집 후 로컬 저장** (매번 API 호출 X — "소장" 개념)
- 데이터 범위 참고:
  - 커밋/이슈/PR: 전체 이력 (100개씩 페이지네이션)
  - Events API는 90일/300개 제한 → 사용하지 않음
  - 잔디: 연도별 1년 단위 반복 호출로 전체 소급

### ② 지식그래프 — 커밋이 메모리

> 상세 설계는 [KNOWLEDGE_GRAPH.md](KNOWLEDGE_GRAPH.md) 참조. 아래는 채택 방침.

- **온톨로지**: 노드 `Project` · `Tech` · `Concept` · `Problem` · `Period` / 엣지 `USES` · `ABOUT` · `SOLVED` · `LEARNED` · `DEVELOPED` · `RELATED_TO` · `DEPENDS_ON`
- **추출 파이프라인** (KNOWLEDGE_GRAPH.md 4장):
  1. 정적 분석 (의존성 매니페스트 파싱 → Tech, 비용 0)
  2. 커밋 필터링·그룹화 (LLM 컨텍스트 최소화)
  3. LLM 구조화 추출 (Concept / Problem / Learned)
  4. 엔티티 정규화 (canonical ID 일원화)
- **LLM은 스위치 가능하게 추상화**: 로컬 Ollama(무료·프라이빗) ↔ Claude API(고품질) — env로 선택
- **저장은 단계적**: 1차 JSON 그래프 + 임베딩 파일 → 2차 Neo4j + Qdrant (Docker)
- 이 그래프가 "AI 사서의 기억" — GraphRAG 질의응답의 근거
- 확장: **MCP 서버**로 노출해 Claude Desktop/Cursor에서 세컨드 브레인 직접 쿼리 (2차)

### ③ 인터랙티브 도서관 — 2D 게임적 경험

- **공간**: 책장이 늘어선 2D 서재. 언어별 서가, 연도별 층
- **책**: 레포 = 책 한 권. 뽑으면 펼쳐지며 커밋 연혁이 페이지로
- **연결의 시각화**: 책을 뽑으면 지식그래프상 관련된 책들이 은은히 빛남
- **비공개 서고**: private 레포는 별도 구역 (본인만 열람)
- **AI 사서**: "실시간 기능 다룬 책 어딨어?" → 해당 서가로 안내
- **성장 요소**: 새 커밋 → 페이지 증가, 새 레포 → 신간 입고, 새 기술 → 새 서가 개설

## 4. 데이터 흐름

```
GitHub OAuth 로그인
   └─> GitHub API ─수집─> 로컬 저장(raw)
              └─AI 분석─> 지식그래프(nodes/edges + 임베딩)
                              ├─렌더링─> 2D 도서관 씬
                              └─RAG─> AI 사서 응답
```

## 5. 배포·사용 형태 (하나의 코어, 세 진입점)

```
                ┌──────────────────────────────┐
                │       Grimoire Core           │
                │  src/lib/{collector,graph}    │
                │  + query (GraphRAG 검색)       │
                └──────┬───────┬───────┬───────┘
                       │       │       │
  ① Next.js 웹앱   ② MCP 서버(stdio)   ③ CLI(헤드리스)
  (2D 서재+사서)   (Claude Desktop/     (수집·빌드만)
                    Cursor 쿼리)
                       │
                    ./data  ← 단일 데이터 계약
          (스냅샷·그래프 JSON → 2차: Neo4j/Qdrant)
```

- **원칙 1**: `./data`가 유일한 진실 — 웹앱이 만든 그래프를 MCP가 그대로 읽음
- **원칙 2**: 저장소 추상화 — JSON → Neo4j/Qdrant 전환 시 진입점 무변경
- **원칙 3**: MCP는 stdio 프로세스 (`node dist/mcp.js`) — 도커 없이도 동작

### Docker: compose 프로파일 조립식

| profile | 서비스 | 비고 |
|---|---|---|
| `app` | Next.js 웹 | |
| `llm` | Ollama | `OLLAMA_MODEL`로 qwen/deepseek distill 선택 |
| `db` | Neo4j + Qdrant | 2차(그래프 DB 전환) 때 |

시나리오: 웹만(`npm run dev`) / 풀 로컬(`--profile app --profile llm`) / MCP만(그래프 빌드 후 Claude Desktop 등록) / 전부(같은 `./data` 공유).

## 6. 로드맵

1. **1차 ✅**: OAuth 수집기 → 지식그래프 층 (JSON, 추출기 스위치 none/ollama/claude)
2. **2차 ✅: MCP 서버** — 도구 3종(stdio + 원격 HTTP·Bearer), Claude Desktop 등록 완료
3. **3차 ✅: Docker 패키징** — compose 프로파일(app/llm/mcp/db), GPU 오버레이, named volume
4. **4차 ✅: 2D 서재 UI** — 책장·책·발광·AI 사서 채팅. (초기의 상태창·업적·잔디 "게임 층"은
   관찰형 게임으로 방향 전환하며 제거 — 아래 4-b가 최종 UI)
4-b. **4-b ✅: 관찰형 게임 — 탑다운 도서관 방** *(핵심 비전, 최종 UI)*: 스크롤 없는 한 화면.
   타일 바닥·달빛 창문·현판의 방에 언어별 책장(가구)이 통로를 두고 배치되고, 사서 NPC가
   그 통로를 걸어다니며 최근 커밋된 책을 꽂고(말풍선=작업 로그) 먼지를 털거나 책을 훑는다.
   하단은 RPG 대화창 — 사서에게 물으면 답이 뜨고, 언급된 책의 책장으로 걸어가 가리키며 발광.
   수집·그래프·모델설정은 HUD 버튼 → 오버레이 창.
5. **5차: GraphRAG 고도화**
   - **5-a ✅: 로컬 임베딩 시맨틱 검색**: nomic-embed-text(Ollama)로 노드 텍스트(`이름+타입+요약`)
     임베딩 → 그래프 JSON에 보관 → 사서/MCP 검색을 키워드+시맨틱 RRF 융합으로. 모델 없으면
     키워드로 조용히 폴백, 재빌드 시 같은 텍스트는 벡터 재사용. 외부 API 없음(§7).
   - **5-b (보류): Neo4j/Qdrant 전환** — 현재 규모(노드 ~370)에선 JSON+임베딩으로 충분.
     그래프가 JSON으로 버거워지거나 2-hop Cypher가 필요해질 때 실측 후 착수.

### 미루는 것

- 3D 공간 / 멀티유저 / 업적 시스템 / GitHub 외 저장소 연동
- 일반 유저용 호스팅 서비스화 (서버 측 API 추출 티어 — DeepSeek API 후보)

## 7. 프라이버시 원칙 (불변)

> **내 데이터(커밋·README·private 레포)는 외부 LLM API로 전송하지 않는다.**

- 추출기 기본값은 `none`(정적) / `ollama`(로컬). 외부 API 추출기(claude/deepseek)는 코드로 존재하되 **명시적 opt-in 전엔 호출 불가** — auto 모드가 API 키 존재만으로 외부를 선택하는 것 금지
- 임베딩은 로컬 nomic-embed-text, AI 사서 응답 합성도 로컬 Ollama
- **MCP 주의사항**: 외부 LLM 클라이언트(Claude Desktop 등)에 연결하면 질의된 서브그래프만큼은 해당 LLM에 노출됨 — 문서에 명시하고, 완전 폐쇄가 필요하면 로컬 LLM 클라이언트에 연결
- 외부 API 티어(DeepSeek 등)는 향후 "타 유저 서비스화" 시나리오 전용, 본인 데이터엔 미적용

## 8. 결정 사항 로그

| 결정 | 선택 | 이유 |
|---|---|---|
| 인증 | GitHub OAuth | private 이력 포함, rate limit 확보 |
| 렌더링 | 2D | 빠른 완성, 그래프·AI에 집중 |
| 데이터 처리 | 수집 후 저장 | 다년치 이력 보존, 속도 |
| 그래프 저장 | JSON + 임베딩 → 추후 그래프 DB | MVP 경량화 |
| 프로젝트명 | **Grimoire** | 커밋이 쌓여 완성되는 나만의 마법서 |
| 그래프 설계 | KNOWLEDGE_GRAPH.md 채택 (온톨로지·파이프라인·MCP) | 상세 설계서 기반 |
| LLM 추출기 | Ollama/Claude 스위치 가능 인터페이스 | 무료·프라이빗 vs 고품질 절충 |
| 그래프 저장 1차 | JSON (Neo4j/Qdrant는 2차) | MVP 부품 최소화 |
| 사용 형태 | 웹앱 · MCP 서버 · CLI 3진입점, `./data` 공유 | 세컨드 브레인 가치 극대화 |
| MCP 우선순위 | 2차로 앞당김 (2D UI보다 먼저) | 적은 코드로 즉시 가치 실현 |
| 로컬 LLM 모델 | 기본 qwen2.5:7b, `OLLAMA_MODEL`로 교체 가능 | R1 distill은 추출 작업에 비효율 |
| 프라이버시 | 외부 LLM API 전송 금지 (로컬 기본, API는 opt-in) | §7 불변 원칙 |
| LLM-free 모드 | `GRAPH_EXTRACTOR=none` 정식 티어 | 정적 분석만으로 온톨로지 ~70% 성립 |
| 최종 배포 형태 | **올인 컨테이너** — 웹·MCP·데이터 전부 도커 내부 | 데이터는 named volume, MCP는 `docker run -i`. 호스트 바인드 마운트·`npm run dev`는 개발 편의용 과도기 |
| 원격 MCP | 개인 서버 배포, `MCP_TRANSPORT=http` + Bearer 토큰 필수 | 어디서든 세컨드 브레인 접속. TLS는 Caddy/Cloudflare Tunnel, 무인증 노출 금지 |
