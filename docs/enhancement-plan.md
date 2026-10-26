# Grimoire 강화 계획안 — "찾아주는 도구"에서 "커밋에 묶인, 근거 있는 기억"으로

> 2026-10-26 작성. [improvement-plan.md](./improvement-plan.md) §7~9의 측정 기록, 현재 코드(v0.6.1), Claude Code 훅 사양(2026-10 문서)을 대조해 세웠다.
> 같은 날 두 차례 조사를 더했다. 1차(§9)는 2026년 논문·프로젝트 12건의 요약, 2차(§10)는 다섯 갈래(메모리 형식·게이팅, 하네스 주입 관행, 공변경·취약도·테스트, 세션→커밋 연결, 벤치 구성, 경쟁 지형)의 원문 정독이다. 본문의 설계값은 2차 조사 기준으로 고쳤고, 바뀐 곳은 "§10 참고"로 표시한다.
> 이 문서는 **에이전트 코딩에 실질적으로 도움이 되는가**만 기준으로 삼는다. 검색 정확도는 그 수단일 뿐 목표가 아니다.

## 0. 요약과 핵심가치

### 핵심가치 (제안)

**한 줄로:**

> **Grimoire는 "이 코드를 왜 이렇게 고쳤는지"를 커밋에 붙여 두었다가, AI가 그 파일을 고치려는 순간 다섯 줄로 귀띔해 주는 내 컴퓨터 안의 기억이다.**

영어로: *Memory that cites the commit — your git history, with the why, handed to the agent right before it edits.*

**쉬운 말로 풀면**

AI 코딩 도구는 매번 새로 출근한 신입 같다. 어제 뭘 했는지, 그 코드를 왜 그렇게 짰는지, 그 파일을 건드리면 어디가 같이 깨지는지, 뭘 돌려 봐야 확인이 되는지 전부 모른 채 일을 시작한다. 그래서 잘 고쳐 놓은 코드를 "정리"해 버리고, 지난주에 실패했던 방법을 또 시도하고, A를 고치면서 늘 같이 바뀌던 B를 빠뜨린다.

그 답은 사실 이미 내 컴퓨터에 있다. git 기록에는 누가 언제 어떤 파일을 고쳤는지가 전부 남아 있다. 빠진 것은 딱 하나, **"왜"**다. 커밋 메시지에는 "무엇을 바꿨다"만 적히고, 그때 내가 AI에게 했던 말("검색이 느려서 p95를 20ms 아래로 내려 줘"), 어떤 테스트를 돌려 확인했는지, 어떤 방법을 시도했다가 버렸는지는 대화창이 닫히는 순간 사라진다.

Grimoire가 하려는 일은 세 가지다.

1. **"왜"를 커밋에 붙여 둔다.** AI와 작업하다가 커밋이 생기면, 그 직전에 내가 했던 말과 돌린 테스트 명령, 고쳤다가 되돌린 파일을 그 커밋 번호에 묶어 저장한다. 요약하거나 꾸미지 않고 원문 그대로. 나중에 "왜 이렇게 했지"를 물으면 그때 내가 쓴 말 그대로 찾아진다.
2. **고치려는 순간에 귀띔한다.** AI가 어떤 파일을 편집하려고 하면, 그 파일에 대해 "최근에 누가 왜 고쳤는지, 이 파일이 바뀔 때 같이 바뀌는 파일과 테스트가 뭔지, 요즘 자주 고장 나는 파일인지"를 다섯 줄 안에 건넨다. 물어보지 않아도, 딱 그때만, 같은 파일엔 한 번만. 줄 게 없으면 아무 말도 안 한다.
3. **전부 내 컴퓨터 안에서.** 서버도, AI 모델도, 별도 설치도 없다. SQLite 파일 하나에 내 모든 저장소의 기록이 들어가고, 코드는 한 줄도 밖으로 나가지 않는다. 한국어로 물어도 영어 식별자를 찾는다.

**왜 이게 남들과 다른가**

- 대화를 통째로 기억하는 도구들(claude-mem, Mem0 등)은 "그때 AI가 뭐라고 했는지"는 알지만 **어느 커밋 이야기인지** 못 댄다. 근거가 없는 기억은 틀려도 알 수 없다.
- 코드 구조를 분석하는 도구들(repowise 등)은 "같이 바뀌는 파일"까지는 알려 주지만 **"왜"는 없다.** 그리고 대부분 파이썬이나 임베딩 모델, 유료 서버가 필요하다.
- 깃허브 Copilot이나 Claude Code는 최근 커밋에 "이 커밋을 만든 세션 링크"를 남기기 시작했다. 재료는 생기고 있는데, 그걸 **내 컴퓨터에서 모아 커밋에 묶고 편집 직전에 꺼내 주는 도구는 아직 없다.** 그 빈자리가 Grimoire의 자리다.

**이 말이 맞는지 어떻게 아나**

말이 아니라 숫자로 확인한다. 과거에 내가 고쳤던 버그를 AI에게 다시 고치게 해서, Grimoire가 있을 때와 없을 때 "고치는 데 든 비용", "다른 테스트를 깨뜨린 횟수", "같이 고쳐야 할 파일을 빠뜨린 횟수"를 비교한다(§3-4). 여기서 나아지지 않으면 "고치려는 순간에 귀띔한다"는 생각이 틀린 것이고, Grimoire는 "근거를 대는 검색 도구"로 돌아간다. 그것도 쓸모지만 핵심은 아니다.

**근거 요약** (상세는 §10-7)

| 기둥 | 뜻 | 뒷받침하는 사실 |
|---|---|---|
| **근거** | 모든 답에 저장소·커밋·파일:줄 | 커밋 검색 기능을 빼면 AI의 버그 해결율이 48%에서 38%로 떨어졌다. 인용을 다시 확인하는 기억은 Copilot의 PR 머지율을 83%에서 90%로 올렸다. 개발자 78.7%가 AI 답의 출처를 중요하게 본다 |
| **왜** | 커밋에 붙인 그때의 말·테스트·결정 | 커밋은 "무엇"만 남기고 "왜"를 버린다. 커밋에 "왜"를 적는 규약(Lore, QAC)과 플랫폼 꼬리표(Copilot, Claude Code)가 생기는 중이지만, 그걸 로컬에서 모아 쓰는 도구는 없다 |
| **때** | 편집 직전, 다섯 줄, 파일당 한 번 | 효과가 확인된 기억은 다섯 줄 안팎이고 평균 65줄짜리는 오히려 해로웠다. 기존 기억 도구 12개 조합 중 11개가 없느니만 못했다. 도구가 실행되는 길목에서 주는 규칙은 프롬프트에 적어 둔 규칙보다 더 잘 지켜졌다(55%→70%) |

이 세 기둥을 **동시에** 가진 도구는 조사에서 없었다(§10-6). 가장 가까운 repowise는 공변경·능동 훅·다중 레포를 갖췄지만 Python+임베딩+AGPL/유료이고 커밋에 "왜"를 묶지 않는다. claude-mem·Mem0·agentmemory는 기억의 원천이 대화라 sha를 못 댄다. Copilot Memory는 호스팅이고 단일 레포다.

### 축의 전환

지금까지의 개선은 "질문을 받으면 맞는 커밋을 찾는다"는 축을 따랐고, 그 축은 측정으로 한계가 확인됐다(§1). 에이전트 코딩에서 Grimoire가 실제로 줄일 수 있는 비용은 **에이전트가 모르는 채로 지나가는 것**에 있다: 그 파일을 왜 그렇게 고쳤는지, 그 파일을 고치면 어디가 같이 바뀌는지, 어떤 접근이 이미 실패했는지, 뭘 돌려서 확인했는지. 이 넷은 git 어디에도 없고, 에이전트는 모르는 것을 물어볼 줄 모른다.

1. **재료**: 커밋에 "왜"와 "검증"을 묶어 색인한다 — 커밋 트레일러 파싱(훅 없이), 그리고 Claude Code 훅으로 세션의 사용자 프롬프트·검증 명령·버린 편집을 **다음 커밋 sha에** 결정론적으로 연결한다. LLM 요약 없이 원문만.
2. **전달**: 물어볼 때만 답하던 것을, **파일을 편집하려는 순간** 먼저 건넨다 — PreToolUse(Edit·Write) 훅이 그 파일의 최근 변경·"왜"·공변경 파일·같이 바뀌는 테스트·취약도를 400자 안에 주입한다.

효용은 "sha를 맞혔나"가 아니라 **"실제 수정 작업을 더 적은 비용으로, 회귀 없이 끝냈나"**로 잰다(§3-4, §5). 지키는 원칙은 그대로다: LLM·임베딩·데몬 없음, 커밋에 묶인 기억만, 응답은 토큰 예산 안에서.

| 단계 | 내용 | 효용이 닿는 실패 유형 | 측정 | 기간 |
|---|---|---|---|---|
| P0 | 파일 맥락 코어(`fileContext`) + 공변경·테스트 지도·import 역방향·취약도 집계 + `file_context` 도구 | 불완전한 변경(A 고치고 B 빠뜨림), 회귀(돌릴 테스트 모름) | 오프라인: 시간 분할 공변경·테스트 예측 | 2~3일 |
| P1 | 훅 러너(`grimoire hook`) + `install --hooks` + 편집 직전 주입 | 맥락 없이 고침 | e2e 훅 단계(지연·크기), 에이전트 하네스 1사례 | 3일 |
| P2 | 커밋 트레일러 파싱(훅 없이) → 세션 캡처 → 커밋에 묶기(프롬프트·검증·버린 편집) | 같은 실수 반복, "왜" 모름 | 새 코퍼스에서만 측정 가능(2주 사용 후) | 3~4일 |
| P3 | 작업 완수 벤치(`taskbench`) — 그리모어 있음/없음 A/B | 전체 효용의 최종 판정 | 해결당 청구 비용·회귀·빠뜨린 파일 | 3일 + 실행 비용 |
| P4 | 세션 시작 요약, 막혔을 때 2단계 주입, 플러그인 패키징(선택) | 세션 간 단절, 막힘 | P3 재실행 | 2~3일 |

## 1. 진단 — 왜 지금 축으로는 더 못 가는가

### 1-1. 검색 레버는 소진됐다

§8·§9의 실험 여섯 개(위치 가중, 불용어, 본문 낱말, porter 어간, 식별자 일치, 커밋 접기)에서 Acc@1은 0.22~0.30 사이를 오갔고, 미리 정한 기준(순증 3문항·p<0.1)을 통과한 것은 사후 선택한 조합 하나뿐이었다. 0.3턴 차이를 에이전트 벤치로 가리려면 빌드당 340회가 필요하다(§7). 더 다듬어도 **판정이 안 되는 영역**에 들어와 있다.

### 1-2. 원인은 알고리즘이 아니라 재료다

§8의 1위 실패 원인 분류: 낱말 일부만 닿음 30개, 하나도 안 닿음 15개. 질문의 말과 커밋 제목의 말이 다르다. 커밋 제목은 "무엇"을 쓰고, 질문은 "왜·어떻게"를 묻는다. 이 간극은 색인에 "왜·어떻게"의 **원문**이 들어가야 메워진다. RepoMem(arXiv 2510.01003)이 LLM 요약으로 얻은 이득이 0.2~1.2pt에 그친 것은 요약이 아니라 **원래 말**이 필요하다는 뜻으로 읽는다. 2차 조사에서 이것이 2026년 메모리 벤치의 일관된 결론임을 확인했다: 찾기 실패는 1.3%, **형식 실패가 69.3%**(§10-1).

### 1-3. 효용의 대부분은 호출되지 않는 데서 사라진다

현재 Grimoire는 pull 전용이다. 에이전트가 `search_memory`를 부르는 것은 사용자가 이력을 물었을 때, 또는 CLAUDE.md에 "먼저 쓰라"고 적어 뒀을 때다. **구현 작업 중 스스로 과거를 찾아보는 일은 거의 없다.** 그 결과 세션마다 도구 정의 약 2,000자를 내고도, 가장 값진 순간(파일을 고치기 직전)에는 아무 것도 주지 못한다. "효용 = 맞힌 질문 수"가 아니라 "효용 = 알려줘서 막은 실수 수"로 보면, 지금 구조는 분모의 대부분을 놓친다.

### 1-4. 에이전트 코딩에서 반복되는 실패 네 가지

| 실패 | 지금 git·에이전트가 못 보는 이유 | 어떤 기억이 막나 |
|---|---|---|
| **불완전한 변경**: A를 고치고 늘 같이 바뀌던 B를 빠뜨림 | 공변경은 `commit_files`에 있지만 아무도 집계하지 않음 | "A가 바뀔 때 80%는 B도 바뀜" |
| **의도 훼손**: 이유가 있어 그렇게 된 코드를 "정리" | 이유는 커밋 제목에 없고 당시 대화에만 있었음 | 그 커밋에 묶인 당시 사용자 프롬프트, `Constraint:`·`Rejected:` 트레일러 |
| **실패 반복**: 전에 깨졌던 접근을 다시 시도 | 되돌린 편집은 커밋에 흔적이 없음 | "그때 X를 편집했다가 커밋에서 뺐다", "테스트 N회 실패" |
| **검증 누락·회귀**: 뭘 돌려 확인해야 하는지 모름 | 테스트 명령은 CLAUDE.md에 있거나 없음. 바닐라 에이전트는 패치당 통과 테스트 6.5개를 깨뜨린다(TDAD) | 그 파일과 같이 바뀌는 테스트, 그 영역을 고친 커밋들이 실제로 돌린 명령 |

넷 모두 **LLM 없이 결정론적으로 기록·집계 가능**하다. 이것이 이 계획의 범위다.

## 2. 원칙

**유지한다**
- LLM·임베딩·데몬 없음. 훅은 짧게 살다 죽는 프로세스이고, 해석은 호출한 AI가 한다. (§10-2: 코딩 하네스 11개 중 코드 검색에 벡터 RAG를 쓰는 것은 0개, "SQLite FTS5가 운용 상한"이라는 것이 2026년 조사 결론)
- DB 하나(`~/.grimoire/grimoire.db`)가 유일한 상태. 훅도 같은 DB를 WAL로 쓴다.
- 응답 토큰 예산. 주입 텍스트에도 예산을 두고 e2e로 지킨다.
- "회수보다 정밀". 줄 것이 없으면 **아무 것도 주지 않는다**. (§10-1: 틀린 짧은 기록은 긴 기록보다 더 해롭다 — 믿어 버리기 때문)

**새로 세운다**
- **커밋에 묶인 기억만 남긴다.** 세션 중 모은 것은 임시이고, 커밋이 생길 때만 그 sha에 붙어 영구화된다. 커밋 없이 끝난 세션의 기록은 14일 뒤 지운다. 대화 전체를 저장하는 세션 메모리 도구와 자리를 겹치지 않는다.
- **원문만, 요약 없음. 단 형태는 고정.** 사용자 프롬프트는 쓴 그대로(길이 상한만), 검증 명령은 명령 그대로, 버린 편집은 경로 그대로. 커밋당 기록의 **형태**는 "어디(파일·심볼) → 왜(의도·원인) → 무엇(바뀐 선언) → 검증(명령)"으로 고정한다 — 효과가 확인된 기록의 공통 꼴이다(§10-1).
- **훅은 절대 작업을 막지 않는다.** 항상 exit 0, 자체 타임아웃 3초, 오류는 로그 파일로. Grimoire 때문에 편집이 느려지거나 멈추면 사용자는 끈다.
- **프라이버시는 기본값이 보수적.** 캡처는 `install --hooks`로 명시적 opt-in. `<private>…</private>` 구간·비밀 패턴(토큰·키·`password=`)은 저장 전에 지운다. 도구 출력은 저장하지 않는다(실패한 테스트의 stderr 끝 300자만 예외). 프롬프트는 git 밖(DB)에만 둔다 — git-ai도 같은 선택을 했다(§10-4).
- **한 번에 하나.** 주입은 파일당 기록 하나(top-1), 세션당 한 번. 여러 커밋이 걸리면 가장 최근의 "검증 신호가 있는" 커밋 하나만.

## 3. 강화 항목

### 3-1. 파일 맥락 코어 — `fileContext(repo, path)` (P0)

하나의 코어 함수가 훅(3-2)과 MCP 도구, CLI를 모두 먹인다. 입력은 레포와 파일 경로, 출력은 다음 여섯이다.

| 항목 | 출처 | 규칙 |
|---|---|---|
| `recent` | `commits` ⨝ `commit_files` | 그 경로를 건드린 의미 있는 커밋 최근 3개: sha 10자·날짜·`me`/이름·제목. 이름 바꾸기는 `--name-status`의 R 레코드로 따라간다(git-insight-mcp가 못 하는 것) |
| `why` | `commit_context`(3-3) | `recent` 중 **검증 신호가 있는 가장 최근 커밋 하나**의 의도 첫 줄(120자). 그 커밋의 변경 파일이 HEAD에 하나도 없으면 생략 |
| `related` | `cochange` ∪ `file_imports` | 신뢰도 ≥ 0.5, 지지도 ≥ 3인 공변경 파일 최대 3개와 `n/m`. import 이웃이기도 하면 맨 앞. 신뢰도 ≥ 0.7은 "strong", 0.5~0.7은 "likely"로 표시 |
| `tests` | `cochange` 중 테스트 파일 + 이름 규칙 | 이름 규칙 짝(`foo.ts`↔`foo.test.ts`·`test_foo.py`)은 지지도와 무관하게 첫 자리. 그 다음 같이 바뀐 테스트 파일을 신뢰도·최근순으로 최대 2개 |
| `usedBy` | `file_imports` 역방향 | 이 파일을 import하는 파일 수와 상위 3개. 5개 이상일 때만 |
| `fragile` | `commits` ⨝ `commit_files` | 최근 90일 fix류 커밋이 2개 이상 **이고** 그 파일 전체 커밋의 30% 이상일 때만, **이유와 함께**("fixes(90d): 3 — a1b2c3 'fix: …', …") |

**공변경 집계** (`cochange` 테이블, 동기화 때 증분 갱신; §10-3 참고):
- 대상 커밋: `meaningful = 1`, 머지 커밋 제외, 변경 파일 **2~10개**(설정 가능). 문헌의 전통적 상한은 30이지만 10개 시스템 측정에서 MAP은 6~8개에서 최고이고 10·20·30·무제한으로 갈수록 유의하게 떨어진다. 커밋의 96%는 10개 이하라 잃는 것이 거의 없다.
- 이력 길이는 **시간이 아니라 커밋 수**로 센다. 1만5천 커밋까지는 전체를, 그 이상이면 최근 1만5천 커밋. "오래된 이력이 해롭다"는 증거는 3만5천 커밋까지 없었다.
- 쌍 (a, b)에 대해 `support = |a∧b|`, `confidence = |a∧b| / |a|` — **양방향**(a→b와 b→a는 다르다). 경로마다 confidence 상위 8개만 저장. 지지도 3 미만은 저장하되 "weak"로 표시해 훅에서는 안 쓴다(작은 레포는 2까지 허용하는 설정).
- **정렬은 최근순, 필터는 신뢰도.** 신뢰도로 자르고(≥0.5, 0.8 넘게 올리면 정밀도·재현율이 같이 떨어진다) 표시 순서는 마지막 공변경 날짜 최근순. 신뢰도 순 정렬은 10개 시스템에서 가장 나빴다.
- **신선도.** 공변경 모델은 커밋 20개 뒤 3%, 200개 뒤 8% 낡는다. 동기화마다 새 커밋의 쌍만 더하는 증분 갱신으로 항상 최신을 유지한다. 밤에 한 번 집계하는 설계는 안 된다.
- 남는 노이즈의 주범은 "무관한 변경을 한 커밋에 섞은 것"이라 필터로 다 지울 수 없다. 그래서 신뢰도 문턱을 0.5로 두고, 도구 설명에 "확인하라는 후보이지 고치라는 지시가 아니다"를 적는다.
- 색인 추가: `CREATE INDEX commit_files_path ON commit_files(repo_id, path)` — 지금은 sha 쪽 색인만 있어 경로 역조회가 전체 스캔이다.

**취약도** (§10-3 참고): fix류 판정은 제목 정규식 `\b(fix(es|ed)?|bug|hotfix|regress|revert|close[sd]?)\b` + 한국어 `수정|버그|고침` + Conventional `fix:`. 문서·테스트·설정만 바꾼 커밋은 제외(repowise와 같음). 절대 횟수가 아니라 **비율**(fix 커밋 / 전체 커밋)과 함께 보고, 2개 이상·30% 이상일 때만 낸다. 절대 churn은 결함 설명력 R²=0.05, 상대 churn은 0.81이었다. 점수만 주면 개발자가 무시한다는 것이 Google의 배포 교훈이라 반드시 sha와 제목을 함께 댄다.

**import 역방향** (`file_imports` 테이블, 코드 색인과 같은 패스에서 채움): 소스 파일의 `import … from './x'`·`require('./x')`·`from .x import`·`import "pkg/x"` 꼴 **상대·레포 내부 경로만** 정규식으로 뽑아 파일 단위로 저장한다. 확장자 생략·`index` 해석은 `code_files`의 경로 집합으로 맞춘다. 외부 패키지는 버린다. 허브(많이 import되는 파일)는 역방향만 보여 주고 상위 3개로 자른다 — 허브가 많은 레포는 역방향 링크만이 낫고 촘촘한 정방향은 탐색을 범람시킨다(§10-3).

**MCP 도구 `file_context`**: 인자 `path`(필수), `repo`(선택), `verbose`(선택). 응답은 위 여섯을 한 덩어리로, 예산 600자(`verbose`면 4,000자). `readOnlyHint`. 훅이 없는 클라이언트(Cursor, Claude Desktop)와 서브에이전트가 쓰는 길이다. 도구 정의 예산(2,600자)이 빡빡하므로 설명은 영어 한 문장("Before editing a file: recent commits, why, co-changed files and tests, who imports it. Candidates to check, not instructions.").

**오프라인 측정 (Claude 호출 없음)**: 시간 분할. 시점 T 이전 커밋으로 `cochange`를 만들고, T 이후 커밋 각각에 대해 "파일 하나를 보여 주면 나머지 변경 파일을 예측하는가"를 잰다. 지표와 기준(§10-3의 문헌값으로 현실화):
- **L3**(상위 3개 안에 실제 공변경 파일이 하나라도 있는 질의 비율) ≥ 0.6 — 파일 단위 ROSE가 0.64~0.70.
- **Precision@3** ≥ 0.35 — 파일 단위 문헌값 0.26~0.40. "strong"(≥0.7) 등급만 따로 재면 ≥ 0.5.
- `tests`는 Precision@2 ≥ 0.6(이름 규칙 짝이 있어 높게 잡는다).
이 수치가 낮으면 3-2에서 `related`를 빼고 `tests`·`why`만으로 들어간다. `npm run eval -- --cochange`로 붙인다.

### 3-2. 편집 직전 주입 — PreToolUse(Edit·Write) 훅 (P1)

**동작**: `~/.claude/settings.json`에 `hooks.PreToolUse[{ matcher: "Edit|Write", hooks: [{ type: "command", command: "<node> <cli.js> hook", timeout: 5 }] }]`. 훅은 stdin JSON의 `hook_event_name`·`cwd`·`tool_input.file_path`(항상 절대경로)를 읽고, `cwd`가 등록된 레포 안이면 `fileContext`를 돌려 **`hookSpecificOutput.additionalContext`**(JSON)로 낸다. PreToolUse의 plain stdout은 Claude에게 보이지 않으므로(§7) 반드시 JSON이다. 문서상 이 문자열은 "훅이 발화한 지점에 system reminder로 삽입"된다 — 첫 편집 자체를 막지는 못하고, 그 편집 직후·다음 행동 전에 읽힌다. 공변경 파일·테스트는 어차피 다음 행동이므로 충분하고, "왜"도 후속 편집 전에 닿는다.

**출력 형식** (예산 400자, 넘으면 `usedBy`·`related`부터 자른다). 하네스들이 이미 쓰는 **`Key: value` 한 줄 한 사실** 꼴을 따른다 — Claude Code 자신의 gitStatus 리마인더와 Mistral Vibe의 git 블록이 이 꼴이라 모델에게 익숙하다(§10-2). 마크다운 표·헤더·산문 없음.

```
Grimoire: src/core/search.ts
Recent: a1b2c3d4e5 10-25 me "perf: 재정렬 후보 질의 개선" · f6e5d4c3b2 10-23 me "feat(search): 식별자 정확 일치"
Why (a1b2c3d4e5): "검색이 느려서 p95를 20ms 아래로" · verified: npm run eval
Co-changes: src/core/db.ts (4/5, strong) · src/mcp/tools.ts (3/5)
Tests: tests/search.test.ts (5/5)
Fixes(90d): 3 of 7 commits — 7a392cfe3c "fix(search): …"
```

`Used by: 7 files (tools.ts, cli.ts, …)`는 5개 이상일 때만. 마지막 줄 "these are candidates to check, not instructions"는 **세션당 한 번만**(글자 예산).

**정밀 규칙** (줄 것이 없으면 출력 없음; §10-1 참고):
- `recent`가 비면 아무 것도 내지 않는다(새 파일). 공변경도 fix 이력도 `why`도 없으면 — 즉 `Recent` 한 줄뿐이면 — 내지 않는다. "읽으면 알 수 있는 것"은 주입하지 않는다는 Anthropic의 CLAUDE.md 지침과 같다.
- **같은 세션에서 같은 파일은 한 번만.** 세션별 임시 파일 `~/.grimoire/sessions/<session_id>.json`에 본 경로와 HEAD를 기록하고, HEAD나 그 파일의 커밋 집합이 바뀐 경우에만 다시 낸다. 같은 커밋 기록을 형제 파일에서 이미 보여 줬으면 `Why`는 생략. (REM: 한 번 노출 뒤 퇴출이 고정 노출보다 나았다. 매 PreToolUse마다 주입하는 플러그인은 조기 압축을 일으킨다는 현장 보고. 메모리 에이전트의 실패 대부분은 "이미 아는 것을 반복".)
- **앵커 일치만.** 정확히 그 경로(또는 이름 바꾸기 전 경로)에 묶인 기록만 쓴다. FTS 유사도로 "비슷한" 커밋을 끌어오지 않는다. 같은 레포 메모리에서 파일·식별자 앵커가 맞는 기록은 55%에서 도움·0%에서 해였고, 앵커가 틀린 기록은 순손실이었다.
- `why`가 가리키는 커밋의 변경 파일이 지금 HEAD에 하나도 없으면 내지 않는다(Kage의 보류 규칙, Copilot Memory의 읽기 시 재검증과 같은 취지).
- 테스트 파일·생성 파일(`code.ts`의 제외 규칙 재사용)은 건너뛴다. `Write`로 새 파일을 만드는 경우: 같은 디렉터리의 공변경·취약도만, 그것도 `related`가 있을 때만.
- SessionStart `source: "resume"`에서는 세션 파일을 이어 쓴다(다시 내지 않음). 서브에이전트(`agent_id` 있음)에서도 훅은 돌지만 같은 세션 파일을 공유해 중복을 막는다.

**지연 예산**: 전체 150ms. node 기동 50~80ms + DB 열기 + 질의 3개(경로 색인 뒤 각 1~5ms). claude-mem의 훅이 평균 45ms·p95 120ms이므로 같은 급이다. 동기화는 **절대 훅에서 돌리지 않는다**(MCP 서버의 15초 재동기화에 맡긴다). (file, HEAD) 단위로 결과를 캐시한다. 150ms를 넘는 측정이 나오면 `hook` 서브커맨드가 `dist/hook.js`를 따로 번들해 import 비용을 줄인다.

**설정 쓰기** (`grimoire install claude-code --hooks`): 기존 `install`의 규칙을 그대로 따른다 — 실행 중인 node의 절대경로, `.bak` 백업, JSON이 깨져 있으면 중단, `--dry-run`. `hooks.<Event>` 배열에 `command`가 `grimoire`·`cli.js hook`를 포함하는 항목이 이미 있으면 바꿔 쓰고, 다른 훅은 건드리지 않는다. Claude Code는 settings 파일을 감시하므로 재시작 없이 적용된다. Windows에서는 명령 문자열의 경로를 큰따옴표로 감싸고 `\`를 이중으로 — 기존 Windows e2e가 이 경로를 함께 검증한다. `grimoire doctor`가 훅 항목의 node 경로·존재 여부를 점검한다.

**측정**:
- e2e 하네스에 "훅 단계" 추가: PreToolUse stdin 픽스처를 `hook`에 넣어 (a) 등록 레포 밖 → 출력 없음, (b) 공변경 있는 파일 → 400자 이내·`Co-changes:` 포함·JSON 형식, (c) 두 번째 호출 → 출력 없음, (d) 깨진 stdin → exit 0·stderr만, (e) 벽시계 150ms 이내, (f) `Recent`만 있는 파일 → 출력 없음.
- 에이전트 하네스 `cochange` 사례: 픽스처 레포에서 A와 B가 늘 같이 바뀌는 상태로 만들고, 내장 도구를 켠 채 "A의 X를 바꿔"라고만 준다. 채점: 답이나 편집이 B를 언급·수정했는가. 훅 있음/없음 각 3회.

**정직한 한계**: 편집 직전 파일 이력 주입을 공개적으로 출시한 도구는 아직 없다. 가장 가까운 repowise의 "최근 버그 수정이 있는 파일 경고" 훅은 공개 수치가 없고, claude-mem의 Read 게이트는 모델에 따라 비용이 6% 줄거나 20% 늘었다. 그러므로 **opt-in으로 내고, P3로 잰다.**

### 3-3. 세션 캡처 → 커밋에 묶기 (P2)

**0단계, 훅 없이: 커밋 메시지 트레일러 파싱** (§10-4 참고). 색인 때 커밋 본문 끝의 `Key: value` 블록을 `git interpret-trailers --parse` 규칙(키 대소문자 무시, 같은 키 반복 가능, 값은 자유 문자열)으로 읽는다. 열거형 검증은 하지 않는다(Lore의 논문·CLI·스킬이 서로 다른 값을 쓴다). 저장 대상 허용 목록:

| 출처 | 키 | 쓰임 |
|---|---|---|
| Lore | `Constraint`, `Rejected`(첫 ` \| `로 대안/이유 분리), `Directive`(`[until:…]` 떼어 만료로), `Tested`, `Not-tested`, `Confidence`, `Scope-risk`, `Reversibility`, `Supersedes`/`Depends-on`/`Related`, `Lore-id` | `why` 본문. `Tested`는 검증 신호 |
| QAC | `Agent`, `Mode`(hitl/autonomous), `What`, `Why` | `why` 본문, 에이전트 커밋 판정 |
| 플랫폼 | `Claude-Session`, `Agent-Logs-Url`, `Agent-Conversation`, `Semantica-Checkpoint`, `Trace-Session`, `Co-Authored-By`/`Co-authored-by`, `Assisted-by` | 세션 링크, 에이전트 커밋 판정 |

`why_text` = `Why` ∪ `Constraint` ∪ `Rejected` ∪ `Directive` ∪ `Not-tested`를 커밋 doc 본문 뒤에 `[why]`로 덧붙여 재색인하고, bm25에서 `body`보다 높게 가중한다. 모르는 키도 저장한다(Lore 규약상 무시되므로 무해). Grimoire가 트레일러를 **쓰는** 쪽(커밋 메시지 수정)은 하지 않는다 — 에이전트의 커밋 워크플로에 끼어들면 그것이 곧 "작업을 막는 훅"이다. 다만 `install --hooks`가 쓰는 CLAUDE.md 두 줄로 "커밋에 `Tested:`·`Rejected:`를 적어라. 오타·형식 커밋엔 쓰지 말고, 지어내지 말고, diff를 되풀이하는 트레일러는 지워라"(Lore 스킬의 규칙)를 권하는 것은 비용이 없다. 트레일러 규약은 아직 채택 데이터가 없다(Lore 32★, QAC 없음) — **있으면 읽되 의존하지 않는다.**

**1단계: 훅으로 모으는 것** (세션 임시 저장 `session_events`, 14일 보존):

| 이벤트 | 훅 | 저장 | 상한 |
|---|---|---|---|
| 사용자 프롬프트 | `UserPromptSubmit` | `prompt` 원문. `<pasted_content>` 블록·`<private>` 구간·비밀 패턴 제거. `/`로 시작하는 슬래시 명령은 제외. jsonl에 append만(이 훅은 턴을 막는다) | 1,000자/건, 커밋당 최근 10건 |
| 검증 실행 | `PostToolUse` matcher `Bash` | `tool_input.command`가 테스트·린트·타입체크 패턴이면 명령과 결과(`stderr`가 비고 `interrupted`가 아니면 pass, 아니면 fail + stderr 끝 300자). 필드명 `ok_guess` | 커밋당 20건 |
| 편집한 파일 | `PostToolUse` matcher `Edit\|Write` | 레포 상대 경로 + **새로 들어간 줄의 해시**(정확 해시와 공백 제거 해시, Agent Blame 방식) | 커밋당 200건 |
| 커밋 | `PostToolUse` matcher `Bash`, `if: "Bash(git commit *)"`(best-effort라 스크립트가 다시 확인), `stderr`에 `nothing to commit`·`error`가 없으면 | `git -C <cwd> rev-parse HEAD`로 sha → 묶기 | — |

`SessionEnd`는 기본 예산이 1.5초라 무거운 일을 두지 않는다 — 묶기는 전부 PostToolUse에서, SessionEnd는 flush만.

**묶기** (커밋 감지 시, 그 세션에서 **직전 커밋 이후** 쌓인 이벤트를 대상으로). `commit_context(repo_id, sha, kind, text, ord)`에 저장, `kind` ∈ `prompt` · `verify` · `dropped` · `trailer:*`. 기록의 **형태**는 2 원칙대로 네 칸이다:

| 칸 | 출처 | 비고 |
|---|---|---|
| 어디 | 커밋의 변경 파일 + `commits.symbols`(이미 있음) | 앵커. 이것이 없으면 기록은 쓸모가 없다 |
| 왜 | `prompt` 첫 건의 첫 줄 + `Why`/`Constraint` 트레일러 | 의도. 증상만 있는 줄(에러 메시지, "안 돼요")은 **왜로 쓰지 않는다** — 증상·요청만 담긴 기록 14건은 전부 순손실이었다(§10-1) |
| 무엇 | `symbols`(바뀐 선언) | 구체적으로. 일반화한 한 문장으로 다시 쓰지 않는다(형식 실패의 18%) |
| 검증 | `verify` 중 pass + `Tested` 트레일러 | 검증 신호가 있는 커밋만 3-2의 `why`에 쓴다(신뢰 등급) |

- `dropped` = 세션에서 편집했으나 그 줄 해시가 커밋 diff에 없는 파일(정확 일치 신뢰 1.0, 공백 제거 일치 0.95). 해석("실패한 접근")은 쓰지 않고 사실("편집 후 커밋에서 제외")만 남긴다.
- 커밋 doc 본문에 `[why]`를 덧붙여 **재색인**한다. 새 doc 종류를 만들지 않고 커밋 doc 자체가 그 말로 검색되게 하는 것이 핵심이다 — "검색이 느려서"라고 물으면 `perf:` 커밋이 직접 뜬다.
- `SearchHit`에 `why?: string`(120자), `detail: "summary"`에 `verify`·`dropped`·트레일러까지. 어느 단계에서도 커밋당 맥락은 **5줄·400자**를 넘기지 않는다.
- 에이전트 커밋 판정: `Co-Authored-By: Claude*`, `Claude-Session`, `Agent-Logs-Url`, QAC `Agent:` 중 하나라도 있으면 에이전트, 아니면 사람. 어떤 신호였는지 기록(평가 코퍼스 분할에 쓴다).
- squash 머지: 머지 커밋은 로컬에서 만들어지지 않으므로 묶이지 않는다. 기존 "같은 변경의 커밋 접기"(제목·파일 집합 동일)가 브랜치 커밋의 맥락을 머지 결과에 함께 싣는다. 파일 집합이 다른 squash는 git-ai의 규칙(줄 해시로 내용 재매칭)을 P4에서 검토한다.
- 세션 기록을 git notes(`refs/notes/grimoire`)로 **내보내는** 명령은 선택 사항(Memento 방식, 팀 공유 M4용). 기본은 DB다: notes는 clone에 따라오지 않고 squash·rebase에서 따로 옮겨야 하며, 원문 전체가 원격에 올라가는 프라이버시 문제가 있다.

**프라이버시·안전**
- `install --hooks`에서만 켜지고, `GRIMOIRE_CAPTURE=0`으로 끈다. 등록 안 된 레포는 캡처도 안 한다.
- 저장 전 필터: `<private>…</private>`, `sk-…`·`ghp_…`·`AKIA…`·`-----BEGIN` 류 토큰 패턴, `password=`·`token=` 뒤 값. 규칙은 `src/core/redact.ts`에 두고 단위 테스트로 고정.
- 저장되는 것은 **사용자의 말과 명령 문자열, 줄 해시**뿐이다. 코드 내용·도구 출력은 실패 stderr 300자 외에 저장하지 않는다.
- 서브에이전트(`agent_id`가 있으면)의 프롬프트는 사용자의 말이 아니므로 건너뛴다.

**측정**: 기존 평가 셋에는 프롬프트가 없으므로 **새 코퍼스에서만** 잴 수 있다. 2주 사용 뒤 (a) 묶인 커밋 비율, (b) 그 커밋들에 대해 당시 프롬프트의 말로 쓴 질문 20개의 Acc@1을 `[why]` 색인 있음/없음으로 짝 비교(§8 기준 그대로: 순증 3문항·p<0.1). 그동안은 e2e로 형식·필터·상한만 고정한다. 트레일러 파싱은 픽스처 커밋으로 단위 테스트.

### 3-4. 작업 완수 벤치 — `e2e/taskbench.ts` (P3)

지금의 `bench`는 "sha를 대는가"를 잰다. 이 계획의 효용은 **실제 수정 작업**에서 잰다. 설계는 SWE-rebench·SWE-smith의 채굴 절차와 2026년 효율 벤치의 보고 규칙을 따른다(§10-5).

**사례 채굴** (`taskbench --mine`, 결과는 `bench/tasks.local.json`, git 제외):
1. 후보 = 자기 레포 커밋 중 머지·revert 아님, 비테스트 소스 ≥1 **그리고** 테스트 파일 ≥1을 건드림(경로 정규식 `(?i)(test(?:ing|s)?|e2e)`), 파일 1~15개, 비테스트 변경 ≤100줄, 부모 존재, 제목·트레일러가 `fix|bug|regress|Why:|Constraint:`에 걸림. 의존성 파일(`package.json`·lockfile·`requirements*`)을 바꾼 커밋은 환경 드리프트 때문에 제외.
2. 레포당 환경 하나를 HEAD에서 만든다(테스트 80% 이상 통과해야 함).
3. 후보마다: 부모 체크아웃 → **테스트 파일 부분만** 적용 → 전체 스위트(2분 타임아웃) → 지금 실패하는 테스트 = F2P 후보. 커밋 체크아웃 → F2P는 통과하고 이전 통과 테스트는 그대로 통과해야 함. **두 상태를 각 3회 돌려 한 번이라도 뒤집히는 테스트는 버린다**(flaky).
4. 기대 수율은 테스트를 건드린 커밋의 5~10%(SWE-rebench V2 7.1%). 사례 40개를 얻으려면 후보 500~1,000개를 훑어야 한다. 처음엔 10개로 파일럿.
5. 문제 서술 = 3-3이 묶어 둔 당시 사용자 프롬프트가 있으면 그것, 없으면 커밋 제목이 아닌 **증상 서술**을 손으로. 수정 힌트는 지운다.

**실행**: 사례마다 부모 커밋의 임시 worktree에서 `claude -p --bare --output-format json`(훅·CLAUDE.md·MCP 설정을 모두 끄고, Grimoire만 `--mcp-config`로, 훅은 `--settings`로 명시). `--max-turns`·`--max-budget-usd` 고정, `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`을 두 모드에 같게, 매 실행 새 세션(`--resume` 금지: 세션 누적 비용이 섞인다).

| 모드 | 조건 |
|---|---|
| `bare` | 내장 도구만 |
| `grimoire` | 내장 도구 + Grimoire MCP + 훅(3-2) — 임시 DB는 **부모 커밋까지만** 색인(시간 마스킹) |

**채점** (사례·모드별, **3 시드**, 블록마다 모드 순서 무작위):
- `pass`: F2P 전부 통과. **`p2p_broken`**: 부모에서 통과하던 다른 테스트를 깨뜨린 수.
- `cost_billed` = 결과 JSON의 `total_cost_usd`; 토큰은 `modelUsage`(서브에이전트 포함. `usage`는 제외라 쓰지 않는다)의 `cacheCreationInputTokens`·`cacheReadInputTokens`·`inputTokens`·`outputTokens`. 캐시가 청구액의 약 80%를 차지하고 토큰 수와 비용의 상관은 0.15라, 토큰만 세면 결론이 뒤집힌다.
- `cost_per_solved` = 모드별 총비용 / 해결 사례 수(실패 실행도 분자에 둔다). 효율의 1차 지표.
- `turns` = stream-json의 `assistant` 메시지 중 `parent_tool_use_id == null`을 `message.id`로 중복 제거한 수. 도구 호출 수는 `tool_use` 블록 수.
- `stray`: 실제 fix가 건드리지 않은 파일을 편집한 수. `missed`: 실제 fix가 건드렸는데 편집하지 않은 파일 수.
- `reverted_edits`: 했다가 되돌린 편집 수. `churn_ratio`: 전체 편집 줄수 / 최종 diff 줄수(해결 사례만).
- `_ok` 변형: 두 모드 모두 해결한 사례만으로 `turns`·`cost`를 비교. 일찍 포기한 쪽이 턴이 적어 보이는 착시를 막는다.
- `subtype`(`success`/`error_max_turns`/`error_max_budget_usd`/`error_during_execution`)을 그대로 기록. 인프라 실패(비용 0)는 제외 장부에 적고, 예산 초과는 실패로 세되 비용은 남긴다.

**규모와 검정** (§10-5의 분산 추정): 실행 간 비용의 급내상관 0.37~0.55를 전제로, 턴·비용 15% 차이를 80% 검정력으로 보려면 **사례 40 × 시드 3 × 모드 2 = 240회**. 통과율 15pt 차이는 100사례 이상이 필요하므로 **통과율은 비열등 가드레일**로만 쓴다. 분석 단위는 사례, 짝지은 log-비용 차이, 사례 단위 부트스트랩 1만 회, 실효 표본수(Kish)를 보고. 먼저 **10사례 × 1시드 파일럿**($10~20)으로 실제 분산을 재고 N을 확정.

**채택 기준 (결과 보기 전 고정)**: `pass`가 떨어지지 않고 `p2p_broken`이 늘지 않으며, 짝지은 `_ok` 사례에서 `cost_billed` 또는 `turns`가 15% 이상 줄거나 `missed`·`p2p_broken`이 유의하게 준다(윌콕슨 부호 순위, p<0.1). 어느 하나라도 `bare`보다 나쁜 사례가 3개 이상이면 원인을 적고 해당 기능을 뺀다. 결과는 평균과 95% 구간을 함께 적고, 단일 셀의 유의성보다 셀 전체의 방향으로 판단한다.

**사례의 "여유"를 미리 본다**: 메모리 벤치에서 짝의 42%는 메모리 없이도 이미 전부 풀려서 기억이 잃을 것밖에 없었다. `bare`가 3회 모두 푸는 사례는 효율 지표에만 쓰고 통과율 비교에서는 뺀다. 사례를 고를 때부터 `bare` 1회를 돌려 "풀리지 않거나 회귀를 내는" 쪽에 무게를 둔다.

비용: Sonnet급 실행당 약 $0.5~1.5 → 240회 **$120~360**, Opus급은 3~4배. 이것이 **첫 질문("없을 때보다 얼마나")의 답을 숫자로 만드는 유일한 길**이다.

### 3-5. 세션 시작 요약과 "막혔을 때" 2단계 — SessionStart·PostToolUse (P4, 선택)

- **SessionStart** (`source`가 `startup`·`clear`·`compact`; `resume`은 제외): 현재 레포에 대해 "지난 세션 이후 내 커밋 3개 + 묶인 `why` + 아직 커밋되지 않은 편집 파일"을 **600자** 안에 plain stdout으로. Claude Code 문서의 예시가 3줄("Current branch / Uncommitted changes / Active issue")이고 claude-mem이 1,100토큰으로 정착했으니 그 사이다. `compact` 뒤 맥락 소실을 가장 싸게 메운다.
- **막혔을 때 2단계** (§10-1의 REM 설계): 세션에서 **첫 번째 실패한 검증 실행**이 감지되면(3-3의 `verify` fail; 테스트 파일 자체를 편집한 뒤의 실패는 제외) 그 세션에서 편집 중인 파일들의 `why`·`verify`·`dropped` 전체(커밋당 5줄, 최대 3커밋)를 **한 번만** `additionalContext`로 내고 다시 내지 않는다. 막히지 않은 세션에는 아무 비용도 없다. REM에서 "막혔을 때 한 번"이 "첫 편집 때 바로"(25.3%)와 "항상 고정"(24.9%)보다 나았다(27.6%).
- 둘 다 매 세션 고정 비용이 될 수 있으므로 **P3 재실행에서 해결당 비용이 줄지 않으면 뺀다**.

### 3-6. 배포 형태 — settings 직접 쓰기 vs 플러그인

- **1차는 `grimoire install claude-code --hooks`가 `~/.claude/settings.json`을 직접 쓴다.** 이미 `install`이 설정 파일을 안전하게 쓰는 코드와 e2e(`--config` 모드)를 갖고 있고, Claude Desktop·Cursor와 같은 명령 체계를 유지한다.
- 플러그인(hooks.json + SKILL.md + .mcp.json 동봉)은 설치가 한 번에 끝나고 SKILL.md로 "편집 전 file_context, 이력 질문엔 search_memory" 라우팅을 실어 줄 수 있어 매력적이지만, 마켓플레이스 등록과 npm 배포의 이중 관리가 생긴다. **P4에서 P3 결과가 좋을 때** 별도로 검토한다. SKILL.md는 **20줄 안쪽**으로 — 107줄 프롬프트를 20줄로 줄이자 해결율이 12→50%로 뛴 보고가 있다(TDAD).
- Codex CLI가 Claude Code와 같은 훅 이벤트 이름을 쓰므로(§10-2) `install codex`는 같은 코드로 가능하다. P4 후보.

## 4. 데이터 모델 변경 (마이그레이션 5)

```sql
CREATE INDEX commit_files_path ON commit_files(repo_id, path);

CREATE TABLE cochange (                -- 동기화 때 증분 갱신. 양방향(path→other)
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  other       TEXT NOT NULL,
  support     INTEGER NOT NULL,
  confidence  REAL NOT NULL,
  last_at     TEXT NOT NULL,           -- 마지막 공변경 날짜 (정렬 키)
  PRIMARY KEY (repo_id, path, other)
);

CREATE TABLE file_imports (            -- 코드 색인 때 채움. usedBy = target으로 역조회
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  target   TEXT NOT NULL,
  PRIMARY KEY (repo_id, path, target)
);
CREATE INDEX file_imports_target ON file_imports(repo_id, target);

CREATE TABLE session_events (          -- 임시. 커밋에 묶이면 commit_context로, 14일 지나면 삭제
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL,
  repo_id     INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- prompt | verify | edit | commit
  text        TEXT NOT NULL,
  path        TEXT,
  line_hashes TEXT                     -- edit: 새 줄의 (정확, 공백제거) 해시 목록
);
CREATE INDEX session_events_session ON session_events(session_id, at);

CREATE TABLE commit_context (          -- 영구. 커밋에 묶인 "왜·검증·버린 편집·트레일러"
  repo_id  INTEGER NOT NULL,
  sha      TEXT NOT NULL,
  kind     TEXT NOT NULL,              -- prompt | verify | dropped | trailer:<이름>
  text     TEXT NOT NULL,
  ord      INTEGER NOT NULL,
  FOREIGN KEY (repo_id, sha) REFERENCES commits(repo_id, sha) ON DELETE CASCADE,
  PRIMARY KEY (repo_id, sha, kind, ord)
);
ALTER TABLE commits ADD COLUMN agent_signal TEXT;   -- 에이전트 커밋 판정 근거 (없으면 사람)
```

`docs_fts` 스키마는 바꾸지 않는다. `[why]`는 커밋 doc의 `body` 컬럼에 덧붙이고 `upsertDoc`로 재색인한다. 노트(`notes`)는 그대로 두고 수동 기록 용도로 남긴다 — 자동 캡처와 수동 노트를 한 테이블에 섞으면 "회수보다 정밀"이 깨진다.

## 5. 단계와 판정

| 단계 | 산출물 | 통과 조건 (결과 보기 전 고정) |
|---|---|---|
| P0 | `fileContext`(recent·why·related·tests·usedBy·fragile), `cochange` 증분 집계, `file_imports`, `file_context` 도구, `eval --cochange` | 공변경 L3 ≥ 0.6 · Precision@3 ≥ 0.35(strong 등급 ≥ 0.5) · `tests` Precision@2 ≥ 0.6 · 도구 정의 예산 2,600자 유지 · `npm test`·`e2e` 통과 |
| P1 | `grimoire hook`, `install --hooks`, `doctor` 훅 점검, e2e 훅 단계, 에이전트 하네스 `cochange` 사례 | 훅 150ms 이내 · 출력 400자 이내·JSON · `Recent`만 있으면 무출력 · `cochange` 사례에서 B 언급율 훅 있음 > 없음 (3회 중 2회 이상 차이) |
| P2 | 트레일러 파싱(먼저) → 캡처·redact·줄 해시·묶기·`[why]` 재색인·`why` 필드·`agent_signal` | 트레일러: 픽스처 커밋 단위 테스트 · redact 단위 테스트 전부 · e2e 캡처 단계(상한·필터·서브에이전트 제외·증상만 있는 줄 제외) · 2주 뒤 새 질문 20개로 §8 기준 |
| P3 | `taskbench --mine`, 파일럿 10사례 → 40사례 × 3시드, 첫 A/B | §3-4 채택 기준. **여기서 "실질적 효용"을 선언하거나 철회한다** |
| P4 | SessionStart 요약, 막혔을 때 2단계, 플러그인·Codex 검토 | P3 재실행에서 해결당 비용 개선 유지 |

각 단계는 이전 단계가 통과해야 들어간다. P2의 0단계(트레일러 파싱)는 P1 없이도 가치가 있으므로 P1이 실패하면 먼저 한다.

## 6. 하지 않을 것과 한계

- **임베딩·형태소 분석기**: §9-4 결정 유지. 3-3이 들어오면 질문의 말과 색인의 말이 같아져 의미 검색의 필요가 더 줄어든다. 하네스 11개 조사의 권고도 "코드에 RAG를 만들지 마라, ripgrep+FTS5보다 낫다는 것을 먼저 증명하라"였다.
- **대화 전체 저장·4계층 메모리·망각 곡선**: 세션 메모리 도구의 영역. Grimoire는 커밋에 묶인 것만.
- **LLM으로 "왜"를 요약**: 비결정적이고 비용이 들며, RepoMem에서 이득이 미미했다. 원문만.
- **UserPromptSubmit마다 검색해 주입**: 매 프롬프트에 노이즈가 붙어 "회수보다 정밀"을 깨뜨린다. 편집 직전(3-2)·세션 시작·막혔을 때(3-5)로 좁힌다.
- **순위 미세조정 추가**: 검정력 부족(§7). 3-3으로 재료가 바뀐 뒤 평가 셋을 다시 만들고 나서야 의미가 있다.
- **LLM이 이력에서 "스킬·관례"를 증류하는 것** (Learning to Commit 류): 효과는 보고돼 있으나 LLM 호출·비결정성이 따른다. Grimoire는 결정론적 재료까지만.
- **원문 전체를 git notes로 기본 저장** (Memento 류): 감사 추적에는 맞지만 기억으로는 너무 길다. 내보내기 옵션으로만.
- **코드 그래프·tree-sitter·repo map**: improvement-plan §9-4 결정 유지. `usedBy`는 정규식 import 한 단계만.
- **repowise와 정면으로 겹치는 것**(코드 건강 점수, 대시보드, 호출 그래프, 커버리지 기반 테스트 선택): 그쪽이 더 잘한다. Grimoire의 자리는 "커밋에 묶인 왜"와 "의존성 0"이다(§10-7).
- **한계로 남기는 것**: 파일 집합이 다른 squash 머지의 맥락 연결, `tool_response`에 exit code가 없어 검증 pass/fail이 추정인 점, 훅이 없는 클라이언트(Cursor·Desktop)에서는 캡처가 안 되고 `file_context` 도구만 쓸 수 있는 점, 공변경의 "섞인 커밋" 노이즈, 편집 직전 주입의 효과가 아직 어디서도 수치로 입증되지 않은 점.

## 7. 확인된 사양과 실측할 것

Claude Code 문서로 확인된 것(2026-10-26): 훅 이벤트 목록과 공통 입력(`session_id`·`cwd`·`tool_name`·`tool_input`·`tool_response`·`agent_id`), `additionalContext`·stdout 주입 경로와 1만 자 상한, exit 0/2 의미, 훅 병렬 실행, `timeout`은 초 단위, settings 병합 규칙, `-p`·resume·compact에서 SessionStart 실행, Bash `tool_response`의 `stdout`·`stderr`·`interrupted`, **PreToolUse도 `hookSpecificOutput.additionalContext`를 받으며 "훅이 발화한 지점에 system reminder로 삽입"되고 `permissionDecision: "defer"`면 무시**, PreToolUse의 plain stdout은 Claude에게 보이지 않음(커뮤니티 실패 사례의 원인), `if`는 규칙 하나·best-effort, `once`는 스킬 frontmatter에서만, Edit/Write의 `file_path`는 항상 절대경로, `SessionEnd` 기본 예산 1.5초, 훅은 서브에이전트 안에서도 돈다, `-p` 결과 JSON의 `total_cost_usd`·`modelUsage`·`num_turns`·`subtype`, `--bare`.

문서로 확인되지 않아 P1 첫날 실측으로 고정할 것:
- PreToolUse `additionalContext`가 실제 대화에서 **어느 위치**에 보이는지(편집 결과 바로 뒤인지). 3-2의 설계는 "다음 행동 전"이면 충분하다.
- PostToolUse `if: "Bash(git commit *)"` 필터의 실제 동작. 스크립트 안의 명령 검사가 1차다.
- `transcript_path` JSONL 구조. 이 계획은 transcript를 읽지 않는다.
- MCP 서버가 SKILL.md를 동봉할 수 있는지. 3-6 판단에만 영향.
- Windows에서 `hooks[].command`의 경로 인용 규칙. 기존 Windows CI에 e2e 훅 단계를 넣어 확인.
- `Agent-Logs-Url`·`Claude-Session`의 정확한 URL 꼴(2차 출처만 있음). 일반 URL로 파싱한다.

## 8. 기대와 정직한 전망

- **확실한 것**: 공변경·테스트 지도·취약도는 이미 있는 데이터의 집계라 비용이 낮고, 오프라인으로 검증된다. 편집 직전 주입은 에이전트가 요청하지 않아도 작동하므로 지금 구조가 놓치는 분모를 처음으로 건드린다. 커밋 트레일러 파싱은 훅 없이도 "왜"를 만든다.
- **가능성이 큰 것**: 커밋에 묶인 원문 프롬프트는 이력 질문의 어휘 불일치(§8 원인 분류의 45문항 대부분)를 정면으로 메운다. 다만 과거 커밋에는 소급되지 않아 효과는 사용 기간에 비례해 나타난다.
- **2026년 연구가 보태는 기대치**: 커밋 검색은 해결율 10pt(Code Researcher), 인용 검증형 기억은 PR 머지율 7pt(Copilot), 가벼운 구조 주입은 왕복 −1.6·분산 절반, 검증된 짧은 경험은 +1~4.5pt. 반면 기존 메모리 시스템 12쌍 중 11쌍은 기준선 이하였고, 메모리는 약한·막힌 실행을 돕고 이미 잘 푸는 실행(상위 모델)은 오히려 해쳤다. 즉 **기대 상한은 "해결당 비용 10~25% 감소, 회귀 감소, 통과율 몇 pt"이고 형식을 잘못 잡으면 음수**다. P3의 15% 기준은 이 범위 안에 있다.
- **모르는 것**: 이 전부가 실제 수정 작업의 비용을 얼마나 줄이는가. 그것은 P3 전까지 숫자가 없고, P3가 나쁘게 나오면 이 문서의 가정이 틀린 것이다. 그래서 P3를 선택이 아니라 **관문**으로 둔다.

## 9. 레퍼런스와 영감 — 1차 조사 (2026-10-26)

2026년 arXiv와 진행 중인 프로젝트에서 이 계획과 **같은 방향**인 것만 골랐다. 방향을 바꾸는 근거가 아니라, 각 항목의 설계 결정과 기대치를 고정하는 근거다. (2차 조사 §10이 이 표의 수치를 원문으로 재확인하고 일부를 고쳤다. 어긋나는 곳은 §10이 우선한다.)

### 9-1. 코딩 에이전트 메모리 — "무엇을, 얼마나 짧게"가 전부다

| 출처 | 결과 | 이 계획에 반영 |
|---|---|---|
| **VibeMemBench** (arXiv 2609.23570, 2026-09) | 이력에서 검증한 짧은 기록(4필드, 5줄 안팎)을 주입하면 5개 모델 중 4개에서 +1.1~4.5pt, 스텝 전부 감소. Mem0·SimpleMem·MemoryOS·A-MEM은 12쌍 중 11쌍이 기준선 이하. 실패의 69%가 **"찾긴 했는데 형식이 나빠서"**, 순위 실패는 1.3% | 커밋당 5줄·400자 상한. "검색 정확도가 병목이 아니다"는 §1의 진단과 일치 |
| **REM** (arXiv 2610.27377) | 같은 경험을 그냥 주입하면 효과 없음. 작은 문서를 시작 때, 비싼 기록은 **막혔을 때만** 한 번 → 27.6 vs 24.9%, 비용 −17% | 3-2 "세션당 파일당 한 번", 3-5 "막혔을 때 2단계" |
| **SWE-ContextBench** (arXiv 2602.08316) | 걸러지지 않은 과거 맥락은 효과가 없거나 음수 | §2 "줄 것이 없으면 아무 것도 주지 않는다" |
| **Learning to Commit** (arXiv 2603.26664) | 이력을 재생하며 관례를 축적 → organic한 PR | 방향은 같지만 LLM 증류라 채택하지 않음(§6) |

### 9-2. 구조 신호 — 가벼운 위상이면 충분하다

| 출처 | 결과 | 반영 |
|---|---|---|
| **Code Isn't Memory** (arXiv 2606.22417) | 구조 색인 유무만 비교: 위치 파악 큰 폭 개선, 해결당 비용 감소, 턴 36.2→28.3 | P3 기대치. `related`·`usedBy`의 존재 이유 |
| **Deterministic Anchoring** (arXiv 2606.26979) | 위상 주입: Func@5 +2.2pt, 왕복 −1.6, 분산 절반, 토큰 +10%. 허브 많은 레포는 **역방향만** | 3-1 `usedBy`는 역방향 한 단계만 |
| **Caprese** (arXiv 2606.21187) | 이력 공변경 P@5 0.49, 혼합 0.58, 런타임 0.71. 머지·30파일 초과 제외, 남는 노이즈는 "섞인 커밋" | 3-1 집계 규칙과 기준치 |
| **LTR vs LLM 공변경** (arXiv 2411.19099) | LLM은 공변경 예측에 약하고 느림 | 공변경은 집계로 |

### 9-3. 검증·회귀 — 테스트 지도는 이력에서 공짜로 나온다

| 출처 | 결과 | 반영 |
|---|---|---|
| **TDAD** (arXiv 2603.17973) | 바닐라 에이전트는 패치당 통과 테스트 6.5개를 깨뜨림. 테스트 지도 + **20줄 SKILL.md**로 −72%. SKILL 107→20줄로 해결율 12→50% | 3-1 `tests`, 3-4 `p2p_broken`, 3-6 SKILL은 짧게 |
| **codebase-memory-mcp** (DeusData) | 증거가 모자라면 좁히지 않는 보수적 기본값 | `tests`는 지지도 3 미만이면 내지 않는다(이름 규칙 짝 제외) |

### 9-4. 세션 → 커밋 연결 — 이미 규약이 생기고 있다

| 출처 | 내용 | 반영 |
|---|---|---|
| **Lore** (arXiv 2603.15566) | 커밋 트레일러로 "결정의 그림자"를 남김 | 3-3 0단계 트레일러 파싱 |
| **Memento** | 세션 트랜스크립트를 git notes에 | 기본은 DB, notes는 내보내기 옵션 |
| "Agent Sessions Are the Real Commit Messages We Discard" | 의도·과정·추론·검증 4층. **의도와 추론은 기본, 과정은 요청 시** | 3-3의 저장 대상 |
| Copilot `Agent-Logs-Url`, Claude Code `Co-Authored-By`·`Claude-Session` | 플랫폼이 커밋에 세션 흔적을 남기기 시작 | 트레일러 허용 목록 |

### 9-5. 전달 — 훅 주입의 현장 교훈

| 출처 | 내용 | 반영 |
|---|---|---|
| mann1x/claude-hooks, blueman82/recall, claude-mem | PreToolUse 주입은 흔한 패턴. "매 PreToolUse마다 주입하면 조기 압축" | 세션당 파일당 1회, 400자 |
| agentmemory #1278 | 주입이 안 닿은 원인: plain stdout + 타임아웃 | JSON으로, 150ms |
| **Kage** | 인용한 코드가 사라지면 기억을 보류 | 3-2 "변경 파일이 HEAD에 없으면 `why` 생략" |
| Anthropic "Effective context engineering" | 참조만 두고 필요할 때 적재 | 3-2는 "그때그때"의 자동화 |

### 9-6. 측정 — 토큰이 아니라 해결당 청구 비용

| 출처 | 내용 | 반영 |
|---|---|---|
| **Token Reduction Is Not Cost Reduction** (arXiv 2607.12161) | 토큰 −38%가 비용 +6.8%. 상관 r=0.15. 캐시가 비용을 지배 | 3-4 `cost_billed`·`cost_per_solved` |
| agent-efficiency-benchmark | `reverted_edits`·`churn_ratio`·`_ok` 변형 | 3-4 지표 |

### 9-7. 출처 (1차)

- VibeMemBench: https://arxiv.org/abs/2609.23570 · REM: https://arxiv.org/abs/2610.27377 · SWE-ContextBench: https://arxiv.org/abs/2602.08316 · Learning to Commit: https://arxiv.org/abs/2603.26664
- Code Isn't Memory: https://arxiv.org/abs/2606.22417 · Deterministic Anchoring: https://arxiv.org/abs/2606.26979 · Caprese: https://arxiv.org/abs/2606.21187 · LTR co-change: https://arxiv.org/abs/2411.19099
- TDAD: https://arxiv.org/abs/2603.17973 · codebase-memory-mcp: https://github.com/DeusData/codebase-memory-mcp
- Lore: https://arxiv.org/abs/2603.15566 · Memento: https://github.com/mandel-macaque/memento · Session-as-commit-message: https://blakecrosley.com/blog/session-is-the-commit-message
- claude-hooks: https://github.com/mann1x/claude-hooks · recall: https://glama.ai/mcp/servers/@blueman82/recall · claude-mem: https://github.com/thedotmack/claude-mem · agentmemory #1278: https://github.com/rohitg00/agentmemory/issues/1278 · Kage: https://github.com/kage-core/Kage · Anthropic context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Token Reduction Is Not Cost Reduction: https://arxiv.org/abs/2607.12161 · agent-efficiency-benchmark: https://github.com/Emmimal/agent-efficiency-benchmark
- Claude Code hooks 문서: https://code.claude.com/docs/en/hooks.md

## 10. 집중 조사 — 2차 (2026-10-26, 원문 정독)

다섯 갈래를 각각 원문(arXiv HTML, 소스 코드, 공식 문서)으로 읽었다. 2차 출처·벤더 수치·미확인은 표시했다. 여기서 나온 설계값이 §3의 본문에 반영돼 있다.

### 10-1. 메모리 형식·게이팅 — 무엇이 실제로 도움이 되나

**VibeMemBench** (arXiv 2609.23570, 111 과제·90 레포·이력 3,634개, 시드 4):
- 기록 형식: 버그 종류·근본 원인·수정 패턴·교훈 4필드, LLM이 이력 하나당 하나 증류. 효과 있는 기록(aiohttp-7907)은 "수정과 앵커 파일(`client_reqrep.py`)을 다섯 줄로". 같은 과제에 334줄짜리 A-MEM 기록은 4/4 → 0/4. 실패 집단의 주입 기록은 중앙값 10줄, 평균 65.1줄, 최대 414줄.
- 실패 분류(231건): 형식 실패 69.3%(수정 패턴이 빠지거나 원문에 묻힘), 커버리지 누락 16.0%, 사용 실패 13.4%, **순위 실패 1.3%**. 형식 실패 중 "지시문 오염" 40%, "일반화해 버린 수정 패턴" 18.1%, 도구 잡음 10%, 스키마에 수정 칸 없음 8.8%. 지시문 줄을 지우면 +0.60, 같은 수의 무작위 줄을 지우면 +0.48 회복 → **해는 지시문이 아니라 분량**.
- **앵커**: 모델이 메모리 없이 못 풀고 기록이 디렉터리·식별자 앵커를 공유하면 58쌍 중 55.2%에서 도움, 해는 0. 메모리 없이 이미 4/4인 짝이 전체의 42% — 거기선 잃을 것만. 무관한 기록 대조군 −0.7~−3.4pt. 주입 예산을 1~5개로 늘려도 0개(67.1%)를 넘지 못함.
- 검증된 기록의 이식: +0.0 / +2.5 / +4.5 / +3.6 / +1.1pt, 모두 신뢰구간이 0을 포함. Mem0·SimpleMem·MemoryOS·A-MEM은 12쌍 중 11쌍 기준선 이하(−5.5~+2.0).
- 원문 기록 예시는 HTML에 없음(미확인).

**REM** (arXiv 2610.27377, NeurIPS 2026 워크숍, Sonnet 4.5, 99과제·3반복):
- 문서 스키마: localize/understand/fix/verify 4단계, 필드 `files_modified, root_cause, fix_approach, related_functions, test_cases, bug_description, error_messages`. 약 270토큰. 2단계 "구현 기록"(원 편집·검증)은 12,000자 상한.
- **막힘 게이트** = "첫 번째 실제 실패한 검증"(테스트 파일 편집 뒤의 실패는 제외). 턴 수·반복 읽기가 아니다. 발화 뒤 한 턴만 보이고 퇴출.
- 정책 비교(해결율): 문서만 26.9 · 첫 편집 때 바로 25.3 · 막혔을 때 고정 24.9 · **막혔을 때 한 번(REM) 27.6**. 없음 24.9. 비용 452K→374K 토큰(−17%), 턴 70.4→64.6. p=0.22.
- 모델별: Haiku 4.5 20.2→24.2, Sonnet 4.5 23.2→27.3, Opus 4.6 31.3→32.3, **Opus 4.8 47.5→39.4, Sonnet 5 52.5→50.5** — 기준 31% 이하 모델은 돕고 47% 이상은 해친다.

**SWE-ContextBench** (arXiv 2602.08316, Lite 99과제): 없음 26.3 · 원 트랜스크립트 자유 재사용 26.3 · 오라클 트랜스크립트 27.3 · **요약 자유 재사용 22.2 · 오라클 요약 34.3**. 요약 217토큰 vs 트랜스크립트 25,634토큰. 캐시 읽기가 소비의 97%. **틀리게 고른 짧은 요약(−4pt)이 틀린 긴 원문(±0)보다 해롭다** — 짧으면 믿어 버린다.

**Subtask-Level Memory** (arXiv 2602.21611, SWE-bench Verified): 한 문장짜리 교훈("a*b는 되는데 b*a가 안 되면 반사 연산자 누락을 봐라")을 하위작업 종류로 필터 뒤 top-1 → 평균 +4.7pt(Gemini 2.5 Pro 53.5→60.3, Claude 4 Sonnet 63.5→65.8). 어려운 과제 +8.7, 쉬운 과제 +1.8. 카테고리 필터 없이 전역 top-1은 "치명적 노이즈". 교차 레포 메모리라 파일 경로를 지운다(같은 레포인 Grimoire와 반대).

**Proactive Memory Agent** (Meta, arXiv 2607.08716): 별도 메모리 에이전트가 매 스텝 개입 여부를 결정, 개입은 "다음 행동 호출에만" 일시 주입. Terminal-Bench 2.0 Sonnet 4.5 37.6→45.9. 선별 개입 64.3 > 항상 주입 63.5 > 매 스텝 전체 61.5. 유용한 개입은 "상태를 바꾸는 도구 호출 직전". 실패는 "이미 아는 것 반복", 과신, 불필요한 걱정 — "불필요한 개입은 중복이 아니라 해".

**Compiling User Corrections into Runtime Enforcement** (arXiv 2606.13174): 규칙 준수율 — 없음 31.6%, 프롬프트에 전부 55.0%, Mem0 42.5%, **PreToolUse 훅으로 강제 70.1%**. 도구 경계에서 작동하는 것이 프롬프트 주입보다 낫다는 직접 증거.

**Do Context Files Help Coding Agents?** (arXiv 2607.27250): AGENTS.md 없음/항상/선택 — Claude 53.3/55.6/55.6%, Codex 58.8/56.9/52.9%. "정확도를 움직이지 못한다. 실제 과제는 구현 능력에서 실패하지 레포 지식 부족이 아니다." 검정력 부족(15~17과제). 반례로 적어 둔다.

**확인 못 한 것**: 행동 전 vs 후 주입 비교, 같은 기록 반복 주입의 해를 직접 잰 연구. 간접 증거만(REM 고정<퇴출, Meta 매 스텝<선별, VibeMemBench 예산 곡선).

### 10-2. 하네스들은 레포 맥락을 어떻게 넣는가

**Harness Engineering, 11개 시스템 소스 연구** (arXiv 2609.00006; Claude Code·Codex CLI·Gemini CLI·Mistral Vibe·OpenHands·Aider·Mini-SWE-Agent·Hermes·Pi·OpenCode·OpenClaw):
- 레포 맥락 = 전부 "계층적 Markdown 컨텍스트 파일 자동 발견 + 하위 디렉터리 파일은 도구가 그 아래를 건드릴 때 just-in-time 주입"(8개 시스템). **git 이력을 시스템 프롬프트에 넣는 것은 Mistral Vibe뿐**(`git log --oneline -5`, 2초 타임아웃, 루트별 캐시). 파일별 이력 주입은 0개.
- 예산: Hermes 메모리 2,200자 고정 스냅샷(캐시 위생), Aider repo map 1,024토큰, Claude Code 자동 메모리 200줄/25KB, 하위 CLAUDE.md는 더 작은 상한, 스킬당 25,000토큰, Codex AGENTS.md 32KiB.
- "코드 검색에 벡터 RAG를 주 기억으로 쓰는 시스템 0/11. SQLite FTS5(Hermes, 642K줄)가 운용 상한." 권고 8/16: "코드에 RAG를 만들지 마라. ripgrep+tree-sitter보다 낫다는 것을 홀드아웃에서 먼저 증명하라." 9/11이 훅을 갖고, **Codex의 훅 이벤트 이름은 Claude Code와 똑같다.**
- 관찰 5: "영속 메모리가 압축을 대신해 컨텍스트 엔지니어링의 최전선이 됐다." 네 가지 거버넌스: 에이전트 유지(Codex), 사람 승인(Gemini inbox), 모델 직접이되 상한(Hermes), 턴 전 회상(OpenClaw).

**Aider repo map**: tree-sitter 정의·참조 그래프에 PageRank, 대화 중 파일에 ×50 개인화, 1k 토큰에 맞춰 이진 탐색. 유일한 "순위 매긴 repo map".

**claude-mem**: v1~3는 세션당 25,000~35,000토큰을 쏟아 넣었고 1.4~8%만 관련 → v4는 색인 우선 ~1,100토큰(최근 세션 요약 10개 + 관측 50줄, 한 줄 `id·시각·종류·제목·토큰수`). 도구 9개→4개(스키마가 2,500토큰). Read 게이트: 32KB 이상 파일에만, 파일당 세션당 한 번, 3초 예산, 실패 시 열림. **자체 평가: 513줄 파일에서 Sonnet −6%, Opus +20% 비용**; 941줄 파일 −32~35%. 훅 지연 평균 45ms·p95 120ms.

**GitHub Copilot Memory** (2026 공식 블로그): 레포 단위 기억 `{subject, fact, citations(file:line), reason}`. 세션 시작 때 최근 기억을 프롬프트에 넣고, **쓰기 전에 인용 위치를 현재 코드와 대조해 틀리면 고쳐 저장**. 오프라인 만료 대신 읽기 시 검증. **A/B: 코딩 에이전트 PR 머지율 83→90%, 코드 리뷰 긍정 피드백 75→77%, p<0.00001**(표본 수 미공개). "검색은 비대칭 문제다: 풀기는 어렵고 검증은 쉽다."

**Serena**: 기억은 파일 이름 목록만 주고 내용은 에이전트가 고른다(이름당 한 번). **Cursor**: Memories UI를 2.1.x에서 제거, Rules로 내보내라고 안내(포럼). **Claude Code**: CLAUDE.md "200줄 이하", "지우면 Claude가 실수할 줄만 남겨라", "코드를 읽으면 아는 것·자주 바뀌는 것·파일별 설명은 빼라", 훅은 "예외 없이 매번 일어나야 하는 결정론적 행동"에.

**편집 시 파일 이력 주입 도구**: 공개된 것 **없음**. pastcode(0★)·git-insight-mcp(2★)는 요청형 MCP 도구. **repowise(7.9k★)**가 가장 가까움: opt-in 훅으로 "다루는 파일의 지배적 결정", "최근 버그 수정이 있는 파일 경고", 세션 시작 브리핑을 밀어 넣고, `get_risk`가 `missing_cochanges`·`missing_tests`·`tests_to_run`을 돌려줌. 응답 24,000자. 자체 보고 django 43문항에서 출력 −31.6%, 도구 호출 7.2→3.8(벤더). 공변경 창·훅 형식은 비공개. code-review-graph(32k★)의 공변경 모드는 "모든 커밋에서 predicted_files=0"으로 자체 README가 인정.

**이력이 돕는다는 증거**: **Code Researcher**(arXiv 2506.11060, Linux 커널 크래시 96건): `search_commits`(`git log -G`로 diff, `--grep`로 메시지, 패치 100줄 반환)를 빼면 **해결율 48→38%, 재현율 0.51→0.33**. HAFixAgent(arXiv 2511.01047): blame 맥락 주입으로 Defects4J +4.4%, 약한 모델은 +64.3%, 스텝·토큰 증가 없음.

### 10-3. 공변경·취약도·테스트 영향 — 파라미터의 근거

**거래 크기 필터** (ASE 2016, 10개 시스템·5백만 데이터점): MAP은 상한 6(0.464)·8(0.463)에서 최고, 10(0.459)·4(0.457), **20·30·무제한은 유의하게 계속 하락**. 커밋 크기 분포: 1개 56.4%, ≤5 90.4%, ≤10 96.1%, ≤20 98.4%, >30 1.0%. "전통적 30보다 훨씬 공격적으로 걸러야 한다." 흥미도 척도는 거의 무관(신뢰도 0.444, 지지도 0.442, 상위 11개가 동률).

**이력 길이와 신선도** (SCAM 2016, 19 시스템): 길이 5k→15k→25k→35k 커밋에서 MAP 0.285→0.312→0.318→0.322(1만5천에서 체감). "오래된 이력이 낡았다는 속설의 증거는 없었다." 반면 **모델의 나이**: 커밋 20개 뒤 −3%, 200개 뒤 −8%, 2,000개 뒤 −12.5%, 5,000개 뒤 0.372→0.270 "사실상 지수적" → 약 30커밋마다 갱신해야 한다.

**순위** (HistoRank, SANER 2020, 10 시스템): 최근순 정렬이 지지도·신뢰도 정렬보다 유의하게 낫고(p=0.04), **신뢰도 순은 모든 시스템에서 최악**, 파일 근접(같은 디렉터리)이 6/10에서 최고.

**ROSE** (ICSE 2004): 기본 지지도 3·신뢰도 0.5. 파일 단위: 재현율 0.26, 정밀도 ~0.30, **L3(상위 3개에 정답 하나 이상) 0.70**(GCC 같은 안정 레포는 >0.90). 신뢰도 0.9면 정밀도 >50%지만 재현율 4~7%. "신뢰도 0.8 넘게 올리면 정밀도·재현율이 같이 떨어진다."

**Caprese** (arXiv 2606.21187, 함수 단위): 머지 제외, 30파일 초과 제외, 단일 함수 커밋 제외 → 16,590 커밋 중 8,879 거래(54%). P@5 이력 0.49 / 동적 0.71 / 혼합 0.58, P@60은 이력이 최고(0.41). 노이즈 1위는 "섞인 커밋". 테스트↔소스 결합은 "영향 전파가 안 되는 잡음"으로 분류 — 바로 그것을 Grimoire는 `tests`로 따로 낸다.

**취약도**: Nagappan & Ball(ICSE 2005, Windows Server 2003): 절대 churn R²=0.052, **상대 churn(M1~M8) R²=0.811**, 가장 강한 단일 지표는 "삭제 줄수/전체 줄수". Google Bugspots: fix 커밋마다 시그모이드 `1/(1+e^(−12t+12))` 가중(창의 앞 ⅔는 거의 0), 정규식 `\b(fix(es|ed)?|close(s|d)?)\b`. **Google 배포 교훈(ICSE 2013)**: 개발자 행동 변화 없음 → 이유 없는 점수는 무시된다, "지금" 문제인 파일을 강조하라, 자동 소비자(테스트 우선순위)에 써라. 90일 창의 경험적 최적값을 준 연구는 없음(관례). Facebook은 3/14/56일 변경 수와 7~56일 실패율.

**테스트 영향**: Facebook Predictive Test Selection(ICSE-SEIP 2019): 가장 강한 피처는 **테스트 자체의 최근 실패율**(1.37/1.62), 다음이 의존 그래프 거리, 파일 변경 이력(3/14/56일). Çıngıl & Sözer(EASE 2022): **과거 fix 커밋에서 같이 바뀐 파일로 테스트↔소스를 잇는** 블랙박스 RTS, 30~70% 테스트로 결함 65~85% 포착 — Grimoire의 `tests`와 가장 가까운 선행. 이름 규칙으로 짝지은 테스트 파일의 변경 이력을 쓰자 변경 추천 정확도 21→62%(2차 출처). TDAD: 테스트 링크는 이름 규칙(1순위)·접두 절단·디렉터리 근접이고 이력은 안 씀; `test_map.txt`는 "한 줄에 매핑 하나, grep 가능"(정확한 형식은 미공개).

**git-insight-mcp의 공변경 구현**: `git log -n 1000 -- <file>` 뒤 커밋마다 `git show --name-only`, count≥3, ratio=count/파일 커밋 수, count 순 정렬, 20개. 머지·크기·이름 바꾸기·시간·테스트 구분 **전부 없음**.

**역방향 import** (Deterministic Anchoring 원문): 주석 블록 `# used by: fetch, lang_stats, update_catalogs` 꼴. SWE-bench Lite(허브 8%): 위상 주입 Func@5 0.832→0.854, 왕복 35.3→33.7, 토큰 +9.9%; 역방향만은 0.824·왕복 55.0(나쁨). Verified(허브 23%): 위상 0.619→0.631, **역방향만 0.633(최고)**, 왕복 42.4→41.7. 휴리스틱: 평균 출차수 <5면 전체 위상, >8이면 역방향만. 검증 안 된 휴리스틱.

### 10-4. 세션 → 커밋 연결 — 규약과 도구

**Lore** (arXiv 2603.15566, 레포 32★·릴리스 0·평가 없음): 의도 한 줄 + 본문 + 트레일러. 키: `Lore-id`(8자 hex, 리베이스 생존), `Constraint`, `Rejected`(`대안 | 이유`), `Confidence`, `Scope-risk`, `Reversibility`, `Directive`(`[until:…]` 만료), `Tested`, `Not-tested`, `Supersedes`/`Depends-on`/`Related`. 논문·CLI·kargnas 스킬이 열거값을 서로 다르게 씀 → 자유 문자열로 파싱. `lore context <path>`의 구현은 비공개; 스킬은 `git log -n 20 --all --grep="^TRAILER:" -- PATH`(`--follow` 없음, 순위 없음). 스킬 규칙: 오타·형식 커밋엔 쓰지 말 것, 지어내지 말 것, diff를 되풀이하는 트레일러는 삭제. 원문 예: `Constraint: Auth service does not support token introspection` / `Rejected: Extend token TTL to 24h | security policy violation`.

**QAC** (v1.0.0): `Agent`, `Mode(hitl|autonomous)`, `What`, `Why` 네 개 모두 필수·고정 순서. "외부 산출물(개인 파일·채팅 세션)을 참조하지 말 것." 채택 수치 없음.

**git-ai** (2.9k★, Apache-2.0): 줄 단위 귀속을 `refs/notes/ai`에(`refs/notes/commits` 금지). 프롬프트는 **git 밖**에 저장·마스킹. 귀속은 에이전트가 보고한 것만, 추정 금지. Claude Code 훅(`checkpoint`)을 스스로 설치·매일 갱신. squash N→1은 프롬프트 기록 전부 유지, 줄은 최종 상태로 재계산.
**Semantica** (Go): `.semantica/lineage.db`(SQLite) + 트레일러 `Semantica-Checkpoint`. `.claude/settings.local.json`에 훅.
**Agent Blame** (Mesa): 줄의 정확 해시 + 공백 제거 해시, post-commit에서 매칭(1.0 / 0.95). "틀린 귀속이 누락보다 나쁘다" — 정밀 우선.

**플랫폼 트레일러**: Copilot 코딩 에이전트는 2026-03-20부터 `Agent-Logs-Url:`(URL 꼴 미공개). Claude Code는 `Co-Authored-By: <모델명> <noreply@anthropic.com>`(v2.0.60부터 모델명), 클라우드·Remote Control 세션은 `Claude-Session:`(`attribution.sessionUrl`, v2.1.183; URL은 2차 출처만). `git log --format='%(trailers:key=Claude-Session,valueonly)'`로 조회 가능.

**데이터셋**: 사람의 프롬프트↔커밋 짝은 **DevGPT**(MSR'24, 커밋 694건·`ChatgptSharing[].Conversations[].Prompt`)가 유일. AIDev(agentic PR 768만 건·Claude Code 157만)는 PR 본문·diff만. SWE-smith 궤적은 에이전트 궤적.

### 10-5. 벤치 구성 — 채굴 절차와 검정력

**채굴** (SWE-rebench V2, ICML 2026): PR 2,951만 → 테스트 포함 29.1% → 이슈 연결 9.4% → **F2P 있음 7.1%** → 최종 0.11%. 테스트/소스 분리 정규식 `(?i)(test(?:ing|s)?|e2e)`. 설치 한 번에 성공하는 레포 ~20%. V1: "여러 번 돌려 한 번이라도 실패하면 제외"(flaky). SWE-smith: 레포당 환경 하나(HEAD, 테스트 80% 이상 통과), 2분 타임아웃, PR 미러 수율 33.8%(고정 환경). R2E-Gym: 비테스트 파일 ≤5·≤100줄·패치 ≤2,000자. 함정: 의존성 드리프트, 테스트만 바꾼 커밋, 테스트가 프롬프트에 없는 심볼 이름을 요구, 외부 I/O, 부동소수 비교.

**검정력** (Token Reduction 논문의 분산: 비용 급내상관 0.37~0.55, 실효 n 38~45/모드; 자체 계산, 미검증): 짝지은 log-비용, 15% 효과, α 0.05, 검정력 80% → 사례 80×1시드, 27×3시드, 16×5시드. 상호작용·탈락 30% 가산 → **40×3×2 = 240회**. 통과율 15pt는 맥니마로 100+ 사례. 비용 구성: 캐시 쓰기 48.5%, 캐시 읽기 38.7%, 출력 11.4%, 비캐시 입력 1.4% — 도구 출력은 비용의 3.3%.

**VibeMemBench 프로토콜**: 시드 4, 과제 단위 부트스트랩 1만 회, 순열 검정, 조건이 시드 2개 이상 다를 때만 대조, 여유(headroom) 층화. 비용은 공급자 의존이라 제외하고 토큰·스텝만.

**Claude Code `-p` 결과 JSON** (문서 확인): `total_cost_usd`(클라이언트 추정, 서브에이전트 포함), `modelUsage[model].{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}`, `usage`는 서브에이전트 **제외**, `num_turns`, `duration_api_ms`, `subtype`, `permission_denials`. `--bare`는 훅·MCP·CLAUDE.md·스킬을 끔. `--resume` 결과는 세션 누적.

### 10-6. 경쟁 지형과 개발자 요구

| 도구 | 기억의 원천 | LLM/임베딩 의존 | 다중 레포 | 능동 훅 | 커밋에 묶음 | 비고 |
|---|---|---|---|---|---|---|
| **repowise** (7.9k★, AGPL, Python+uv, 호스팅/Pro) | 코드 그래프 + git 이력(핫스팟·공변경·버그 이력) | 그래프·위험은 LLM 0; 검색은 임베딩 | 워크스페이스로 가능 | **있음**(opt-in) | 없음 | 가장 가까움. django 색인 366초. 코드 건강·대시보드·커버리지 테스트 선택은 Grimoire 범위 밖 |
| claude-mem (58k★) | 대화(훅 캡처) | LLM 압축 필요, Bun+uv+워커 | 프로젝트별 | 있음 | 없음 | 가장 큰 세션 메모리 |
| agentmemory | 대화·도구 관측(12훅) | 선택 | 한 머신 | 있음 | post-commit 링크만 | |
| Mem0 / Letta / Zep | 대화 | LLM+임베딩, 호스팅 | — | 일부 | 없음 | |
| Copilot Memory | 레포 사실 + 인용(file:line) | 호스팅 | 단일 레포 | 세션 시작 | 없음 | A/B 머지율 +7pt |
| Cursor/Windsurf Memories | 대화 | 모델 | 프로젝트 | — | 없음 | Cursor는 UI 제거 |
| Augment Context Lineage | 커밋을 Gemini로 요약 | LLM+임베딩, 호스팅 | 원격 | 없음 | 없음 | "git blame with more context" |
| Kage (6★) | 에이전트가 쓴 기억을 코드와 대조 | 없음 | 레포별 | CLAUDE.md 정책 | 레포 파일로 커밋 | 낡은 기억 보류 |
| spelungit / git-insight-mcp / pastcode | git 이력 | 임베딩 / 없음 / 없음 | 단일 | 없음 | 없음 | 요청형 |
| **Grimoire** | **git 이력 + 현재 코드 + (계획) 커밋에 묶인 의도·검증·트레일러** | **없음** | **모든 레포, DB 하나** | (계획) | **(계획)** | 한→영 확장은 유일 |

"git 이력 원천 + 커밋에 묶은 왜 + 의존성 0 + 다중 레포 + 능동 훅"의 조합은 비어 있다. 단, repowise가 이 중 셋을 이미 갖고 있고 성장 중(7.9k★)이라 **"능동 훅·공변경"만으로는 차별화가 안 된다.** 차별화는 "커밋에 묶인 왜"와 "의존성 0·로컬·한국어"다.

**개발자 요구(수치)**: SO 2025(n≈49k) — 66%가 "거의 맞는데 안 맞는" AI 답에 좌절, 45%는 AI 코드 디버깅이 더 오래 걸림, 신뢰 33% vs 불신 46%. **SO 2026 — 78.7%가 AI 답의 출처·귀속이 중요, 63.9%가 코드베이스와 대조 검증.** 에이전트 사용 31→59%, Claude Code가 66%로 1위, 63%는 자동 실행을 거의 안 시킴. Qodo 2025(n=609, 벤더) — 리팩터링에 AI를 쓰는 개발자의 65%가 "관련 맥락을 놓친다", 1위 요구는 "맥락 이해 개선". JetBrains 2025(n=24.5k) — 우려 1위 코드 품질 23%, "복잡한 코드 이해 부족" 18%, 프라이버시 13%. DORA 2025 — 90%가 AI 사용, 처리량은 오르나 **안정성과는 여전히 음의 상관**. METR 2025 RCT — 숙련 OSS 개발자가 AI로 19% 느려졌고 본인은 +20%로 믿음. Copilot 코딩 에이전트 PR 머지율 61~77%(2차).

**한국**: 2025~26 한국 개발자 AI 도구 설문은 찾지 못함(공백). 금융·공공 망분리는 완화 중이나 소스 코드의 외부 반출은 여전히 불가. 공군 국방망 AI 코딩 보조 24.5억 원 계약, Cisco 온프레미스 sLLM 출시(금융·공공은 코드를 외부로 못 보낸다는 이유). **네트워크 호출 0·LLM 0**인 기억 도구는 claude-mem(AI 공급자 필요)·Mem0/Augment/Zep(호스팅)이 못 들어가는 곳에 들어간다.

### 10-7. 핵심가치 — 후보와 선택

후보 다섯(경쟁 조사 에이전트 제안을 고쳐 씀):

| # | 한 줄 | 가장 강한 근거 | 밀어내는 대상 |
|---|---|---|---|
| 1 | **당신의 git 이력이 이미 기억이다. Grimoire는 그것을 한국어로도 검색하게 하고, 증명할 커밋을 댄다** | Code Researcher 48 vs 38%; SO 2026 78.7% 출처 중시 | 대화 기억(claude-mem·Mem0): sha를 못 댄다 |
| 2 | **SQLite 파일 하나, 내 머신의 모든 레포, 네트워크 0: "예전에 어디서 풀었지"를 repo·sha·file:line으로** | 다중 레포+로컬+의존성 0은 유일; 망분리 수요 | Augment 원격·Unblocked·Sourcegraph |
| 3 | **에이전트는 매 세션 잊고, 커밋은 잊지 않는다. Grimoire는 `git log`를 Claude Code가 편집 전에 읽는 맥락으로 바꾼다** | Claude Code 메모리 상한 200줄/25KB; Qodo 65% "맥락 놓침"; Cursor Memories 철수 | CLAUDE.md 수작업, Cursor/Windsurf 기억 |
| 4 | **코드가 왜 이렇게 됐는지 안다: 프롬프트·검증 명령·트레일러를 커밋에 묶고, 편집 직전에 400자로 건넨다** | Lore "결정의 그림자"; Copilot 인용 검증 기억 +7pt; VibeMemBench 5줄 규칙 | agentmemory post-commit 링크(세션 단위), Augment Lineage(LLM 요약·호스팅), repowise(왜 없음) |
| 5 | **LLM도 임베딩도 데몬도 없이, Node 22 하나로 10년치 내 작업을 밀리초에** | claude-mem은 Bun+uv+AI 공급자+워커; JetBrains 13% 프라이버시 | claude-mem, Engram, Serena |

**선택**: 4를 머리로, 1·2를 몸으로. 즉 §0의 문장 — **"'이 코드를 왜 이렇게 고쳤는지'를 커밋에 붙여 두었다가, AI가 그 파일을 고치려는 순간 다섯 줄로 귀띔해 주는 내 컴퓨터 안의 기억."**

이유:
- **4만이 아직 아무도 출시하지 않은 것**이다. 1·2·5는 지금 Grimoire가 이미 하는 일이라 진실이지만, repowise(공변경·훅·다중 레포)와 Augment Lineage(커밋 맥락)가 1·3을 부분적으로 덮고 있어 그것만으로는 1년 뒤 자리가 없다. "커밋에 묶인 왜"는 Lore·QAC·Copilot·Claude Code 트레일러가 **재료를 만들어 주기 시작한 시점**이고, 그것을 로컬에서 색인해 sha에 묶고 편집 직전에 건네는 도구는 비어 있다.
- 4는 **측정 가능한 약속**이다: P3의 `missed`·`p2p_broken`·해결당 비용이 그 약속의 검증이다. 1·2·5는 속성이지 결과가 아니다.
- 2·5(로컬·의존성 0·한국어)는 4를 **지키는 해자**다. repowise가 4를 따라 하려면 Python·임베딩·호스팅 구조를 버려야 하고, claude-mem이 따라 하려면 기억의 원천을 대화에서 git으로 옮겨야 한다.
- 핵심가치가 로드맵에 요구하는 것: P2(트레일러 파싱 + 세션 캡처)가 선택이 아니라 **중심**이 된다. P0·P1은 "건넨다"의 수단, P3는 "약속이 참인가"의 관문.

핵심가치의 **반증 조건**도 적어 둔다: P3에서 `grimoire` 모드가 `bare`보다 해결당 비용·회귀에서 낫지 않으면, "편집 직전에 건넨다"는 틀렸고 Grimoire는 1·2(근거 있는 검색 도구)로 돌아간다. 그것도 가치이지만 "핵심"은 아니다.

### 10-8. 2차 조사로 바뀐 설계값

| 항목 | 1차 | 2차 | 근거 |
|---|---|---|---|
| 공변경 커밋 파일 수 상한 | 20 | **10** (설정) | ASE'16: 6~8 최고, 10·20·30 유의 하락; 커밋 96%가 ≤10 |
| 공변경 이력 창 | 2년 | **커밋 1만5천개**(초과 시 최근) | SCAM'16: 1만5천에서 체감, 오래된 이력 해롭다는 증거 없음 |
| 공변경 정렬 | 신뢰도 | **최근순**, 신뢰도는 필터 | HistoRank: 신뢰도 순 최악, 최근순 최고(p=0.04) |
| 공변경 갱신 | 동기화 끝 재계산 | **증분**(항상 최신) | 모델 나이 20커밋 −3%, 200커밋 −8% |
| 공변경 방향 | 대칭 | **양방향** | Caprese: 비대칭 의존 |
| P0 기준 | P@3 ≥ 0.5 | **L3 ≥ 0.6, P@3 ≥ 0.35, strong P ≥ 0.5** | ROSE 파일 단위 L3 0.70, P 0.26~0.40 |
| `tests` | 공변경 중 테스트 파일 | **이름 규칙 짝 1순위** + 공변경 | TDAD 1순위; 이름 짝 이력으로 21→62% |
| 취약도 | 90일 fix ≥3 | **≥2 이고 비율 ≥30%, 문서·테스트·설정 커밋 제외, 이유(sha) 동봉** | Nagappan 상대 churn R² 0.81 vs 0.05; Google: 이유 없는 점수는 무시됨 |
| `why` 선택 | 최근 3커밋의 프롬프트 | **검증 신호 있는 최근 1커밋**(top-1) | VibeMemBench: 검증된 기록만 이식; 예산 ≥1은 0을 못 넘음 |
| 기록 형태 | 원문 그대로 | 원문이되 **어디→왜→무엇→검증** 네 칸 고정, 증상만 있는 줄 제외 | 형식 실패 69%; 증상·요청만 담긴 기록 14건 전부 손실 |
| 주입 형식 | 자유 | **`Key: value` 한 줄 한 사실** | Claude Code gitStatus·Vibe git 블록과 같은 꼴 |
| 주입 조건 | recent 있으면 | **Recent만 있으면 무출력**; 앵커 정확 일치만 | Anthropic "읽으면 아는 것은 빼라"; 앵커 불일치 순손실 |
| 2단계 주입 | 없음 | **첫 실패한 검증 뒤 한 번**(P4) | REM 27.6 vs 25.3(첫 편집) vs 24.9(고정) |
| `dropped` 판정 | 파일 집합 차이 | **줄 해시**(정확/공백제거) | Agent Blame 1.0/0.95 |
| 트레일러 | Lore 5개 | **Lore·QAC·플랫폼 허용 목록, 자유 문자열, 모르는 키도 저장** | 열거값 불일치; 채택 데이터 없음 → 의존 금지 |
| 벤치 규모 | 10~20사례 × 3회 | **파일럿 10 → 40사례 × 3시드 × 2 = 240회** | ICC 0.37~0.55 기준 검정력 계산 |
| 벤치 실행 | `-p` | **`-p --bare`**, 새 세션, 캐시 TTL 고정, `modelUsage` | 문서 확인 |
| 통과율 | 1차 지표 | **비열등 가드레일**, 1차는 해결당 청구 비용 | 15pt 차이는 100+ 사례 필요 |

### 10-9. 출처 (2차)

- 메모리 형식: VibeMemBench https://arxiv.org/html/2609.23570 · REM https://arxiv.org/html/2610.27377 · SWE-ContextBench https://arxiv.org/html/2602.08316 · Subtask memory https://arxiv.org/html/2602.21611v1 · Mise en Place https://arxiv.org/html/2605.05400v1 · Proactive Memory Agent https://arxiv.org/html/2607.08716v1 · Corrections→hooks https://arxiv.org/html/2606.13174 · Do Context Files Help https://arxiv.org/html/2607.27250v1
- 하네스: Harness Engineering https://arxiv.org/html/2609.00006v1 · Aider repomap https://aider.chat/docs/repomap.html · claude-mem docs https://docs.claude-mem.ai/progressive-disclosure.md https://docs.claude-mem.ai/file-read-gate.md · Copilot Memory https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/ · Serena memories https://oraios.github.io/serena/02-usage/045_memories.html · Claude Code memory https://code.claude.com/docs/en/memory · best practices https://code.claude.com/docs/en/best-practices · repowise https://github.com/repowise-dev/repowise · git-insight-mcp https://github.com/HasanJahidul/git-insight-mcp · pastcode https://github.com/muhcen/pastcode · Code Researcher https://arxiv.org/html/2506.11060 · HAFixAgent https://arxiv.org/abs/2511.01047
- 공변경·취약도·테스트: ROSE https://www.st.uni-trier.de/diehl/pubs/icse04.pdf · ASE'16 guidelines https://cms.simula.no/sites/default/files/publications/files/practical_guidelines_for_change_recommendation_using_association_rule_mining_1.pdf · SCAM'16 history length https://www.cs.loyola.edu/~binkley/papers/scam16-history-exploration.pdf · HistoRank https://clones.usask.ca/pubfiles/articles/MMondal_Historank_saner20.pdf · Caprese https://arxiv.org/html/2606.21187v2 · Nagappan & Ball https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/icse05churn.pdf · Bugspots https://github.com/igrigorik/bugspots · Facebook PTS https://ar5iv.arxiv.org/html/1810.05286 · Çıngıl & Sözer https://doi.org/10.1145/3530019.3530023 · TDAD https://arxiv.org/html/2603.17973v1 · Deterministic Anchoring https://arxiv.org/html/2606.26979
- 세션→커밋: Lore https://arxiv.org/html/2603.15566v1 https://github.com/Ian-stetsenko/lore-protocol · QAC https://github.com/hubtheocoelho/qac-spec · git-ai https://github.com/acunniffe/git-ai · Semantica https://pkg.go.dev/github.com/semanticash/cli · Agent Blame https://mesa.dev/blog/agentblame-deep-dive · Copilot Agent-Logs-Url https://github.blog/changelog/2026-03-20-trace-any-copilot-coding-agent-commit-to-its-session-logs · DevGPT https://github.com/NAIST-SE/DevGPT · AIDev https://huggingface.co/datasets/hao-li/AIDev
- 벤치: SWE-smith https://arxiv.org/html/2504.21798v2 · SWE-rebench https://arxiv.org/html/2505.20411v2 · SWE-rebench V2 https://arxiv.org/html/2602.23866v1 · R2E-Gym https://arxiv.org/html/2504.07164 · Token Reduction https://arxiv.org/html/2607.12161 · agent-efficiency-benchmark https://github.com/Emmimal/agent-efficiency-benchmark · Claude Code headless https://code.claude.com/docs/en/headless.md
- 지형·요구: memory MCP 비교 https://mnemoverse.com/docs/library/memory-mcp-servers-compared https://getunblocked.com/blog/memory-mcp-servers-compared/ · SO 2026 https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/ · SO 2026 agents https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work · Qodo 2025 https://www.qodo.ai/reports/state-of-ai-Code-quality/ · JetBrains 2025 https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/ · DORA 2025 https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report · Augment Context Lineage https://augmentcode.com/blog/announcing-context-lineage · Cursor Memories https://forum.cursor.com/t/are-my-memories-gone/144057 · 망분리 https://www.ddaily.co.kr/page/view/2026071517443276094 · 국방망 AI 코딩 https://www.venturesquare.net/1112999/
