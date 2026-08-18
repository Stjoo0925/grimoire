# Grimoire

> "내 커밋들이 마법서가 되어 꽂히고, 서로 연결되어 말을 거는 **살아있는 마법 도서관**"

개발자의 GitHub 이력을 **마법 도서관**으로 시각화하고, 커밋 내역을 메모리 삼아 **지식그래프**를 구축해, AI 사서와 함께 탐험하는 **인터랙티브 2D 서재**입니다.

- 레포 = 마법서 한 권 (책등 색 = 주 언어)
- 커밋 = 마법서의 페이지
- 언어 = 서가 분류 / 잔디 = 수련 일지 / README = 서문

전체 기획은 [PLANNING.md](./PLANNING.md) 참고.

> 현재 상태: **스캐폴드 단계**. 인증 뼈대와 3층 폴더 구조만 있고 수집·그래프·도서관 로직은 아직 미구현 스텁입니다.

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
| ① 수집기 | `src/lib/collector/` | `types.ts` (Repo/Commit/ContributionDay), `github.ts` (페처 스텁) |
| ② 지식그래프 | `src/lib/graph/` | `types.ts` (GraphNode/GraphEdge, 엣지 `uses`·`about`·`relatedTo`·`learned`), `builder.ts` (빌더 스텁) |
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

### 그 외 명령

```bash
npm run build   # 프로덕션 빌드
npm start       # 빌드 결과 실행
npm run lint    # ESLint
```

## 로드맵 (MVP)

1. GitHub OAuth 로그인 → 본인 전체 레포·커밋 수집·저장
2. Claude로 레포당 개념 태그 + 관계 추출 → JSON 그래프
3. 2D 도서관 뷰: 책장 + 책 클릭 → 상세 + 관련 책 하이라이트
4. AI 사서 채팅 (그래프 기반 질의응답)
