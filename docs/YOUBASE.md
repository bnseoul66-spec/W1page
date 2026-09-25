# YouBase 연결 상태 및 이식 명세

## 확인된 것 / 확인되지 않은 것

YouWare 공식 문서는 YouBase의 이메일/비밀번호·Google 인증, 사용자별 영구 데이터, 서버 로직 및 YouWare 프로젝트 안에서의 배포 기능을 설명합니다. Pro/Ultra 플랜이 필요합니다. 이번 환경에는 YouBase가 활성화된 프로젝트, 공식 프로젝트별 SDK, 함수 배포 도구, 인증 설정 또는 DB 자격 증명이 제공되지 않았습니다. 따라서 **현재 실행 코드는 YouBase를 호출하지 않습니다.** `DATABASE_PATH`만 바꾸거나 환경변수를 추가한다고 YouBase로 전환되지 않습니다.

공개 문서는 기능/관리 UI 위주여서 특정 SDK 메서드·SQL 방언·실시간 구독 API를 확인할 수 없었습니다. 존재를 확인하지 못한 API를 구현한 것처럼 넣지 않았습니다. 아래는 **실제 플랫폼 에이전트가 구현해야 할 데이터 모델·보안 정책·API 계약**입니다. `database/schema.sql`은 독립 SQLite 구현용이며 YouBase에 그대로 실행된다고 보장하지 않습니다.

참고한 공식 문서(2026-09-22 확인):
- https://docs.youware.com/youbase/introduction
- https://docs.youware.com/youbase/users-authentication
- https://docs.youware.com/youbase/database

## 목표 데이터 모델

YouBase 관리 인증 저장소에는 비밀번호/Google 인증을 위임합니다. 기존 독립 DB의 비밀번호 해시나 세션은 YouBase 인증으로 직접 복사하지 않습니다.

| 테이블 | 필드 | 제약/인덱스 |
|---|---|---|
| `profiles` | `user_id` 공식 인증의 불변 사용자 ID, `name` 최대40자, `role` member/admin, `challenge_start` 날짜, `challenge_days` 기본30, `daily_goal` 기본500, `created_at` UTC | user_id PK/인증 사용자 연결, role 기본 member, days 1–365, goal 1–1,000,000 |
| `writing_entries` | `user_id`, `entry_date` YYYY-MM-DD, `character_count` 정수, `memo` 최대2000자, `link` 최대2048자, `created_at`, `updated_at` UTC | **UNIQUE(user_id, entry_date)**, 사용자 참조, character_count 1–1,000,000, 날짜 인덱스 |
| `site_settings` | 단일 id=1, `header` 최대120자, `announcement` 최대500자, `challenge_guide` 최대2000자, `accent` green/blue/violet, `updated_at` | singleton PK, 허용된 accent만 |
| `audit_log` | `id`, `actor_id`, `action`, `target_id`, `detail`, `created_at` UTC | 서버만 추가/조회, 일반 사용자 접근 불가 |

- `profiles`는 공식 인증 완료 뒤 서버가 생성. role은 무조건 member. 클라이언트가 user_id나 role을 정하지 못하게 합니다.
- 날짜 유효성 및 미래 날짜 금지는 저장 시 서버에서 검사합니다. 클라이언트의 오늘 날짜를 신뢰하지 않습니다.
- 삽입/수정은 위 유일키 기반 **원자적 UPSERT**여야 합니다. 조회 후 개별 INSERT로 구현하면 동시 요청에서 중복될 수 있습니다.
- 회원 email은 공식 인증 조회 또는 서버가 관리하는 검증된 미러를 통해 관리자에게만 제공합니다.

## 접근 정책 — UI 숨김만으로 대체 금지

| 작업 | 익명 | 일반 회원 | 관리자 |
|---|---|---|---|
| 공개 서비스 문구 조회 | 가능 | 가능 | 가능 |
| 프로필/기록 읽기·쓰기 | 불가 | 본인만 | 본인 기록 쓰기, 전체 기록 읽기 |
| 이름·목표 수정 | 불가 | 본인만 | 본인만 |
| 전체 회원/일별 출석 읽기 | 불가 | 불가 | 가능 |
| 역할 변경 | 불가 | 불가 | 자신 외 회원, 감사 로그 필수 |
| 서비스 문구·색상 수정 | 불가 | 불가 | 가능, 감사 로그 필수 |
| 감사 로그·인증 정보 직접 쓰기 | 불가 | 불가 | 불가, 서버 작업만 |

플랫폼에 행 수준 권한 정책이 있다면 이를 활성화하고 서버 함수의 권한 검사도 유지하세요. 사용자가 직접 DB SDK를 호출해 다른 user_id를 지정해도 읽기/쓰기가 거절되어야 합니다. 최초 관리자는 플랫폼 콘솔/신뢰된 관리 절차에서 지정하세요. 역할/설정 변경+감사로그는 같은 트랜잭션으로 처리합니다.

## 프론트엔드가 기대하는 앱 API 계약

아래 경로는 **이 프로젝트가 정의한 경로**이며 YouBase의 공식 엔드포인트가 아닙니다. 플랫폼 서버 함수가 동일 계약을 제공하거나 `src/main.jsx`의 API 호출을 실제 SDK로 교체해야 합니다.

- `GET /api/config` → `{ settings, backend:'youbase', googleEnabled:true, timezone:'Asia/Seoul' }`
- `GET /api/dashboard` → `{ user, entries, stats, settings, today }`
  - `user`: `{ id, name, email, role, challenge_start, challenge_days, daily_goal, created_at }`
  - `entries`: `{ user_id, entry_date, character_count, memo, link, created_at, updated_at }[]`, 날짜 내림차순
  - `stats`: `shared/dates.js`의 `calculateStats(entries,user,today)`와 동일
- `PUT /api/entries` → 본문 `{ entry_date, character_count, memo, link }`, 로그인 ID로 원자적 upsert
- `DELETE /api/entries/:date` → 현재 사용자 기록만 삭제
- `PUT /api/profile` → `{ name, daily_goal }`, role은 받지 않음
- `GET /api/admin/members?date=YYYY-MM-DD` → `{ members:[{id,email,name,role,created_at,total_days,total_characters,day_characters}] }`
- `GET /api/admin/members/:id/entries` → `{entries}`
- `PATCH /api/admin/members/:id/role` → `{role}`
- `PUT /api/admin/settings` → `{header,announcement,challenge_guide,accent}`
- 오류: JSON `{error:string}`, 미인증 401, 비관리자 403, 입력 400, 충돌 409

독립 앱의 `/api/auth/register|login|logout`와 Google code exchange, `sessions`, `password_hash`는 **공식 YouBase 인증으로 교체**합니다. 로그인 버튼/다이얼로그도 공식 인증 SDK의 실제 지원 방식에 맞춰 연결합니다. 공식 인증 토큰을 서버에서 검증하지 않은 상태로 `user_id` 헤더 등을 신뢰하면 안 됩니다.

## 실시간 잔디

1. 최초 로그인 후 본인 `writing_entries`를 DB에서 조회합니다.
2. 저장 API가 성공하면 DB를 재조회하고 그 결과로 잔디·통계를 갱신합니다.
3. 공식 YouBase 구독 API가 제공되면 **본인 user_id 필터 + 서버 권한 검사**를 적용합니다. 구독 알림 후에도 권한이 검증된 최신 기록을 조회합니다.
4. 구독 기능이 없으면 서버 SSE 또는 현재 15초 폴링을 이식하고 해당 지연을 UI에 명시합니다. 관리자 문구 변경은 모든 회원에게 재조회 알림을 보냅니다.
5. 재연결 시 전체 재조회, 로그아웃/권한 회수 시 구독 종료. 로컬 저장값을 출석의 기준으로 쓰지 않습니다.

## YouWare 에이전트에 전달할 실행 요청

아래 요청과 **전체 프로젝트 소스**를 YouBase 활성화된 새 YouWare 프로젝트에 제공하세요.

> WriteOn의 React UI와 날짜 계산/테스트를 보존하고, 현재 독립 SQLite 백엔드를 이 프로젝트의 공식 YouBase 인증·데이터베이스·함수로 이식해 주세요. docs/YOUBASE.md의 모델·접근 정책·응답 계약을 구현하세요. user_id는 검증된 YouBase 인증에서만 도출하고, 사용자+날짜 고유 제약과 원자적 upsert를 만드세요. 이메일/비밀번호 및 Google 인증을 활성화하고 관리자 역할은 서버에서 검사하세요. 실제 저장/재로그인/서로 다른 두 사용자 격리/관리자 접근 차단/권한 회수/실시간 잔디/날짜 경계의 스트릭을 검증하세요. 검증 완료 전 화면의 'YouBase 미연결' 표시를 제거하지 마세요. 공개 게시 전에 배포 URL과 테스트 결과를 제시해 주세요.

## 완료 판정 체크리스트

- [ ] 실제 YouBase 프로젝트 생성, 이메일/Google 인증 설정, 승인된 도메인/콜백
- [ ] 테이블·유일키·정책 생성 및 첫 관리자 설정
- [ ] 다른 브라우저/기기에서 이메일/Google 로그인 및 기록 유지
- [ ] YouBase 콘솔에서 실제 날짜/글자 수 행 확인
- [ ] 사용자 A의 ID를 B가 주입해도 조회·수정·삭제 실패
- [ ] 일반 회원의 관리자 API 요청 403
- [ ] 하루 두 번 저장·동시 저장에서도 한 행/한 출석
- [ ] KST 자정·윤일·연말·출석 누락·삭제 스트릭 테스트
- [ ] 두 세션 간 실시간 갱신 및 재접속 복구
- [ ] 관리자 변경 문구가 별도 회원 세션에 반영
- [ ] 실제 배포 도메인에서 검증 후 연결 상태 UI를 YouBase로 교체
