# Sprint 2 설계안 — 자료조사 + 원고 생성

작성일: 2026-08-27 · 상태: **설계 검토 대기** (구현 착수 전)

## 1. 목표

`article_jobs`에 `status='selected'`로 쌓인 job을 읽어 **출처가 붙은 원고 초안**까지 만든다.
이미지·검수·발행은 Sprint 3~4다.

### 완료 조건

1. 선택된 job 1건이 자료조사를 거쳐 `sources`에 근거 N건을 **출처 등급과 함께** 남긴다
2. 그 근거를 입력으로 원고가 생성되어 `articles`에 저장된다
3. job 상태가 `selected → researching → writing → review`로 전이된다
4. 의학 주제는 **사람 교차확인 대기** 상태로 따로 표시된다
5. 원고 1건당 소요 시간과 비용이 실측된다

현재 `selected` 상태 job이 4건 있어 실데이터로 바로 검증할 수 있다.

---

## 2. ⚠️ 설계 전제가 하나 깨졌다 (2026-08-27 실측)

로드맵과 `runHeadlessClaude.ts` 주석은 **"기존 블로그 작성 스킬을 헤드리스에서 그대로
재사용한다"**를 전제로 했다. 실제로 확인해보니 아니었다.

```
$ claude -p --allowed-tools Skill  (스킬 목록 질의)

anthropic-skills:entertainment-blog-writer   없음
anthropic-skills:parenting-blog-writer       없음
anthropic-skills:trend-blog-writer           없음
moai-marketer:content-blog                   있음
moai-writer:korean-humanize                  있음
moai-coworker:ai-slop-reviewer               없음
```

`anthropic-skills:*`는 대화형 세션에만 있고 **헤드리스 CLI에서는 로드되지 않는다.**

**대체재가 더 잘 맞는다.** `moai-marketer:content-blog`는 네이버 블로그를 명시적으로 다루고 SEO
메타까지 만든다. 카테고리별로 스킬이 갈리지 않아 분기도 단순해진다. `moai-writer:korean-humanize`를
후처리로 체이닝한다. `runHeadlessClaude.ts` 상단의 낡은 주석도 함께 고쳐야 한다.

---

## 3. 데이터 연결 — `job_id` 컬럼 추가

`sources`와 `articles`는 `keyword_id`(int, `keywords.id` 참조)로 설계돼 있는데, **우리 파이프라인은
`keywords` 테이블에 아무것도 쓰지 않는다.** 그래서 `keyword_id`는 항상 null이 되어 원고를 job과 이을
방법이 없다.

```sql
alter table public.sources  add column if not exists job_id uuid;
alter table public.sources  add column if not exists authority text;
alter table public.articles add column if not exists job_id uuid;

create index if not exists idx_sources_job_id  on public.sources (job_id);
create index if not exists idx_articles_job_id on public.articles (job_id);
```

`keyword_id`는 건드리지 않는다(기존 testCrud 데이터 2건이 쓰고 있다). FK 제약은 걸지 않는다 —
`article_jobs`가 정리돼도 원고는 남아야 하고, 이는 `article_jobs`가 `keyword_rankings`를 참조하지
않고 값을 복사한 것과 같은 판단이다.

`article_jobs.metadata`에 원고를 넣는 방안도 검토했으나, 본문이 5~10KB라 jsonb에 넣으면 job 조회가
매번 무거워진다.

---

## 4. 자료조사 — 출처 등급이 핵심이다

### 4-1. 왜 등급이 필요한가 (2026-08-27 실측)

같은 파이프라인인데 **주제에 따라 근거 품질이 완전히 다르다.**

`"2026 근로장려금 지급일"` 웹문서 검색:
```
🏛 hometax.go.kr    국세청 홈택스 - 근로·자녀장려금     ← 1차 출처
🏛 hometax.go.kr    국세청 홈택스
🏛 awoo.or.kr       자녀장려금 2026 지급일...
→ 공공 9건 / 일반 1건
```

`"아기 셔더링어택 증상"` 웹문서 검색:
```
   in.naver.com    셔더링어택 영아연축증상 차이점 대처법
   in.naver.com    이거 아기 셔더링어택 맞나요?
   clien.net       아기가 부르르떠는 경련 증상이 있네여 ㅠ,ㅠ
→ 공공 0건 / 뉴스 0건 (전부 블로그·커뮤니티)
```

정책·지원금은 정부 공식 사이트가 잘 잡히고, **의학 주제는 하나도 안 잡힌다.** 이 차이를 무시하고
같은 파이프라인에 태우면, 영아 경련 감별 같은 주제를 커뮤니티 게시글 근거로 쓰게 된다.

### 4-2. 출처 등급 분류

수집 시 도메인으로 자동 판정해 `sources.authority`에 저장한다.

| 등급 | 판정 | 예 |
|---|---|---|
| `official` | `.go.kr` / `.or.kr` / `.re.kr` | hometax.go.kr, 복지로 |
| `medical` | 병원·의학회 도메인 화이트리스트 | amc.seoul.kr, snuh.org |
| `news` | 뉴스 API 결과 | wikitree.co.kr, etoday.co.kr |
| `community` | 그 외(블로그·카페·커뮤니티) | in.naver.com, clien.net |

`community`도 **버리지 않는다.** 의학 주제에서는 그게 유일한 근거이고, 실제 양육자들이 무엇을
궁금해하는지가 담겨 있어 글의 구성에 쓸모가 있다. 다만 **등급을 원고 프롬프트와 검수에 그대로
노출**해서, 어떤 주장이 어느 등급에 기대고 있는지 드러나게 한다.

### 4-3. 공공 도메인에 한해 본문을 읽는다

`official` 등급 URL은 **화이트리스트 도메인에 한해** WebFetch로 본문을 가져온다. `hometax.go.kr`이
잡히는데 스니펫만 쓰는 건 아깝다.

도메인이 제한돼 있어 **어떤 URL을 읽었는지 `sources`에 그대로 남고 감사 가능성이 유지된다.**
그 외 등급은 검색 API 스니펫만 쓴다.

### 4-4. 언론사·블로그 본문은 긁지 않는다 (검토 후 기각)

- **저작권** — 기사 본문 수집·저장은 로드맵 §6-1의 위험 범위다. 검색 API 스니펫은 네이버가 그
  용도로 제공하는 것이라 성격이 다르다
- **취약성** — 사이트마다 마크업이 다르고 수시로 바뀐다
- **ToS** — 대부분이 자동 수집을 금지한다

정부 사이트는 공공누리 등으로 이용 조건이 열려 있어 다르게 취급한다.

---

## 5. 의학 주제 — 생성은 하되 사람이 교차확인한다

### 5-1. 판정

키워드·headline의 어휘로 판정한다(`config/keywordCategoryRules.ts`와 같은 방식, 순수 함수 + 테스트).

```
증상, 진단, 치료, 처방, 부작용, 복용, 접종, 예방접종, 발열, 경련, 발진,
연축, 아토피, 수족구, 장염, 중이염, 황달, 탈수, 응급, 골절, 통증 ...
```

보수적으로 잡는다 — **의학이 아닌데 의학으로 분류되는 쪽이, 의학인데 놓치는 쪽보다 낫다.**

### 5-2. 의학 주제일 때 달라지는 것

**① 원고를 만든다.** 배제하지 않는다. 블로그·커뮤니티 근거도 그대로 쓴다.

**② 프롬프트가 달라진다.**
- 진단·처방으로 읽힐 표현 금지 (`~이면 ~입니다`, `~하면 낫습니다`)
- 개별 사례 소개는 출처를 명시하고 일반화하지 않는다
- 본문에 전문가 상담 안내를 반드시 포함
- 응급 신호(경련 지속, 의식 저하 등)는 즉시 진료 안내를 앞쪽에 배치

**③ `metadata.requiresMedicalReview = true`로 표시**하고 status는 `review`에 머문다.
Sprint 3의 자동 검수를 통과해도 **이 표시가 있으면 사람 승인 없이는 다음 단계로 못 간다.**

**④ 텔레그램 알림이 다르다.** 일반 원고는 "검수 요청"이지만, 의학 주제는:

```
⚕️ 의학 주제 — 직접 확인이 필요합니다

아기 셔더링어택 증상 원인 언제

이 원고의 근거는 전부 community 등급입니다 (공공 0건 / 의료 0건).
아래 출처를 직접 확인하신 뒤 승인해주세요.

1. [community] 셔더링어택 영아연축증상 차이점 — https://in.naver.com/...
2. [community] 아기가 부르르떠는 경련 증상 — https://clien.net/...

[✅ 확인함]  [✏️ 수정 필요]  [🗑 폐기]
```

출처 URL을 **전부 나열**해서 클릭 한 번으로 원문을 볼 수 있게 한다. 교차확인을 요청하면서
확인할 대상을 안 주면 형식적인 승인이 된다.

### 5-3. 비-의학 주제의 근거 부족

의학이 아니어도 근거가 얇을 수 있다. 이때는 **거부하지 않고 경고만** 붙인다.

| 유형 | 기대 등급 | 미달 시 |
|---|---|---|
| 정책·지원금 | `official` 1건 이상 | 알림에 ⚠️ 표시, 진행 |
| 의학 | `official`/`medical` 1건 이상 | **사람 교차확인 필수**(§5-2) |
| 연예·드라마 | `news` 1건 이상 | 알림에 ⚠️ 표시, 진행 |

정책에서 공공 출처가 없는 건 실측상 드물다(9/10이 공공이었다). 드물게 발생하면 사람이 보고
판단하면 된다.

---

## 6. 파이프라인

```
runArticleJob(jobId)
 1. job 조회 (status='selected' 확인)
 2. status -> 'researching'
 3. NAVER 검색 재조회(뉴스/웹/블로그) -> 도메인으로 authority 판정 -> sources 저장
 4. official 등급 URL은 화이트리스트 도메인에 한해 본문 fetch -> sources.content 보강
 5. 의학 주제 판정 -> metadata.isMedical
 6. 팩트 카드 조립 (등급·출처·발행일·본문/스니펫 + URL)
 7. status -> 'writing'
 8. claude -p (content-blog + korean-humanize, 의학이면 프롬프트 강화) -> 원고
 9. articles에 job_id로 저장 (ai_model 기록)
10. status -> 'review', 의학이면 metadata.requiresMedicalReview = true
11. 텔레그램 알림 (의학이면 출처 목록 포함 교차확인 요청)
```

**단계마다 status를 전이시키는 이유**: 어디서 멈췄는지 DB만 보고 알 수 있어야 한다. Sprint 0에서
파이프라인이 조용히 죽었을 때 로그를 열어보고서야 알았던 문제를 반복하지 않는다.

**실패 처리**: status를 되돌리지 않고 `metadata.lastError`에 사유를 남긴다. `researching`에서 멈춘
job은 다시 돌릴 수 있어야 하므로 status는 그대로 둔다.

---

## 7. 모든 원고에 강제할 규칙

로드맵 §6-2·§6-4의 위험을 프롬프트에서 막는다. Sprint 3 검수가 2차 방어선이다.

1. **제공된 근거를 벗어난 수치·날짜·인용을 만들지 않는다**
2. **인물 관련은 확정 보도된 사실만.** 추측성 표현(`~라는 의혹`, `~한 듯`) 금지 — 한국은 사실을
   적시해도 명예훼손이 성립할 수 있다(형법 307조 1항)
3. **정책·지원금은 출처 URL과 발표일을 본문에 명시**하고 "작성 시점" 기준임을 밝힌다
4. **`community` 등급에만 기댄 주장은 단정하지 않는다** — "~라고 알려져 있습니다" 수준으로 낮추고
   출처를 함께 밝힌다
5. 과장된 낚시 표현(충격, 경악, 소름) 금지
6. 본문 끝에 참고 출처 목록(제목 + URL + 등급)

---

## 8. 비용과 시간

**아직 모른다.** 제목 3개 생성이 25초였는데 원고는 훨씬 길다. 첫 1건 실측 후 판단한다.
`runHeadlessClaude`의 기본 타임아웃 120초는 부족할 가능성이 높다.

---

## 9. 작업 순서

| # | 작업 | 담당 | 승인 게이트 |
|---|---|---|---|
| 1 | migration (`job_id`, `authority` + index) | Claude | **적용 시 승인** |
| 2 | `types/database.ts` 반영 | **Codex** | - |
| 3 | 출처 등급 판정 + 의학 주제 판정 (순수 함수 + 테스트) | Claude | - |
| 4 | `SourceRepository` / `ArticleRepository` | **Codex** | - |
| 5 | `workflows/research/` — 재조회 + 공공 본문 fetch + 팩트 카드 | Claude | - |
| 6 | 원고 프롬프트(일반/의학) + 스킬 체이닝 | Claude | - |
| 7 | `runArticleJob` 오케스트레이션 + status 전이 | Claude | - |
| 8 | 의학 교차확인 텔레그램 알림 + 버튼 | Claude | - |
| 9 | **원고 1건 실측** | Claude | **LLM 실행 승인** |
| 10 | `runHeadlessClaude.ts` 낡은 주석 정정 | Claude | - |

3·6·8은 안전 판단이 걸려 있어 Claude가 한다. 2·4는 기존 패턴을 따르는 반복 작업이라 Codex 위임에
적합하다.

---

## 10. 남은 결정 항목

**① 원고 생성을 자동으로 돌릴까, 수동 트리거로 둘까?**
수동(`npm run job:write -- <jobId>`)을 제안한다. **비용이 실측되기 전에 무인 자동화는 위험하다.**

**② 원고 길이 목표**
네이버 블로그 기준 1,500~2,500자를 제안한다. 짧으면 저품질 판정 위험, 길면 비용과 이탈률이 는다.

**③ 의료 도메인 화이트리스트 범위**
서울아산·서울대병원·질병관리청 정도로 시작하고 필요할 때 넓히는 것을 제안한다.

---

## 11. 이 설계에서 의도적으로 하지 않는 것

- **이미지** — Sprint 3
- **자동 검수 게이트** — Sprint 3 (프롬프트가 1차, 검수가 2차, 사람이 3차)
- **발행** — Sprint 4
- **언론사·블로그 본문 수집** — §4-4, 기각
- **의학 주제 자동 배제** — 검토했으나 사용자 결정으로 기각. 대신 §5의 사람 교차확인으로 다룬다
