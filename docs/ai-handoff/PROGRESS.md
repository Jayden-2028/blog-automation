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

기준일: 2026-09-17

현재: 원고·이미지 품질 끌어올리기 — 웹 검색 이미지를 Codex가 찾고 로컬 보관함으로 내보냄

마지막 세션: 2026-09-17 — 웹 검색 마커에 AI 이미지를 생성하던 버그 수정, Codex(`--search`)로
웹 검색 이미지 수집, 승인 원고를 ~/Documents/blog-manuscripts/whyissuenow로 내보내기

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
- [x] 텔레그램 클릭 수신 유실 제거 — telegram-update concurrency 삭제(병렬 처리), Worker가 클릭
      즉시 "접수됨" 토스트 (2026-09-16, 하루 취소 14건 실측 후)
- [x] 공통 문체 `style/voice.md` — 카테고리 4종의 어미 규칙을 하나로(trend 기준, incident 예외),
      검수 `checkVoice` (2026-09-16)
- [x] 이미지 프롬프트 "바로 위 문단을 한 장으로 요약" 규칙 + 데이터형(대진표·표) AI 생성 금지,
      검수 `checkImagePrompts` (2026-09-16)
- [x] 웹 검색 마커 AI 생성 중단 — 한국어 검색어가 이미지 프롬프트로 들어가던 경로 차단 (2026-09-17)
- [x] Codex 웹 검색 이미지 수집 — `npm run images:collect`, 출처·해상도 검증 (2026-09-17)
- [x] 로컬 보관함 내보내기 — `npm run manuscript:export`, 날짜>주제 폴더 + image-metadata.md (2026-09-17)
- [x] 화면 캡처(법령 조문·정부 포털)를 이미지 자리에서 제외 — 현장 실사로 대체, `checkImagePrompts` 탐지 (2026-09-17)
- [x] 정책 기사 이미지 전략 — 특정 일시 회의·의회 현장 자리 금지(§8-3), 웹 검색/AI를 실물 특정 여부로 판단(§8-4), AI 절반 상한 폐기 (2026-09-17)
- [x] 수집 이미지 비전 검증 — Claude가 파일을 직접 열어 설명↔실물 불일치를 차단, 불합격 시 삭제 (2026-09-17)
- [x] 핫링크 차단(403) 대응 — 출처를 Referer로 전송 + 재시도, 실패 시 URL 안내 (2026-09-17)
- [x] 이미 쓰인 원고의 마커 교체 도구 `images:refix` — 본문은 두고 규칙 위반 자리만 재설계(미리보기 기본) (2026-09-17)
- [x] Blogspot 단독 운영 결정 + 전체 재설계 문서화
- [x] 티스토리 완전 삭제 + 채널 단일화 (타입·경로·manifest·배리에이션·테스트)
- [x] 원고 뷰어 재설계 (viewer.html 레이아웃 이식, 오렌지 포인트, 날짜→주제 2단)
- [x] 뷰어에 실제 이미지 인라인 + 캡션 표 + A/B 나란히 보기
- [x] 이미지 자동 생성 코드 — writer 프롬프트 → 생성 → Supabase Storage
- [x] 이미지 로컬 미러 CLI (npm run sync:images)
- [x] 비용 계측 — api_usage 원장 + 단가표 + cost.json (2026-09-16, migration 적용 완료)
- [x] 이미지 생성 켜기 — GitHub secret/variable 등록 + 첫 실측 완료 (2026-09-16)
- [x] 이미지 A/B 비교 후 provider 확정 — OpenAI(gpt-image-2) 단독, 단가 1/5.6 + 한글·맥락 우위
- [x] 이미지 규격을 구글 디스커버 기준으로 (16:9 / 1536x864, max-image-preview:large 적용)
- [x] **Blogspot 자동 업로드 — 비공개 초안까지** (2026-09-16 켬: `BLOGGER_ENABLED=true` +
      `BLOGGER_PUBLISH_AS_DRAFT=true`. 텔레그램 최종 승인 → 원고·이미지 준비 → 초안 자동 저장)
- [ ] **Blogspot 자동 발행 — 공개** (스위치는 `BLOGGER_PUBLISH_AS_DRAFT=false`. 사용자 별도 결정)
- [ ] 사람이 채우는 3영역 자동화 검토 — 퍼머링크 / 검색 설명 (웹 검색 이미지는 2026-09-17에
      `images:collect`로 상당 부분 자동화됨. 나머지는 CURRENT_STATE 2026-09-16 후속6 참고)
- [ ] 예약 발행을 원고 뷰어에서 시간 지정으로 (후순위 기능 패치 — 지금은 CLI
      `npm run blogspot:schedule`로만 가능)
- [ ] 로컬 폴더 정리 (~/blog-automation/{repo,prod,kw})
- [ ] 커뮤니티 수집기 브랜치 main 병합
- [ ] keyword-collection-optimization 브랜치 main 병합

## 막혀 있는 것

- ✅ 해결(2026-09-16): OpenAI 이미지 모델을 `gpt-image-1` → `gpt-image-2`로 교체했다. 공식 deprecation 문서 기준 `gpt-image-1` 종료일은 2026-12-01(예전에 여기 적혀 있던 2026-10-23은 오기)이고 권장 대체가 `gpt-image-2`이며 단가도 더 싸다.
- ✅ 해결(2026-09-16): heavy-pipeline(조사/집필/재작성) 원고 유실이 이틀 연속 재발했다 - GitHub Actions concurrency 큐 의존을 걷어내고 Supabase 기반 자체 큐(`pipeline_dispatch_queue`/`pipeline_lock`)로 근본 수정했다.
- 공개 발행(`BLOGGER_PUBLISH_AS_DRAFT=false`)을 켜는 기준은 "원고·이미지 품질이 보장됐다"는 사용자 판단이다 - 초안 자동 저장까지는 이미 켰다(2026-09-16). 켜기 전에 미충족 이미지 마커 제거(완료)와 사람이 채우는 3영역(퍼머링크/검색설명/웹검색이미지) 절차를 사용자가 숙지해야 한다.
- ✅ 해결(2026-09-16): 텔레그램 클릭 자체가 유실됐다(telegram-update.yml의 concurrency 큐 - 대기 취소 시 클릭 내용이 영구 소실). concurrency 삭제로 병렬 처리. 오늘 유실된 클릭(두쥐안 답장·나비 승인·커뮤니티 Go 2건)은 사용자가 다시 누르면 정상 처리된다.
- ⬜ 새 DB 큐 + 병렬 telegram-update가 실제 사용자 클릭 패턴(여러 건 몰림)에서도 유실 없이 동작하는지 며칠 더 관찰 필요 - `gh run list --workflow=telegram-update.yml`에 cancelled가 0건이어야 한다.
- ✅ 해결(2026-09-17): `웹 검색` 마커에 AI 이미지를 생성하던 버그(한국어 검색어가 그대로 gpt-image-2로). 획득 방식을 읽어 건너뛴다.
- ⬜ 09-16 이전 원고의 웹 검색 자리에는 이미 저품질 AI 이미지가 남아 있다 - `images:collect`가 같은 자리에 제대로 된 이미지를 추가하므로 사람이 고르고 지워야 한다.
- ✅ 해결(2026-09-17): 관공서 화면·법령 조문은 이미지 자리에서 아예 제외하기로 결정(output-format.md §8-2). 그 제도가 적용되는 현장 실사로 대체한다 - 옛 원고에 남은 자리는 `images:collect`가 대안을 제안한다.
- ✅ 해결(2026-09-16): 이미지 프롬프트가 원고 내용과 동떨어짐 - output-format.md §8-1 "문단 한 장 요약" 규칙 + 데이터형 이미지 AI 생성 금지(웹 검색으로) + `checkImagePrompts` 검수.
- ✅ 해결(2026-09-16): 원고별 문체·어투 불일치 - `style/voice.md` 하나로 통일(trend 기준, incident 예외) + `checkVoice` 검수.
- ⬜ 위 두 건은 프롬프트 규칙 변경이라 **다음 실제 원고에서 어투 통일·이미지-문단 일치를 눈으로 확인**해야 한다(헤지 규칙 3회 재발 전례). 계정 레벨 스킬 원본(`/trend-blog-writer` 등)은 저장소 밖이라 미수정.
