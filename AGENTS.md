# Codex 작업자 규칙

## 역할과 범위

Claude Code가 이 프로젝트의 리드다. Codex는 Claude가 제공한 작업지시서의 범위가 명확한 반복 코딩,
테스트 보강, 정적 점검, 자료조사를 수행한다.

- 작업지시서의 목표, 허용 파일, 완료 조건을 먼저 확인한다.
- 모호한 설계 선택이나 범위 확대가 필요하면 구현을 멈추고 선택지를 보고한다.
- 사용자 변경과 무관한 파일은 수정하지 않는다.
- `.env`, 인증 토큰, Creator Advisor 로그인 프로필 등 비밀 파일을 읽거나 출력하지 않는다.
- 명시적 지시가 없으면 commit, push, merge하지 않는다.

## 기본 금지 작업

다음 작업은 작업지시서에 사용자의 명시적 승인이 기록되고 정확한 대상이 지정되지 않는 한 수행하지
않는다.

- Supabase migration 적용, migration history 수정
- 원격/운영 DB 쓰기 또는 삭제
- Telegram/Kakao 등 외부 메시지 발송·설정 변경
- production 배포 또는 유료 작업
- final 6-factor scoring, relevance, clustering 변경
- 파괴적 Git 명령

`ALLOW_SUPABASE_WRITE_TEST=1`은 승인된 원격 쓰기 테스트에서만 사용한다. 기본 테스트에서는 설정하지
않는다.

## 검증 원칙

- 먼저 변경 범위에 가장 가까운 테스트를 실행하고 마지막에 `npm run build`를 실행한다.
- 현재 안전 회귀 테스트 후보:
  - `npm run test:creator-advisor-parser`
  - `npm run test:creator-advisor-pipeline`
  - `npm run test:daily-query-pool`
  - `npm run test:keywords`
  - `npm run test:naver`
  - `npm run test:ranking`
  - `npm run test:notification`
- `test:trend-candidate-repository`, `test:seed-query`, `test:crud`처럼 원격 저장소에 접근할 수 있는
  테스트는 코드의 write guard와 작업지시서 허용 범위를 확인한 뒤 실행한다.
- 외부 API를 호출하는 테스트는 호출 사실을 결과에 명시한다.

## 완료 보고 형식

1. 완료한 내용
2. 변경한 파일
3. 실행한 검증과 결과
4. 남은 위험 또는 미확인 사항
5. Claude/사용자가 결정할 다음 항목

Codex 결과는 Claude의 독립 검증 전까지 최종 승인으로 간주하지 않는다.
