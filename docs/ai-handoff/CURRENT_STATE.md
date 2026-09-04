# Claude Code 인수인계 상태

기준일: 2026-09-03 (Asia/Seoul)

## 2026-09-03 세션 — 네이버 제목 클릭 30초 타임아웃 방어 코드 (미검증)

브랜치 `claude/naver-tistory-blogspot-publish-dnh60r`(별도 세션 창, 이후 네이버·티스토리·
블로그스팟 임시저장/발행 관련 작업은 이 창을 계속 쓴다). 대상 이슈: §12에서 문서화만 되고
코드에는 반영 안 됐던 "재진입 시 클릭 차단"(`se-popup-dim` dim 오버레이)이 실제
`job:publish` 실행에서도 제목 클릭 30초 타임아웃으로 재현됨.

**가설**: 오버레이(추정: "이어서 작성하시겠습니까" 류 확인창이 짧게 떴다 사라짐)가 title 클릭
시점에 떠 있으면 `page.click()`이 "다른 요소에 가려짐" 판정으로 기본 30초 액션너빌리티
타임아웃을 그대로 소진한다. **`NaverBlogPublisher.ts`에 방어 코드 추가**:
- `dismissRecoveryOverlay()` — 오버레이가 있으면 Escape로 닫고 사라질 때까지 최대 8초 대기(없으면
  즉시 반환, 정상 경로에 대기 추가 없음).
- `safeClick()` — 클릭 전 오버레이 통과, 막히면 한 번 더 통과 후 재시도(1회당 타임아웃 10초로
  단축 - 오버레이가 아닌 다른 이유로 막혀도 30초씩 두 번 이상 걸리지 않게).
- 제목/본문/이미지업로드/임시저장 클릭 지점 전부에 적용.
- `saveFailureSnapshot()` — stage 실패 시 HTML+스크린샷을 `.local/dom-snapshots/naver-publish/`에
  남긴다(가설이 틀렸을 경우 다음 실패의 실제 화면을 사후에 볼 수 있게).

**⚠️ 라이브 미검증**: 원격 세션은 사용자의 실제 네이버 로그인 프로필(`.local/naver-publish-profile/`)에
접근할 수 없어 headed 브라우저로 재현·검증이 불가능하다. `npm run build` 통과, 기존
`npm run test:naver-publish`/`test:naver-html`(오케스트레이션/HTML 변환 단위 테스트, 실제
브라우저 조작 없음)만 확인. **다음에 `npm run job:publish -- <jobId> --watch`로 라이브 재검증
필요** — 특히 임시저장된 기존 초안이 있는 상태에서 재진입시켜 오버레이가 실제로 뜨는지, 뜬다면
Escape로 닫히는지 확인. 실패하면 스냅샷 디렉터리에서 화면 상태를 먼저 확인한다.

## 2026-09-02 세션(메인 윈도우) — 자료조사 provider 분리(Claude → Gemini, 기본 off)

**목적**: 자료조사 단계(researcher 에이전트)가 파이프라인에서 Claude 사용량을 가장 많이 먹는다
(WebSearch 반복, ~10분+). 집필/OSMU 배리에이션은 블로그 스킬(entertainment/parenting/
trend-blog-writer) 의존이 강해 Claude를 유지하지만, 자료조사는 스킬 의존이 없어 분리 가능
하다고 판단 — Gemini(Google Search grounding)로 이 단계만 분리했다.

**구현**: `RESEARCH_PROVIDER` env(`claude`|`gemini`, 기본 `claude` — 안 건드리면 기존 동작 그대로).
- `src/config/researchProvider.ts` — provider/모델/폴백 설정
- `src/services/llm/runGeminiResearch.ts` — Gemini REST 호출(SDK 없이 fetch, `tools:[{google_search:{}}]`).
  Node 22 전역 fetch/AbortController 사용, 새 npm 의존성 추가 안 함.
- `src/workflows/research/buildGeminiResearchPrompt.ts` — `researcher.md` 전문을 Node가 직접
  읽어 프롬프트에 인라인(Gemini는 Read 도구가 없음). 파일 저장도 Node가 직접 함(Write 도구 없음).
- `runArticleJob.ts`의 `runResearchStageInner`: `options.runResearcher`(테스트 주입)가 없을 때만
  `runDefaultResearcher`가 provider 분기. Gemini 실패 시 `RESEARCH_FALLBACK_TO_CLAUDE`(기본 true)로
  같은 job에 한해 Claude로 자동 폴백.
- 출력 계약(`research/<슬러그>.md`, researcher.md §7 템플릿)은 그대로라 `parseResearchFile.ts`
  이하 전부 무변경.
- 신규 `npm run debug:gemini-research -- "키워드"` — DB 안 건드리고 실제 Gemini 호출 1회 스모크
  테스트(`research/<슬러그>-gemini-smoketest.md`에 저장).

**실측(2026-09-02, 이 세션 = 별도 클라우드 체크아웃, 프로덕션 .env 아님)**:
- `gemini-2.5-flash`는 신규 사용자에게 404(퇴역, `gemini-3.6-flash` 권장 — API가 직접 안내) → 기본
  모델을 `gemini-3.6-flash`로 변경.
- `gemini-3.6-flash` + `google_search` grounding 호출 시 **429 RESOURCE_EXHAUSTED**(quota/billing
  안내 링크 포함). API 키 자체는 유효(404/429 둘 다 인증 통과 후의 응답). **Google Search grounding이
  이 키의 현재 플랜에서 막혀 있을 가능성이 높다** — Google AI Studio 콘솔에서 결제 활성화 여부 확인
  필요(다음 세션 확인 사항).
- `RESEARCH_PROVIDER` 기본값이 `claude`라 이 상태로도 운영에는 영향 없음. `RESEARCH_FALLBACK_TO_CLAUDE`
  덕에 나중에 `gemini`로 켜도 quota 문제 시 자동으로 Claude로 넘어간다.

**검증**: `npm run build`, `test:gemini-research-prompt`(신규), `test:research-prompt`,
`test:parse-research` 전부 통과. `debug:gemini-research`로 실측(위 429 확인).

**후속(같은 날, 결제 활성화 후 재검증)**: 사용자가 Google AI Studio에 결제를 연결한 뒤 429가
사라짐 — `debug:gemini-research`로 재실측 성공(테스트 키워드 "테스트 키워드 삭제예정", 31초,
5784자). `groundingChunks` 원시 응답 구조도 별도 확인(`candidate.groundingMetadata.groundingChunks[].web.{uri,title}`
— 코드의 추출 로직과 일치, 진짜 조선일보/연합뉴스TV 등 실제 언론사 도메인이 리다이렉트 URL로
확인됨 = 실제 grounding이지 환각 아님). §10 출처 표에도 같은 형식의 URL이 정상적으로 채워졌고,
verdict 판정도 §7 규칙대로 정확히 계산됨(blocked — official+medical 합계 1 < 2, news 1 <3).
다만 `debug:gemini-research`가 출력하는 "grounding 출처 N건" 카운트는 이 특정 호출에서 0으로
찍혔는데, 실제 응답 텍스트(§10 표)에는 grounding 형식 URL이 정상적으로 있었다 — 코드의
groundingSources 추출은 §10 표 검증에 쓰이지 않는 참고용 필드라 기능적으로 막힌 건 아니지만
원인 불명(사소한 버그로 남겨둠, 다음에 재현되면 조사).

**실제 키워드 A/B 비교(2026-09-03, "2026년 추석 연휴 기간", `npm run debug:compare-research`)**:
신규 `debugCompareResearchProviders.ts` — 실전과 동일한 `buildResearchPrompt`/`buildGeminiResearchPrompt`
+ `runHeadlessClaude`/`runGeminiResearch`를 그대로 재사용해 같은 키워드를 두 경로로 순서대로 실행.

- **환경 주의(중요, 결과 해석에 영향)**: 이 클라우드 세션에서는 Claude의 WebFetch가 **전 도메인에서
  예외 없이 실패**했다("proxy refused the connection" - 이 세션의 아웃바운드 프록시 제약으로 추정,
  사용자 맥 프로덕션 환경과 다름). Claude는 이 사실을 파일 최상단에 스스로 명시하고, §2 확인됨
  등급을 한 건도 안 쓰며 전부 보도됨/미확인으로 보수적으로 낮춰 기록했다 — researcher.md §2가
  요구하는 정직한 한계 고지를 정확히 따른 것. 즉 이 비교는 Claude가 정상 컨디션(WebFetch 가능)일
  때의 품질이 아니라 "핸디캡을 진 상태에서도 규칙을 지키는가"를 본 셈이라, 사용자 맥에서 재검증하면
  Claude 쪽 결과가 더 좋아질 가능성이 높다.
- **Claude**: 475초, 14,443자, 40개 출처(§10), verdict `ok`(파서 버그로 한때 `thin` 오표시 - 아래
  버그 수정). URL이 전부 구체적 경로(article ID·게시글 번호 등)를 가진 실제 검색결과 형태.
- **Gemini**: 35초, 5,240자, 12개 출처, verdict `ok`. 핵심 사실(9/25 추석, 9/24~27 연휴, 대체공휴일
  없음)은 Claude와 일치 - 여기까지는 문제없음. **다만 "확인된 사실"(§2, official 등급) 3건 중 2건이
  `https://www.msit.go.kr`, `https://www.law.go.kr`처럼 특정 게시물 경로 없는 최상위 도메인에
  구체적인 원문 인용문("원문 근거")을 붙여놨다** - 이 URL로는 그 인용문을 확인할 수 없다(researcher.md
  §2 규칙 2·4 위반 소지 - 추측/미열람 확인). 하나는 "우주항공청이 발표"라고 써놓고 URL은 과기정통부
  (msit.go.kr)라 출처 자체도 안 맞는다. 실제 grounding API가 반환하는 URL은 전부
  `vertexaisearch.cloud.google.com/grounding-api-redirect/...` 형태인데(별도 확인 완료), 이 파일의
  §2/§10에 나온 저 두 URL은 그 형태가 아니다 - grounding된 실제 URL이 아니라 모델이 "그럴듯한
  공식 도메인"을 기억으로 채운 것으로 보인다.
- **버그 발견 + 수정**: `parseResearchFile.ts`의 frontmatter 파서가 `verdict: ok        # 주석`처럼
  인라인 주석이 붙으면(researcher.md §7 템플릿이 예시로 보여주는 형태) 값 전체를 "ok # 주석"으로
  읽어 무엇과도 안 맞아 `thin`으로 조용히 오분류했다. Claude가 실제로 이 형태를 남겨 재현됨 -
  checkpoint 알림의 "원고 작성" 버튼 노출을 좌우하는 값이라 실제 job 진행을 막을 수 있었던 문제.
  주석을 무시하도록 수정 + 회귀 테스트 추가, `test:parse-research` 통과.

**결론(현재)**: Gemini는 핵심 사실은 맞히지만 이번 실측에서 "official 등급 출처의 URL이 실제로
grounding된 것인지" 검증이 안 되는 사례가 나왔다 - 자동 채택하기엔 이르다.
**`RESEARCH_PROVIDER=claude` 기본값 유지.**

**grounding URL 강제 검증 구현 완료(2026-09-03, 같은 세션)**: 신규 `enforceGeminiGroundingUrls.ts`.
Gemini 응답에서 §2/§3 "- [official]"/"- [medical]" 불릿과 §10 표를 훑어, 그 항목의 URL이
(baseline URL + API가 실제로 돌려준 `groundingChunks` URL) 목록에 없으면 태그를 community로
강등하고 강등 표시를 붙인다. 강등이 하나라도 있으면 frontmatter의 `verdict`/`source_counts`를
researcher.md §7 공식대로 재계산해 다시 쓴다(안 그러면 강등 전 부풀려진 개수로 계산된 `ok`가
강등 사실과 모순된 채로 남는다). `runArticleJob.ts`의 Gemini 경로, `debug:gemini-research`,
`debug:compare-research` 전부 이 강제검증을 거친 텍스트를 저장하도록 배선. 신규
`test:gemini-grounding-enforce` 통과, `npm run build` 통과.

**실전 검증 중 발견한 더 큰 문제(2026-09-03)**: 같은 "2026년 추석 연휴 기간" 키워드로 새로
Gemini를 호출했더니 **`groundingMetadata.groundingChunks`가 이번에도 0건**으로 돌아왔다(전에도
한 번 이랬던 것과 동일 - 우연이 아니라 재현되는 패턴으로 보인다). §2에 적힌 URL들은 이번엔
`kasi.re.kr/.../newsMaterial/12061`, `law.go.kr/.../lsiSeq=262900`, `korea.kr/news/...?newsId=...`
처럼 이전보다 훨씬 그럴듯하고 구체적인 경로를 갖고 있었지만(진짜일 수도 있다), grounding 원시
응답이 비어 있어 강제검증이 8건 전부(official/medical 전량)를 community로 강등했고 verdict는
`thin`이 됐다. 즉 **researcher.md 규격에 맞는 긴 구조화 문서를 한 번에 생성하라고 시키면, Gemini가
google_search 도구를 켰는데도 API의 grounding 메타데이터가 비어 오는 경우가 실제로 흔하다**(원인
미확정 - 모델이 도구 결과 없이 학습 지식만으로 답했거나, 구조화된 긴 출력에서 API가 grounding
메타데이터를 못 채우는 API 쪽 특성일 수 있다). 강제검증 장치 자체는 설계대로 안전하게 동작했지만
(허위 "확인됨" 주장이 그대로 새 나가지 않는다), 실무적으로는 **지금 프롬프트 구조로는 Gemini가
official/medical 등급을 사실상 못 딴다**는 뜻이라 - "빠르고 저렴하지만 검수 게이트를 거의 항상
`thin`으로 통과한다"에 가깝다. Claude를 완전히 대체하기엔 이 상태로는 부족하다.

**결론(갱신)**: 강제검증으로 "거짓 확신"은 막았지만, 그 대가로 Gemini 경로의 실질 신뢰도가
기대보다 낮다는 게 드러났다. **`RESEARCH_PROVIDER=claude` 기본값 유지**하고, 아래 개선 없이는
`gemini`로 전환 안 함.

**남은 것**:
- ⬜ **grounding 실제 발동 여부 원인 규명/개선**: (a) 프롬프트를 "먼저 검색 결과를 그대로 나열하고
  그다음 템플릿에 채워라"처럼 2단계로 쪼개거나, (b) 짧은 grounding 질의 여러 번 + Node가 결과를
  조립하는 방식으로 바꾸면 grounding이 더 안정적으로 잡히는지 실험 필요. 지금 구조(긴 규격 문서
  1콜 생성)에서는 grounding이 비어 오는 경우가 흔했다.
- ⬜ 사용자 맥(WebFetch 정상 환경)에서 같은 키워드로 Claude 쪽 재비교 - 이 클라우드 세션의 Claude
  결과는 WebFetch 불능 핸디캡이 있어 정상 비교가 아니다.
- ⬜ 이 세션(클라우드 체크아웃)의 `.env`에는 GEMINI_API_KEY만 있고 NAVER/Supabase/Telegram 비밀값이
  없다 - 사용자 맥 프로덕션 `.env`에도 동일한 `GEMINI_API_KEY`/`RESEARCH_PROVIDER` 값을 넣어야 실제
  운영에 반영된다(이 세션은 별도 환경).

## 2026-09-01 세션(별도 창) — writing 멈춤 job 실사고 + 텔레그램 재시도 버튼

**실사고**: 사용자가 두 job에 "✏️ 원고 작성"을 눌렀는데 둘 다 "⏳ 이미 원고를 작성 중입니다"만
반복되고 원고가 안 왔다. `debug:approved-jobs`엔 안 잡힘(approved/published만 조회) - 실제로는
`article_jobs.status='writing'`에 멈춰 있었다(job `87d25d04-...`, `1b7e635e-...`).

**근본 원인**: `runWritingStage`(runArticleJob.ts:395-404, :437-441)는 writer 실패 시 **의도적으로**
status를 `writing`에서 되돌리지 않는다(이미 모은 근거·조사 파일 재사용 목적). 문제는 텔레그램
쪽(`isStillAtResearchCheckpoint`, `TelegramBot.ts`)이 `researching`/`selected`만 재시도 가능
상태로 보고 `writing`은 무조건 "이미 작성 중"만 반복해, **버튼으로는 죽은 job을 복구할 방법이
없었다.** 터미널로 jobId를 찾아 `npm run job:write -- <jobId>`를 직접 쳐야만 했다(CLI는
`NON_RETRYABLE_STATUSES`에 `writing`이 없어 재시도 가능).

이번 사고 자체는 이 원인 하나가 아니라, 오늘 커밋한 detached 실행 수정(`6a8efce`)이 **아직 이
맥의 운영 코드에 배포되지 않은 상태**(`logs/job_write.detached.log` 없음 - 구버전 동기 실행 중
사망 추정)에서 발생. 두 job은 사용자가 직접 `curl .../article_jobs?status=eq.writing`으로
jobId를 찾아 `job:write`로 재실행해 복구함(2026-09-01, `research/*` 로그 재개 확인).

**수정(`src/notifications/TelegramBot.ts` · `researchDecisionCallbackData.ts` ·
`runArticleJobCli.ts`)**:
- `research:retry:<jobId>` callback 신설. `writing`에 `WRITE_STUCK_THRESHOLD_MS`
  (`WRITE_TIMEOUT_MS` 20분 + 5분 버퍼) 이상 멈춘 job에는 "이미 작성 중" 안내에 **🔄 다시 시도**
  버튼을 함께 붙인다. 임계값 전이면(정상 진행 중일 수 있음) 버튼 없이 안내만 한다.
- retry는 `triggerWriting`(detached `job:write` 재실행)만 다시 부른다 - status는 이미 writing이라
  건드리지 않는다. writing이 아니게 됐거나 아직 임계값 전이면 `retry_rejected`로 거부(경합 방어).
- `sendMessage`가 `reply_markup`(inline keyboard)을 받을 수 있게 확장.
- `job:write`(jobId 없이 실행)가 이제 `status=writing` job도 목록에 보여준다(경과 시간 포함) -
  전에는 approved/published만 보는 `debug:approved-jobs`나 직접 DB 조회 없이는 멈춘 job의 jobId를
  찾을 방법이 없었다.
- status를 writing에서 되돌리지 않는 기존 설계는 그대로 유지(근거·조사 파일 재사용 의도가
  유효하므로) - 대신 사람이 "죽었다"고 판단할 신호(경과 시간)와 버튼만 추가했다.

검증: `test:telegram-bot`(8-6a 갱신 + 8-7/8-8 신규 - 임계값 전/후, retry 성공/거부 3종) +
`test:research-decision-callback` + `test:callback-data` + `npm run build` 전부 통과.

**남은 것**:
- ⬜ 오늘 detached 실행 커밋(`6a8efce`)이 이 맥 운영 코드에 아직 배포 안 됨 - `work`/현재 브랜치를
  `main`에 병합 후 배포하면 "5분 무응답+15분 잠김" 구버전 증상 자체가 사라진다. 그 전까진 지금 추가한
  재시도 버튼이 안전망 역할.
- ⬜ writing 멈춤이 재발하면 `research:retry` 버튼으로 텔레그램에서 바로 복구 가능 - 터미널 접근
  불필요해짐(단, 여전히 임계값 25분은 기다려야 버튼이 뜬다).

## 2026-09-03 세션 — 원고 퀄리티 컨트롤: 책임 회피 문장·톤 불일치 수정

별도 세션(`claude/manuscript-quality-control-oasnpf`)에서 사용자가 발행 전 검수 중 지적한 4가지
문제를 원인까지 추적해 고쳤다. `prompts/writing/writer.md`, 신규 `prompts/writing/style/*.md`,
`src/workflows/writing/buildWritingPrompt.ts`(+테스트) 변경.

**문제 1·2·3 — 헤지·책임 회피·과잉 불확실성 표기·"결론부터 말씀드리면" 남발**: writer.md 자체가
원인이었다. §4 "등급별 서술 강도" 표가 `news`(뉴스 출처) 등급을 매번 "~라고 보도됐다" 식으로
쓰라고 못박아 두고 있었다 — 그런데 트렌드·연예 카테고리는 대부분 사실이 news 등급이라 문장마다
헤지가 반복됐다. §6 충돌1은 "결론부터 말씀드리면"을 오프닝 직후 **고정 문구로 매번 삽입**하라고
명시하고 있었다. 리서치의 `확인되지 않은 통설`/`확인 실패`를 다룰 때 disclaimer를 붙이라는 규칙은
있었지만 애초에 "굳이 다루지 않는다"는 원칙이 없어, 애매한 내용을 disclaimer와 함께 원고에 그대로
옮기는 패턴이 나왔다. 세 가지 모두 writer.md를 수정해 해결했다:
- §4: `## 3. 보도로만 확인된 내용`(뉴스 2곳 이상 교차확인)은 이제 단정 가능. "보도에 따르면"류
  반복 금지, 처음 1회만 자연스러운 표시 허용.
- §4-1(신규): `확인되지 않은 통설`/`확인 실패`/`등급 판정 보류`는 검색 의도상 꼭 필요한 경우가
  아니면 원고에 넣지 않는다. 미확정 값은 참고값 + 기준 시점을 짧게 괄호로 붙이고, "이건 확인 안
  됐다"는 사실 자체를 별도 문장으로 늘어놓지 않는다.
- §6 충돌1: "결론부터 말씀드리면"은 선택지 중 하나로 격하(정책·안내형 글에서만 자연스럽게).
  구조(오프닝 → 직답)는 유지하되 고정 문구 요구는 제거.
- §7 구조도, §11 체크리스트에 위 내용 반영.

**문제 4 — 톤이 "우아 아빠" 개인 블로그가 아니라 기사 톤**: 근본 원인은 설계와 실행의 괴리였다.
계정 레벨 스킬 `entertainment-blog-writer`/`parenting-blog-writer`/`trend-blog-writer`가 실제 발행
최종본을 분석해 만든 정교한 문체 가이드를 갖고 있었는데, `buildWritingPrompt.ts`는 "헤드리스에서
Skill 라우팅이 로드 안 된다"는 이유로 이 세 스킬을 완전히 우회하고 legacy
`pickStyleRules`(PERSONAL/EDITORIAL 2분류, 얕은 요약)로만 대체하고 있었다 — 그래서 세 스킬의
디테일(제목 공식, 흐름 7단계, 문체 관찰 근거)이 파이프라인에 전혀 반영되지 않았다. 사용자가 준
실제 발행 최종본 5편(네이버 블로그, mobile 페이지로 확보)을 확인해 계정 스킬 내용이 정확함을
검증한 뒤, 세 스킬을 리포 안 파일로 복제했다: `prompts/writing/style/{parenting,entertainment,
trend}.md`(web_search 지시는 제거, 리서치 파일 참조로 교체, 위 헤지 수정사항 반영). `Skill`
호출과 달리 `Read`는 헤드리스에서 항상 로드되므로(runArticleJob.ts의 allowedTools에 Read 포함,
실측 확인됨) 이 경로가 확실하다. `buildWritingPrompt.ts`가 category(entertainment/ott →
entertainment.md, parenting → parenting.md, living/community/미분류 → trend.md)에 맞는 파일을
Read하라고 지시하도록 변경. **계정 스킬 원본이 바뀌면 이 3개 사본도 같이 갱신해야 한다** — 동기화
안 하면 다시 벌어진다.

**검증**: `npm run build` 통과(이 세션 컨테이너에 `node_modules` 없어서 `npm ci` 먼저 실행).
`testBuildWritingPrompt`(카테고리별 문체 파일 분기 3케이스 추가) / `testBuildArticlePrompt` /
`testArticleReview` / `testParseDraftFile` 전부 green. **라이브 E2E 미실행** — 다음 원고 생성 때
실제 톤 개선을 실측 확인해야 한다.

**남은 것**:
- ⬜ 다음 실제 원고 생성으로 톤 개선 실측 검증(이번 수정은 정적 검증만 마침).
- ⬜ `generateArticleVariant.ts`(OSMU 배리에이션)는 writer.md §4를 Read하라고만 지시하고 스타일
  파일은 안 가리킨다 — 기준 원고 톤을 베이스로 재구성하므로 우선순위는 낮지만, 배리에이션에서도
  같은 문제가 재현되면 `category ? "- 카테고리: ..."` 줄에 스타일 파일 참조를 추가해야 한다.
- ⬜ `buildArticlePrompt.ts`의 legacy `pickStyleRules`(PERSONAL/EDITORIAL 2분류)는 `scripts/
  generateSampleArticle.ts`(수동 샘플 생성 스크립트)에서만 쓰인다 - 손대지 않았다. 그 스크립트도
  같은 톤 문제를 겪을 수 있으니, 쓸 일이 있으면 같이 손볼 것.
- ✅ 계정 레벨 스킬 3개도 오늘 정한 정책과 맞춰 고쳤다(trend-blog-writer의 "정직하게 헤지합니다"
  문구 2곳 제거, "결론부터 말씀드리면" 고정 문구 완화, 뉴스 반복 인용 완화). 각 스킬 상단에
  "고치면 리포도 갱신" 경고 배너 추가.
- ✅ `scripts/syncWriterStyle.ts`(`npm run sync:writer-style [-- --apply]`) 신설 - 계정 스킬과
  `prompts/writing/style/.snapshots/*.skill.md`(마지막 동기화 시점 원문, git 추적)를 비교해 drift를
  diff로 보여준다. **자동으로 파생본을 덮어쓰지 않는다** - 파생본은 원본을 그대로 베낀 게 아니라
  일부러 고친 버전이라, 맹목적 자동 복사는 오늘 고친 내용을 원본의 옛 표현으로 되돌릴 위험이 있다.
  diff를 보고 `prompts/writing/style/<카테고리>.md`를 직접(또는 Claude에게 요청해) 반영한 뒤
  `--apply`로 스냅샷만 갱신한다. 이 저장소가 아닌 다른 머신(계정 스킬이 없는 곳)에서는 "못 찾음"만
  뜬다 - 원고 자동화가 실제로 도는 머신에서 실행해야 의미가 있다.

## 2026-09-01 세션 — 원고 파이프라인 재설계 (스펙 주도 파일 기반)

전체 계획: `~/.claude/plans/serialized-spinning-feigenbaum.md`. 커밋 `0ba2368`(P1) →
`c197a08`(P2) → `c107be7`(P3) → `68fd36d`(P4+5), 브랜치 `work`. **아직 라이브 미검증** —
researcher/writer 에이전트가 실제로 규격대로 파일을 쓰는지는 다음 E2E에서 확인한다.

**무엇이 바뀌었나**: 자료조사·집필이 Node 인라인 프롬프트 주도 → **스펙 문서 주도 + 파일 산출**로.
Node는 조율만 한다(헤드리스 `claude -p` 호출 · 산출 파일 파싱 · DB 반영 · 알림).

- **Phase 1 (비용 통제)**: `CLAUDE.md`에 "원고 파이프라인 운영 규칙" 절 신설. 원고 내 이미지
  API 자동생성 **보류**(`ARTICLE_IMAGE_GENERATION` 기본 false, `src/config/articleImages.ts`) —
  코드·provider는 유지, `[IMAGE: 설명]` 마커를 본문에 남겨 사용자가 직접 삽입. Blogspot는
  `BLOGGER_PUBLISH_AS_DRAFT` 기본 true 유지(당분간 draft 고정). `notifyArticleReady`/
  `notifyMultiPublish`에 "직접 삽입 후 발행" 안내.
- **Phase 2 (자료조사)**: `runResearchStage` 하이브리드 재작성. Node가 NAVER API로 기준 sources
  수집(감사 베이스라인) → 헤드리스 researcher가 `prompts/research/researcher.md` 계약대로
  WebSearch/WebFetch로 보강해 `research/<슬러그>.md` 작성 → Node가 파싱(frontmatter verdict/
  source_counts, §10 출처표에서 새 URL을 sources에 추가). 체크포인트 알림은 별도 LLM 요약 호출을
  없애고 `research/*.md` §1 요약을 그대로 쓴다. verdict=blocked면 `[✍️ 원고 작성]` 버튼 제거.
  신규 `src/config/pipelinePaths.ts`, `buildResearchPrompt.ts`, `parseResearchFile.ts`.
  `runHeadlessClaude`에 `permissionMode` 옵션(`--permission-mode acceptEdits` — Write/WebSearch가
  비대화형에서 동작하려면 필요, 2026-09-01 실측 확인).
- **Phase 3 (집필)**: `runWritingStage` 재작성. 헤드리스 writer가 `prompts/writing/writer.md` +
  `docs/seo-guide.md` 계약대로 `research/<슬러그>.md`를 읽고 `drafts/<슬러그>.md` 작성(웹 검색
  없음 — 사실은 자료조사 파일뿐) → Node가 frontmatter+본문 파싱 → `articles` 행. 소제목 `## `
  유지(다운스트림 변환기), `[IMAGE:]` 마커 유지. 신규 `buildWritingPrompt.ts`, `parseDraftFile.ts`.
  상수 정렬: `TARGET_ARTICLE_LENGTH` `{2000,3000}`, `HASHTAG_COUNT` `10` (writer.md·seo-guide).
  `buildArticlePrompt`/`parseArticleOutput`는 레거시로 남김(상수·톤 규칙·의학 고지 헬퍼 공유).
- **Phase 4 (검수)**: `articleReviewChecks` 팩트 대조에 `research/<슬러그>.md` 전문 추가(에이전트
  인용 웹 출처는 sources에 URL만 있어 오탐 방지). `[IMAGE:]` 마커는 변환기에서 문단 텍스트로 통과.
- **Phase 5 (배리에이션)**: `generateArticleVariant` 프롬프트에 writer.md Read·준수 참조,
  `allowedTools`에 `Read` 추가. 출력은 stdout 마커 유지, 사실은 기준 원고에서만.

**산출 파일**: `research/`, `drafts/`는 `.gitignore`(repo 루트만 — `src/workflows/research/`는 소스라
제외). job 1건 = 파일 1개, 재실행 시 덮어쓴다.

**라이브 E2E 1회 완료(2026-09-01, "가을장마" job `b374133f`, 커밋 `672bf1d`~`0a23c24`)**:
파일 기반 research→write 파이프라인 검증됨. 진행: Go → 조사(하이브리드) → `research/*.md`(28KB,
verdict ok, 근거 31건) → 체크포인트 → 원고 작성 → `drafts/*.md`(2760자) → 검수(경고 1건) →
"수정 필요" → draft 트림 → 재작성(재검수 0건) → 승인 → 3채널 발행.
- ✅ researcher/writer 에이전트가 규격(researcher.md §7 / writer.md §9)대로 파일 산출
- ✅ 파서(parseResearchFile / parseDraftFile) 정상, verdict·§10 출처표·해시태그·HTML 주석 분리
- ✅ "✏️ 수정 필요" → draft 편집 → `job:write` 재실행 사이클(신규)
- ✅ Blogspot draft(본문 정상 6743자, OSMU 배리에이션 #19)
- ⚠️ **네이버 임시저장: 제목만 들어가고 본문이 비어 있음** — `NaverBlogPublisher.focusAndPasteHtml`의
  클립보드 paste가 조용히 실패(HTML 변환은 정상 5976자 확인). P1-5와 무관한 브라우저 자동화
  버그(Sprint 4 §12에서 한 번 잡았던 증상 재발 또는 새 원인). paste 후 본문 되읽기 검증이 없어
  실패를 못 잡는다. **헤디드 브라우저로 재현·수정 필요.**
- ⚠️ 티스토리 deferred(카카오 세션 만료) — 변형 원고 #18은 생성됨, `npm run setup:tistory` 필요
- 🐛 `telegramPollJob` 로그가 비의학 confirm/edit도 "⚕️ 의학 교차확인"으로 출력(문구만, 기능 무관)
- E2E 중 파이프라인 무관 잠재 버그 8건 수정(커밋 참고): NUL 바이트, timestamp 파싱, 에러 직렬화
  `[object Object]`, 헤드리스 타임아웃 3건(WRITE 20분/VARIANT 20분/재조사 재사용), `[IMAGE PROMPT:]`
  검수 오발, `## 참고 자료` 복원, `_workspace/` gitignore.

**남은 것**:
- ⬜ **네이버 본문 paste 버그** — 헤디드 브라우저로 재현. paste 후 본문 요소 텍스트 길이 검증 추가.
- ⬜ 라이브 E2E 중 `launchctl bootout`으로 내렸던 launchd `telegram-poll`/`publish-poll`은
  2026-09-01 세션 종료 시 `bootstrap`으로 복구함(prod worktree = main = 구 코드).
- ⬜ `work` 브랜치(P1-5 + E2E fixes, 커밋 `0ba2368`~`0a23c24`)를 `main`에 병합할지 결정 후 prod 배포.
- ⬜ researcher 웹조사로 조사 스테이지 소요 급증(~1분 → 10분+). launchd telegram-poll 5분 주기 ·
  `singleInstanceLock` 상호작용 재점검.
- ⬜ 이미지 재개 시 `generateArticleImages`를 `## 헤딩 뒤 삽입` → `[IMAGE:]` 마커 인식으로 변경.
- ⬜ `prompts/writing/writer.md` §2 스킬 라우팅(anthropic-skills)은 헤드리스 미로드 — 프롬프트에서
  content-blog로 오버라이드 중. writer.md 자체 정리는 사용자 WIP.

## 2026-09-01 세션 — 전체 워크플로우 라이브 E2E 시뮬레이션

키워드 수집 → 3채널 발행까지 실제 프로덕션 조건에서 한 번 관통시켰다. 대상 키워드
"한강 불꽃축제 2026"(run #28, job `9a34f7cf`). 결과: **8단계 중 7.5단계 통과.**

| 단계 | 결과 | 비고 |
|---|---|---|
| 키워드 수집 | ✅ run #28, 텔레그램 10건 | CA 215 + 구글트렌드 9 |
| Go 선택 → job 생성 | ✅ | job `9a34f7cf` |
| 자료조사(자동) | ✅ 근거 6건 | |
| 집필 | ✅ (1회 재시도) | article #12, 3,080자, 88초 |
| 이미지 | ✅ 3/3장 | OpenAI, Storage 업로드, `images` #11~13 |
| Telegraph | ✅ | 공개·영구 페이지 |
| 검수 → 승인 | ✅ job/article `approved` | |
| 네이버 발행 | ✅ 임시저장 | publication #5 pending |
| Blogspot 발행 | ✅ OSMU 배리에이션 #13 → draft | publication #6 pending, post 1482945663230556163 |
| 티스토리 발행 | ⚠️ deferred | 배리에이션 #14 생성됨, 카카오 세션 만료 → 재시도 대기 |

job은 `approved` 유지(전 채널 성공 시에만 `published` — 실패 격리 정상 동작).

**이번에 드러난 것:**
1. **일시적**: 첫 집필이 usage limit으로 `claude` 종료코드 1 → job이 `writing`에 멈춤. 한도 리셋 후
   `job:write` 재실행으로 복구(`writing`은 재시도 가능 상태). `metadata.lastError`에 옛 실패 문자열이
   남는 것은 성공 시 안 지워짐 — 사소한 표시 버그.
2. **검수 오탐**: 팩트 검사가 본문 `20:40~21:10` 시각 표기를 "40분·10분 근거 미확인"으로 잡음.
   알려진 한계(차단 아님).
3. **로그 문구 버그**: `telegramPollJob`이 비의학 원고의 confirm도 "⚕️ 의학 교차확인 confirm"으로
   출력. `reviewResults` status가 `reviewed`면 무조건 의학으로 간주하는 로그 분기 탓. 기능 무관.
4. **티스토리**: 예상대로 카카오 세션 만료 → `publish-poll`이 deferred 처리 + 하루 1회 로그인 알림.
   재개: `npm run setup:tistory`.
5. **원고 품질**: 날짜가 자료마다 9/5 vs 10/3로 엇갈리자 본문에서 명시적으로 헷지 + "공식 채널
   재확인" 문구 삽입. Sprint 2 마감 이벤트 교훈이 반영된 동작.

**시뮬레이션 테스트 잔재 정리(2026-09-01):**
- `job:close 9a34f7cf` → job/article `published` 전이(발행 대기열 제외).
- Blogspot draft(post 1482945663230556163) API로 삭제.
- Supabase Storage `article-images/9a34f7cf.../{1,2,3}.png` 3장 삭제.
- `publications` #5·#6, `images` #11~13, `articles` #12~14, `article_jobs` `9a34f7cf` 행 삭제.
- **유지**: `discovery_run` #28 + `keyword_rankings`(실제 키워드 데이터, watchdog가 오늘 완료 run
  집계에 씀). Telegraph 공개 페이지는 삭제 불가.
- **사용자 수동**: 네이버 블로그 임시저장함의 "한강 불꽃축제..." 초안 1건 직접 삭제.

---

## 2026-08-31 세션 (오전/오후 2회 발송 + 자동 흐름 + 브랜치 통합)

전체 계획: `/Users/wooahpapa/.claude/plans/adaptive-wibbling-abelson.md`

**Phase 0 — 브랜치 통합 + 운영 고정 (완료)**
- `claude/community-collector` + `claude/multi-platform-publish`를 `main`에 병합, `origin/main` push.
  이제 Sprint 0~5(설계) + 구글트렌드 + 커뮤니티 + 주제중복제거가 전부 main에 있다.
- **운영 worktree 분리**: `~/blog-automation-prod`가 `main` 고정. 세 launchd job의 `WorkingDirectory`가
  여기다. `.env`/`.local`/`logs`는 개발 레포(`~/Documents/blog-automation`)로 심링크.
  개발 레포에서 브랜치를 바꿔도 자동화는 영향 없다. 배포:
  `git -C ~/blog-automation-prod pull && npm --prefix ~/blog-automation-prod ci && ... build`.
  ⚠️ main이 prod worktree에 잡혀 있어 개발 레포에서 `git checkout main` 불가 - 병합은 prod에서 하거나
  `git -C ~/blog-automation-prod merge` 사용.

**Phase 1 — 오전/오후 키워드 발송 분리 (완료, 실측)**
- 오전 09:00 `daily-keyword`: Creator Advisor + 구글 트렌드만. (커뮤니티 제거)
- 오후 13:00 `community-keyword`(신규 job + plist): 더쿠 커뮤니티 유래 키워드만 별도 알림 1건.
  `runDailyKeywordWorkflow({ collectionSources: ["community"], includeSeedQueries: false })`.
  `discovery_runs.metadata.kind = "community"`. 알림 헤더 "📡 오후 커뮤니티 인기 키워드".
  실측: run #26에서 Top 10 정상 발송(커뮤니티 후보 cap 12→18로 상향, per-topic sub-cap 제거).
  ⚠️ 관찰 필요: 커뮤니티 Top 10이 정치·논란 편중(노란봉투법·김문수·부동산 정책 등), 점수 낮음(21~45),
  유사 항목 일부 미병합(나혼산 전현무 x2). 며칠 관찰 후 community 전용 relevance/필터 조정.

**Phase 2 — Go → 자료조사 자동 시작 (완료, launchd 반영. 실클릭 검증 대기)**
- Go 버튼 → job 생성 + 제목 생성 + **자료조사 자동 실행**(runResearchStage) → notifyResearchReady가
  요약 + 추천 제목 + `[✍️ 원고 작성][🗑 중단]` 발송. 사용자는 Go 한 번만 누르면 조사 요약이 온다.
  `TelegramBot`에 `triggerResearch` 주입, `pollOnce`에서 `jobFromFreshSelection()`으로 대상 판정.
- 확인 메시지는 제목 대신 "자료조사 시작"만 알림. 제목은 조사 완료 알림으로 이동.
- **신규 `singleInstanceLock`**: telegram-poll 5분 주기 + 조사/집필(수 분)이 겹칠 때 다음 폴러가
  같은 update를 두 번 처리하는 것을 파일 락으로 막는다(`logs/.telegram-poll.lock`, PID+mtime stale 판정).

**Phase 3 — Top 10 중복 제거 (완료, 실측 기반)**
- 실측(run #20/#22/#23)에서 Top 1·2가 같은 사건 기사로 채워지는 도배는 전부 "동일 seedQuery 2건"
  (황재균 지연 x2, 상생페이백 x2, 비비 워터밤 x2). `DIVERSITY_CONFIG.maxPerSeedQuery: 2 → 1`.
- 분류어 seedQuery(넷플릭스/티빙/지원금 + 그날의 seed_queries)는 seed cap 제외 - 다른 작품 2편이
  플랫폼 이름 하나로 묶이면 안 되므로.
- `DIVERSITY_CONFIG.maxPerCategory`(기본 비활성 {}) + 후보 얕은 날 상한 해제 fallback pass 추가.
- 신규 `npm run debug:latest-rankings [n]` - 최근 run들의 Top N 출력(읽기 전용).

**Phase 4 — 승인 → 다채널 자동 발행 (코드 완료, Blogspot까지)**
- `job.status = approved`가 발행 대기열. `publishPollJob`(신규, 10분 주기 plist)이 활성 채널로 fan-out.
  - 네이버: 기존 반자동 임시저장(`publishArticleToNaver`) - 이제 수동 `job:publish` 대신 폴러가 자동 호출.
  - Blogspot: `generateArticleVariant`(claude -p, 팩트 보존)로 OSMU 배리에이션 원고 생성 →
    `BloggerClient.insertPost` → **초기 draft**(`BLOGGER_PUBLISH_AS_DRAFT=true` 기본). 일일 상한 5건 하드 가드.
  - 티스토리: **Phase 5 완료 + 활성화**(아래).
- 채널 실패 격리. 전 채널 성공 시에만 `job.status=published`. `notifyMultiPublish`가 채널별 결과 알림.
- `articles.platform` 컬럼: **migration 20260831040000 적용 완료**(`supabase db push`, 2026-08-31).
  null=기준 원고(네이버), "blogspot"/"tistory"=배리에이션.
- ✅ `supabase migration list` 10개 전부 local==remote.
- 신규 CLI: `job:publish-poll`, `job:close`(대기열에서 제외), `debug:approved-jobs`,
  `debug:check-preflight`. 테스트 7종.
- ✅ **라이브 Blogspot 발행 검증**(2026-08-31): "맥도날드 감튀 홀더" → 배리에이션 원고 #10
  (platform=blogspot) → Blogspot DRAFT(post 8185770171361608510, 이미지 3장, 라벨 "생활정보").
- ✅ **`publish-poll` launchd 등록 완료**(10분 주기). 실측: 맥도날드 job → 두 채널 already_done →
  `job.status=published` 전이. 보조금24 job → preflight 차단(deferred).
- **preflight 가드**(`defaultPreflight`): 기준 원고 이미지가 전부 우리 Supabase Storage URL이 아니면
  job 전체를 deferred(알림 없음)로 건너뛴다. "보조금24" job(Sprint 3 잔재)은 `job:close`로 정리 완료.

**Phase 5 — 티스토리 반자동 발행 (완료 + 활성화, 2026-08-31)**
- `setup:tistory` 실측: 티스토리 에디터 = KEditor 0.9.1(**TinyMCE**). 본문은 클립보드 합성 없이
  `tinymce.get("editor-tistory").setContent(html)`. 제목 `#post-title-inp`, 태그 `#tagText`,
  임시저장 `.btn-draft a.action`. "완료"(`#publish-layer-btn`)는 절대 안 누름.
- `TistoryPublisher.saveDraft()`: 각 단계 되읽어 검증. "임시저장" 클릭 → `POST /manage/drafts` 응답 +
  "임시저장 개수" 증가로 성공 확인(고정 대기 아님 - 1차 실측이 조용히 실패한 원인).
  ✅ 라이브 검증: 제목/본문/외부 이미지(Supabase URL 그대로 렌더)/태그 반영 스크린샷 확인.
- ⚠️ **카카오 세션이 짧아 자주 만료**된다. 만료 시 `login_required` → 폴러가 `deferred`(재시도 대기,
  failed 기록·스팸 없음). `publish-poll`이 감지하면 **하루 1회** "티스토리 로그인 필요" 텔레그램
  알림(`logs/.tistory-login-alerted` dedupe). 재로그인: `npm run setup:tistory`.
- 티스토리 임시저장 글은 **직접 URL 없음** - 글쓰기 화면 하단 "임시저장 N" 버튼 → 목록 팝업.
- `.env` `TISTORY_ENABLED=true` + `TISTORY_BLOG_URL=https://wooahpapa.tistory.com/`. 일일 상한 5.
- 신규: `setup:tistory` / `inspect:tistory` / `debug:live-tistory [--via-publisher]` /
  `test:publish-tistory`(7종). 프로필 `.local/tistory-publish-profile/`(네이버·CA와 분리).

**이제 승인 1번 → 3채널**: 네이버 임시저장 + Blogspot OSMU 자동발행(draft) + 티스토리 OSMU 임시저장.

**운영 노트 - launchd 4개 + pmset 기상 (2026-08-31)**
- launchd: `daily-keyword`(09:00) / `community-keyword`(13:00) / `telegram-poll`(5분) / `publish-poll`(10분).
  전부 `~/blog-automation-prod` worktree(main 고정)에서 실행, caffeinate -i 래핑.
- ⚠️ **pmset repeat 기상은 하루 1개만 가능**. 사용자가 `12:55`로 바꿨다가 `08:55`(오전, 필수)로
  복구. 오후 13:00 run은 맥이 그 시각에 깨어 있어야 정시 실행되고, 자고 있으면 다음 기상 시
  지연 실행된다(맥 사용 중이면 문제 없음). watchdog(11:00 KST GitHub Actions)은 오전 run만 감지 -
  오후 run 감지 추가는 TODO.

---

기준일(이전): 2026-08-30 (Asia/Seoul)

## 한 줄 상태

**Sprint 0·1·2 완료, Sprint 3(검수 게이트 + 이미지) 전 단계 완료.** 매일 09:00 키워드 TOP 10이
Telegram으로 오고, Go/Pass 버튼으로 선택하면 `article_jobs`가 생긴다. 거기서부터 조사 완료
알림의 `[✍️ 원고 작성][🗑 중단]` 버튼으로 원고 생성까지 이어지고, 그 안에서 **검수 규칙 4종이
자동으로 돌고**(차단은 아님, 결과만 알림에 표시) **AI 이미지 2~3장이 실사(photorealistic)
스타일로 자동 생성돼 본문에 삽입된 채로**(OpenAI `gpt-image-1` 기본) Telegraph에 발행된다 -
카테고리별 톤(entertainment/ott/parenting은 개인 블로그 톤, living은 편집자 톤, 실제 블로그
샘플 분석 기반)도 적용된다. `[✅ 승인][✏️ 수정 필요][🗑 반려]` 버튼(모든 원고 공통)으로
`job`/`article` status가 `approved`로 전이된다. 경복궁·아기 셔더링어택·재혼 황후·보조금24·
맥도날드 감튀 홀더 5건으로 전 구간 실측 검증 완료(이미지 포함 최종 형태는 맥도날드 건으로
확인). 상세는 `docs/ai-handoff/SPRINT_2_DESIGN.md` 14절과 `docs/ai-handoff/SPRINT_3_DESIGN.md`
13-1·14절.

**다음 작업(2026-08-30 사용자 결정): 티스토리 + 블로그스팟(Blogspot) 자동 발행 — 원고 승인 후
자동 업로드까지.** 별도 새 브랜치에서 진행한다. 네이버 반자동 발행(Sprint 4)이 참고 모델이지만,
티스토리/블로그스팟은 공식 API가 있어(네이버 SmartEditor 브라우저 자동화와 달리) 접근이 다르다 -
설계부터 시작. 승인된 원고(`job.status = approved`)를 트리거로 삼는다.

**직전 진행 상황**:
- `claude/community-collector` 브랜치에서 **커뮤니티(더쿠) 수집기 구현·실측·활성화 완료.**
  머지는 2026-08-31 오전 09:00 run 결과 관찰 후 진행. 아래 "키워드 수집 확장" 절 §7-4.
- Sprint 4(네이버 반자동 발행)는 §10 작업 1~7 완료 - 승인 원고가 `job:publish` 한 번으로
  네이버 임시저장함까지 들어간다. 남은 사람 개입은 "발행" 버튼 클릭뿐.
- `claude/keyword-collection-optimization-6ojcou` 브랜치도 아직 `main` 미머지.

## 지금 돌아가는 것

### 매일 아침: 키워드 수집 -> 알림

```
pmset(08:55 자동 기상) -> launchd(09:00) -> caffeinate -i -> npm run job:daily-keyword
  [trendCollect] Creator Advisor 크롤링 + 구글 트렌드 RSS -> trend_candidates upsert
  [seed]         seed_queries(44) + trend_candidates(40, 다중 source) = 84건
  [collect]      NAVER 검색 API -> 후보 ~2100건                      (~70초)
  [relevance]    seed 관련성 필터 -> ~900건
  [cluster]      유사도 클러스터링 -> ~400개
  [rank]         6-factor scoring + diversity -> Top 10
  [save]         discovery_runs + keyword_rankings
  [notify]       Telegram 발송
실패 시 -> Telegram으로 단계별 실패 알림 (실발송 검증 완료)
```

전체 소요 약 80초. `trendCollect` 실패는 비치명적으로 처리되어 job을 죽이지 않는다.
알림은 헤더 1건 + 항목 10건으로 나가고, 항목마다 `[✍️ Go] [⏭ Pass]` 버튼이 붙는다.

### 상시: 버튼 클릭 처리 (5분 주기)

```
launchd(StartInterval 300) -> caffeinate -i -> npm run job:telegram-poll
  getUpdates(offset)  -> telegram_offsets 커서 이후만
  callback 파싱       -> go / pass / (구)sel
  chat_id 검증        -> 다른 대화에서 온 것 거부
  keyword_rankings 재조회 -> 위조/만료 callback_data 거부
  article_jobs 기록   -> Go=selected / Pass=rejected
  claude -p 제목 생성 -> Go로 새로 만들어진 job에만
  확인 메시지 + 버튼 상태 갱신
```

처리할 update가 없으면 약 2초에 조용히 끝난다(로그도 남기지 않는다). Go 처리 시 제목 생성에
25초쯤 걸려 `caffeinate`가 필요하다.

## Sprint 1: 선택 루프 (2026-08-27 완료)

설계는 `docs/ai-handoff/SPRINT_1_DESIGN.md`. 확정된 두 결정은 주기적 폴링(맥 잠자기 회피)과
추천 제목의 선택-후 생성이다.

### 새 테이블 2개

- `article_jobs` — 선택된 키워드 1건 = job 1건. 이후 조사->집필->이미지->검수->발행 전 단계의
  상태 머신. `keyword_rankings`를 FK로 참조하지 않고 값을 복사한다(run 스냅샷은 정리 대상이지만
  job은 며칠~몇 주 살아 있어야 한다).
- `telegram_offsets` — getUpdates 커서. 수신기가 짧게 반복 실행되므로 메모리에 둘 수 없다.

둘 다 RLS on + anon/authenticated 권한 회수 + service_role 명시.

### 멱등성과 마음 바꾸기

`unique (source_run_id, source_rank)`로 중복 클릭을 막는다. upsert가 아니라 insert 후
unique violation(23505)을 잡는데, upsert는 기존 row를 덮어써서 이미 writing 단계인 job이 버튼
재클릭으로 selected로 리셋되기 때문이다.

`selected <-> rejected`는 서로 전환할 수 있다. 잘못 눌렀을 때 빠져나올 방법이 없으면 unique
index 때문에 그 항목이 영구히 막힌다. 다만 이미 researching/writing인 job은 `locked`로 거부한다.

### callback_data 규약

`go:<run_id>:<rank>` / `pass:<run_id>:<rank>`. 구 `sel:` 접두사는 go 별칭으로 계속 받는다
(이미 발송된 메시지의 버튼을 회수할 수 없다).

키워드를 넣지 않는 이유가 둘이다. Telegram의 64바이트 제한에 한글 키워드 하나로도 걸리고,
참조 키만 담으면 수신 측이 `keyword_rankings`에서 다시 읽어야 하는데 이것이 곧 검증이 된다 -
위조된 값으로 임의 키워드를 주입해도 조회되지 않으면 거부된다.

발송 측과 수신 측이 같은 형식을 써야 하므로 `notifications/telegramCallbackData.ts` 하나만
참조하게 했다. 각자 조립하면 한쪽만 바뀌었을 때 버튼이 조용히 죽는다.

### 헤드리스 LLM

`services/llm/runHeadlessClaude.ts`가 `claude -p`를 1회 실행한다. Sprint 2의 원고 생성도 같은
경로를 쓴다. API가 아니라 CLI인 이유는 기존 블로그 작성 스킬을 그대로 재사용하기 위해서다 -
프롬프트로 이식하면 스킬이 두 벌이 된다.

프롬프트는 argv가 아니라 stdin으로 넘기고(원고 길이에서 argv 제한·셸 이스케이프), 도구 사용은
기본 차단하며, 타임아웃을 반드시 건다.

### UX: 숫자 격자 -> 항목별 Go/Pass

처음에는 전체를 한 메시지에 담고 하단에 1~10 숫자 버튼을 달았는데, 폰에서 항목이 한 화면에 안
들어와 스크롤로 대조해야 했다. Telegram은 인라인 키보드를 메시지 단위로만 붙일 수 있어서, 항목
바로 아래 버튼을 두려면 항목마다 메시지가 따로 가야 한다(헤더 1 + 항목 10 = 11건, 6초).

Pass는 `rejected`로 기록한다. 다음 개선 지점이 키워드 품질인데 사용자가 실제로 무엇을 거부했는지가
가장 직접적인 신호이고, 지금 모으지 않으면 소급할 수 없다. Pass에서는 제목을 만들지 않는다.

### 실측 검증 (실제 폰 클릭)

  Go(rank 2,7)      -> selected + 제목 3개
  Pass(rank 6)      -> rejected, 제목 0개(LLM 호출 없음)
  중복 Go(rank 1,2) -> unchanged, job/제목 재생성 없음

5건 39초. 가장 위험하다고 본 헤드리스 제목 생성이 첫 실행에서 동작했고 출력 파싱도 깨끗했다.

### 알려진 한계

같은 run의 알림을 재발송하면 이미 결정된 항목의 버튼이 초기 상태로 보인다. 발송 시점에 기존
결정을 조회하지 않기 때문이다. 매일 새 run이 생기므로 실사용에서는 거의 나타나지 않고, 다시
눌러도 `unchanged`로 처리돼 데이터는 안전하다. 필요해지면 `ArticleJobRepository.listByRunId`를
발송 경로에 연결하면 된다.

## 2026-08-26 세션에서 한 일

### 1. Supabase migration 적용 (승인 후)

`20260826024112_upgrade_legacy_trend_candidates.sql`을 Dashboard SQL Editor에서 단독 실행.
Supabase CLI 미설치 + `.env`에 DB 비밀번호 없음 → CLI 경로 불가. `db push`는 원격 history가
비어 있어 여전히 **금지**.

검증 통과: 컬럼 3개 추가/2개 제거, NOT NULL 10개, unique index, RLS on, service_role 권한,
row 0 유지, 다른 테이블 row 수 전부 보존.

### 2. 문서에 없던 원격 테이블 2개 발견

- `images` (article_id, image_url, source, **copyright_status**, alt_text) → Sprint 3에서
  `article_assets`를 새로 만들지 말고 이걸 재사용한다.
- `analytics` (publication_id, views, likes, comments, collected_at) → Sprint 5 통계용.
- **둘 다 `src/types/database.ts`에 정의가 없다**(원격 10개 / 코드 8개). 타입 갭 미해결.
- `articles`/`sources`/`publications`의 각 2행은 `testCrud script`가 남긴 테스트 데이터.

### 3. 누락된 배선 구현

크롤링/변환/저장 조각은 다 있었으나 **프로덕션에서 이어 호출하는 코드가 없었다.**
`buildDailyQueryPool`이 아무도 쓰지 않는 테이블을 읽고 있었다.

- 신규 `workflows/creator-advisor/runCreatorAdvisorCollection.ts` — 실패해도 throw하지 않고
  `status`로만 알림. `dryRun`으로 DB 쓰기 없이 크롤링만 검증 가능.
- `dailyKeywordWorkflow.ts`에 `trendCollect` 단계를 `seed` 앞에 non-blocking 삽입.
- 신규 CLI `collect:creator-advisor` (기본 dry-run, `WRITE=1`로 실제 저장).

### 4. Creator Advisor 파서 근본 원인 해결 (0건 → 220건)

**근본 원인**: `checkCurrentDateStatus()`가 **전역** `.u_ni_trend_item` 개수로 준비 완료를 판정했다.
성별·연령별(demographic) card가 topic card보다 먼저 채워지므로, topic card가 전부 비어 있는
시점에 전역 60개를 보고 "available"로 오판하고 그 HTML을 캡처했다.

| 시점 | cards | topicRows | globalRows |
|---|---|---|---|
| 렌더 대기 직후 | 22 | 0 | 0 |
| 화면 상태 전환 직후 | 33 | 0 | 60 ← 오판 지점 |
| +2초 | 33 | 60 | 120 |

**수정**: `trendsPageReadiness.ts`에 `measureTopicCardRows()` / `waitForTopicCardRowsSettled()` 추가.
전역이 아니라 **비-demographic topic card 안의 row**를 기준으로 카드별 시그니처가 안정될 때까지
폴링한다(고정 sleep 아님). `DEMOGRAPHIC_TITLE_PATTERN`을 export해 Node/브라우저가 같은 정규식을 쓴다.

**Swiper 순회 추가**(Codex 위임 → Claude 검증): `.u_ni_search_swiper`가 2개(topic 11 / demographic 22)로
**서로 다른 인스턴스**이고, 루트 요소에 `element.swiper`가 살아 있어 버튼 없이 `slideTo(index)`로
제어 가능하다. Creator Advisor는 card를 전부 DOM에 만들되 viewport 주변 3장만 row를 채우므로
(lazy) 순회 없이는 3개 topic만 얻는다. `traverseTopicSwiper()`가 전 슬라이드를 순회한다.

`maxTopics` 기본값 4 → **11**. 4로 두면 영화·일상·생각 등 주요 분야가 통째로 빠진다.

**결과**: 11 topic × 20 = 220건, topicErrors 0건, 약 5초.

### 5. 카테고리 오분류 해결

Creator Advisor는 category를 **topic card 단위로만** 준다. 그래서 `육아·결혼` 카드 20건이 전부
`parenting`이 되었고, 실제로는 **진짜 육아가 7건뿐**이었다(나머지는 정부 지원금과 연예 뉴스).

신규 `config/keywordCategoryRules.ts` — 키워드 어휘로 먼저 판정하고, 확실한 신호가 없을 때만
topic 매핑으로 폴백한다. 순서가 우선순위다(entertainment > ott > parenting > living):
- "양준모 재혼 상대 양지원, 임신 소식"은 "임신"이 있어도 연예 뉴스 → entertainment
- "아동수당 신청방법"은 "신청"이 있어도 육아 정보 → parenting

부수 효과로 같은 키워드가 카드마다 다른 category로 흩어지던 문제도 해결(중복 병합 11 → 15건).

**남은 한계**: `윤남노 복담주`, `수원 라뷔포레`, `루치아나바로소` 등 고유명사는 어휘 규칙으로
잡을 수 없어 topic 폴백을 탄다. 인명 사전이나 LLM 분류가 필요한 영역이라 규칙을 늘리지 않았다.

### 6. upsert 배치 내 conflict key 충돌 해결

unique index는 `(keyword_normalized, topic_normalized, trend_date, source)`인데 `topic_normalized`는
매핑된 카테고리다. topic 11개가 카테고리 4개로 축소되므로(living 하나에 6개) 같은 키워드가 같은
카테고리의 두 topic에 나오면 한 배치에 conflict key가 겹쳐 PostgreSQL이 **배치 전체를 거부**한다
(`ON CONFLICT DO UPDATE command cannot affect row a second time`, 21000).

`dedupeTrendCandidateInserts()`로 upsert 전에 병합한다. 승자는 pre-score가 높은 쪽(동점이면 rank가
앞선 쪽), 버려지는 쪽의 topic은 `metadata.mergedFrom`에 보존.

### 7. 에러 직렬화 결함 수정

Supabase(PostgrestError)는 `Error` 인스턴스가 아니라 평범한 객체라 `String(error)`가
`[object Object]`를 만들어 실패 원인이 통째로 사라졌다. **이걸 고치지 않았으면 6번 원인을
못 찾았다.** `message`/`code`/`details`/`hint`를 보존한다.

### 8. 실패 알림 구현 + 검증

이전에는 job이 실패해도 로그 파일에만 남고 조용히 죽었다. 신규
`notifications/notifyPipelineFailure.ts`가 단계별 결과를 Telegram으로 보낸다.
`dailyKeywordJob.ts` 안에 두면 import만으로 job이 실행돼 테스트할 수 없어서 별도 모듈로 분리했다.
**실제 발송까지 검증 완료.**

### 9. launchd 등록

`~/Library/LaunchAgents/com.wooahpapa.blog-automation.daily-keyword.plist`
매일 09:00, `RunAtLoad=false`, 로그는 `logs/daily-keyword.log`에 append.

해제: `launchctl bootout gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword`

**최초 08:00 등록분은 실패했다 - 아래 "운영 노트: 잠자기로 인한 조용한 실패" 참고.**

## 운영 노트: 잠자기로 인한 조용한 실패 (2026-08-27)

첫 자동 실행(08-27 08:22)이 실패했다. 사용자는 "맥이 꺼져 있어서 발송이 안 됐다"고 판단했지만
실제로는 **job이 실행됐다가 도중에 죽은 것**이었다. 로그를 직접 열어보고서야 알았다.

### 무슨 일이 있었나

```
[trendCollect] 5초   성공  <- trend_candidates에 205행 실제로 저장됨
[seed]         0.1초 성공
[collect]      70초   ...  <- 여기서 프로세스가 통째로 사라짐
(이후 로그 없음)
```

`discovery_runs`에 새 row가 없고, 로그에 `❌ ... 단계 실패`도 없었다. 예외였다면 `runStage`가
잡아서 기록했을 것이므로, **예외가 아니라 강제 종료**였다.

### 근본 원인

```
$ pmset -g custom
 sleep  1      <- 유휴 1분 후 시스템 잠자기
```

이 맥은 유휴 1분이면 잠든다. 그런데 launchd로 띄운 백그라운드 job은 **전원 assertion을 잡지
않는다.** 맥이 08:22에 (시스템 알람으로) 잠깐 깨어나 job을 시작했지만, 1분 뒤 다시 잠들면서
70초짜리 collect 단계가 죽었다.

### 해결

plist의 `ProgramArguments`를 `caffeinate -i`로 감쌌다:

```
/usr/bin/caffeinate -i /opt/homebrew/bin/npm run job:daily-keyword
```

`-i`는 **이 job이 도는 동안에만** 유휴 잠자기를 막고 job이 끝나면 assertion이 사라진다.
맥의 전역 전원 설정(`pmset sleep`)은 건드리지 않는다.

추가로 실행 시각을 09:00으로 옮기고, 맥이 스스로 깨어나도록 예약 기상을 걸었다:

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 08:55:00   # 해제: sudo pmset repeat cancel
```

전체 체인: `08:55 pmset 기상` -> `09:00 launchd 발화` -> `caffeinate -i`가 85초 실행 보호

### 검증 방법 (다음에도 이렇게 하면 된다)

내일 아침을 기다릴 필요 없다. `kickstart`는 launchd의 **실제 실행 환경**(PATH, cwd, 비대화형
세션)으로 즉시 실행한다:

```bash
launchctl kickstart gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword
launchctl print gui/$(id -u)/com.wooahpapa.blog-automation.daily-keyword | grep -E "runs|last exit"
```

이 방법으로 검증한 결과 8단계 전부 success, `last exit code = 0`, 85초, run #18 Telegram 발송
완료였다. 이 과정에서 **Playwright가 비대화형 launchd 세션에서도 정상 동작한다**는 것도 확인됐다
(가장 우려하던 위험이었다).

### 여기서 배운 것

**강제 종료된 프로세스는 실패 알림을 보낼 수 없다.** 어제 만든 알림(`notifyPipelineFailure`)은
예외를 잡아서 보내는 구조라 이런 조용한 죽음을 못 잡는다. `caffeinate`가 이 시나리오를 크게
줄여주지만 완전히 없애지는 못한다(전원 차단, 강제 재부팅 등). 근본 해결은 "오늘 성공한 run이
없으면 알린다"는 외부 감시인데, 감시자가 같은 맥에 있으면 같은 문제를 겪는다 - 클라우드로
나가야 하며 Sprint 1의 텔레그램 수신 서버 설계와 함께 다룬다.

## 검증된 명령 (2026-08-26 전부 green)

```
npm run build
npm run test:telegram-bot                # 신규 - callback 핸들러 9케이스
npm run test:callback-data               # 신규 - callback_data 규약
npm run test:score-keyword               # 신규 - freshness 불변식
npm run test:keyword-category            # 신규 - 실제 수집 키워드 24건
npm run test:creator-advisor-parser
npm run test:creator-advisor-pipeline
npm run test:creator-advisor-collection  # 신규 - 배선/실패격리/dedupe 7케이스
npm run test:daily-query-pool
npm run test:notification
npm run test:failure-notification        # 신규 - SEND=1로 실발송
npm run test:keywords
npm run test:naver
npm run test:ranking

npm run collect:creator-advisor          # 신규, 기본 dry-run / WRITE=1로 저장
npm run debug:ca-snapshots               # 신규, DOM 스냅샷 -> .local/dom-snapshots/
npm run job:telegram-poll                # 신규, 버튼 클릭 1회 수신 처리
```

`test:naver`/`test:keywords`/`test:ranking`은 외부 NAVER API를 실제 호출한다.
`test:trend-candidate-repository`는 원격 쓰기가 가능하므로 `ALLOW_SUPABASE_WRITE_TEST=1`은
별도 승인 시에만 사용한다.

## ⚠️ 이름이 오해를 부르는 것

**`npm run dryrun:daily-keyword`는 dry-run이 아니다.** Telegram만 dry-run이고,
`saveRankingHistory`에 write guard가 없어 `discovery_runs`/`keyword_rankings`에 실제로 쓴다.

## 현재 원격 DB 상태

| 테이블 | 행 수 |
|---|---|
| discovery_runs | 16 |
| keyword_rankings | 133 |
| trend_candidates | 215 (active 205 / archived 10) |
| seed_queries | 44 |
| keywords | 38 |
| articles / sources / publications | 각 2 (testCrud 잔재) |
| images / analytics | 0 |

`archived` 10행은 카테고리 수정 전 버전이다. active 조회에서 제외되므로 무해하다.

## 알려진 문제 / 미해결

1. **~~6-factor 중 2개가 죽어 있다~~ — 오진단이었음(2026-08-26 정정).**
   `news`/`cross`가 88% 0점인 것은 결함이 아니라 희소 발화 보너스로 설계된 대로 동작하는 것이다.
   run 15/16/17 데이터로 확인: 발화한 8건은 평균 3.6위/56.6점, 발화 안 한 22건은 6.2위/51.5점.
   발화 항목이 전부 실제로 가장 뉴스성 높은 것들이었다(양준모 재혼, 민음사 빵, 장동윤 결혼).
   **손대지 말 것 - 건드리면 변별력이 사라진다.**
2. **~~freshness 계산이 뒤집혀 있다~~ — 해결됨(2026-08-26).**
   `neutralScoreRatio`를 0.5 → 0.2로 낮춰 발행일 없음이 8점 → 3점이 되었다.
   이제 `발행일 없음(3) < 당일 발행(7)`. `test:score-keyword`가 이 불변식을 고정하며, 0.5로
   되돌리면 실제로 실패하는 것까지 확인했다.
   `TREND_MOMENTUM_CONFIG.neutralScoreRatio: 0.4`도 같은 패턴이라 확인했으나, `unknown`(12점)이
   관측된 모든 값(17~30)보다 낮아 실제 역전이 없어 손대지 않았다.
3. **~~Top 10에 같은 주제가 2번씩 들어간다~~ — 부분 해결됨(2026-08-29).**
   실제로는 2번이 아니라 **4번**까지 들어갔다("넷플릭스 들쥐" 4건). 원인이 두 겹이었다:
   (a) cross-seed clustering이 `excludeSeedQueryFromTokens` 때문에 구조적으로 병합 불가
       (유사도가 정확히 0.000), (b) `maxPerCanonicalTopic=1`이 canonical 문자열 완전 일치로만 세서
       cap이 발화하지 않음. seed 2개 × `maxPerSeedQuery=2` = 정확히 4건이었다.
   (b)는 `topicGrouping.ts`(신규)로 해결 — 최종 선정 단계에서 희소 핵심 명사 공유/핵심 명사 overlap
   으로 같은 주제를 판정한다. `npm run test:topic-grouping`이 고정한다.
   **(a)는 그대로 남아 있다** — clustering 로직 변경이라 승인이 필요하다. 지금은 한 이슈가 여전히
   cluster 4개로 쪼개져 있어 relatedCount/news/cross 점수를 손해 본다.
   상세: `docs/ai-handoff/KEYWORD_SOURCE_EXPANSION.md`
4. **맥이 09:00에 완전히 꺼져 있으면 여전히 실행되지 않는다.** `caffeinate`는 "도는 중에 잠들지
   않게" 할 뿐 "깨우지는" 못하고, `pmset repeat`도 전원이 차단된 상태에서는 한계가 있다.
   더 큰 문제는 **강제 종료 시 실패 알림이 나가지 않는다**는 점이다(위 운영 노트 참고).
   Creator Advisor 크롤링이 로그인된 브라우저 프로필에 묶여 있어 클라우드 이전이 단순하지 않다.
5. ~~`images`/`analytics` 타입 정의 없음~~ — 해결됨(2026-08-27). `database.ts`가 12개 테이블을
   모두 안다. 다만 두 테이블의 `id`가 identity인지는 형제 테이블 관례로 추론한 것이라,
   처음 insert하는 시점(Sprint 3/5)에 실제로 확인해야 한다.
6. **같은 run 재발송 시 버튼 상태가 초기값으로 보인다.** 위 Sprint 1 "알려진 한계" 참고. 무해하다.
7. **버튼 반응까지 최대 5분 걸린다.** 주기적 폴링의 구조적 특성이고, `answerCallbackQuery`는
   그 시점에 만료돼 버튼 로딩 표시가 그냥 사라진다(확인 메시지는 정상 도착). 즉시 반응이
   필요해지면 클라우드 webhook으로 옮겨야 하는데, 핸들러가 수신 방식과 분리돼 있어 옮길 때
   버릴 코드는 거의 없다.
8. Supabase CLI 미설치. migration history와 로컬 파일이 계속 어긋나 있다.
9. 테스트에 assertion 프레임워크가 없다(console.log + assert 헬퍼).
10. `parseTrendHtml.ts` 상단 주석의 "topic과 demographic이 같은 swiper 인스턴스"는 실측과 어긋날
   가능성이 있으나 확정 근거가 부족해 수정하지 않았다.

## n8n 도입 검토 결과

**지금은 도입하지 않는다.** 오늘 겪은 문제(파서 준비 판정, 카테고리 매핑, upsert 충돌, 에러 직렬화)는
전부 도메인 로직이라 오케스트레이터를 바꿔도 그대로 남는다. `dailyKeywordWorkflow.ts`가 이미
stage log·실패 격리·비치명적 단계 구분을 하고 있고, Playwright 크롤링은 n8n 노드와 잘 맞지 않는다.
채널이 늘어 분기·재시도가 많아지는 Sprint 4~5에 재검토한다. 클라우드 이전이 목적이라면 n8n보다
GitHub Actions가 더 맞다(이미 npm 스크립트라 `cron` + `npm run job:daily-keyword`면 된다).

## Sprint 2: 자료조사 + 원고 생성 (진행 중, 2026-08-28)

설계는 `docs/ai-handoff/SPRINT_2_DESIGN.md`. 다음이 구현되고 경복궁·아기 셔더링어택·재혼 황후
3건으로 실측 검증됐다(커밋 `55bf97e` → `e1b953d` → `8f7540b` → `86c8996` → `d893113` →
`d2876ed` → `776c581`):

```
npm run job:research -- <jobId>   NAVER 재검색 + 공공 도메인 fetch -> sources 저장 ->
                                    LLM 요약(경고/사실/판단 3구간)을 Telegram으로 발송,
                                    [✍️ 원고 작성][🗑 중단] 버튼 부착
(사람이 확인 -> 버튼 클릭 또는 CLI)
npm run job:write -- <jobId>      저장된 sources를 재사용해 원고 생성(재조사 안 함) ->
                                    해시태그 15개 + (의학이면) 출처 신뢰도 고지 부착 ->
                                    Telegraph 발행 -> "📄 원고 보기" 버튼 발송
npm run job:reject -- <jobId>     가치가 없다고 판단되면 여기서 끝낸다(사유 기록)
```

원고 작성/중단은 이제 Telegram 버튼으로도 된다 - write 버튼은 `runWritingStage`(최대 수 분)를
`job:telegram-poll`의 콜백 처리 안에서 그대로 실행한다(Go 버튼의 제목 생성과 같은 패턴).

- **자료조사** (`workflows/research/`): 카테고리 무관 NAVER 뉴스/웹/블로그 재검색, 출처를
  official/medical/news/community 4등급으로 분류(`config/sourceAuthorityRules.ts`), official
  등급 URL은 본문을 직접 fetch해 스니펫을 보강한다(`fetchOfficialSourceContent.ts` — 네비게이션
  메뉴 오추출 결함을 고쳐 실제 예매 기간을 뽑아내는 것까지 검증됨, SPRINT_2_DESIGN.md 12/14-1절).
- **의학 주제**: 자동 배제하지 않고 생성하되, 판정되면(`config/medicalTopicRules.ts`)
  `requiresMedicalReview`가 붙어 Telegram에 "확인함/수정 필요/폐기" 버튼이 함께 간다(설계 5절).
- **집필** (`workflows/writing/`): `runHeadlessClaude`로 `moai-writer:korean-humanize` +
  `moai-marketer:content-blog` 스킬을 헤드리스 실행. 실측 원고 길이 1786자(목표 1500~2500 내),
  소요 185초.
- **체크포인트 도입 이유**: 첫 실측에서 대상 키워드("2026 경복궁 별빛야행")가 실제로는 이미 예매가
  마감된 이벤트였는데, 원고 생성 비용(3분)을 다 쓴 뒤에야 알게 됐다. 조사 직후 사람이 "이 근거로
  써도 될까요?"를 판단할 지점을 만들었다 (SPRINT_2_DESIGN.md 13/14-2절).
- **원고 확인**: Telegram 메시지는 마크다운을 서식으로 렌더링하지 않아 telegra.ph 페이지로 발행하고
  버튼으로 연결한다. 발행 실패 시엔 본문 dump로 폴백(14-3절). ⚠️ Telegraph 페이지는 URL을 아는
  누구나 볼 수 있는 공개 페이지 — 검수 전 원고 노출 트레이드오프를 사용자가 승인했다.

**남은 것**: 이미지 삽입, SPA 예매 페이지(ticketlink.co.kr 등) 자동 판독은 미해결 —
체크포인트에서 사람이 원본 사이트를 직접 열어보는 것으로 당분간 대체.

## Sprint 3: 검수 게이트 + 이미지 (전 단계 완료)

설계: `docs/ai-handoff/SPRINT_3_DESIGN.md`. 승인된 결정 5건은 §15에, 작업 순서/상태는 §14에 있다.

**구현 완료(커밋 `83542f6`, `f249b66`, `39322c2`, `9e693fe` 외) + 실측 검증(2026-08-28,
"보조금24"/"맥도날드 감튀 홀더" job)**:

1. **검수 규칙 4종** (`src/workflows/review/`) - 팩트/법적/광고/품질. 팩트 검사가 가장 까다로웠다:
   근거의 "2026. 9. 2."와 본문의 "9월 2일"을 같은 값으로 인식하도록 정규화해야 했고, 그래도 못
   맞추는 표기가 남으므로 "틀렸다"가 아니라 **"근거에서 확인되지 않음"**으로만 표기한다. 저장된
   실제 원고 3건에 돌려 캘리브레이션했고, 합성 테스트로는 못 볼 오탐 6가지(URL 인코딩에서 가짜
   백분율, 참고 자료 링크 제목을 우리 표현으로 오인 등)를 찾아 고쳤다 - `normalizeFactTokens.ts`/
   `articleReviewChecks.ts` 상단 주석에 전부 기록돼 있다.
2. **검수 결과가 알림에 표시된다** - `job.metadata.reviewChecks`에 저장(새 테이블 대신, 결정 2번).
   ⚠️ 차단이 아니라 참고다(결정 1번) - 원고는 검수 결과와 무관하게 항상 사람에게 간다.
3. **승인 버튼이 모든 원고 공통이 됐다** - `[✅ 승인][✏️ 수정 필요][🗑 반려]`가 이제 비의학
   원고에도 붙고, 승인(confirm)이 `job.status`/`article.status`를 `approved`로 전이시킨다.
   의학 주제는 승인 시 `requiresMedicalReview`도 함께 내린다. ⚠️ 의미가 바뀐 지점: 이 통합
   이전에 confirm이 눌린 job("아기 셔더링어택")은 `review`에 남아 있어 다시 눌러야 approved가
   된다.
4. **전 구간 실측 검증** - "보조금24" job(지원금 주제, 숫자·날짜 밀도가 높아 팩트 검사 시험에
   적합)으로 조사→버튼→작성→검수(통과)→Telegraph 발행→승인 버튼→`approved` 전이까지 실제로
   확인했다.
5. **이미지 자동 생성 + 본문 삽입** (`SPRINT_3_DESIGN.md` 13-1절, 2026-08-28 재작업) -
   "이미지가 포함된 원고 풀세트가 필요하다"는 피드백으로, 브리프만 만들어 ChatGPT로 넘기던
   방식을 완전 자동화로 바꿨다. 사용자가 `OPENAI_API_KEY`(기본)/`GEMINI_API_KEY`(전환용)를
   직접 제공. `runWritingStage` 안에서 섹션별(도입부+소제목, 2~3장) 장면을 기획하고
   OpenAI `gpt-image-1`로 생성 → Supabase Storage 신규 공개 버킷(`article-images`) 업로드 →
   본문에 마크다운 이미지로 삽입 → Telegraph에 `<figure><img/><figcaption>`으로 렌더링까지
   승인 전에 전부 끝난다. 스타일은 **실사(photorealistic)**로 확정(처음엔 일러스트였다가 사용자
   요청으로 전환) - 얼굴 안 보이는 구도 강제 + 무지 포장/로고 없음 강제로 초상권·상표권 위험을
   프롬프트 단계에서 방어한다. Gemini는 "나노바나나2 라이트"(`gemini-3.1-flash-lite-image`)로
   고정했으나 ⚠️ 무료 티어라 실제 호출은 429로 막혀 있다(유료 결제 필요, 기본 provider는
   openai라 지금은 영향 없음).
6. **이미지 기록** - 자동 생성된 이미지는 `images` 테이블에 자동 기록된다
   (`copyright_status: ai-generated:openai` 형태). **실제 insert로 `images.id`가 identity
   (자동 증가)임을 확인했다** - `types/database.ts`의 미검증 주석을 해소했다. `job:image` CLI
   (`npm run job:image -- <jobId> <imageUrl> <copyrightStatus>`)는 수동 보완 경로로 남아
   있지만, 이미지 직접 교체 기능은 별도 구현하지 않기로 했다 - Sprint 4가 반자동 업로드라
   사용자가 업로드 직전 단계에서 이미 직접 통제할 수 있다(사용자 확인, 2026-08-28).

**실측 검증**: "맥도날드 감튀 홀더" job으로 이미지 3/3장 성공, Telegraph 페이지에 `<img>` 3개
+ `<figcaption>` 3개 정상 렌더링 확인. 실사 스타일도 별도로 생성해 확인(손만 나오고 얼굴 없음,
무지 포장, 로고 없음). "보조금24" job의 `images`에는 초기 검증용 플레이스홀더 URL이 남아
있다(자동화 이전 수동 테스트 흔적) - 실사용 전 정리할 것.

## Sprint 4: 네이버 반자동 발행 (진행 중, 2026-08-28)

설계: `docs/ai-handoff/SPRINT_4_DESIGN.md`. 결정 6건은 §9에, 작업 순서는 §10에 있다.

**완료(§10 item 1-4)**:

1. **실측** - `npm run setup:naver-publish` + `npm run inspect:publish-layer`(신규, "발행"
   버튼을 1회 눌러 설정 패널만 여는 전용 스크립트, 실제 발행 확정 버튼은 절대 클릭하지 않음)로
   실제 로그인 세션에서 SmartEditor DOM을 실측했다. 핵심 발견:
   - `/{blogId}/postwrite?categoryNo={n}`로 **직접** 이동하면 프레임셋을 거치지 않고
     SmartEditor가 최상위 문서로 바로 뜬다(블로그 홈은 frameset이라 자동화에 쓰면 안 됨).
   - 저장/발행 버튼이 3개로 나뉜다 - 툴바 `tpb.save`(임시저장), 툴바 `tpb.publish`(설정
     패널을 여는 버튼, 발행 확정 아님), 패널 안 `tpb*i.publish`/`seOnePublishBtn`(진짜 발행
     확정 - 코드 어디에도 이 셀렉터를 클릭하는 부분이 없다).
   - 태그 입력란(`#tag-input`)은 패널을 열어야만 DOM에 렌더링된다(정적 화면엔 없음).
   - 상세 셀렉터 표는 `SPRINT_4_DESIGN.md` §6-2.
2. **`convertArticleToNaverHtml.ts`** (+ 테스트 8건, `npm run test:naver-html`) -
   `markdownToTelegraphNodes.ts`와 같은 마크다운 부분집합을 SmartEditor 붙여넣기용 HTML
   문자열로 변환. Telegraph 변환기와 달리 Node[] 트리가 아니라 HTML 문자열이 필요한 이유:
   SmartEditor는 API가 없어 브라우저에 paste 이벤트로 넣는 경로만 있다.
3. **`NaverBlogPublisher.ts`** - 제목/본문/이미지/태그를 채우고 "임시저장"만 하는 핵심 클래스
   (`saveDraft()`). ⚠️ **아직 라이브로 끝까지 실행해보지 않았다** - §10 item 7(실측 1건 검증,
   사용자 승인 필요)에서 처음 실제로 돌려본다. 미검증 가설이 여러 개 섞여 있다(파일 상단 주석에
   전부 기록):
   - 제목/본문 입력: SmartEditor는 보이는 `<p>`가 아니라 화면 밖에 숨겨진
     `contenteditable` proxy(IME 처리용으로 추정)가 실제 입력을 받는 구조로 보인다 - "보이는
     영역 클릭 -> 앱이 알아서 그 proxy로 포커스를 옮긴다"는 가정으로 `page.keyboard.type()`/
     paste event를 쓴다.
   - 이미지 업로드: 툴바 버튼 클릭 시 네이티브 파일 선택 대화상자가 뜬다는 가정
     (`page.waitForEvent("filechooser")`).
   - 태그 입력 후 Escape로 패널을 닫아도 입력한 태그가 유지되는지.
   - "임시저장" 성공 신호(토스트/URL 변화 등) - 지금은 저장 버튼 클릭 후 고정 3초 대기 +
     현재 URL을 draftUrl로 반환하는 임시 구현.
   - `saveDraft()`는 이 가설들이 틀리면 어느 stage(login/navigate/title/body/image/tags/save)
     에서 막혔는지를 결과로 알려준다 - 조용히 잘못된 성공을 보고하지 않는다.
   - 카테고리 번호는 실측 세션에서 확인된 32(육아)를 기본값으로 잠정 고정했다 - 내부 category
     (entertainment/ott/parenting/living)별로 다른 네이버 카테고리가 필요한지는 아직 결정된
     바 없다(§10 item 5에서 필요해지면 매핑표를 만든다).
4. **프로필 분리** - `src/config/naverPublish.ts`(Sprint 4 시작 시 이미 작성됨)가
   `.local/naver-publish-profile/`을 Creator Advisor의 `.local/creator-advisor-profile/`과
   분리해 관리한다(둘 다 gitignore).

5. **`publishArticleToNaver.ts` + `job:publish` CLI** - job 상태(`approved`인지) 확인 →
   원고/이미지/해시태그 조립 → `NaverBlogPublisher.saveDraft()` 호출 → `publications`에 기록.
   설계에서 정한 대로 이미지는 본문 paste에 `<img>`로 넣지 않고(`stripImageMarkdownBlocks()`로
   먼저 걷어냄) SmartEditor 툴바 업로드 경로로만 넣는다 - paste와 toolbar 업로드를 동시에 쓰면
   중복 삽입되기 때문이다. **멱등성**: 같은 job으로 두 번 실행해도 `publications`에 이미
   pending/published row가 있으면 재실행하지 않고 기존 기록을 그대로 돌려준다. **실패도
   기록한다** - `NaverBlogPublisher`가 어느 stage(login/title/body/image/tags/save)에서
   실패했는지까지 `publications.status='failed'`와 함께 CLI 출력에 그대로 나온다. 성공 시
   `publications.status`는 `'pending'`으로 남는다(`'published'`가 아니다 - 실제 발행 버튼은
   누르지 않았으므로 "published"라고 부르면 사실과 다르다). 단위 테스트 6건 전부 주입된
   가짜 의존성으로 오케스트레이션 로직만 검증(`npm run test:naver-publish`) - 실제
   Supabase/Playwright는 호출하지 않는다.

6. **`notifyPublishReady.ts`** - 임시저장 성공을 Telegram으로 알린다. `notifyArticleReady.ts`와
   달리 승인/반려 결정 버튼이 없다 - 이 시점의 유일한 다음 행동("네이버 앱에서 직접 발행 버튼
   누르기")은 Telegram 버튼으로 대신할 수 없기 때문이다. 초안 URL을 여는 버튼 하나만 붙이고,
   그 URL이 정확히 저장한 초안을 여는지는 아직 검증 못했다는 문구를 메시지 자체에도 넣었다.
   `job:publish` CLI에 배선 완료. 테스트 5건(`npm run test:notify-publish`).

7. **✅ 완료(2026-08-28)** - "맥도날드 감튀 홀더" job으로 `npm run job:publish -- <jobId>
   --watch`(headless:false로 직접 지켜봄) 실행, 이후 발견된 버그 수정 + 재검증까지 마쳤다.
   상세는 `SPRINT_4_DESIGN.md` §12/§13/§14. 최종 확인된 것:
   - ✅ 제목 입력(숨겨진 contenteditable proxy 가설)
   - ✅ **이미지 toolbar 업로드** (`.se-toolbar-item-image` → filechooser → setInputFiles -
     실제로 NAVER 자체 CDN `blogfiles.pstatic.net`에 재업로드됨, 3장 전부 정상 삽입을 사용자가
     육안 확인) - 가장 불확실했던 부분이라 제일 중요한 확인이었다.
   - ✅ 임시저장 자체("임시저장 글" 목록에 실제로 생김, 시각도 일치)
   - 🐛→✅ **본문 붙여넣기 버그 발견 후 수정·재검증** - 1차 실측 때 실제로는 본문 문단이 통째로
     비어 있었다(제목에 이미 포함된 단어 때문에 자동 검사가 "본문도 있다"고 오판했었다 -
     검증 스크립트의 허점). 원인은 합성 `ClipboardEvent`를 `document.activeElement`에 직접
     dispatch하는 방식을 SmartEditor가 신뢰하지 않아 무시한 것 - 실제 OS 클립보드에 쓰고
     `Ctrl/Cmd+V`를 누르는 방식으로 바꿔서 재검증했고, 사용자가 브라우저를 직접 보며 본문
     문단이 실제로 채워지는 것을 확인했다.
   - ✅→🔄 **해시태그 흐름 변경**: 처음엔 발행 설정 패널(`tpb.publish` 클릭 → `#tag-input`)에
     직접 입력했고 실제로 잘 반영됐지만(사용자 스크린샷 확인), 사용자가 "발행 버튼에 더 가까이
     다가가는 방식이라 위험하다"며 다른 방법을 요청 - 본문 끝에 이미 있는 "#태그" 텍스트가
     paste로 함께 들어가면 네이버가 실제 발행 시점에 자동으로 태그를 인식해 적용해준다는
     사용자 설명에 따라, `NaverBlogPublisher.ts`에서 발행 패널을 아예 열지 않도록 코드를
     단순화했다(`fillTags()`/패널 관련 코드 전부 제거). `saveDraft()` 흐름은 이제
     login → navigate → title → body → image → save로 줄었다 - 자동화가 클릭하는 버튼이
     `tpb.save` 하나뿐이라 실제 발행 버튼과의 거리가 코드상으로도 더 멀어졌다.
   - ⚠️ **별도 발견**: 같은 계정으로 동시에 다른 곳(폰 앱 등)에서 글을 쓰고 있으면 자동화
     세션이 로그아웃될 수 있다 - `job:publish` 실행 전 동시 사용 여부를 먼저 확인하는 게 안전.
   - `save_count_btn__ZTLNa`(`[data-click-area="tpb*s.count"]`, "임시저장된 글 보기") 셀렉터를
     새로 발견 - 저장/발행과 무관한 안전한 조회용 버튼(발행 흐름에는 아직 안 씀).

**Sprint 4 §10 작업 순서 1~7번 전부 완료.** 승인된 원고가 `job:publish` 한 번으로 네이버
블로그 임시저장함에 제목·본문·이미지가 채워진 채로 들어가고(해시태그는 본문 텍스트로 자동
포함), Telegram으로 초안 확인 알림이 온다 - 로드맵의 8단계 파이프라인 중 7단계(발행 직전까지)가
실사용 조건에서 검증까지 마쳤다. 남은 사람 개입은 실제 "발행" 버튼 클릭뿐이다. 테스트용으로
만들어진 초안 2건("맥도날드 감튀 홀더..." 정상본 + "...[재검증]" 본문 검증용)은 실제 배포용이
아니므로 사용자가 초안함에서 정리해도 된다. "임시저장" 성공 신호(토스트/URL 변화)는 여전히
고정 시간 대기로 대체돼 있다 - 급하지 않으면 다음에 개선한다.

## 키워드 수집 확장 (2026-08-29, `claude/keyword-collection-optimization-6ojcou`)

설계·진단 상세는 `docs/ai-handoff/KEYWORD_SOURCE_EXPANSION.md`. 사용자 요청 4건 중 1·2·4번
구현 완료. 3번(커뮤니티)은 2026-08-30에 더쿠 provider 실측 + 배선 + 활성화까지 완료(§7-4).

1. **Top N 주제 중복 제거** - "넷플릭스 들쥐"가 Top 10 중 4칸을 차지하던 문제. 신규
   `workflows/keyword-ranking/topicGrouping.ts`가 희소 핵심 명사 공유로 같은 주제를 판정해
   최종 선정 단계에서 압축한다. `test:topic-grouping`이 고정. **근본 원인(cross-seed clustering이
   구조적으로 병합 못 함, `excludeSeedQueryFromTokens` 때문)은 그대로 남아 있다** - clustering
   로직 변경이라 승인 필요, 지금은 이 우회책으로 증상만 해결한 상태.
2. **구글 트렌드 RSS 소스 추가 + 활성화(2026-08-29 사용자 승인)** - 인증/로그인 불필요, RSS만
   조회. 코드 기본값(`TREND_SOURCE_CONFIGS.google_trends.enabled`)을 true로 바꿔서 켰다(`.env`
   아님 - git pull만으로 적용됨, 끄려면 `GOOGLE_TRENDS_ENABLED=false`). 실측(KR TOP 10)에서
   10건 중 9건이 category 어휘 규칙을 못 맞고 `living`으로 폴백하는 문제를 발견해, 뉴스 출처
   기반 2차 분류(`config/newsOutletRules.ts`)로 보강했다. 1글자 키워드("션")는 관련성 필터를
   무력화하는 것을 확인해 제외 처리(`MIN_TREND_KEYWORD_LENGTH=2`). 켜는 과정에서 실제 Supabase
   조회로 결함 2건 발견·수정: (a) `buildDailyQueryPool`의 에러 직렬화가 `String(error)`라
   PostgrestError가 `[object Object]`가 되던 문제(2026-08-26에 고쳤던 게 신규 경로에서 재발 -
   `services/describeError.ts`로 통합), (b) `enabledSources` 옵션이 `creatorAdvisorEnabled:
   false`를 덮어써 "disabled면 조회 안 함" 계약이 깨져 있던 문제.
3. **`community` category + 수집기** - 분류 체계 편입 + 더쿠 provider + daily job 배선 + 활성화
   완료(2026-08-30, §7-4). ⬜ 다음 아침 run에서 Top 10 유입 관찰.
4. **`buildDailyQueryPool` 다중 source 지원** - source 하나가 실패해도 나머지로 진행(실패 격리),
   스키마 변경 없음(`trend_candidates.source`가 text 컬럼이라 문자열만 추가하면 됨).

**검증**: `npm run build` + offline 테스트(`test:google-trends`/`test:topic-grouping`/
`test:daily-query-pool`/`test:keyword-category` 등) 전부 통과 확인(이 세션에서 재확인 완료,
원격 컨테이너엔 `.env`가 없어 더미 Supabase 환경변수로 실행 - 실제 원격 접근 없음). `test:naver`/
`test:keywords`/`test:ranking`처럼 실제 NAVER API를 호출하는 테스트는 이 세션에서 실행 안 함.

**다음 단계(미완료)**:
- ⬜ 내일 아침 09:00 run에서 구글 트렌드 유입 후 Top 10 변화 관찰(도배 해소 여부, 구글 트렌드
  유래 키워드 품질, 블로그 무관 키워드 quota 잠식 여부) - `KEYWORD_SOURCE_EXPANSION.md` §8 참고.
- ⬜ 다음 실시간 트렌드 provider - daum.net DOM 실측부터(원격 세션에서 불가, 맥에서 진행).
- ✅ 커뮤니티 수집기 - 브랜치 `claude/community-collector`(2026-08-30). 파이프라인(LLM 엔티티
  추출 + 매핑 + 워크플로우 + CLI) + 더쿠(theqoo.net/hot) provider. 네이트판/다음카페/네이버카페는
  robots.txt가 목록 경로를 막아 제외, 더쿠만 유일 provider(공지/인기글은 class 유무로 구분).
  **맥에서 `npm run collect:community` dry-run 20건 fetch 실측 완료**, `dailyKeywordWorkflow.ts`
  배선 + `TREND_SOURCE_CONFIGS.community.enabled` 코드 기본값 `true`로 활성화(2026-08-30 사용자
  승인, 구글 트렌드와 같은 방식 - 끄려면 `.env`에 `COMMUNITY_TRENDS_ENABLED=false`). 결함 있던
  `test:community`가 prod에 남긴 테스트 row 1건은 삭제 완료. ⬜ 다음 아침 run에서 Top 10 유입
  관찰. 상세는 `KEYWORD_SOURCE_EXPANSION.md` §7-2/§7-3/§7-4.
- ⬜ (관찰 후 판단, 승인 필요) cross-seed clustering 근본 수정.
- ⬜ (관찰 후 판단) 블로그와 무관한 키워드(반도체·노동·무기 등) 필터링 여부.
- 두 브랜치(`claude/keyword-collection-optimization-6ojcou`, `claude/community-collector`) 모두
  아직 `main`에 머지되지 않았다(PR 없음). **`claude/community-collector` 머지는 2026-08-31 오전
  09:00 run 결과 관찰 후 진행**(2026-08-30 사용자 결정).
- ~~네이트판/다음카페 대체 접근 경로 탐색~~ - 드롭(2026-08-30). 더쿠 단독 provider 유지.

## 인프라 정리 (2026-08-28, 중간 점검 후속)

중간 점검에서 나온 "아쉬운 점" 3건 **전부 완료(2026-08-28)**. 상세는 `CLOUD_MIGRATION.md` /
`SUPABASE_MIGRATION_SYNC.md`.

1. **클라우드 감시인 (Phase 1 완료 + 가동)** - `src/jobs/watchdogJob.ts` +
   `.github/workflows/watchdog.yml`. GitHub 러너가 매일 02:00 UTC(11:00 KST)에 "오늘 완료된
   discovery_run이 있나"를 확인하고 없으면 Telegram으로 알린다. 로컬 맥과 완전히 독립 - 강제
   종료 시 실패 알림이 안 나가던 구멍을 밖에서 막는다. `npm run test:watchdog`(7케이스) 통과,
   **GitHub Actions에서 실제 실행해 run #19 감지 + conclusion success 확인**. repo secret 4개
   (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) 등록됨.
   ⚠️ 알림 발송 경로(stale 판정 → Telegram)는 `SEND=1 npm run test:watchdog`로 한 번 눈으로
   확인할 것. Phase 2(Telegram 수신 분리)/Phase 3(로그인 세션 이전)는 설계만.

2. **Supabase CLI 동기화 (완료)** - `brew install`로 v2.116.0 설치, `supabase init`로
   `config.toml` 생성. `supabase login` + `link` 후 `scripts/supabase-repair.sh` 실행 →
   `supabase migration list`에서 9개 전부 LOCAL/REMOTE 일치 확인. 이제 Dashboard SQL Editor 수작업
   대신 `supabase db push`로 스키마를 바꾼다(CLAUDE.md 승인 게이트는 유지). `db diff --linked`는
   Docker 필요라 건너뜀 - `migration list` 일치가 검증. 상세 `SUPABASE_MIGRATION_SYNC.md`.

3. **git 브랜치 정리 (완료)** - 정리 전 46커밋은 로컬 `backup/full-linear-history`에 보존.
   스프린트 경계마다 PR #1~#6을 만들어 0→5 순서로 `main`에 병합(스프린트별 merge commit 6개).
   6주치 작업이 처음으로 `origin/main`에 백업됐다. feature 브랜치는 원격/로컬 모두 정리. 이후
   작업은 스프린트당 브랜치 1개 + PR.

전체 로드맵: `/Users/wooahpapa/.claude/plans/gpt-recursive-squirrel.md`
