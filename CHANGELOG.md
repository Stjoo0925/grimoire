# Changelog

## [0.14.2](https://github.com/Stjoo0925/grimoire/compare/v0.14.1...v0.14.2) (2026-11-09)


### 버그 수정

* **memory:** 이미 색인된 이력의 revert·Supersedes: 판단을 채운다 (마이그레이션 16) ([#59](https://github.com/Stjoo0925/grimoire/issues/59)) ([9d189f2](https://github.com/Stjoo0925/grimoire/commit/9d189f206544ca89b5cce4d2104f72e3ac85d70c))

## [0.14.1](https://github.com/Stjoo0925/grimoire/compare/v0.14.0...v0.14.1) (2026-11-08)


### 버그 수정

* **memory:** 리뷰 발견 10개 — revert 판단 보존, 확인은 노트 없이, export·remove에 판단 기록 포함 ([#57](https://github.com/Stjoo0925/grimoire/issues/57)) ([1fa2636](https://github.com/Stjoo0925/grimoire/commit/1fa2636c6fe06dd85544be5bb4883bb575d665be))

## [0.14.0](https://github.com/Stjoo0925/grimoire/compare/v0.13.0...v0.14.0) (2026-11-06)


### 기능

* **memory:** 판단을 확인·뒤집을 수 있게 하고, 조용히 잃던 기억을 멈춘다 ([#55](https://github.com/Stjoo0925/grimoire/issues/55)) ([47fe9ad](https://github.com/Stjoo0925/grimoire/commit/47fe9adff747b610f7f07c484f3677ec0559876b))

## [0.13.0](https://github.com/Stjoo0925/grimoire/compare/v0.12.4...v0.13.0) (2026-11-06)


### 기능

* **impact:** 놓친 파일 벤치를 더하고, 큰 커밋에서 공용 파일이 순위를 덮지 않게 근거 합치기를 바꾼다 ([#52](https://github.com/Stjoo0925/grimoire/issues/52)) ([9c73aa9](https://github.com/Stjoo0925/grimoire/commit/9c73aa9318fdd8bcfe438905382e70986ad68451))

## [0.12.4](https://github.com/Stjoo0925/grimoire/compare/v0.12.3...v0.12.4) (2026-11-06)


### 버그 수정

* **impact:** 의도로만 찾은 후보를 0.00 대신 intent로 표시하고, 최상위 파일도 같은 폴더 근거를 받는다 ([#50](https://github.com/Stjoo0925/grimoire/issues/50)) ([63946f2](https://github.com/Stjoo0925/grimoire/commit/63946f21d500d7ae0da933117f473fec81d08607))

## [0.12.3](https://github.com/Stjoo0925/grimoire/compare/v0.12.2...v0.12.3) (2026-11-02)


### 버그 수정

* **security:** 레포 git 설정의 명령을 돌리지 않고 놓치던 비밀 꼴도 지운다 + 노트 번호로 본문 전체 찾기 ([#48](https://github.com/Stjoo0925/grimoire/issues/48)) ([1026bb6](https://github.com/Stjoo0925/grimoire/commit/1026bb6fc631265380baf8875f5e73642386162d))

## [0.12.2](https://github.com/Stjoo0925/grimoire/compare/v0.12.1...v0.12.2) (2026-11-02)


### 버그 수정

* **hook:** 자체 타임아웃 로그에 어느 훅·어느 단계에서 멈췄는지와 시작 지연을 남긴다 ([#45](https://github.com/Stjoo0925/grimoire/issues/45)) ([da3c7ac](https://github.com/Stjoo0925/grimoire/commit/da3c7ac9c4f8fac3640a33ca80708ff8543d5c93))

## [0.12.1](https://github.com/Stjoo0925/grimoire/compare/v0.12.0...v0.12.1) (2026-11-02)


### 버그 수정

* **mcp:** 워크트리 세션의 impact·record_note가 그 워크트리의 변경을 읽는다 + 실사용 지표 보강 ([#43](https://github.com/Stjoo0925/grimoire/issues/43)) ([9068064](https://github.com/Stjoo0925/grimoire/commit/906806417cf628f5190c351507a9668d28d9a159))

## [0.12.0](https://github.com/Stjoo0925/grimoire/compare/v0.11.1...v0.12.0) (2026-10-30)


### 기능

* **rules:** 규칙 파일의 규칙마다 그 글자를 쓴 커밋과 왜를 색인한다 ([#42](https://github.com/Stjoo0925/grimoire/issues/42)) ([f2c5001](https://github.com/Stjoo0925/grimoire/commit/f2c500190b89c50f9f4ef0ecb3af32cf3de32c8f))

## [0.11.1](https://github.com/Stjoo0925/grimoire/compare/v0.11.0...v0.11.1) (2026-10-28)


### 버그 수정

* **mcp:** 마지막 진행 알림이 응답에 밀려 버려지지 않게 ([#37](https://github.com/Stjoo0925/grimoire/issues/37)) ([389b26e](https://github.com/Stjoo0925/grimoire/commit/389b26ef643234e5b94592b7af31a68b6f449d30))

## [0.11.0](https://github.com/Stjoo0925/grimoire/compare/v0.10.1...v0.11.0) (2026-10-28)


### 기능

* **setup:** Codex·Cursor에도 /grimoire-impact 스킬 ([#35](https://github.com/Stjoo0925/grimoire/issues/35)) ([a2eb621](https://github.com/Stjoo0925/grimoire/commit/a2eb621cfec09039253712cbd3d8c2b9c130e14a))

## [0.10.1](https://github.com/Stjoo0925/grimoire/compare/v0.10.0...v0.10.1) (2026-10-28)


### 버그 수정

* **update:** 새 버전을 설치할 때 npm 캐시를 건너뛴다 ([#32](https://github.com/Stjoo0925/grimoire/issues/32)) ([2df1a69](https://github.com/Stjoo0925/grimoire/commit/2df1a69487a6914d3969d2deb0c1e341e46a1b55))

## [0.10.0](https://github.com/Stjoo0925/grimoire/compare/v0.9.0...v0.10.0) (2026-10-28)


### 기능

* 영향 범위(impact) — 이력·구조·작업 의도로 같이 바뀔 파일을 찾는다 ([#30](https://github.com/Stjoo0925/grimoire/issues/30)) ([4ca2c6b](https://github.com/Stjoo0925/grimoire/commit/4ca2c6b370a0dab00f0c7829b2dc86d7e8fb8e8d))

## [0.9.0](https://github.com/Stjoo0925/grimoire/compare/v0.8.1...v0.9.0) (2026-10-27)


### 기능

* 노트를 파일에 묶고, 훅은 이력만 아는 것만 말한다 — 정체성 재정립 ([#28](https://github.com/Stjoo0925/grimoire/issues/28)) ([77c4b53](https://github.com/Stjoo0925/grimoire/commit/77c4b53101167dd166cbbe3e21320dff2c79d6dc))

## [0.8.1](https://github.com/Stjoo0925/grimoire/compare/v0.8.0...v0.8.1) (2026-10-27)


### 버그 수정

* **capture:** Claude Code의 자동 블록을 사용자 프롬프트로 저장하지 않는다 ([#25](https://github.com/Stjoo0925/grimoire/issues/25)) ([07cef58](https://github.com/Stjoo0925/grimoire/commit/07cef5855014e204893eeb67c65bee2e0d745647))

## [0.8.0](https://github.com/Stjoo0925/grimoire/compare/v0.7.1...v0.8.0) (2026-10-27)


### 기능

* 훅·세션 캡처·공변경 보강, Codex 설치, MCP roots — 워크트리, squash 중복, 비밀 지우기, 업그레이드 안전 ([#21](https://github.com/Stjoo0925/grimoire/issues/21)) ([dbd2652](https://github.com/Stjoo0925/grimoire/commit/dbd26524a58291d035ab2276bf9160d416544c5d))


### 버그 수정

* **mcp:** 보낸 진행 알림이 다 나간 뒤에 도구 응답을 돌려준다 ([#23](https://github.com/Stjoo0925/grimoire/issues/23)) ([5cfeefe](https://github.com/Stjoo0925/grimoire/commit/5cfeefe7e29b4ad8764aada5c9f48b3358a72641))

## [0.7.1](https://github.com/Stjoo0925/grimoire/compare/v0.7.0...v0.7.1) (2026-10-27)


### 버그 수정

* **update:** Windows에서 grimoire update가 내던 DEP0190 경고를 없앤다 ([#19](https://github.com/Stjoo0925/grimoire/issues/19)) ([2ca134b](https://github.com/Stjoo0925/grimoire/commit/2ca134b147f0fa01f88d66434b73d097f2ca8ebb))

## [0.7.0](https://github.com/Stjoo0925/grimoire/compare/v0.6.2...v0.7.0) (2026-10-27)


### 기능

* 편집 직전 훅·커밋에 묶인 왜·공변경·작업 완수 벤치 — 에이전트 코딩 강화 (P0~P4) ([#17](https://github.com/Stjoo0925/grimoire/issues/17)) ([f9fc3d6](https://github.com/Stjoo0925/grimoire/commit/f9fc3d6df34cbcce2e5edbd082d846242bf11ccc))

## [0.6.2](https://github.com/Stjoo0925/grimoire/compare/v0.6.1...v0.6.2) (2026-10-26)


### 성능

* 색인된 레포로 도는 성능 루프를 더하고 검색·동기화를 빠르게 한다 ([#15](https://github.com/Stjoo0925/grimoire/issues/15)) ([6c70719](https://github.com/Stjoo0925/grimoire/commit/6c7071935f8eefa1461069fde9155941aa5d7b96))

## [0.6.1](https://github.com/Stjoo0925/grimoire/compare/v0.6.0...v0.6.1) (2026-10-26)


### 버그 수정

* Windows에서 e2e·테스트가 돌게 하고 CI에 Windows를 더한다 ([#11](https://github.com/Stjoo0925/grimoire/issues/11)) ([94dd30f](https://github.com/Stjoo0925/grimoire/commit/94dd30f2fc866ec5ac1775add800b395bf05379c))

## [0.6.0](https://github.com/Stjoo0925/grimoire/compare/v0.5.0...v0.6.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* 내장 node:sqlite와 MCP SDK v2로 의존성을 3개로 줄인다 ([#12](https://github.com/Stjoo0925/grimoire/issues/12))

### 기능

* 내장 node:sqlite와 MCP SDK v2로 의존성을 3개로 줄인다 ([#12](https://github.com/Stjoo0925/grimoire/issues/12)) ([c521339](https://github.com/Stjoo0925/grimoire/commit/c5213392d0d99a058ec486d6cc6d19ebd286985a))

## [0.5.0](https://github.com/Stjoo0925/grimoire/compare/v0.4.0...v0.5.0) (2026-10-25)


### 기능

* **search:** 같은 변경의 커밋 접기, 도구 설명 영어화와 show_commit 여러 커밋 조회 ([#9](https://github.com/Stjoo0925/grimoire/issues/9)) ([438b97b](https://github.com/Stjoo0925/grimoire/commit/438b97ba5cd5fc1b6d213d8025d797ec0fcf4358))

## [0.4.0](https://github.com/Stjoo0925/grimoire/compare/v0.3.0...v0.4.0) (2026-10-25)


### 기능

* **search:** 오프라인 평가, 빠른 증분 색인, 커밋이 바꾼 함수 요약 ([#6](https://github.com/Stjoo0925/grimoire/issues/6)) ([c9a4bd6](https://github.com/Stjoo0925/grimoire/commit/c9a4bd67dde55f410a5e110161982dd0ee116ada))

## [0.3.0](https://github.com/Stjoo0925/grimoire/compare/v0.2.0...v0.3.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* 임베딩 제거와 자동 등록 보정, 재시도 가능한 릴리스 ([#2](https://github.com/Stjoo0925/grimoire/issues/2))

### 기능

* **mcp:** 작업 중인 프로젝트 자동 등록과 현재 레포 우선 검색 ([1bb2d3e](https://github.com/Stjoo0925/grimoire/commit/1bb2d3e29bad5a1aac1dbd3e8e22881d4576813d))


### 버그 수정

* **test:** node 22+에서 테스트가 안 돌던 문제 ([a652d6a](https://github.com/Stjoo0925/grimoire/commit/a652d6aaa31167a788c06196eb90bd2e4606017b))


### 리팩터링

* 임베딩 제거와 자동 등록 보정, 재시도 가능한 릴리스 ([#2](https://github.com/Stjoo0925/grimoire/issues/2)) ([061446b](https://github.com/Stjoo0925/grimoire/commit/061446b1df53c811c2c585ef812dca24f1eb3808))
