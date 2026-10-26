# 성능 개선 루프

Grimoire에 **지금 색인된 내 레포들**을 코퍼스로 고정하고, 고치기 전 빌드와 고친 빌드를 같은 질의로 번갈아 잰다.
판정은 Grimoire 노트로 남겨, 다음 바퀴에서 `search_memory`로 "이미 해 본 것"을 먼저 찾는다.

```
        ┌──────────── search_memory "perf …" (지난 판정·미채택 아이디어 확인)
        ▼
  ① 기준 고정 ─ npm run perf -- --snapshot base
  ② 병목 찾기 ─ npm run perf 출력의 "느린 질의", 문장별 SQL 시간 측정(아래)
  ③ 한 가지만 고친다
  ④ A/B ───── npm run perf -- --core bench/builds/base --message <이름> --save --note
  ⑤ 판정 ✓ → npm test · npm run e2e → 커밋, 다음 바퀴는 ①부터 (새 기준)
       판정 ✗ → 되돌리고, 왜 안 됐는지 노트로 남긴다
```

## 명령

| 명령 | 하는 일 |
|---|---|
| `npm run perf -- --freeze` | `~/.grimoire`(또는 `GRIMOIRE_HOME`)의 레포 목록과 HEAD·브랜치·태그 끝을 `bench/perf.local.json`에 고정. 레포가 바뀌어도 같은 코퍼스를 다시 잰다. 처음 실행 때 자동으로 한 번 한다 |
| `npm run perf -- --snapshot base` | 지금 `dist`를 `bench/builds/base`로 떠 둔다 |
| `npm run perf -- --core bench/builds/base` | 기준과 지금 소스(`src`)를 각자 임시 DB에 색인하고, 질의마다 두 빌드를 번갈아 잰다 |
| `--save` / `--note` / `--message x` | 결과를 `bench/results/perf-*.json`에 저장 / 판정을 Grimoire 노트(태그 `perf`, `perf-loop`)로 / 이름 |
| `--queries 150` `--rounds 3` | 유형별 질의 수, 질의당 반복 |
| `npm run perf -- --compare a.json b.json` | 저장한 두 결과 비교 |

원본 레포와 실제 `~/.grimoire` DB는 건드리지 않는다(읽기 전용, 임시 shared clone). `--note`만 실제 DB에 노트를 쓴다.

## 무엇을 재나

- **속도**: 첫 색인(메타)·diff 단계·바뀐 것 없는 재동기화 시간, DB 크기, `search()`와 `search_memory` 응답의 p50/p95.
- **정확도 안전망**: 색인에서 자동으로 만든 질의 — 커밋 제목 → 그 커밋, 한 파일에만 있는 심볼 이름 → 그 파일 — 의 Acc@1·Acc@8을 질의별로 짝지어 맥니마 검정. 절댓값은 부풀려져 있다(제목을 그대로 씀). 보는 것은 "빨라졌는데 결과가 바뀌지 않았나"뿐이다. 찾기 품질 자체는 `npm run eval`(손 질문)이 맡는다.

## 채택 기준

- 지연 지표 하나 이상이 10% 넘게 빨라지거나, 색인·동기화가 20% 넘게 빨라진다.
- 어떤 지표도 같은 문턱을 넘어 나빠지지 않는다.
- 정확도: 유형별 Acc@1·Acc@8 순손실이 2문항을 넘으면서 p < 0.1이면 탈락.

문턱의 근거는 A/A 측정(같은 빌드끼리, 2026-10-26)이다. 지연은 ±5%, 한 번만 재는 색인·동기화는 ±9%까지 흔들렸다.

## 병목 찾기

`perf` 출력 끝의 "느린 질의"에서 시작한다. 어디서 시간이 드는지는 DB의 `prepare`를 감싸 문장별 누적 시간을 재면 바로 보인다.
첫 바퀴에서는 이 방법으로 재정렬 질의 하나가 검색 시간의 86%라는 것을 찾았다. 색인 쪽은 SQL이 0.3s뿐이고 나머지는 git 프로세스 띄우기였다(Windows 호출당 ~20ms).

## 기록

코퍼스: 레포 15개, 커밋 3,042개, 파일 3,167개, 질의 300개(커밋 150·심볼 150).

| 바퀴 | 변경 | 결과 | 판정 |
|---|---|---|---|
| 0 | A/A (같은 빌드) | 지연 ±5%, 색인 ±9% | 문턱 정함 |
| 1 | 재정렬: 개념마다 `MATCH ∧ rowid IN (후보)` → 매칭 rowid를 한 번 받아 JS에서 겹침(df도 그 길이로). 후보 질의: `ORDER BY bm25()` → `ORDER BY rank`(snippet을 LIMIT 행에만 계산) | search p50 38.7→7.3ms(−81%), p95 140→17ms(−88%), 정확도 변화 0/300 | ✓ |
| 2 | 동기화: `refTips`·`headTree`·`remoteUrl`을 함께 띄우고, 커밋·기술 스택·코드 읽기를 겹침 | 메타 색인 6.9→5.4s(−22%), 재동기화 945→462ms(−51%) | ✓ |
| — | `DB.prepare` 문장 캐시 | 2.5만 번 prepare가 ~100ms(색인의 2%) | ✗ 문턱 미달 |
| — | file 문서만 snippet 생략 / 최종 결과마다 snippet | 차이 없음 / 더 느림 | ✗ |

다음 후보: diff 단계(6s, 레포별 `git log -p` 한 번이지만 레포 사이는 순차), 파일 결과의 `lastCommit` 조회(`commit_files(repo_id, path)` 색인 없음, 질의당 ~1ms).
