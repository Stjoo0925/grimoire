# Changelog

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
