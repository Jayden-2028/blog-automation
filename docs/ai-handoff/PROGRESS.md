# 진척 원장 (PROGRESS.md)

데일리 데스크 아티팩트(`제이든의 데일리 데스크`)의 **blog-automation 시스템** 패널이 이 파일을
읽어 집계한다. 아래 `- [ ]`를 `- [x]`로 바꾸면 다음 동기화 때 진척률이 따라 움직인다.

형식 규칙(동기화 스크립트가 이 형식만 읽는다):
- `현재:` 로 시작하는 줄 → 패널의 "지금 단계"
- `마지막 세션:` 로 시작하는 줄 → "마지막 세션"
- `기준일:` 로 시작하는 줄 → 갱신 나이 계산(5일 이상이면 "갱신 오래됨" 배지)
- `- [ ]` / `- [x]` 줄 → 마일스톤
- `## 막혀 있는 것` 아래 `- ` 줄 → 블로커

---

기준일: 2026-09-16

현재: Blogspot 초안 자동화 안정화 — heavy-pipeline DB 큐로 원고 유실 근본 수정

마지막 세션: 2026-09-16 — job-research/write/revise 유실 사고(이틀 연속) DB 큐로 근본 수정,
검수 버튼 더블탭 방어, Blogspot 초안 자동 저장 켬

## 마일스톤

- [x] 기반 — Supabase 스키마 + 매일 키워드 수집 3종(사회이슈·연예·커뮤니티)
- [x] 선택 루프 — 텔레그램 TOP 10 → Go → article_jobs 생성
- [x] 자료조사 + 집필 — researcher.md / writer.md 헤드리스 파이프라인
- [x] 검수 게이트 4종
- [x] 클라우드 이전 — 로컬 launchd 전면 폐기, GitHub Actions가 전 단계 실행
- [x] 텔레그램 간소화 — 키워드 20자 요약, 조사→집필 자동 연결, 수정 피드백 자동 재작성
- [x] 전역 직렬화 — 조사·집필·재작성 GH Actions를 heavy-pipeline 그룹 1개로
      (⚠️ GitHub concurrency 큐의 "대기 1개" 한도로 이틀 연속 원고 유실 - 아래 DB 큐로 대체)
- [x] heavy-pipeline DB 큐 — GitHub 큐 의존 제거, Supabase 큐+싱글턴 락으로 원고 유실 근본 수정
      (2026-09-16, `pipeline_dispatch_queue`/`pipeline_lock`, 라이브 스모크 검증 완료)
- [x] 검수 버튼(승인/수정/반려) 더블탭 방어 — 재클릭 시 중복 발송·데이터 덮어쓰기 방지 (2026-09-16)
- [x] Blogspot 단독 운영 결정 + 전체 재설계 문서화
- [x] 티스토리 완전 삭제 + 채널 단일화 (타입·경로·manifest·배리에이션·테스트)
- [x] 원고 뷰어 재설계 (viewer.html 레이아웃 이식, 오렌지 포인트, 날짜→주제 2단)
- [x] 뷰어에 실제 이미지 인라인 + 캡션 표 + A/B 나란히 보기
- [x] 이미지 자동 생성 코드 — writer 프롬프트 → 생성 → Supabase Storage
- [x] 이미지 로컬 미러 CLI (npm run sync:images)
- [x] 이미지 생성 켜기 — GitHub secret/variable 등록 + 첫 실측 완료 (2026-09-16)
- [x] 이미지 A/B 비교 후 provider 확정 — OpenAI(gpt-image-2) 단독, 단가 1/5.6 + 한글·맥락 우위
- [x] 이미지 규격을 구글 디스커버 기준으로 (16:9 / 1536x864, max-image-preview:large 적용)
- [x] **Blogspot 자동 업로드 — 비공개 초안까지** (2026-09-16 켬: `BLOGGER_ENABLED=true` +
      `BLOGGER_PUBLISH_AS_DRAFT=true`. 텔레그램 최종 승인 → 원고·이미지 준비 → 초안 자동 저장)
- [ ] **Blogspot 자동 발행 — 공개** (스위치는 `BLOGGER_PUBLISH_AS_DRAFT=false`. 사용자 별도 결정)
- [ ] 사람이 채우는 3영역 자동화 검토 — 퍼머링크 / 검색 설명 / 웹 검색 이미지
      (API로 안 되는 것들. 우회안은 CURRENT_STATE 2026-09-16 후속6 참고)
- [ ] 예약 발행을 원고 뷰어에서 시간 지정으로 (후순위 기능 패치 — 지금은 CLI
      `npm run blogspot:schedule`로만 가능)
- [ ] 로컬 폴더 정리 (~/blog-automation/{repo,prod,kw})
- [ ] 커뮤니티 수집기 브랜치 main 병합
- [ ] keyword-collection-optimization 브랜치 main 병합

## 막혀 있는 것

- ✅ 해결(2026-09-16): OpenAI 이미지 모델을 `gpt-image-1` → `gpt-image-2`로 교체했다. 공식 deprecation 문서 기준 `gpt-image-1` 종료일은 2026-12-01(예전에 여기 적혀 있던 2026-10-23은 오기)이고 권장 대체가 `gpt-image-2`이며 단가도 더 싸다.
- ✅ 해결(2026-09-16): heavy-pipeline(조사/집필/재작성) 원고 유실이 이틀 연속 재발했다 - GitHub Actions concurrency 큐 의존을 걷어내고 Supabase 기반 자체 큐(`pipeline_dispatch_queue`/`pipeline_lock`)로 근본 수정했다.
- 공개 발행(`BLOGGER_PUBLISH_AS_DRAFT=false`)을 켜는 기준은 "원고·이미지 품질이 보장됐다"는 사용자 판단이다 - 초안 자동 저장까지는 이미 켰다(2026-09-16). 켜기 전에 미충족 이미지 마커 제거(완료)와 사람이 채우는 3영역(퍼머링크/검색설명/웹검색이미지) 절차를 사용자가 숙지해야 한다.
- ⬜ 새 DB 큐가 실제 사용자 클릭 패턴(여러 건 몰림)에서도 유실 없이 동작하는지 며칠 더 관찰 필요 - 오늘은 라이브 스모크 테스트로 로직만 검증했다.
