# 키워드 수집 확장 설계 — 주제 중복 제거 + 커뮤니티/다음/구글 소스

작성일: 2026-08-29 (Asia/Seoul) · 브랜치: `claude/keyword-collection-optimization-6ojcou`

사용자 요청 4건에 대한 진단·설계 문서다.

1. 오늘 Top 10 중 "넷플릭스 들쥐"가 4칸을 차지 → 하나로 묶어야 한다
2. 묶이면 생기는 자리를 새 키워드로 채운다
3. "커뮤니티" 카테고리 추가 (더쿠·펨코·다음/네이버 인기카페 인기글)
4. 다음 실시간 검색 + 구글 트렌드를 검색 풀에 반영

**진행 상태**: 1·2번 구현·검증 완료. 3번(커뮤니티)은 `community` category까지 완료, 수집기는 설계.
4번은 구글 트렌드 구현 완료(실측 미검증·기본 disabled), 다음 실시간은 설계. 사용자 결정 사항은 §7,
이번 세션에서 실제로 구현한 것은 §7-1, 남은 순서는 §8.

> **이 세션의 검증 한계**: 원격 컨테이너에 `.env`가 없고 외부 egress가 차단돼 있다.
> Supabase/NAVER API 호출과 외부 endpoint 실측은 불가능했다. 순수 함수 테스트와 `npm run build`는
> 전부 통과했고, 외부 endpoint(§5·§6)는 **맥에서 실측 확인이 필요하다**.

---

## 1. 진단: 왜 한 이슈가 Top 10을 4칸 차지했나

원인이 **두 겹**이고, 둘 다 재현했다.

### 1-1. clustering이 병합하지 못한다 (구조적)

`CLUSTERING_CONFIG.excludeSeedQueryFromTokens = true`는 "seed 토큰은 그 seed에서 나온 거의 모든
후보에 등장하므로 변별력이 없다"는 이유로 seed 토큰을 유사도 계산에서 지운다. **같은 seed 안에서는
맞는 판단이지만, 서로 다른 seed에서 같은 이슈가 잡히면 정확히 반대로 작동한다.**

```
seed "넷플릭스" 유래: "넷플릭스 들쥐 출연진 총정리"  -> 토큰 {들쥐, 출연진}      ("넷플릭스" 삭제)
seed "들쥐"     유래: "들쥐 결말 해석과 시즌2 가능성" -> 토큰 {결말, 해석, 시즌2}  ("들쥐" 삭제)
```

두 제목이 같은 이슈라는 **유일한 증거인 고유명사가 양쪽에서 각각 지워져** 교집합이 정확히 0이 된다.
실제 재현값:

| 쌍 | combined | threshold | token | coreNoun | 교집합 |
|---|---|---|---|---|---|
| 넷플릭스seed ↔ 넷플릭스seed | 0.169 ~ 0.238 | 0.38 | 0.14~0.20 | 0.14~0.20 | 1 |
| 넷플릭스seed ↔ 들쥐seed (cross) | **0.000** | 0.55 | 0.00 | 0.00 | **0** |

cross-seed가 0.000인 것은 우연이 아니라 필연이다. 그리고 **Creator Advisor가 그날의 화제 키워드를
매일 seed로 밀어 넣기 때문에**(`넷플릭스`는 `seed_queries`, `들쥐`는 `trend_candidates`)
**인기 이슈일수록 반드시 이 경로를 탄다.** 화제가 클수록 도배될 확률이 올라가는 구조였다.

같은 seed 안에서도 0.169~0.238로 threshold 0.38을 못 넘는다 — 뉴스 제목은 수식어가 많아 Jaccard가
잘 오르지 않는다.

### 1-2. diversity cap이 발화하지 않는다

`DIVERSITY_CONFIG.maxPerCanonicalTopic = 1`은 있었지만, **canonical keyword 문자열 완전 일치**로만
셌다. 제목이 다르면 canonical도 달라지므로("넷플릭스 들쥐 출연진" vs "들쥐 결말 해석과 시즌2 가능성")
cap이 한 번도 발화하지 않았다.

`maxPerSeedQuery = 2`는 정상 작동했다. 그래서 seed 2개 × 2건 = **정확히 4건**이 남은 것이다.
사용자가 본 숫자가 이 설정값과 정확히 일치한다.

---

## 2. 구현한 것 (1·2번)

**clustering은 건드리지 않았다.** 오병합 위험이 크고 CLAUDE.md상 승인 대상이라, 최종 Top N 선정
단계에만 2차 안전장치를 넣었다. clustering이 놓쳐도 Top 10 도배는 막힌다.

### 신규 `src/workflows/keyword-ranking/topicGrouping.ts`

두 후보가 "같은 주제"인지 판정한다. 둘 중 하나라도 만족하면 같은 주제:

- **신호 A — batch 안에서 희소한 핵심 명사를 공유**
  `들쥐`는 400개 cluster 중 4개에만 나오므로 희소 → 같은 주제의 강한 증거.
  희소 기준을 고정 상수가 아니라 **그날 batch의 document frequency**로 잡았다. 어떤 단어가 "그날의
  고유명사"인지는 그날 수집 결과가 알려주지 미리 적을 수 없기 때문이다.
  (기본: `df <= max(2, ceil(batch × 0.02))`, 상한 12 → 400건 batch에서 df 8 이하)
- **신호 B — 핵심 명사 집합 자체가 충분히 겹침** (Jaccard ≥ 0.5 & 교집합 ≥ 2)
  희소 토큰이 없어도 "부모급여 인상 시기" / "부모급여 지급 시기"를 잡는다.

clustering과 달리 **seed 토큰을 지우지 않는다** — §1-1이 이 모듈을 만든 이유이므로.

### 과병합 방지 (반대 방향 오류)

첫 구현은 테스트에서 **"넷플릭스 들쥐"와 "넷플릭스 오징어게임"을 같은 주제로 오판**했다.
후보가 얕은 날에는 `넷플릭스`의 df가 `들쥐`의 df와 거의 같아져, **df 통계만으로는 플랫폼 이름과
고유명사를 구분할 수 없다.** 통계로 안 되는 정보이므로 명시적으로 넣었다:

- `TOPIC_GROUPING_CONFIG.categoryTerms` — 어느 날이든 분류어인 고정 목록
  (넷플릭스/티빙/디즈니/드라마/영화/예능/육아/날씨…)
- `extraCategoryTerms` — **그날의 분류어를 runtime 주입.** daily workflow가 `seed_queries` 유래
  query(= 사람이 등록한 상시 검색어)만 넘긴다. Creator Advisor에서 온 그날의 화제 키워드는
  넘기지 않는다 — 그건 분류가 아니라 주제 그 자체다.
- `genericTokens` — 리뷰/후기/방법/이유/출연진/결말/촬영지… 없으면 서로 다른 드라마 두 편이
  "촬영지" 하나로 묶인다.

### 변경 파일

| 파일 | 내용 |
|---|---|
| `src/workflows/keyword-ranking/topicGrouping.ts` | 신규. 주제 동일성 판정 (순수 함수) |
| `src/workflows/keyword-ranking/selectDiverseTopN.ts` | topic cap을 문자열 일치 → `isSameTopic()`으로 |
| `src/config/keywordScoring.ts` | `TOPIC_GROUPING_CONFIG` 신규, `DIVERSITY_CONFIG.enableTopicGrouping` |
| `src/workflows/dailyKeywordWorkflow.ts` | `seed` origin query를 `categoryTerms`로 전달 |
| `src/workflows/keyword-ranking/testTopicGrouping.ts` | 신규 회귀 테스트 |
| `package.json` | `test:topic-grouping` |

### 검증 결과 (`npm run test:topic-grouping`, 392건 batch)

```
✅ 넷플릭스 들쥐 4건이 서로 같은 주제로 판정됨 (cross-seed 포함)
✅ 같은 '넷플릭스'라도 다른 작품(오징어게임)은 별개 주제로 유지됨
✅ '리뷰/후기' 같은 범용 수식어만으로는 묶이지 않음
✅ 토큰 판정: 들쥐=주제 토큰(희소), 넷플릭스=분류어로 제외
✅ seed_queries 유래 분류어 runtime 주입이 실제로 판정을 바꿈
✅ 넷플릭스 들쥐 4건 -> 1건으로 축소
✅ Top 10 안에 같은 주제 중복 없음
✅ 확보된 자리에 다른 주제가 실제로 채워짐
✅ pool에 존재하는 target category 전부 대표 확보
✅ community(신규 category)가 backfill로 편입됨
```

`npm run build` 통과. 되돌리려면 `DIVERSITY_CONFIG.enableTopicGrouping = false` 한 줄이면 예전
동작(문자열 완전 일치)으로 복귀한다.

### 남은 근본 원인 (승인 필요 — §7-A)

§1-1의 clustering 문제 자체는 **그대로 남아 있다.** 지금은 Top 10 표시만 고쳤고, 내부적으로는
여전히 한 이슈가 cluster 4개로 쪼개져 있다. 그래서:

- 4개로 쪼개진 cluster는 각각 `relatedCount`가 작아 **newsVelocity/contentDemand/crossSource 점수를
  손해 본다.** 병합됐다면 그 이슈가 지금보다 더 높은 순위였을 것이다.
- 근본 수정은 clustering 로직 변경이라 승인이 필요하다.

---

## 3. 확보되는 자리 (2번)

오늘 기준 **10칸 중 3칸**이 새로 열린다(들쥐 4 → 1). 다만 **지금 채워지는 건 그냥 차순위 후보**다.
사용자가 원한 "추가 룸"이 의미를 가지려면 후보 풀 자체가 넓어져야 하고, 그게 3·4번이다.

현재 풀: `seed_queries` 44건 + Creator Advisor 40건 = **84 query → 후보 ~2100 → 관련성 필터 ~900 →
cluster ~400**. 소스가 NAVER + Creator Advisor 둘뿐이라 **네이버 생태계 밖의 화제는 구조적으로 못
본다.** 커뮤니티/다음/구글은 이 사각지대를 정확히 겨냥한다.

---

## 4. 소스 확장 공통 설계

### 4-1. 스키마 변경이 필요 없다 ✅

`trend_candidates`의 unique index가 이미
`(keyword_normalized, topic_normalized, trend_date, source)`이고 `source`는 `text` 컬럼이다
(기본값 `'creator_advisor'`). **새 소스는 `source` 값만 추가하면 되고 migration이 필요 없다.**

```
'creator_advisor'  (기존)
'google_trends'
'daum_realtime'
'community_theqoo' / 'community_natepann' / 'community_dcinside' / 'community_cafe'
```

### 4-2. 고쳐야 하는 지점 하나

`buildDailyQueryPool.ts`가 `listLatestActiveCandidates("creator_advisor")`로 **소스를 하드코딩**하고
있다. 소스별로 조회 → 소스별 quota만큼 선별 → merge 하도록 확장해야 한다.

권장 quota (합 84 → 약 110):

| source | quota | 근거 |
|---|---|---|
| seed_queries | 44 | 그대로 |
| creator_advisor | 40 | 그대로 (네이버 블로그 실검색 기반, 가장 신뢰도 높음) |
| google_trends | 10 | TOP 20 중 상위 |
| daum_realtime | 8 | TOP 10 전부는 과함 |
| community_* | 12 | LLM 추출 후 상위 (§5-3) |

`collect` 단계가 query당 3 API를 순차 호출하므로 **query 수에 비례해 소요 시간이 는다**(현재 84건에
70초). 110건이면 약 90초, 전체 약 105초. `caffeinate` 보호 범위 안이라 안전하다.

### 4-3. 실패 격리

모든 신규 소스는 Creator Advisor와 같은 규칙을 따른다: **실패해도 throw하지 않고 status로만 알린다.**
`buildDailyQueryPool`은 어떤 소스가 죽어도 나머지로 진행한다. 새 소스가 daily job을 죽이면 안 된다.

---

## 5. 커뮤니티 (3번)

### 5-1. 핵심 난점: 커뮤니티 제목은 키워드가 아니다

Creator Advisor는 이미 "검색 키워드" 형태로 준다. 커뮤니티는 다르다.

```
"ㅋㅋㅋㅋ 이거 실화냐"
"어제 그거 본 사람?"
"진짜 개역대급이던데"
```

**이걸 그대로 seed query로 넣으면 NAVER 검색이 아무것도 못 찾는다.** 그래서 커뮤니티 소스는
반드시 **엔티티 추출 단계**가 필요하다. 이게 다른 세 소스와의 결정적 차이다.

**제안: 하루 1회 LLM 1콜.** 이미 있는 `services/llm/runHeadlessClaude.ts`를 재사용해 인기글 제목
40~60개를 한 번에 넘기고, 각 제목에서 (a) 검색 가능한 고유명사/이슈 키워드 (b) 블로그 소재 적합도
(c) 카테고리를 뽑는다. 규칙 기반으로는 불가능한 영역이고(형태소 분석기도 밈·축약어를 못 잡는다),
비용은 하루 1콜이라 무시할 만하다.

> clustering에는 LLM을 쓰지 않으면서 여기에는 쓰는 이유: clustering은 이미 동작하는 규칙 기반
> 경로가 있다. 커뮤니티 제목 → 키워드는 규칙 기반 경로가 **아예 없다.**

### 5-2. 소스별 난이도 (⚠️ 맥에서 실측 필요)

| 소스 | 경로 | 로그인 | 위험 | 평가 |
|---|---|---|---|---|
| **네이버 카페글 검색 API** | `/search/v1/cafearticle` | 불필요 | 없음 | ✅ 공식 API, 기존 인증 그대로. 단 **발굴이 아니라 검증용** — seed에 대한 커뮤니티 반응량 신호 |
| **네이버 지식iN API** | `/search/v1/kin` | 불필요 | 없음 | ✅ 공식. "사람들이 지금 뭘 묻는가" |
| **네이트판 오늘의 톡** | 공개 페이지 | 불필요 | 낮음 | ✅ 접근 쉬움. 시작점으로 추천 |
| **더쿠 핫게시판** | `theqoo.net/hot` | 불필요 | 중 | ⚠️ Cloudflare 여부 실측 필요 |
| **디시 실시간 베스트** | `gall.dcinside.com/board/lists/?id=dcbest` | 불필요 | 중 | ⚠️ 트래픽 필터 있음 |
| **다음 카페 인기글** | 포털 랭킹면 | 불필요 | 중 | ⚠️ 동적 렌더링, Playwright 필요 |
| **네이버 카페 인기글** | `section.cafe.naver.com` 랭킹 | 불필요 | 중 | ⚠️ 동적 렌더링, Playwright 필요 |
| **에펨코리아 포텐** | `fmkorea.com/best` | 불필요 | **높음** | ❌ Cloudflare Bot Management 강함. **후순위 권장** |

**펨코를 후순위로 두는 이유**: Cloudflare Bot Management는 헤드리스 브라우저를 식별해 차단하며,
우회는 명시적 차단 회피에 해당한다. 다른 소스로 같은 목적을 달성할 수 있으므로 굳이 여기서 시작할
이유가 없다. 다른 소스가 다 붙은 뒤에도 부족하면 그때 재검토한다.

### 5-3. 스크래핑 운영 원칙

- 하루 1회만. 목록 페이지 1~2개만.
- **제목만** 수집. 본문·이미지·작성자는 저장하지 않는다.
- 각 사이트 `robots.txt`를 먼저 확인하고, 금지면 그 소스는 제외한다.
- User-Agent를 위장하지 않는다.
- 실패는 비치명적(§4-3).
- 이미 있는 Playwright + persistent profile 인프라(`BrowserCreatorAdvisorProvider`)를 그대로 재사용.

### 5-4. "커뮤니티 카테고리"에 대한 설계 판단 ⚠️

사용자 표현은 "키워드 카테고리에 커뮤니티를 추가"인데, 여기에 **주의할 점**이 있다.

`category`는 표시용이 아니다. 두 곳에서 실제로 쓰인다:
1. `DIVERSITY_CONFIG.targetCategories` — Top 10 category backfill
2. `buildArticlePrompt.pickStyleRules()` — **원고 톤 결정** (`living`=편집자 톤, 나머지=개인 블로그 톤)

**"커뮤니티"는 주제가 아니라 출처다.** 더쿠에서 온 키워드도 결국 연예/육아/생활 중 하나다.
`category = "community"`로 두면 그 축이 무너진다.

**두 가지 선택지:**

- **(A) 출처 축을 분리한다 (기술적으로 정석)**
  `category`는 4종 유지. 커뮤니티 유래 여부는 `metadata.origin`으로 남기고,
  `DIVERSITY_CONFIG`에 "커뮤니티 유래 키워드 Top 10에 최소 N건 보장" quota를 추가한다.
  → 원고 톤 라우팅이 안 깨지고, 사용자가 원한 "커뮤니티 키워드가 매일 들어온다"는 목적은 달성된다.

- **(B) 5번째 category `community`를 만든다 (사용자 표현 그대로)**
  이쪽도 말이 된다. 이 저장소에는 이미 **`trend-blog-writer` 스킬**이 있고
  ("최근 화제가 된 한국 인터넷 트렌드, 사회 이슈, 논쟁적 사안 · 찬반 양측 정리 · 개인적 견해")
  그건 기존 4종 어디에도 안 맞는 **독립된 글 유형**이다. 즉 `community`는 출처가 아니라 진짜로
  "화제/밈/논쟁" 이라는 주제 유형일 수 있다.
  이 경우 `pickStyleRules`에 `community` 분기를 추가해야 한다(현재는 `living` 외 전부 PERSONAL로
  떨어지므로 톤이 크게 어긋나진 않지만, 명시하는 편이 안전하다).

**Claude 권장: (B).** `trend-blog-writer` 스킬의 존재가 결정적이다 — 이미 이 유형의 글을 따로
쓰고 있다는 뜻이고, 그렇다면 그건 별개 카테고리다. 다만 (B)를 택하면 **커뮤니티에서 온 연예 뉴스는
`entertainment`로, 밈·논쟁거리만 `community`로** 가도록 `keywordCategoryRules.ts`에 어휘 규칙을
넣어야 한다(출처가 아니라 내용으로 판정). → **§7-B 결정 필요**

---

## 6. 다음 실시간 트렌드 / 구글 트렌드 (4번)

### 6-1. 다음 실시간 검색 — 지금은 가능하다 ✅

사용자 요청 시점 기준으로 상태가 최근에 바뀌었다.

- 다음 실시간 검색어는 2020-02 폐지됐다가 **2026-03-03 "실시간 트렌드" 베타로 부활**했다
  (카카오 자회사 AXZ 운영).
- 다음 홈 검색창 우측 상단에 **TOP 10**, **10분 주기 갱신**.
- 단순 검색량 집계가 아니라 **뉴스 + 카페 검색기록 + 웹문서**를 결합해 이슈 순위를 만든다.
  → 카페 검색기록이 들어간다는 점에서 **§5의 커뮤니티 목적과도 부분적으로 겹친다.**
- 공식 API는 없다. **`daum.net` 홈 스크래핑 또는 내부 JSON endpoint**가 경로다.
  Playwright 인프라 재사용. 로그인 불필요로 추정되나 **실측 필요**.

⚠️ **카카오데이터트렌드(`datatrend.kakao.com`)는 2025-08-29 종료됐다.** DataLab 대체재로는 못 쓴다.
"다음 쪽 검색량 지표"를 기대했다면 그건 현재 존재하지 않는다.

### 6-2. 구글 트렌드 — RSS가 가장 현실적 ✅

- **공식 Google Trends API**는 2025-07-24 발표됐으나 **1년 넘게 신청 승인제 alpha**다. 지금은 못 쓴다.
- **`pytrends`는 2025-04 아카이브**됐다. 참고하지 말 것.
- **권장: RSS 피드** `https://trends.google.com/trending/rss?geo=KR`
  - 인증·키 불필요, XML, 응답 가벼움
  - 구 endpoint(`/trends/trendingsearches/daily/rss`)는 폐기됐다 — 새 `/trending/rss`를 쓴다
  - 항목당: 검색어(`title`), 대략 검색량(`ht:approx_traffic`), 관련 뉴스 여러 건
    (`ht:news_item` — 제목/URL/출처), `pubDate`
  - **이미 있는 의존성으로 충분하다.** 별도 라이브러리 불필요
- 구글 트렌드는 **키워드 형태로 그대로 나오므로 §5의 LLM 추출 단계가 필요 없다.** 가장 싸다.

### 6-3. 우선순위 권장

| 순위 | 소스 | 이유 |
|---|---|---|
| 1 | **구글 트렌드 RSS** | 인증 없음, 키워드 그대로, 실패 위험 최소. 반나절 |
| 2 | **다음 실시간 트렌드** | Playwright 인프라 재사용, TOP 10 고품질. 하루 |
| 3 | **커뮤니티** | 가치는 가장 높지만 LLM 추출 + 스크래핑 위험. 2~3일 |

3번은 네이트판·더쿠부터 붙이고 펨코는 마지막에 재검토한다(§5-2).

---

## 7. 결정 사항 (2026-08-29 사용자 확정)

| 항목 | 결정 | 상태 |
|---|---|---|
| A. clustering 근본 수정 (§1-1) | **지금은 두고 관찰** | 보류 — 며칠 Top 10을 보고 재판단 |
| B. 커뮤니티를 category로 (§5-4) | **(B) 5번째 category `community`** | ✅ 구현 완료 |
| C. 스크래핑 대상 (§5-2) | 네이버 공식 API(카페글·지식iN) + 네이트판 + 더쿠 + 다음/네이버 카페 인기글. **펨코 제외** | 설계 확정, 구현 대기 |
| D. 커뮤니티 엔티티 추출에 LLM 1콜/일 (§5-1) | **사용** | 설계 확정, 구현 대기 |
| E. quota 배분 (§4-2) | 제안대로 (query 84 → 약 110, 소요 80초 → 약 105초) | ✅ config 반영 |

### A에 대한 메모

보류를 택했으므로 **한 이슈가 여전히 cluster 4개로 쪼개져 relatedCount/news/cross 점수를 손해 보는
상태는 유지된다.** Top 10 표시만 고쳐진 것이다. 관찰 포인트는 두 가지다.

1. 도배가 실제로 사라졌는가 (기대: 사라진다)
2. 원래 1위였어야 할 이슈가 병합 실패 때문에 3~4위로 밀리고 있지는 않은가
   → `discovery_runs.metadata`의 preDiversityRankings와 최종 rankings를 비교하면 보인다

2번이 반복 관측되면 그때 §1-1을 승인 요청한다.

---

## 7-1. 2026-08-29 세션에서 실제로 구현한 것

§8의 0~3단계를 이 브랜치에서 마쳤다. 4~5단계(다음 실시간, 커뮤니티)는 **외부 페이지 DOM 실측이
필요해 이 원격 세션에서는 불가능**하므로 설계 상태로 남겼다.

### (1) Top N 주제 중복 제거 — §2

### (2) `community` category — 결정 B

| 파일 | 변경 |
|---|---|
| `config/keywordCategoryRules.ts` | `KeywordCategory`에 `community` 추가, 규칙을 **맨 마지막**에 배치 |
| `config/keywordScoring.ts` | `DIVERSITY_CONFIG.targetCategories`에 `community` 추가 |
| `workflows/writing/buildArticlePrompt.ts` | `pickStyleRules` 분기를 명시적으로 (community → PERSONAL, 임시) |
| `config/testKeywordCategoryRules.ts` | community 케이스 8건 추가 |

**규칙을 맨 마지막에 둔 것이 핵심이다.** "출처가 아니라 내용으로 판정한다"는 결정 B의 조건을
순서로 강제한다 — 더쿠에서 온 연예 가십은 entertainment, 펨코에서 온 지원금 소식은 living이 되고,
앞 네 규칙이 전부 미스한 순수 인터넷 화제만 community가 된다. 테스트가 이 순서를 고정한다.

> **부수 발견**: community 테스트를 쓰다가 entertainment 규칙의 구멍을 찾았다. "연예인 갑질 논란"에
> 매칭되는 어휘가 하나도 없어서(`연예인`이 규칙에 없었다) community로 떨어졌다. 커뮤니티 소스가
> 붙으면 이 형태가 대량으로 들어오므로 `연예인`/`아이돌`을 entertainment에 추가했다.
> `배우`/`가수`는 넣지 않았다 — 부분 문자열 매칭이라 "배우자 출산휴가"가 연예 뉴스가 된다.

`community` 톤은 현재 PERSONAL로 보낸다. `trend-blog-writer`의 실제 문체(찬반 양측 정리 + 화자의
개인적 견해)는 개인 경험담과 다르므로, **발행 표본이 쌓이면 전용 rule set이 필요하다**(미해결).

### (3) 다중 source query pool — §4-2

`buildDailyQueryPool`이 `source="creator_advisor"` 하드코딩에서 벗어났다. 이제
`config/trendSources.ts`의 enabled 소스를 순회하며 소스별 quota만큼 뽑아 합친다.

- **스키마 변경 없음** (§4-1 예상대로). `trend_candidates` unique index에 이미 source가 있다.
- 소스 하나가 실패해도 나머지로 진행한다. 전부 실패해도 seed_queries만으로 정상 동작한다.
- 결과에 `trendCountBySource` / `trendErrorBySource`가 추가돼 어느 소스가 기여했는지 보인다.
- `QueryPoolEntry.source` 추가. `origin`(seed냐 아니냐)과 `source`(어디서 왔나)는 별개 축이라
  한 필드에 섞지 않았다 — topicGrouping의 분류어 판정이 origin 축을 쓴다.
- 기존 호출부와 테스트는 그대로 통과한다(`loadLatestCreatorAdvisorCandidates` 옵션 유지).

신규 소스 priority는 2로, Creator Advisor(3)보다 낮다. CA는 "네이버 블로그에서 실제로 검색된
키워드"라 이 프로젝트의 발행 채널과 가장 직접 연결돼 있기 때문이다.

### (4) 구글 트렌드 RSS — §6-2

| 파일 | 역할 |
|---|---|
| `services/search/providers/googleTrends/parseGoogleTrendsRss.ts` | RSS 파서 (순수, **절대 throw 안 함**) |
| `services/search/providers/googleTrends/GoogleTrendsProvider.ts` | fetch + 타임아웃 |
| `services/search/providers/googleTrends/fixtures/trendingRss.sample.xml` | 테스트 fixture |
| `workflows/google-trends/mapGoogleTrendsCandidates.ts` | RSS 항목 → `trend_candidates` row |
| `workflows/google-trends/runGoogleTrendsCollection.ts` | 배선 (실패해도 status로만 알림) |
| `workflows/google-trends/runCollectionCli.ts` | `npm run collect:google-trends` (**기본 dry-run**) |
| `workflows/google-trends/testGoogleTrends.ts` | `npm run test:google-trends` |

Creator Advisor와 다른 점 세 가지를 매핑에서 처리했다.

1. **topic이 없다.** 구글 트렌드는 분야 구분 없이 순위 목록만 준다 → `topic`은 고정값
   `"google_trends"`(원문 보존 필드에 거짓 분야명을 지어내지 않는다), category는 키워드 어휘 분류에
   전적으로 의존하고 신호가 없으면 `living`으로 폴백한다. 새 "미분류" 값을 만들지 않은 이유는
   category 소비자(backfill, 원고 톤)가 그 값을 몰라 조용히 어긋나기 때문이다.
2. **movement_type을 알 수 없다** → `flat`. 전부 `new`로 두면 "어제도 1위였던 키워드"를 신규라고
   말하게 된다. `flat`이 스키마 4값 중 "변화 정보 없음"에 가장 가깝다.
3. **candidate_score를 순위 + approx_traffic으로 만든다.** CA 점수와 스케일을 맞출 필요는 없다 —
   candidate_score는 같은 source 안에서만 비교된다(소스별 quota로 따로 자르므로).

`dailyKeywordWorkflow`의 `trendCollect` 단계가 두 소스를 순차 수집하고 상태를 집계한다
(하나라도 성공 → success / 전부 disabled → skipped / 성공 0 + 실패 1 이상 → failed). 어느 쪽이든
파이프라인을 멈추지 않는다.

### ⚠️ 구글 트렌드는 아직 실측되지 않았다

이 세션은 외부 egress가 차단돼 `trends.google.com`에 한 번도 접속하지 못했다. 엔드포인트
(`/trending/rss?geo=KR`)와 필드 구성은 **공개 스키마 기준 추정**이다. 그래서:

- 파서를 **어떤 입력에도 예외를 던지지 않게** 만들었다(빈 문자열/HTML 오류 페이지/구조 변경 →
  0건 반환). 테스트가 이걸 고정한다.
- `approx_traffic`/`news_item`/`pubDate`를 전부 optional로 뒀다. 없어도 항목을 버리지 않는다.
- **`GOOGLE_TRENDS_ENABLED` 기본값은 false다.** 맥에서 `npm run collect:google-trends`(dry-run)로
  실제 응답을 눈으로 확인한 뒤에 켜야 한다. CLI가 조회 결과를 목록으로 출력한다.

### 검증 결과 (전부 offline, 외부 호출/DB 쓰기 없음)

```
npm run build                       OK
npm run test:topic-grouping         pass
npm run test:google-trends          pass   (신규, 파서 강건성 포함)
npm run test:daily-query-pool       pass   (기존 테스트 무수정 통과)
npm run test:keyword-category       pass   (community 8건 추가, 총 32건)
npm run test:score-keyword          pass
npm run test:creator-advisor-*      pass   (parser / pipeline / collection)
npm run test:callback-data          pass
npm run test:telegram-bot           pass
npm run test:article-prompt         pass
npm run test:fact-card              pass
npm run test:article-review         pass
npm run test:naver-html             pass
```

> 이 원격 세션에는 `.env`가 없어 Supabase 클라이언트를 import하는 테스트는 더미 환경변수
> (`SUPABASE_URL=https://dummy.invalid SUPABASE_SERVICE_ROLE_KEY=dummy`)로 실행했다. 전부 loader를
> 주입받는 테스트라 실제 원격 접근은 일어나지 않는다. 맥에서는 그냥 `npm run <test>`로 돌면 된다.
> 외부 API를 실제 호출하는 `test:naver`/`test:keywords`/`test:ranking`은 이 세션에서 실행하지 못했다.

---

## 8. 실행 순서

```
0. ✅ Top N 주제 중복 제거 + 회귀 테스트
1. ✅ buildDailyQueryPool 다중 source 지원 (§4-2)
2. ✅ 구글 트렌드 RSS provider (§6-2)          <- 코드 완료, 실측 미검증 / 기본 disabled
3. ✅ community category (결정 B)
--- 여기까지 이 브랜치 ---
4. ⬜ 맥에서 실측 확인
   a. npm run test:topic-grouping / test:google-trends / build
   b. npm run collect:google-trends            (dry-run, 실제 RSS 응답 눈으로 확인)
   c. 확인되면 .env에 GOOGLE_TRENDS_ENABLED=true
   d. WRITE=1 npm run collect:google-trends    (원격 DB 쓰기 - 승인 필요)
   e. 내일 아침 run에서 Top 10 변화 관찰
5. ⬜ 다음 실시간 트렌드 provider (§6-1)        <- daum.net DOM 실측부터
6. ⬜ 커뮤니티 수집 + LLM 엔티티 추출 (§5)      <- 결정 C/D 반영, 펨코 제외
7. ⬜ (관찰 후 판단) clustering 근본 수정 (§7-A)
```

5·6은 외부 페이지 DOM 구조 실측이 선행돼야 해서 원격 세션에서 진행할 수 없다. 실측 뒤 파서 작성은
범위가 명확해지므로 `delegate-codex` 위임 후보가 된다(Creator Advisor Swiper 순회 때와 같은 방식).

### 새 환경변수 (전부 기본 false / 미설정 시 기존 동작)

```
GOOGLE_TRENDS_ENABLED=false                    # 실측 확인 후 true
GOOGLE_TRENDS_MAX_DAILY_CANDIDATES=10
GOOGLE_TRENDS_CANDIDATE_TTL_HOURS=12
DAUM_REALTIME_ENABLED=false                    # 5단계 구현 후
COMMUNITY_TRENDS_ENABLED=false                 # 6단계 구현 후
```
