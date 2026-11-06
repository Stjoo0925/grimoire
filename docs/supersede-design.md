# 결정 뒤집기 — "틀린 결정이 계속 나오지 않게" (2026-11-06)

> 상태: **구현됨 (2026-11-06, 미배포).** `src/core/supersede.ts`, 마이그레이션 14, `record_note supersedes/confirms`, CLI `note --supersedes/--confirms`·`note confirm`·`note rm`·`review`, 색인 때 `Supersedes:`·revert. 성공 기준(§6)의 단위 테스트는 `tests/supersede.test.ts`. §3-2의 표는 repo_id가 NULL일 수 있고(레포 없는 노트) `how`에 `confirm`이 더 있다. 실제 레포 측정(§6 넷째 줄)은 아직 하지 않았다. 리뷰 뒤 고친 것(마이그레이션 15): 확인만은 노트를 만들지 않고 `by_kind = user`로 남긴다(스텁 노트가 카드를 차지하지 않게), 전체 sha의 revert는 풀어 보지 않고 바로 적는다(색인은 최신부터 들어와 원본이 아직 없을 수 있다), 고리 검사는 사슬 전체를 본다, export·remove가 판단 기록을 포함한다.

## 0. 한 줄

**결정을 뒤집는 일은 언제나 새 기록으로 한다.** 새 노트나 새 커밋이 "옛 결정 X는 이제 맞지 않는다"고 직접 가리키면, grimoire는 고치기 직전 카드에서 X 대신 새 결정을 보여 준다. 검색에서는 X를 지우지 않고 "뒤집힘" 표시를 붙인다.

## 1. 문제

grimoire는 옳고 그름을 판단하지 않고 있었던 일을 기억한다. 그래서 틀린 결정도 똑같이 성실하게 다시 꺼낸다.

| 구멍 | 지금 동작 | 근거 |
|---|---|---|
| 노트를 철회할 수 없음 | MCP·CLI 모두 노트를 추가만 한다. 옛 결정과 새 결정이 같은 무게로 나란히 나온다 | `src/mcp/tools.ts` `record_note`, `src/cli.ts` `note` |
| 훅이 할 수 없는 일을 시킴 | 규칙 파일 훅이 "Notes on this file (update any this change makes wrong)"이라고 안내한다. 하지만 노트를 고칠 도구가 없다 | `src/hook/runner.ts:505` |
| stale은 "바뀜"만 앎 | 파일 blob이 다르면 stale로 표시한다. 틀린 노트가 붙은 파일이 그대로면 그 노트는 멀쩡해 보인다 | `src/core/notes.ts:128` |
| 되돌린 커밋의 "왜"가 살아 있음 | `whyOf`는 최근 커밋 중 의도가 있는 것을 고른다. 나중에 `git revert`된 커밋의 의도도 고를 수 있다 | `src/core/context.ts:435` |
| `Supersedes:` 트레일러를 읽기만 함 | 허용 목록에 있어 저장은 되지만, 아무도 쓰지 않는다 | `src/core/trailers.ts:52` |

## 2. 원칙 (규칙 노트 #39를 되돌리며 배운 것)

1. **자동으로 숨기지 않는다.** #39는 제목 유사도로 다른 규칙을 조용히 대신했다. 뒤집기는 기록이 대상을 **명시적으로** 가리킬 때만 일어난다. 유사도나 나이는 쓰지 않는다.
2. **AI가 사람의 결정을 조용히 내리지 않는다.** `by: ai`가 `by: me`를 뒤집으면 옛 노트를 숨기지 않고 둘 다 보여 준다(§3-3).
3. **지우지 않고 표시한다.** "예전엔 왜 그렇게 했지?"도 grimoire가 답할 질문이다. 뒤집힌 결정도 검색에는 남는다.
4. **도구를 늘리지 않는다.** 새 MCP 도구 없이 `record_note`에 인자 하나를 더한다. 뒤집는 이유가 곧 새 노트의 본문이다.

## 3. 설계

### 3-1. 뒤집는 방법 세 가지

| 누가 | 어떻게 | 대상 |
|---|---|---|
| 에이전트·사람 (MCP) | `record_note({ text, supersedes: ["#12", "a1b2c3d"] })` | 노트(`#id`), 커밋(sha 앞 7자 이상) |
| 사람 (CLI) | `grimoire note "…" --supersedes 12 --supersedes a1b2c3d` | 같음 |
| 커밋 | 마지막 문단의 `Supersedes: a1b2c3d` 또는 `Supersedes: #12` 트레일러 | 같음 |
| 커밋 (자동) | `git revert`가 남기는 본문 `This reverts commit <sha>.` | 커밋 |

`git revert`는 사람이 명시적으로 한 일이라 원칙 1과 어긋나지 않는다.

**대체 없이 철회만 하고 싶을 때**도 같은 길로 한다. 예: `record_note({ text: "#12 철회: 캐시 TTL을 1시간으로 둔 건 측정 실수였다", supersedes: ["#12"] })`. 철회 이유가 그 자리에 남아서, 다음 사람이 같은 실수를 다시 하지 않는다.

### 3-2. 저장 (마이그레이션 한 단계)

```sql
-- 누가(by) 무엇을(target) 뒤집었나. 노트·커밋 어느 쪽이든 양쪽이 될 수 있다
CREATE TABLE supersessions (
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL,   -- 'note' | 'commit'
  target_ref   TEXT NOT NULL,   -- notes.id 또는 전체 sha
  by_kind      TEXT NOT NULL,   -- 'note' | 'commit'
  by_ref       TEXT NOT NULL,
  how          TEXT NOT NULL,   -- 'note' | 'trailer' | 'revert'
  at           TEXT NOT NULL,
  PRIMARY KEY (repo_id, target_kind, target_ref, by_kind, by_ref)
);
CREATE INDEX supersessions_target ON supersessions (repo_id, target_kind, target_ref);
```

- `notes`에 컬럼을 더하지 않고 표 하나로 둔다. 커밋이 노트를 뒤집는 경우와 노트가 커밋을 뒤집는 경우를 같은 모양으로 담기 위해서다.
- 트레일러와 revert 관계는 색인 때(`indexer.ts`) 채운다. 커밋 색인을 다시 만들면 `how != 'note'`인 행만 다시 만든다.
- 노트가 사라지면(`notes` 행 삭제) 그 노트가 만든 행도 지운다.

### 3-3. 보여 주는 곳

| 자리 | 지금 | 바뀐 뒤 |
|---|---|---|
| 편집 직전 훅·`file_context`·`impact`의 노트 (`notesForFile`) | 최근 노트 3개 | 뒤집힌 노트는 빼고, 그 자리에 뒤집은 노트를 `#31 "…" (replaces #12)`로 보인다 |
| 위와 같음, **AI가 사람 노트를 뒤집었을 때** | — | 둘 다 보인다: `#12 "…" (by you) · disputed by #31 (ai) "…"` |
| 훅·`file_context`의 `Why (sha)` (`whyOf`) | 최근 의도 | 뒤집힌 커밋은 건너뛴다. 이유는 다음 후보로 넘어간다 |
| `search_memory` 결과 | 같은 무게 | 뒤집힌 결과는 순위를 내리고 `supersededBy: "#31"` 또는 `revertedBy: "b2c3d4e"`를 붙인다. 결과에서 빼지는 않는다 |
| `search_memory`가 `#12`를 직접 찾았을 때 | 본문 | 본문과 함께 `supersededBy`를 보인다. 찾는 사람이 옛 결정만 보고 가지 않게 하기 위해서다 |
| 규칙 파일 훅의 안내 | "update any this change makes wrong" | "`record_note` with `supersedes` to retire any this change makes wrong" (할 수 있는 일만 시킨다) |

**사슬**: #12 → #20 → #31로 이어지면, 카드에는 맨 끝(#31)만 보인다. 이미 뒤집힌 #12를 또 뒤집으려 하면 응답이 `#12 is already superseded by #20`이라고 알리고, 그대로 기록한다.

**권한 표** (원칙 2):

| 뒤집는 쪽 → 뒤집히는 쪽 | 카드에서 |
|---|---|
| me → me·ai·커밋 | 옛것을 숨김 |
| ai → ai·커밋 | 옛것을 숨김 |
| ai → me | 둘 다 보이고 "disputed" 표시 |
| 커밋(트레일러·revert) → 무엇이든 | 옛것을 숨김 (커밋은 사람이 확인하고 남긴 것으로 본다) |

### 3-4. 검증과 오류

- 대상이 없으면 오류를 낸다: `#99 not found`, `sha a1b2c3d not in <repo>`. 틀린 참조를 조용히 저장하지 않는다.
- 다른 레포의 대상은 오류를 낸다. 결정은 레포 안에서만 뒤집는다.
- 자기 자신, 또는 자기를 뒤집은 노트는 뒤집을 수 없다(고리 방지).
- 짧은 sha가 여러 커밋과 맞으면 오류를 내고 후보를 보인다.
- `supersedes`가 있고 `paths`가 없으면, 대상 노트의 `paths`를 물려받는다. 그래야 새 결정이 옛 결정이 보이던 바로 그 파일에서 보인다. 대상이 커밋이면 그 커밋의 소스 파일(최대 5개, 자동 묶기와 같은 상한)을 물려받는다.

### 3-5. 되돌리기

뒤집기를 잘못했으면 그 뒤집은 노트를 다시 뒤집는다(#40 supersedes #31). #12는 되살아나지 않는다. 옛 결정이 다시 맞다면 #40의 본문에 그 내용을 다시 적는다. 이렇게 하면 "한때 틀렸다고 봤다가 다시 맞다고 봤다"는 흐름 자체가 기록으로 남는다.

CLI에만 `grimoire note rm <id>`를 둔다. 비밀이 섞였거나 실수로 남긴 노트를 지우는 용도다. MCP에는 두지 않는다. 에이전트가 기억을 지울 수 있으면 안 되기 때문이다.

## 4. 하지 않는 것

- **유사도·나이로 자동 철회하지 않는다.** #39의 실패를 반복하는 것이다. 오래되었지만 맞는 결정이 가장 값지다.
- **공변경(co-change)을 고치지 않는다.** "잘못된 구조 때문에 늘 같이 바뀌던 파일"도 사실이다. 그 구조를 바꾸기로 했다면 그 파일들에 노트를 묶는다. 그러면 공변경과 함께 그 노트가 보인다. 공변경 모델은 구조를 바꾼 뒤의 커밋으로 스스로 따라온다(커밋 200개 뒤 8% 낡음, `context.ts:15`).
- **stale 노트를 자동으로 뒤집지 않는다.** stale은 "다시 확인하라"는 뜻이다. 대신 카드의 stale 표시 옆에 뒤집는 방법을 한 번 알린다.
- **규칙 파일을 고치지 않는다.** 규칙을 뒤집는 것은 규칙 파일을 고치는 커밋이다. grimoire는 그 커밋의 "왜"를 이미 안다(rules-research).

## 5. 구현 순서

1. 마이그레이션 + `supersessions` 읽기·쓰기 (`src/core/supersede.ts`), 고리·사슬 처리
2. `record_note`·CLI `note`의 `supersedes`, 경로 물려받기, 오류 메시지
3. `notesForFile`이 뒤집힌 노트를 빼고 권한 표대로 보이기. 훅·`file_context`·`impact`는 이 함수 하나로 함께 바뀐다
4. 색인: `Supersedes:` 트레일러와 `This reverts commit` 읽기. `whyOf`가 뒤집힌 커밋을 건너뛰기
5. `search_memory`의 순위 내림과 `supersededBy`·`revertedBy` 표시
6. 규칙 파일 훅 안내 문구, 도구 설명(`record_note`: "supersedes = note ids/shas this overturns")

1~3만으로도 "노트를 철회할 수 없다"는 가장 큰 구멍이 메워진다. 4~5는 커밋 쪽이다.

## 6. 성공 기준 (만들기 전에 고정)

| 기준 | 잴 방법 | 통과 |
|---|---|---|
| 뒤집힌 노트가 카드에 안 나옴 | 단위 테스트: #12에 묶인 파일, #31 supersedes #12 → `notesForFile`에 #31만 있다 | 필수 |
| AI가 사람 노트를 숨기지 못함 | 단위 테스트: ai #31 supersedes me #12 → 둘 다 보이고 disputed 표시 | 필수 |
| 되돌린 커밋의 "왜"가 안 나옴 | 단위 테스트: 커밋 A(Why 트레일러), 커밋 B(revert A) → `whyOf`가 A를 고르지 않는다 | 필수 |
| 실제 레포에서의 크기 | 등록된 레포에서 `This reverts commit` 커밋 수와, 그 대상 중 지금 카드의 `Why`로 고를 수 있는 것의 수를 센다. 구현 전 값을 이 표에 적어 둔다 | 구현 뒤 0 |
| 카드 예산 | 훅 출력이 `HOOK_BUDGET`을 넘지 않는다. 사슬이 길어도 끝 하나만 보인다 | 필수 |
| 검색 회귀 없음 | 기존 `search.test.ts`·`taskbench`가 그대로 통과한다 | 필수 |

실제 레포 측정은 개발 빌드가 아니라 **복사한 DB**로 한다. 개발 빌드의 `openDb`는 `~/.grimoire`를 새 스키마로 마이그레이션하기 때문이다.

## 7. 열린 질문

- 뒤집힌 노트를 검색에서 얼마나 내릴지: 고정 감점 vs 맨 뒤로. 우선 고정 감점으로 하고 `taskbench`로 본다.
- `Supersedes:` 트레일러 값의 꼴이 Lore 규약과 같은지(sha만 받는지, 자유 문장도 받는지) 확인해야 한다. 자유 문장이면 sha·`#id`로 보이는 부분만 대상으로 삼는다.
