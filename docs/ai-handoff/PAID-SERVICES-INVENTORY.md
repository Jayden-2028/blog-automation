# 유료 서비스 재고 (2026-11-11 조사)

이 저장소가 돈 또는 한도를 쓰는 항목 전부. **비용 대시보드를 만들 세션이 읽고 바로 착수할 수
있도록** 쓴 문서다. 추측은 「미확인」으로 적었고, 사용자만 알 수 있는 것은 §7에 모았다.

조사 범위는 코드·워크플로·repo 변수/시크릿 이름·운영 DB 읽기(`api_usage`)·GitHub Actions run
이력이다. **유료 API를 확인용으로 호출하지 않았고**, 운영 DB에 쓰지 않았고, `.env`를 열지 않았다
(키 **이름**은 `.env.example`과 `gh secret list`에서만 봤다).

---

## 1. 한눈에

**측정된 호출 단위 지출은 월 $5 미만이다.** 최근 30일(2026-10-12~11-11) `api_usage` 합계
**$4.812 / 3,793 호출 / 원고 294건**(원고 1건당 $0.0164). 금액 미상 행은 **0건**이다.

| 구분 | 항목 | 최근 30일 | 계측 |
|---|---|---|---|
| 호출 과금 | Serper 이미지 검색 | $3.038 (3,038) | ✅ |
| 호출 과금 | OpenAI `gpt-image-2` | $1.366 (346) | ✅ |
| 호출 과금 | Serper 웹 검색 | $0.408 (408) | ✅ |
| 호출 과금 | Gemini(자료조사·이미지) | $0 — 스위치 꺼짐 | ✅(경로만) |
| 월정액 | Supabase **Pro** | 미확인(청구서) | ❌ |
| 무료 구간 | Cloudflare Workers·Pages·Access | $0 | ❌ |
| 무료 구간 | GitHub Actions(**퍼블릭 저장소**) | $0 | ❌ |
| 무료/미확정 | NAVER API HUB 검색·검색어트렌드 | 미확인 | ❌ |
| 무료 쿼터 | YouTube Data API v3 | 미확인 | ❌ |
| 구독 한도 | `claude -p` (Claude 구독) | 돈이 아니라 **한도** | ❌ |
| 구독 한도 | `codex exec` (ChatGPT 구독) | 현재 호출 경로 없음 | ❌ |
| 선불 잔액 | Serper 크레딧 | 45,714건 남음(추정) | ⚠️ 추정 |

**가장 중요한 발견 셋**

1. **`cost_source='reported'` 행이 단 한 건도 없다.** GCP 청구액 동기화
   (`gcp-billing-sync.yml`)는 매일 성공하지만 BigQuery 결제 내보내기가 매번 0행을 돌려준다
   (§4). 「공급자 청구액과의 대조」 축은 설계만 있고 데이터가 없다.
2. **고정비 금액이 전부 비어 있다.** `FIXED_COST_*` repo 변수가 하나도 없어
   `cost.json`의 고정비 합계는 항상 `$0` / `missingCount: 4`다. 게다가
   [`fixedCosts.ts`](../../src/config/fixedCosts.ts)는 Supabase를 **"무료 구간"**으로 적고 있는데
   실제 조직 plan은 **pro**다(MCP `get_organization` 실측).
3. **`cost.json`은 Cloudflare Access 뒤에 있다.** 공개 URL로 보이지만
   `https://blog-automation-manuscripts.pages.dev/cost.json`은 302로
   `cloudflareaccess.com` 로그인으로 넘긴다. 브라우저에서 사람이 열면 보이지만
   **대시보드가 그냥 `fetch`하면 못 읽는다**(§6-5).

---

## 2. 계측되는 항목 (api_usage에 쌓인다)

### 2-1. OpenAI 이미지 생성 — `gpt-image-2`

1. **무엇을** — OpenAI Images API(`https://api.openai.com/v1/images/generations`).
   호출: [`src/services/images/generateImage.ts:161`](../../src/services/images/generateImage.ts).
   부르는 워크플로: [`src/workflows/images/generateManuscriptImages.ts`](../../src/workflows/images/generateManuscriptImages.ts)
   (원고 준비 = `job-publish-prepare.yml`), 재채움 `images:fill`,
   koreaplain 소급 `reimageKoreaplainCli.ts`. 동시 생성 상한 3, 화질 기본 `low`.
   게이트 `MANUSCRIPT_IMAGE_GENERATION=true`(repo 변수), `IMAGE_PROVIDER=openai`,
   `IMAGE_AB_COMPARE=false`.
2. **과금 단위** — 토큰. 텍스트 입력 **$5** / 이미지 입력 **$8** / 이미지 출력 **$30** per 1M tokens
   (Batch는 절반). 출처: <https://developers.openai.com/api/docs/pricing> (2026-11-11 확인,
   `platform.openai.com/docs/pricing`에서 301). **단가표와 공식 문서가 일치한다.**
   실측 1장: 1536x864 `quality=low` = 출력 120토큰 ≈ **$0.0036**.
3. **지금 얼마나** — 최근 30일 **346호출 / $1.36609**. 장당 평균 $0.00395.
   누적(2026-09-16~): 540호출 / $2.130285. 월별: 2026-09 $0.5089 · 10월 $0.9100 ·
   11월(11일까지) $0.7114.
4. **계측** — ✅ 완전. `operation='image.generate'`, `job_id` 채워짐, `cost_usd` null 0건.
   단 **성공 호출만** 기록한다(실패는 원장에 남지 않는다 — 과금도 안 되므로 의도된 것이지만
   "실패율"은 원장에서 볼 수 없다).
5. **한도·위험** — 무료 한도 없음, 쓴 만큼 과금. 키가 없으면 생성 단계만 실패하고 원고는 진행.
   `IMAGE_INFOGRAPHIC_QUALITY=medium`으로 올리면 출력 토큰이 늘어 단가가 오른다(승인 항목).

### 2-2. Serper (구글 검색 중계) — `serper-images`, `serper-search`

1. **무엇을** — `https://google.serper.dev/images`
   ([`searchSerperImages.ts:25`](../../src/workflows/images/searchSerperImages.ts))와 `/search`
   ([`searchKinolightsStills.ts:35`](../../src/workflows/images/searchKinolightsStills.ts)).
   구글 공식 Custom Search가 신규 발급을 막아 중계로 쓴다. 이미지 수집
   (`collectWebImages`)과 키노라이츠 작품 페이지 찾기에서 부른다 — 둘 다 원고 준비 단계.
2. **과금 단위** — 쿼리(크레딧). **선지불**: Starter $50 / 50,000크레딧 = **$0.001/쿼리**,
   **유효 6개월**. 출처: <https://serper.dev/> (2026-11-11 확인. `serper.dev/pricing`은 404이고
   요금표는 홈페이지 안에 있다). ⚠️ **1호출=1크레딧은 공식 문서에 명시돼 있지 않다** —
   티어의 "쿼리 수 = 크레딧 수"에서 추론한 값이고, `num=10`의 크레딧 소모량을 Serper가
   문서로 밝히지 않았다.
3. **지금 얼마나** — 최근 30일: 이미지 **3,038호출 $3.038** + 웹 **408호출 $0.408**
   + 실패 1호출 $0. 구매일(2026-10-06) 이후 과금 호출 누적 **4,286건**.
   최근 7일 **632건 = 일 90.3건**.
4. **계측** — ✅ 호출 단위로 쌓인다. 성공/실패를 `operation`으로 가른다
   (`image.search` vs `image.search.failed`) — 실패 행은 `billedQueries=0`이라 금액 0,
   잔여 크레딧 추정에서도 제외된다. **fire-and-forget**이라 DB가 느리거나 죽으면
   조용히 누락될 수 있다([`recordSerperUsage.ts`](../../src/services/usage/recordSerperUsage.ts)).
5. **한도·위험** — 선불 잔액 소진이 위험이고 과금이 아니다. 잔여 추정
   **45,714 / 50,000 (91.4%)**, 만료 **2027-04-06**.
   **현재 속도(일 90건)로는 만료일까지 ~13,200건만 더 쓴다 → 약 32,500크레딧(≈$32.5)이
   그대로 만료된다.** 경보(`evaluateSerperCredits`)는 구매 150일째(= 2027-03-05)에야
   `expiry_risk`를 띄우므로 **쓸 방법을 찾을 시간이 한 달밖에 남지 않는다.**
   잔액이 0이면 Serper가 400을 주고 그 호출은 `.failed`로 기록된다(파이프라인은 계속 돈다).

### 2-3. Gemini — `gemini-3.6-flash`(자료조사), `gemini-3.1-flash-lite-image`(이미지)

1. **무엇을** — `https://generativelanguage.googleapis.com/v1beta/models/...`.
   자료조사: [`runGeminiResearch.ts`](../../src/services/llm/runGeminiResearch.ts) →
   [`runArticleJob.ts:252`](../../src/workflows/writing/runArticleJob.ts)에서 원장 기록.
   이미지: [`generateImage.ts:230`](../../src/services/images/generateImage.ts).
2. **과금 단위** — 토큰. `gemini-3.6-flash` 입력 **$0.75** / 출력 **$3.75** per 1M tokens,
   **2027-01-01부터 $1.50 / $7.50**. `gemini-3.1-flash-lite-image` 입력 **$0.25** /
   이미지 출력 **$30**(≈ 1K 해상도 1장 $0.0336). 출처:
   <https://aistudio.google.com/docs/pricing> (2026-11-11 확인, `ai.google.dev`에서 301).
   **단가표와 공식 문서가 일치하고 2027 인상 밴드도 맞다.**
3. **지금 얼마나** — **$0. 호출 행이 한 건도 없다.** `RESEARCH_PROVIDER` repo 변수가
   없어 기본값 `claude`로 떨어지고, `IMAGE_PROVIDER=openai` + `IMAGE_AB_COMPARE=false`라
   이미지도 안 탄다. `GEMINI_API_KEY` 시크릿은 등록돼 있다(언제든 켤 수 있다).
4. **계측** — ✅ 경로는 이미 있다(스위치만 켜면 기록된다). 실패 호출은 기록하지 않는다.
5. **한도·위험** — `gemini-3.6-flash`는 무료 등급이 있다(공식 문서가 Free Tier를
   "Free of charge"로 표기). `gemini-3.1-flash-lite-image`는 무료 등급 **없음**("Not available").
   RPM/RPD 구체 수치는 그 문서에 없다 → 미확인. 스위치를 켜면 비용이 **$0에서 바로
   늘어나므로**, 대시보드에 "이번 달 gemini 0건" 자리를 비워 두지 말고 명시하는 편이 좋다.

---

## 3. 계측되지 않는 항목

### 3-1. `claude -p` 헤드리스 — **돈이 아니라 구독 한도를 쓴다**

1. **무엇을** — [`src/services/llm/runHeadlessClaude.ts`](../../src/services/llm/runHeadlessClaude.ts).
   호출 지점 **29개**(자료조사, 집필, 번역, 수정, 이미지 슬롯 기획·수집·중복 판정·크롭,
   핫이슈 스타 인물 추출, 키워드 요약·제목 추천, 브리프, 문체 학습, 금지표현 집행 등).
   워크플로 **12개**가 `CLAUDE_CODE_OAUTH_TOKEN`을 받는다: `job-research`, `job-write`,
   `job-revise`, `job-translate`, `job-publish-prepare`, `entertainment-keyword`,
   `entertainment-hot-star`, `social-issue-keyword`, `kscene-topic`, `style-learn`,
   `telegram-update`, `image-pick`.
2. **과금 단위** — **없다.** Claude Max 구독(정액)이고 OAuth 토큰으로 돈다. 토큰을 세도
   청구액이 그만큼 늘지 않는다 — [`fixedCosts.ts`](../../src/config/fixedCosts.ts)가 적은 대로
   "호출 1건의 금액이라는 게 원리상 존재하지 않는다". **쓰는 자원은 구독 사용 한도**다.
3. **지금 얼마나** — 호출 수는 계측되지 않는다. 대리 지표(최근 14일, Actions run 수):
   `job-research` 145 · `job-write` 144 · `job-publish-prepare` 145 · `job-translate` 32 ·
   `job-revise` 16 · 키워드 수집 4종 59 · `style-learn` 3. 한 run 안에서 여러 번 부르는
   단계가 있으므로(특히 원고 준비) **실제 호출 수는 이보다 많다.**
4. **계측** — ❌ 전혀. `api_usage`에 한 줄도 남지 않는다. CLI 응답에 토큰 사용량이 실려
   오지 않아 지금 구조(usage × 단가)로는 기록할 값이 없다.
5. **한도·위험** — 한도에 걸리면 **그 단계가 실패**한다(2026-11-10·11 소급 작업이 세 번
   걸렸다). 한도는 돈과 성격이 달라 **대시보드에 금액으로 섞으면 안 된다** — 별도 블록으로
   "이번 주 몇 번 한도에 막혔나"를 보여주는 쪽이 맞다. 구독 한도의 남은 양을 저장소에서
   조회할 방법은 없다(미확인).

### 3-2. `codex exec` 헤드리스 — ChatGPT 구독, 현재 호출 경로 없음

[`runHeadlessCodex.ts`](../../src/services/llm/runHeadlessCodex.ts)는 있지만 **`src/`에서
실제로 호출하는 곳이 없다**(`extractTrailingJson` 유틸만 다른 모듈이 import한다).
`RESEARCH_PROVIDER=codex`로 켜면 **맥미니 폴러**가 Codex CLI로 조사한다
([`researchProvider.ts`](../../src/config/researchProvider.ts)) — 1건당 143k~325k 토큰
실측(2026-11-01)이라 Plus 한도로 상시 운용이 안 된다. 과금 단위 없음(정액 구독), 계측 ❌.
대시보드는 **"조사 provider가 지금 무엇인가"를 한 줄로 띄우는 것으로 족하다** —
`claude`/`gemini`/`codex`에 따라 어느 자원이 깎이는지가 바뀐다.

### 3-3. NAVER API HUB 검색 / 검색어트렌드

1. **무엇을** — `https://naverapihub.apigw.ntruss.com`(NAVER Cloud Platform API Gateway).
   **구형 `openapi.naver.com`이 아니다**([`naverClient.ts`](../../src/services/search/naver/naverClient.ts)).
   쓰는 경로 9개: `/search/v1/news` · `/blog` · `/webkr` · `/image` · `/encyc` · `/kin` ·
   `/cafearticle` · `/search-trend/v1/search`, 그리고 블로그 경쟁도 탐침
   ([`fetchBlogTotal.ts`](../../src/services/search/naver/fetchBlogTotal.ts)).
   부르는 곳: 키워드 수집(`collectNaverCandidates`), 자료조사 기준 sources
   (`collectSourcesForJob`), 인물 소스팩(`collectPersonSourcePack`), 이미지 후보
   (`searchNaverImages`), 트렌드 모멘텀(`fetchTrendMomentum`), 링크 입력 추출.
2. **과금 단위** — **미확인.** 공식 페이지로 확인하지 못했다: `apihub.naver.com`은 가져오지
   못했고, `ncloud.com/product/aiService/naverApiHub`에는 요금·쿼터·초과 정책이 없고,
   `api.ncloud-docs.com/docs/naverapihub`는 404다. 2차 자료는 "한시적 무료 + 종량제 예정,
   검색 일 25,000건 / 카테고리 월 775,000건, 초과 시 429"라고 하지만 **공식 확인 전이므로
   숫자로 쓰지 않는다.** → §7-3.
3. **지금 얼마나** — 호출 수는 계측되지 않는다. 코드에서 유도한 **추정**:
   키워드 수집 1회 = 질의 풀 **106건**(2026-11-10 run 로그 실측: seed 56 + trend 50)
   × news·blog·webkr 3경로 ≈ **318호출**, + 경쟁도 탐침 최대 **60**, + 트렌드 소수.
   수집 run이 하루 3회(엔터·사회·사용설명서)이고 자료조사가 원고당 3~6호출이므로
   **하루 1,000~1,500호출 규모**로 본다. 추정이고 대조는 NCP 콘솔의 이용량 화면이다.
4. **계측** — ❌ 전혀. `api_usage`에 provider `naver`가 없고
   [`apiPricing.ts`](../../src/config/apiPricing.ts)의 `ApiUsageProvider`에도 없다.
5. **한도·위험** — 초과 시 **차단(429)**으로 보이고 과금은 아닌 것으로 보이지만 미확인.
   429가 나면 키워드 수집·자료조사가 통째로 비어 그날 파이프라인이 멈춘다 —
   **금액은 0이어도 운영 위험은 이 목록에서 가장 크다.** 유료 전환 공지가 뜨면
   그때부터는 돈이 나가는 자리가 된다.

### 3-4. Supabase (DB · Storage · egress)

1. **무엇을** — 프로젝트 `blog_automation`(`exbhtdearvxjorwqlqno`, ap-northeast-2).
   파이프라인 전체의 정본 DB + 이미지 원본 Storage(`article-images`).
   조직 plan **pro**(MCP `get_organization` 실측, 2026-11-11).
2. **과금 단위** — Pro **$25/월**(컴퓨트 크레딧 $10 포함). 포함량: DB 디스크 8GB/프로젝트 ·
   egress 250GB · 캐시 egress 250GB · 파일 스토리지 100GB · MAU 100,000.
   초과 단가: 디스크 $0.125/GB · egress **$0.09/GB** · 캐시 egress $0.03/GB ·
   스토리지 $0.0213/GB. 출처: <https://supabase.com/pricing> +
   <https://supabase.com/docs/guides/platform/cost-control> (2026-11-11 확인).
3. **지금 얼마나** — 실측(2026-11-11, SQL): **DB 68MB** / 8GB,
   **Storage 563MB · 객체 2,843개** / 100GB, `api_usage` 4,833행.
   **egress는 SQL로 볼 수 없다** → §7-2.
4. **계측** — ❌ 금액은 어디에도 없다. DB·Storage **용량**은 위처럼 SQL로 언제든 뽑을 수
   있으므로 대시보드에 바로 넣을 수 있다(§5-1). egress는 Supabase 대시보드/관리 API만 안다.
5. **한도·위험** — **spend cap이 켜져 있다**(2026-11-05 사용자 결정). 공식 문서 기준
   "쿼터를 넘기면 그 항목의 추가 사용이 다음 결제 주기까지 **거부**되고 초과 과금은 없다".
   즉 위험은 **청구서가 아니라 서비스 정지**다 — **2026-10-09에 실제로 egress 무료 한도(5GB)를
   넘겨 프로젝트가 제한되고 전 트랙이 멈췄다.** Pro의 egress 포함량이 250GB로 50배 늘었으므로
   같은 사고의 재발 여지는 크게 줄었다.
   ⚠️ **`storage-cleanup`이 실삭제를 한 적이 없다**: `STORAGE_CLEANUP_APPLY` repo 변수가 없어
   주간 cron이 매번 dry-run이다. 2026-11-06 run 실측 **"대상 177건, 객체 964개, 121.5MB"**가
   지워지지 않은 채 남아 있다. 지금 용량에서는 문제가 아니지만 **스토리지는 단조 증가 중**이다.

### 3-5. Cloudflare (Workers · Pages · Access)

1. **무엇을** — ① 텔레그램 릴레이 Worker `blog-automation-telegram-relay`
   ([`cloudflare/telegram-relay/`](../../cloudflare/telegram-relay/)) — 버튼 콜백 수신 +
   cron으로 워크플로 디스패치. ② 원고 뷰어 Pages `blog-automation-manuscripts`
   (+ `functions/api/*` = Pages Functions: 수정 저장·이미지 교체·발행 요청).
   ③ 이미지 호스팅 Pages `korea-manual-images-2026`(사용설명서 발행본 이미지).
   ④ **Cloudflare Access**(Zero Trust)가 뷰어 앞에 붙어 있다(실측: 302 →
   `patient-king-6754.cloudflareaccess.com`).
2. **과금 단위** — 무료 플랜. Workers Free: 일 **100,000요청**(UTC 자정 리셋, 초과 시
   Error 1027), HTTP 요청당 CPU **10ms**, cron 트리거 **계정당 5개**. Pages Functions 요청은
   같은 10만/일 쿼터를 쓰고 **정적 자산 요청은 무료·무제한**. Pages Free: 월 **500빌드**
   (동시 1건, 20분 타임아웃), 사이트당 파일 **20,000개**, 파일 1개 **25MiB**,
   프로젝트당 커스텀 도메인 100개. 출처:
   <https://developers.cloudflare.com/workers/platform/pricing/> ·
   <https://developers.cloudflare.com/workers/platform/limits/> ·
   <https://developers.cloudflare.com/pages/platform/limits/> ·
   <https://developers.cloudflare.com/pages/functions/pricing/> (2026-11-11 확인).
3. **지금 얼마나** — 미확인(Cloudflare 대시보드만 안다). 규모로는 요청이 하루 수백~수천
   건이라 10만/일과 거리가 멀다. **cron은 4/5를 썼다**(`"0 9,10,11,12 * * *"`,
   `"30 0 * * *"`, `"0 1 * * 1"`, `"0 18 * * 6"`) — **남은 슬롯이 1개뿐이고, 이것이 이
   저장소에서 무료 한도에 가장 가까이 닿아 있는 수치다.**
   Pages 빌드는 발행 준비·수정·이미지 교체마다 `wrangler pages deploy`가 돌아 월 500빌드에
   근접할 수 있다 → 미확인, 확인 가치 있음.
4. **계측** — ❌. Worker 로그는 `[observability] enabled = true`로 보관되지만
   **토큰 권한이 없어 저장소 쪽에서 읽을 수 없다**(2026-11-04 장애 때 실측).
5. **한도·위험** — cron 슬롯 5개가 **하드 한도**다. 새 스케줄이 필요하면 유료 플랜으로
   올리거나 기존 cron에 동승시켜야 한다(이미 주간 리포트·이미지 건강 점검이 그렇게 붙어 있다).
   Workers 10만/일을 넘기면 **차단**(1027)이고 과금이 아니다.

### 3-6. GitHub Actions — **퍼블릭 저장소라 무료다**

1. **무엇을** — 파이프라인 전 단계. 워크플로 **25개**, 전부 `ubuntu-latest`(표준 러너).
2. **과금 단위** — 공식 문서: *"The use of standard GitHub-hosted runners is free: In public
   repositories."* 프라이빗이면 Linux 2-core **$0.006/분**이고 포함량은 분이 아니라 금액
   (Free $12/월, Pro $18/월). 출처:
   <https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions>
   (2026-11-11 확인). `Jayden-2028/blog-automation`은 **PUBLIC**(`gh repo view` 실측).
3. **지금 얼마나** — 실측: 최근 30일 run **2,147건**. 최근 1,000 run(2026-10-27~11-11,
   14일)의 `run_started_at→updated_at` 합계 **2,569.8분 = 일 183.6분 ≈ 월 5,500분**.
   상위: `job-publish-prepare` 791분(145run, 평균 5.5분) · `job-research` 637분(145, 4.4) ·
   `job-write` 474분(144, 3.3) · `telegram-update` 190분(335, 0.57) · `image-pick` 160분(36, 4.4).
4. **계측** — ❌. [`fixedCosts.ts`](../../src/config/fixedCosts.ts)가 적은 대로
   "billing API가 0을 반환하는 사례가 보고돼 자동 조회는 붙이지 않았다". 다만 **run 수와
   소요 시간은 GitHub REST API로 지금 바로 뽑을 수 있다**(§5-1).
5. **한도·위험** — 퍼블릭인 동안 $0이고 분 제한도 없다.
   ⚠️ **저장소를 프라이빗으로 돌리는 순간 월 5,500분이 과금 대상이 된다** —
   $0.006 × 5,500 ≈ **$33/월**, 포함량을 빼면 실지출 **$21~$27/월**. 지금 이 저장소에서
   가장 큰 숨은 비용 레버다. (run API는 한 번에 최근 1,000건까지만 돌려주므로 30일 전체
   분수는 1,000건 표본에서 외삽한 값이다.)

### 3-7. 과금 없음 — Telegram · Blogger · Bing · Reddit · Instagram · YouTube

| 서비스 | 쓰는 곳 | 과금 | 한도 |
|---|---|---|---|
| Telegram Bot API | 알림·버튼(봇 4개: 메인·사회·사용설명서·인스타) | 무료 | 공식 rate limit |
| Blogger API v3 | 사용설명서 발행(`thekoreamanual.blogspot.com`) | 무료 | 구글 API 쿼터(미확인) |
| Google Search Console API | `analytics:search`, 색인 점검 | 무료 | 쿼터(미확인) |
| GA4 Data API | `analytics:ga4` | 무료 | 쿼터(미확인) |
| YouTube Data API v3 | 링크 입력 추출(`videos.list?part=snippet`) | 무료 쿼터 | **일 10,000유닛**, `videos.list` = **1유닛**, PT 자정 리셋. 초과분 구매 경로는 문서에 없고 **쿼터 증액 신청**만 있다. 출처: <https://developers.google.com/youtube/v3/determine_quota_cost> (2026-11-11) |
| Bing Webmaster API | URL 제출 | **미확인** — 공식 페이지에 가격·일 쿼터 기술 없음 | 미확인 |
| Reddit API | 사용설명서 시드(`KSCENE_REDDIT_ENABLED=true`) | 미확인 | 미확인 |
| Instagram Graph API | 인스타 변환기(별도 워크트리) | 무료 | 미확인 |
| 네이버·티스토리 발행 | Playwright(API 아님) | 무료 | 캡차·세션 만료가 실질 한도 |

---

## 4. 공급자 청구액(`reported`) 경로 — 있는데 비어 있다

[`syncGcpBillingCli.ts`](../../src/workflows/reports/syncGcpBillingCli.ts) +
[`gcp-billing-sync.yml`](../../.github/workflows/gcp-billing-sync.yml)가 Google Cloud 결제
BigQuery 내보내기를 읽어 `api_usage`에 `cost_source='reported'`, `provider='google'`로 적재한다.
매일 00:40 UTC 예약(실제 발화는 06:30~07:45 UTC로 밀린다), `--apply` 모드.

**실측: `cost_source='reported'` 행이 전체 DB에 0건이다.** 2026-11-10 run 로그:

```
데이터셋 ***.*** 테이블 1개: gcp_***_v1_...
최근 5일: 0행, 순비용 합계 $0.0000 [통화 행 없음]
적재할 행이 없습니다.
```

원인이 둘로 갈린다 — ① 구글 쪽 지출이 실제로 $0(Gemini를 안 쓰고 나머지가 무료 등급이라
그럴 수 있다), ② 결제 내보내기 테이블에 행이 안 쌓인다. **CLI에 이미 가르는 수단이 있다**:
`npm run billing:gcp -- --probe`가 날짜·비용 필터를 뺀 전체 행 수와 기간을 보여준다.
대시보드 세션이 "청구액 대조" 축을 쓰려면 **이것부터 한 번 돌려야 한다**(읽기만 하므로 안전).
2026-11-03·04 run은 실패했고 11-05부터 성공으로 돌아왔다.

BigQuery 자체도 과금 대상이다(쿼리 스캔 + 내보내기 스토리지). 현재 데이터가 0행이라
실지출도 0으로 보이지만 **미확인**이다.

---

## 5. 대시보드를 만들 세션에게

### 5-0. 먼저 — 이미 만들어져 있는 것 (다시 만들지 마라)

| 이미 있는 것 | 파일 | 하는 일 |
|---|---|---|
| 단가표 + 금액 계산 | [`src/config/apiPricing.ts`](../../src/config/apiPricing.ts) | `estimateCostUsd`(토큰×단가, 기간 밴드 적용), `estimateQueryCostUsd`(쿼리 과금), `listPricedModels`(단가를 아는 모델 목록) |
| 원장 기록 | [`src/services/usage/recordApiUsage.ts`](../../src/services/usage/recordApiUsage.ts), [`recordSerperUsage.ts`](../../src/services/usage/recordSerperUsage.ts) | 호출 1건 → `api_usage` 1행 |
| 원장 조회 | [`src/repositories/ApiUsageRepository.ts`](../../src/repositories/ApiUsageRepository.ts) | `listSince`(1,000행 페이징 포함), `countBilledSerperSince` |
| **집계(순수 함수)** | [`src/workflows/reports/buildCostSummary.ts`](../../src/workflows/reports/buildCostSummary.ts) | 오늘 / 이번 달 / 최근 7일 / 모델별 / 원고당 / 고정비 / 주의사항. 날짜 경계는 Asia/Seoul |
| Serper 크레딧 게이지·경보 | [`src/workflows/reports/serperCredits.ts`](../../src/workflows/reports/serperCredits.ts) | 잔여·소진 속도·runway·만료, 경보 3종 판정(순수 함수) |
| 고정비 목록 | [`src/config/fixedCosts.ts`](../../src/config/fixedCosts.ts) | `FIXED_COST_*` 환경변수에서 월정액을 읽고, 없으면 "미입력"으로 남긴다 |
| 스냅샷 파일 | [`src/workflows/reports/writeCostSnapshot.ts`](../../src/workflows/reports/writeCostSnapshot.ts) | `manuscripts/cost.json` 생성(배포는 안 한다) |
| CLI | `npm run report:cost` (`--dry`로 파일 안 씀) | 집계를 지금 다시 만들어 화면에 출력 |
| 테스트 | `npm run test:cost-summary`, `src/workflows/reports/testSerperCredits.ts` | 집계·게이지 회귀 |

**즉 "금액을 계산하고 단가 미등록을 드러내는 층"은 완성돼 있다.** 지금 없는 것은
**보여주는 화면**과 **§3의 계측 공백**이다.

`cost.json`은 원고 뷰어와 같은 디렉터리에 떨어지고, `job-publish-prepare` ·
`manuscripts-refresh` · `manuscript-edit` · `image-pick` 중 하나가 돌 때 갱신된다
(`wrangler pages deploy`가 디렉터리를 통째로 올리므로 **cost.json만 따로 배포하면 뷰어가
날아간다** — 실제로 2026-09-14/15에 그 사고가 있었다).

### 5-1. 지금 바로 집계 가능 / 계측을 먼저 붙여야 함

| 항목 | 상태 | 어디서 | 비고 |
|---|---|---|---|
| OpenAI 이미지 금액·호출 | ✅ 바로 | `api_usage` (`provider='openai'`) | 성공 호출만 |
| Serper 금액·호출·성공률 | ✅ 바로 | `api_usage` (`provider='serper'`, `operation` 접미사 `.failed`) | |
| Serper 선불 잔액·runway·만료 | ✅ 바로 | `computeSerperCredits` + repo 변수 2개 | 1호출=1크레딧은 추정 |
| 원고 1건당 단가 | ✅ 바로 | `api_usage.job_id` (최근 30일 null 0건) | |
| 단가 미등록 건수 | ✅ 바로 | `cost_usd is null` | 지금 0건 |
| Supabase DB·Storage 용량 | ✅ 바로 | SQL(§5-2) | 금액은 따로 |
| GitHub Actions run 수·소요 시간 | ✅ 바로 | `GET /repos/{o}/{r}/actions/runs` | 금액은 $0(퍼블릭) |
| 조사 provider 현재값 | ✅ 바로 | `RESEARCH_PROVIDER` | 어느 자원이 깎이는지가 바뀐다 |
| Gemini 금액 | ⚠️ 경로 있음 | `api_usage` | 스위치 꺼져 0건 |
| GCP 청구액(`reported`) | ⚠️ 경로 있음, 데이터 0 | `api_usage` (`cost_source='reported'`) | §4 `--probe` 먼저 |
| 고정비 금액(Supabase·Claude·CF·GitHub) | ❌ 입력 먼저 | `FIXED_COST_*` repo 변수 | 하나도 없다. §7-1 |
| **`claude -p` 호출 수·한도 사고** | ❌ **계측 먼저** | 없음 | 금액 아님. 별도 블록 |
| **NAVER API HUB 호출 수** | ❌ **계측 먼저** | 없음 | 운영 위험이 가장 큼 |
| Cloudflare 요청·빌드 수 | ❌ 계측 먼저 | CF 대시보드/API | cron 4/5가 핵심 수치 |
| Supabase egress | ❌ 계측 먼저 | Supabase 대시보드/관리 API | 2026-10-09 사고 원인 |
| YouTube·Bing·Reddit 쿼터 | ❌ 계측 먼저 | 없음 | 쓰임이 적다 |

**계측을 붙일 때 가장 싸게 끝나는 둘**

- **NAVER**: `ApiUsageProvider`에 `"naver"`를 더하고
  [`naverClient.ts`](../../src/services/search/naver/naverClient.ts)의 `naverGetJson` **한 곳**에서
  `recordApiUsage({ provider:"naver", model:"naver-<경로>", operation:"search.query",
  billedQueries: ok?1:0 })`를 fire-and-forget으로 부르면 9개 경로가 한 번에 잡힌다.
  단가가 미확정이므로 `API_QUERY_PRICING`에 넣지 말고 **금액 null(= "모름")로 남겨야 한다** —
  0으로 적으면 "공짜"와 구분되지 않는다. 호출 **수**만으로도 쿼터 대비 안전 여유를 볼 수 있다.
  ⚠️ 하루 1,000~1,500행이 늘어난다(지금 `api_usage` 전체가 4,833행). 쿼터 감시만 원한다면
  일별 집계 행 1건으로 접는 쪽이 낫다.
- **`claude -p`**: [`runHeadlessClaude.ts`](../../src/services/llm/runHeadlessClaude.ts) 한 곳에서
  `operation`(호출자 라벨)과 성공/실패·소요 시간만 남기면 29개 지점이 전부 잡힌다.
  **금액은 null로 둬라** — 정액 구독이라 금액이 존재하지 않는다. 한도 사고를 세려면
  실패 사유 문자열을 metadata에 남기는 것이 핵심이다.

### 5-2. 데이터 출처와 쿼리 예시

**테이블 `public.api_usage`** (migration
[`20260916153725_api_usage.sql`](../../supabase/migrations/20260916153725_api_usage.sql))

| 컬럼 | 뜻 |
|---|---|
| `occurred_at timestamptz` | 호출 시각. **모든 집계 기준**. 날짜 경계는 Asia/Seoul |
| `provider text` | `openai` / `gemini` / `serper` / (`google` = reported). 자유 문자열 |
| `model text` | `gpt-image-2`, `serper-images`, `serper-search`, `gemini-3.6-flash` … 단가표 키와 같다 |
| `operation text` | `<도메인>.<동작>`. `image.generate` / `image.search` / `web.search` / `research.generate`, 실패는 `*.failed` |
| `input_tokens` / `output_tokens` / `total_tokens` | 공급자가 준 usage. 안 주면 null |
| `quantity int not null default 1` | 이미지 장수 등. **금액 계산에 쓰지 않는다** |
| `cost_usd numeric(12,6)` | 계측 금액. **null = 모름**(0이 아니다) |
| `cost_source text` | `metered`(우리 계측) / `reported`(공급자 청구액) |
| `job_id uuid` | `article_jobs.id`. FK 아님(job이 정리돼도 지출 기록은 남는다) |
| `metadata jsonb` | `costUnknownReason`, `keyword`, `imageIndex`, `endpoint`, `status` 등 |

인덱스: `occurred_at desc`, `(provider, occurred_at desc)`, `job_id`(부분).
`reported` 행에는 유니크 인덱스 `uq_api_usage_reported_daily (provider, model, operation,
occurred_at) where cost_source='reported'`가 걸려 있다.
RLS 켜짐 — **`service_role`만 읽고 쓴다.** anon/authenticated는 차단이므로
**브라우저에서 이 테이블을 직접 조회할 수 없다**(그래서 `cost.json`이 있는 것이다).

```sql
-- 모델·동작별 최근 30일 (대시보드 기본 표)
select provider, model, operation,
       count(*) as calls,
       sum((cost_usd is null)::int) as unknown_cost_calls,
       round(coalesce(sum(cost_usd), 0), 6) as cost_usd
from api_usage
where occurred_at >= now() - interval '30 days'
group by 1, 2, 3
order by cost_usd desc;

-- 일별 추이 (Asia/Seoul 경계)
select (occurred_at at time zone 'Asia/Seoul')::date as d,
       round(coalesce(sum(cost_usd), 0), 6) as cost_usd, count(*) as calls
from api_usage
where occurred_at >= now() - interval '30 days'
group by 1 order by 1;

-- 원고 1건당 단가
select count(distinct job_id) as jobs,
       round(sum(cost_usd), 6) as total,
       round(sum(cost_usd) / nullif(count(distinct job_id), 0), 6) as avg_per_job
from api_usage
where job_id is not null and cost_usd is not null
  and occurred_at >= now() - interval '30 days';

-- Serper 선불 크레딧 사용분(성공 호출만) — serperCredits.ts와 같은 정의
select count(*) from api_usage
where provider = 'serper' and operation not like '%.failed'
  and occurred_at >= '2026-10-06T00:00:00+09:00';

-- Supabase 용량
select pg_size_pretty(pg_database_size(current_database())) as db_size,
       (select count(*) from storage.objects) as storage_objects,
       (select pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0))
          from storage.objects) as storage_bytes;
```

**`cost.json`**(집계 결과) — 키: `generatedAt`, `timezone`, `today`, `month`, `daily`(7일),
`byModel`, `perManuscript`, `fixed`, `notes`, `serperCredits`, `pricedModels`.
`CostSummary` 타입이 계약이다([`buildCostSummary.ts`](../../src/workflows/reports/buildCostSummary.ts)).

**GitHub Actions 사용 시간**:
`gh api --paginate "/repos/Jayden-2028/blog-automation/actions/runs" -f created=">=YYYY-MM-DD"`
→ `run_started_at`과 `updated_at` 차이를 더한다. **한 번에 최근 1,000건까지만** 돌려준다.

### 5-3. 알려진 함정

1. **`costUsd`가 null이면 "모름"이고 0이 아니다.** 공급자가 usage를 안 줬거나 단가 미등록이면
   null이다. 0으로 합산하면 합계가 조용히 과소집계된다. `CostBucket.unknownCostCalls`가
   0이 아니면 **표시 금액은 하한**이고, 대시보드는 그렇게 적어야 한다.
2. **Serper 1호출 = 1크레딧은 추정이고 대조가 아직 안 됐다.** 2026-10-06 재가동 때
   "1주 뒤 Serper 대시보드 Usage와 대조"로 적어 뒀는데 **5주가 지난 지금도 대조 기록이 없다.**
   잔여 45,714건은 추정값이다.
3. **`cost_usd`가 `numeric(12,6)`이다.** 이미지 1장이 $0.0036이라 **소수 6자리보다 굵게
   반올림하면 0이 된다.** 집계 코드의 `round6`을 그대로 쓰고, 화면에서도 최소 4자리를 보여라
   (`$0.00`으로 표시하면 346장이 전부 공짜로 보인다).
4. **날짜 경계는 Asia/Seoul이다.** UTC로 자르면 한국시간 오전 9시 이전 지출이 전날로 밀려
   "오늘 얼마 썼나"가 매일 아침 틀린다.
5. **`api_usage`는 `service_role`만 읽는다.** 브라우저에서 직접 조회할 수 없다.
   그래서 `cost.json`이 있는데, **그 파일도 Cloudflare Access 뒤에 있다**(§1-3).
   공개 fetch로 대시보드를 만들 생각이라면 Access 정책·서비스 토큰을 먼저 정해야 한다.
6. **실패 호출은 원장에 안 남는다**(Serper만 예외). OpenAI·Gemini는 성공만 기록하므로
   "실패율"이나 "재시도 비용"을 원장에서 볼 수 없다.
7. **원장 기록은 전부 best-effort다.** `recordApiUsage`는 예외를 던지지 않고 경고만 찍고,
   Serper 쪽은 아예 await하지 않는다. **DB가 느리거나 죽은 구간은 조용히 비어 있을 수 있다** —
   원장과 공급자 청구서가 1:1로 맞는다고 가정하지 마라.
8. **`listSince`의 PostgREST 1,000행 상한.** 직접 조회를 새로 쓰면 같은 함정을 다시 밟는다
   (2026-10-06에 Serper가 하루 수백 행을 쌓으며 실제로 잘렸다). 기존 페이징을 재사용해라.
9. **`quantity`로 금액을 내지 마라.** 참고용 컬럼이고 금액 계산에 쓰이지 않는다.

---

## 6. 조사하다 발견한 이상한 점

1. **`cost_source='reported'` 행이 0건.** 매일 성공하는 워크플로가 매번 "적재할 행이 없습니다"로
   끝난다. `--probe`를 안 돌려 「구글 지출이 정말 0」인지 「내보내기가 비었는지」를 아직 못 갈랐다(§4).
2. **`fixedCosts.ts`가 Supabase를 "무료 구간"으로 적고 있다.** 실제 plan은 **pro**다.
   `FIXED_COST_SUPABASE_USD`도 비어 있어 대시보드 고정비는 항상 $0 / 미입력 4건이다.
   **지금 이 대시보드가 보여주는 월 지출은 실제 지출과 자릿수가 다르다**(측정 $4.8 vs
   Supabase Pro $25+).
3. **`storage-cleanup`이 실삭제를 한 적이 없다.** `STORAGE_CLEANUP_APPLY` repo 변수가 없어
   주간 cron이 항상 dry-run이다. 2026-11-06 실측으로 **964객체 121.5MB**가 삭제 대상인데
   남아 있다. 그런데 `images:health`·`images:repair-pages`는 "원본이 지워지기 전에만
   복구된다"를 전제로 설계돼 있다 — **삭제가 실제로 안 돌고 있으므로 복구 창이 사실상
   무한이다.** 둘 중 한쪽 전제가 문서와 다르다.
4. **Serper 크레딧의 절반 이상이 만료될 궤도다.** 현재 소진 속도로 2027-04-06까지
   약 32,500크레딧(≈$32.5)이 남는다. 경보는 2027-03-05에야 뜬다 — **이미 늦은 시점이다.**
   "사용량을 줄여라"가 아니라 "쓸 자리를 늘려라"가 맞는 조치인데 경보 문구는
   "소진 속도 조절을 검토하세요"로 반대 방향을 가리킨다.
5. **`pipelinePaths.ts`의 경고가 현실과 다르다.** `manuscriptCostSnapshotPath`에
   "이 디렉터리는 공개 URL로 그대로 서빙된다 - 누구나 볼 수 있다고 보고 골라야 한다"고
   적혀 있지만, 실제로는 Cloudflare Access가 앞을 막고 있다(실측 302).
   보안상 더 안전하지만 **대시보드 설계 전제가 달라진다.**
6. **`runHeadlessCodex`를 호출하는 코드가 없다.** `RESEARCH_PROVIDER=codex` 경로는
   맥미니 폴러 쪽에 있고, `src/`에서는 `extractTrailingJson` 유틸만 쓰인다.
   코드 주석은 "웹 검색 이미지 수집에 Codex를 쓴다"고 하지만 현재 기본 경로는
   `runClaudeWebSearch`(= `claude -p`)다.
7. **repo 변수 `GSC_SITE_URL`이 폐쇄된 블로그를 가리킨다**(`whynowissue.blogspot.com`,
   2026-10-11 폐쇄). `GSC_SITE_URLS`가 있으면 폴백은 쓰이지 않으니 지금은 무해하지만
   남아 있는 쓰레기 값이다. 비용과 무관.
8. **`gcp-billing-sync`의 실제 발화 시각이 예약(00:40 UTC)과 6~7시간 어긋난다**
   (06:30~07:45 UTC 관측). GitHub 예약 cron의 알려진 지연이지만, "원고 파이프라인과 겹치지
   않는 시각으로 잡았다"는 주석의 전제가 깨져 있다.

---

## 7. 사용자 확인 필요

저장소에서는 알 수 없고 사용자(또는 각 서비스 콘솔)만 아는 항목.

1. **고정비 실제 금액** — Supabase Pro 실청구액, Claude 구독료, Cloudflare·GitHub 실지출.
   확인되면 `FIXED_COST_SUPABASE_USD` / `FIXED_COST_CLAUDE_USD` /
   `FIXED_COST_CLOUDFLARE_USD` / `FIXED_COST_GITHUB_USD` repo 변수에 넣으면
   **코드 변경 없이** `cost.json` 고정비 합계가 채워진다. (`fixedCosts.ts`의 Supabase 설명
   "무료 구간"은 코드 수정이 필요하다.)
2. **Supabase egress 실사용량** — 대시보드 Usage에서만 보인다. Pro 포함량 250GB 대비
   현재 몇 GB인지. 2026-10-09 사고가 egress였으므로 대시보드 1순위 지표 후보다.
3. **NAVER API HUB 요금·쿼터** — NCP 콘솔의 이용량 화면과 공식 공지. 검색 API와
   검색어트렌드의 무료 한도(일/월), 초과 시 동작, 유료 전환 예정일. 공식 페이지를
   저장소 쪽에서 열지 못했다(§3-3).
4. **Serper 대시보드의 실제 Usage** — `serper.dev` 대시보드에서 소비 크레딧을 확인해
   우리 추정(4,286건)과 대조. 1호출=1크레딧 가정이 맞는지 5주째 미확인이다.
5. **Cloudflare 사용량** — Workers 일 요청 수, Pages 월 빌드 수(무료 500), Access 사용자 수.
   cron은 4/5를 썼다(저장소에서 확인됨).
6. **OpenAI 계정 실청구액** — 우리 계측 $1.37/월(30일)과 실제 청구서 대조.
   OpenAI Costs API는 Admin key가 따로 필요해 붙이지 않았다.
7. **Google Cloud 결제 내보내기 상태** — BigQuery 테이블에 행이 쌓이고 있는지.
   `npm run billing:gcp -- --probe`로 저장소 쪽에서도 가를 수 있다(읽기만 한다).
8. **저장소를 프라이빗으로 바꿀 계획이 있는지** — 있다면 Actions가 월 $21~$27의
   실지출로 바뀐다(§3-6).

---

## 부록: 측정 기준

- 측정일 **2026-11-11**. `api_usage` 구간은 2026-10-12~11-11(30일).
- `api_usage` 집계는 Supabase MCP `execute_sql`(읽기 전용)로 운영 DB에서 직접 뽑았다.
- GitHub Actions 수치는 `gh api /actions/runs`의 `run_started_at`→`updated_at` 차이를 더한
  **추정**이다(GitHub의 실제 과금은 job 단위 분 단위 올림). 표본은 최근 1,000 run
  (2026-10-27~11-11).
- 단가는 전부 위 각 항목의 공식 문서 URL + 확인 날짜를 적었다. 기억으로 쓴 숫자는 없다.
- 유료 API를 확인 목적으로 호출하지 않았다. 운영 DB에 쓰지 않았다. `.env`를 열지 않았다.
