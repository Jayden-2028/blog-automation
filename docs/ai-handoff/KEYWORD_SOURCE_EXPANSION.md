# 키워드 수집 확장 설계 — 주제 중복 제거 + 커뮤니티/다음/구글 소스

작성일: 2026-08-29 (Asia/Seoul) · 브랜치: `claude/keyword-collection-optimization-6ojcou`

사용자 요청 4건에 대한 진단·설계 문서다.

1. 오늘 Top 10 중 "넷플릭스 들쥐"가 4칸을 차지 → 하나로 묶어야 한다
2. 묶이면 생기는 자리를 새 키워드로 채운다
3. "커뮤니티" 카테고리 추가 (더쿠·펨코·다음/네이버 인기카페 인기글)
4. 다음 실시간 검색 + 구글 트렌드를 검색 풀에 반영

**진행 상태**: 1·2번 구현·검증 완료. 3번(커뮤니티)은 `community` category 완료 +
**수집기 파이프라인 + 더쿠(theqoo) provider 구현·오프라인 검증 완료, 맥에서 실제 fetch 확인만
남음**(브랜치 `claude/community-collector`, §7-2/§7-3). 네이트판·다음카페·네이버카페는 robots.txt가
막아 제외됐다(§7-3). 4번은 구글 트렌드 **실측 검증 완료·활성화**(브랜치
`claude/keyword-collection-optimization-6ojcou`), 다음 실시간은 설계만. 사용자 결정 사항은 §7,
첫 세션에서 구현한 것은 §7-1, 커뮤니티 수집기 파이프라인은 §7-2, 더쿠 provider + robots.txt 실측
반영은 §7-3, 남은 순서는 §8.

> **검증 한계**: 원격 컨테이너에 `.env`가 없고 외부 egress가 차단돼 있어, Supabase/NAVER API 호출은
> 이 세션에서 실행하지 못했다(순수 함수 테스트와 `npm run build`는 전부 통과). 구글 트렌드는
> **맥에서 실측 확인을 마쳤고 그 결과가 §7-1에 반영돼 있다.** 다음 실시간·커뮤니티는 여전히 설계
> 단계이며 DOM 실측이 필요하다.

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

### 구글 트렌드 실측 결과 (2026-08-29, 맥)

**엔드포인트 추정이 맞았다.** `/trending/rss?geo=KR`이 인증 없이 TOP 10 + 항목별 뉴스 2건을 정상
응답했고, `ht:approx_traffic` / `ht:news_item`(제목·URL·출처) 구성도 가정과 일치했다.
파싱 10건, dropped 0, `trendDate: 2026-08-29`.

그런데 **실제 데이터가 설계상 리스크 하나를 그대로 터뜨렸다.**

| # | 키워드 | 검색량 | 어휘 분류 결과 |
|---|---|---|---|
| 1 | 2026년 태풍 | 2000+ | living ✅ |
| 2 | 게임스컴 | 200+ | ❌ 미매칭 → living |
| 3 | 오연수 | 500+ | ❌ 미매칭 → living **(연예)** |
| 4 | 용종 | 2000+ | ❌ 미매칭 → living |
| 5 | 유재석 | 5000+ | ❌ 미매칭 → living **(연예)** |
| 6 | 엄태웅 | 200+ | ❌ 미매칭 → living **(연예)** |
| 7 | 자폭 | 100+ | ❌ 미매칭 → living |
| 8 | 션 | 500+ | ❌ 미매칭 → living **(1글자)** |
| 9 | 창신메모리테크놀로지 | 1000+ | ❌ 미매칭 → living |
| 10 | 포스코노동조합 | 100+ | ❌ 미매칭 → living |

**10건 중 9건이 어휘 규칙에 걸리지 않았다.** 급상승 검색어의 상당수가 인명·고유명사이기 때문이다.
§6-2에 "topic이 없어 category를 어휘 분류에 전적으로 의존한다"고 리스크로 적어둔 그대로였고,
결과적으로 유재석·오연수·엄태웅이 **"생활정보"로 분류돼 편집자 톤 원고로 갈 상황**이었다.

#### 해결 1: 뉴스 출처를 category 신호로 쓴다 (`config/newsOutletRules.ts` 신규)

피드는 topic 대신 **그 검색어가 왜 떴는지 설명하는 뉴스 항목**을 준다. 그리고 한국 언론 지형에서
**스포츠지·연예매체에 실렸다는 사실 자체가 연예 뉴스라는 강한 신호**다 — 인명 사전 없이 얻을 수
있는 정보 중 가장 신뢰도가 높다.

```
오연수 -> 스포츠조선 -> entertainment ✅
유재석 -> 스포츠동아 -> entertainment ✅
엄태웅 -> 스포츠동아 -> entertainment ✅
나머지 7건 -> 매칭 없음, 건드리지 않음   (오탐 0건)
```

판정 순서는 **키워드 어휘 → 뉴스 출처 → living 폴백**이다. 어휘가 먼저인 것이 중요하다 —
그래야 "아기 수족구"가 스포츠지에 실려도 parenting을 유지한다. 테스트가 이 순서를 고정한다.

종합지(조선일보·연합뉴스 등)는 목록에 넣지 않았다. 연예부터 정치까지 다 쓰므로 신호가 되지 못한다.
실제로 "션"이 조선일보 연예 기사로 떴지만, 조선일보를 넣으면 정치·경제 기사까지 연예가 된다.

뉴스 **제목** 어휘로도 분류해봤지만 효과가 없었다(태풍 1건만 잡았고 그건 이미 키워드에서 잡힌다).
오탐 위험만 늘어 채택하지 않았다.

#### 해결 2: 1글자 키워드를 버린다 (`MIN_TREND_KEYWORD_LENGTH`)

"션"(가수 션)이 들어왔다. 이건 단순히 검색 품질 문제가 아니라 **관련성 필터를 통째로 무력화한다**:

```
tokenize()가 CLUSTERING_CONFIG.minTokenLength(2) 미만 토큰을 버림
  -> 1글자 seed는 토큰이 0개
  -> computeSeedRelevance가 neutralRelevanceWhenSeedTooShort(0.7) 반환
  -> minRelevanceThreshold(0.25)를 넘어 그 seed의 후보가 전부 통과
```

즉 1글자 키워드 하나가 relevance 게이트를 열어 무관한 후보 수십 건을 clustering까지 밀어 넣는다.
`seed_queries`는 사람이 큐레이션하므로 이런 값이 없지만 동적 소스는 무엇이든 준다.
제외하되 **rank는 원본 피드 순위를 유지한다** — 당겨 매기면 "구글에서 몇 위였나"가 왜곡되고
candidate_score도 실제보다 높아진다.

#### 활성화 (2026-08-29 사용자 승인)

**`.env`가 아니라 코드 기본값을 바꿨다.** `TREND_SOURCE_CONFIGS.google_trends.enabled`의 기본값을
false → **true**로 두고, 끄고 싶을 때만 `GOOGLE_TRENDS_ENABLED=false`를 명시하게 했다.

`.env`를 고치는 방식보다 나은 이유:
- `.env`는 git에 없다. 맥에만 있는 값이라 클라우드 이전(`CLOUD_MIGRATION.md`)이나 재설치 때
  이 설정이 조용히 사라진다. 코드 기본값은 저장소를 따라다닌다.
- 사용자가 `git pull` 외에 할 일이 없다.

기본값 기준을 소스마다 다르게 잡은 근거도 config에 적어뒀다: **"사람의 사전 준비 없이 혼자 도는가."**
구글 트렌드는 인증도 브라우저도 로그인 프로필도 필요 없고 실측 검증까지 끝났다 → 기본 true.
Creator Advisor는 사람이 최초 1회 수동 로그인한 profile에 의존한다 → 기본 false(준비 안 된 환경에서
켜지면 매일 실패한다). 다음 실시간/커뮤니티는 수집기 자체가 없다 → 기본 false.

#### 켜면서 함께 고친 것 (테스트가 잡아낸 결함 2건)

기본값을 켜자 기존 테스트가 실제 Supabase를 조회하려 시도했고, 그 과정에서 두 가지가 드러났다.

1. **`[object Object]` 재발.** `buildDailyQueryPool`의 catch가 `String(error)`를 쓰고 있었다.
   여기로 오는 오류는 대부분 Supabase PostgrestError(Error 인스턴스가 아닌 평범한 객체)라
   실패 원인이 통째로 사라진다 — 이 프로젝트가 2026-08-26에 이미 한 번 겪고 고쳤던 결함인데
   신규 코드 경로에서 되살아났다. 두 곳에 중복돼 있던 `describeError`를
   `services/describeError.ts`로 뽑아 세 곳이 공유하게 했다.
2. **`enabledSources`가 `creatorAdvisorEnabled: false`를 덮었다.** "disabled면 조회조차 하지
   않는다"는 기존 계약이 나중에 추가된 옵션 때문에 조용히 깨져 있었다. `creatorAdvisorEnabled`가
   항상 우선하도록 판정 순서를 명시했다.

두 결함 모두 신규 회귀 테스트(`testMultiSourceIsolatesFailures`)가 고정한다.

#### 아직 판단하지 않은 것: 블로그와 무관한 키워드 (§9)

게임스컴·자폭·창신메모리테크놀로지·포스코노동조합 4건은 이 블로그 카테고리(육아/엔터/OTT/생활/
커뮤니티)와 거리가 멀다. quota 10칸 중 4칸을 먹는다.

**지금은 필터하지 않았다.** 이유는 두 가지다. (1) 이미 6-factor scoring + diversity가 뒤에서
거르므로 Top 10까지 올라올 가능성이 낮고, (2) "무관하다"를 규칙으로 정하면 오히려 좋은 키워드를
놓친다 — "포스코 파업"은 사회 이슈로 `community` 소재가 될 수도 있다. 며칠 관찰 후 판단한다.

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

## 7-2. 2026-08-30 세션에서 실제로 구현한 것 (`claude/community-collector`)

§8의 6번(커뮤니티 수집 + LLM 엔티티 추출)을 시작했다. **사이트별 스크래핑(더쿠/네이트판/다음·
네이버 카페)은 여전히 DOM 실측이 필요해 이 원격 세션에서 할 수 없었다** - 이번엔 egress 자체를
실측해서 확인했다: 이 세션의 agent proxy는 `theqoo.net` 등 목표 사이트를 `EGRESS_BLOCKED`로
전부 거부한다(WebFetch/curl 둘 다 확인). 그래서 이번 세션은 **사이트 provider를 뺀 나머지 전부**를
구현했다 - provider는 인터페이스만 있으면 나중에 이 파이프라인을 전혀 건드리지 않고 추가된다.

구현한 것:

1. `src/services/community/CommunitySource.ts` - `CommunitySourceProvider` 인터페이스
   (`{ site, label, fetchPosts() }`). `COMMUNITY_SOURCE_PROVIDERS`는 **아직 빈 배열**이다(실제
   사이트 없음).
2. `src/workflows/community/extractCommunityKeywords.ts` - §5-1의 "하루 1회 LLM 1콜" 구현.
   `runHeadlessClaude`를 재사용해 사이트 무관 제목 목록을 한 번에 넘기고, `번호|키워드|category`
   형식으로 돌려받는다. 파싱은 `generateTitleSuggestions.ts`의 방어적 정리(따옴표/번호 제거,
   형식 어긴 줄 무시)를 따른다. **posts가 0건이면 LLM을 호출하지 않는다** - 지금은 provider가
   없어 매 실행이 이 경로를 탄다.
3. `src/workflows/community/mapCommunityCandidates.ts` - 추출 결과 -> `TrendCandidateInsert`.
   category는 **LLM 결과 -> `classifyKeywordCategory` 어휘 규칙 -> `community` 자체 폴백** 순으로
   정한다. 구글 트렌드의 폴백(`living`)과 다르게 잡은 이유: 이 소스 자체가 "인터넷 화제"라는 정의라,
   끝까지 못 잡은 항목은 생활정보보다 화제/밈에 더 가깝다고 판단했다. candidate_score는 검색량
   신호가 없어 site 내 순위(siteRank)만으로 계산하고, 구글 트렌드(만점 50)보다 만점을 낮게
   잡았다(30) - 신호가 약한 소스라는 걸 스케일에도 반영. 배치 내 conflict key(21000) 중복 제거는
   기존 두 소스와 동일하게 적용.
4. `src/workflows/community/runCommunityCollection.ts` - `runGoogleTrendsCollection.ts`와 같은
   "절대 throw하지 않는다" 계약. **사이트별 실패를 격리한다**(`buildDailyQueryPool`의 소스별
   try/catch와 같은 원칙) - 사이트 하나가 막혀도 나머지로 진행. provider가 0개면 LLM 호출 없이
   `status: "success", fetchedCount: 0`을 반환한다(현재 실제 상태).
5. `src/workflows/community/runCollectionCli.ts` - `WRITE=1` 게이트를 포함한 동일한 dry-run
   기본 CLI. 지금 실행하면 "등록된 사이트: 0개"만 나온다(배선 확인용).
6. `scripts/communityRecon.ts` - **다음 단계를 위한 실측 도구.** `npm run recon:community`로
   맥에서 실행하면 대상 4개 사이트의 `robots.txt`를 먼저 확인하고(금지된 경로는 건너뜀), 통과한
   페이지의 원본 HTML을 `docs/ai-handoff/community-recon/`(git에 커밋 안 함, `.gitignore` 추가)에
   저장한다. 이 원격 세션에서 자체 테스트했을 때 4개 사이트 전부 이 환경의 egress 프록시가
   `Host not in allowlist`로 막았다(실제 사이트 응답이 아님을 확인 후 결과 파일은 삭제했다) -
   즉 이 스크립트가 실제 사이트 데이터를 주는지는 맥에서만 확인 가능하다.
7. `isUsableTrendKeyword`(1글자 키워드 제외)를 `mapGoogleTrendsCandidates.ts`에서
   `config/trendSources.ts`로 옮겼다 - 구글 트렌드 전용이 아니라 사람이 큐레이션하지 않는 모든
   동적 소스가 공유하는 게이트이기 때문이다(작은 리팩터, 동작 변경 없음, 기존 `test:google-trends`
   회귀 통과 확인).

## 7-3. 2026-08-30 세션 후속: 실측 결과 반영 + 더쿠 provider 구현

사용자가 맥에서 `npm run recon:community` + `npm run communityProbe` 결과를 공유해줬다. 실제
결과는 예상과 달랐다:

- **네이트판/다음카페/네이버카페**: robots.txt가 **정확히 우리가 쓰려던 목록 경로를 disallow**
  했다(`/talk/ranking/d`, `/_c21_/home`, `/ca-fe/home/ranking`). §5-3 원칙("robots.txt가 금지하면
  그 소스는 제외한다")에 따라 이 경로로는 붙이지 않기로 했다 - 3곳 모두 결정 C에서 빠졌다.
  다른 접근 경로(공식 API 등)를 찾으면 재검토 대상이지만 지금은 없다.
- **더쿠(theqoo.net/hot)**: robots.txt에 disallow가 없어 실제 목록 페이지(22,804자)를 정상
  받았다. `communityProbe.ts`로 구조를 두 단계로 확인했다:
  1. 후보 그룹 탐색 -> `td.title > a`가 유력(46개 anchor, 그중 제목 8~60자 후보 22개)
  2. 상세 확인(상위 tr/li class 포함) -> **운영 공지(로그인 보안 안내 등) 6건이 진짜 인기글과
     같은 태그 구조로 섞여 있었다.** 구분 신호를 찾아보니 공지 row만 `tr.notice`(+ `nofn`/
     `nofnhide` 등 부가 class)를 갖고, **진짜 인기글 row는 class 속성 자체가 없었다** - 이게
     유일하고 신뢰할 수 있는 구분 신호였다. 또한 `td.title` 안에 anchor가 2개(제목 + 추천수
     숫자)씩 있어, 숫자만 있는 텍스트는 제목 후보에서 걸러야 했다.

이 구조를 그대로 구현했다:

- `src/services/community/theqoo/parseTheqooHtml.ts` - 순수 파서. `tr.notice`는 제외, class 없는
  `tr`만 인기글로 집계, `td.title > a` 중 숫자만 있는 anchor(추천수)는 제목으로 뽑지 않는다.
  `parseTrendHtml.ts`(Creator Advisor)와 같은 "row 하나 실패는 그 row만 skip, 전체는 안 죽는다"
  원칙.
- `src/services/community/theqoo/TheqooProvider.ts` - fetch 래퍼(`CommunitySourceProvider` 구현).
  User-Agent 위장 안 함(§5-3), robots.txt는 이미 실측 확인했으므로 매 호출 재조회하지 않는다.
- `src/services/community/theqoo/fixtures/theqooHot.sample.html` + `testParseTheqooHtml.ts`
  (`npm run test:theqoo-parser`) - fixture는 실제 실측 구조(공지 class/무-class 구분, 제목+추천수
  두 anchor)를 그대로 본떴지만, **제목 텍스트는 저작권이 있는 실제 게시글 원문이 아니라 임의로
  지어낸 placeholder다**(`docs/ai-handoff/community-recon/`를 git에 안 올리는 것과 같은 이유).
- `COMMUNITY_SOURCE_PROVIDERS`에 `theqooProvider`를 등록했다. `npm run collect:community`
  (dry-run)을 이 원격 세션에서 실행하면 "등록된 사이트: 1개(더쿠 핫게시판)"까지는 나오고, 실제
  fetch는 이 세션의 egress 차단으로 403을 받아 `sourceErrors`로 격리된다(설계대로 동작 - 전체
  status는 여전히 success). **맥에서 실제 fetch 성공까지는 아직 확인 못 했다.**

**남은 것**:
- ~~네이트판/다음카페/네이버카페 대체 접근 경로 탐색~~ - **드롭(2026-08-30 사용자 결정).** 더쿠
  단독 provider로 유지.

## 7-4. 2026-08-30 세션 후속: 맥 실측 + 배선 + 활성화 (사용자 승인)

- **맥 dry-run 실측 완료** - `npm run collect:community`(dry-run)로 더쿠에서 인기글 20건 fetch
  성공. `runHeadlessClaude`가 실제 `claude` CLI로 엔티티 추출까지 도는 것 확인. "provider 최소
  1개 실동작" 조건 충족.
- **`dailyKeywordWorkflow.ts` 배선** - 구글 트렌드 옆에 `runCommunityCollection(options.communityOptions)`
  추가. `trendCollect` 단계 집계(`trendResults`)에 `community` 포함. `dailyKeywordJob.ts`에
  커뮤니티/구글 트렌드 비치명적 실패 + 커뮤니티 `sourceErrors` 사이트별 로그 추가.
- **활성화 (2026-08-30 사용자 승인, 방법 A)** - `TREND_SOURCE_CONFIGS.community.enabled` 코드
  기본값을 `true`로. 구글 트렌드 전례와 동일 - `.env` 수정 불필요, git pull만으로 다음 09:00
  run부터 적용. 끄려면 `.env`에 `COMMUNITY_TRENDS_ENABLED=false`.
- **테스트 결함 수정** - `testCommunityCollection.ts`의 "never throws" 블록이 `dryRun:false` +
  실 Supabase 부재에 의존해 실패를 유도하고 있었다. `.env`가 있는 맥에서 이 테스트가 실제로
  prod `trend_candidates`에 테스트 row(`이서준 열애설`, `metadata.site: "site_ok"`) 1건을
  write했다. → 주입 함수 throw + `dryRun:true`로 교체(`testGoogleTrends.ts`와 같은 원칙).
  오염된 row 1건은 사용자 승인 후 삭제 완료(`source=community` 현재 0건).
- **검증** - `npm run build` + `test:community`/`test:theqoo-parser`/`test:google-trends`/
  `test:topic-grouping`/`test:keyword-category`/`test:daily-query-pool` 회귀 통과.

**다음**: 다음 09:00 run 로그에서 `[trendCollect]` 커뮤니티 라인 확인 + Top 10에 커뮤니티
키워드 유입/품질 며칠 관찰.

---

## 8. 실행 순서

```
0. ✅ Top N 주제 중복 제거 + 회귀 테스트
1. ✅ buildDailyQueryPool 다중 source 지원 (§4-2)
2. ✅ 구글 트렌드 RSS provider (§6-2) — 맥 실측 완료, 분류 보강까지 반영
3. ✅ community category (결정 B)
--- 여기까지 첫 브랜치(claude/keyword-collection-optimization-6ojcou) ---
4. ✅ 구글 트렌드 켜기 (2026-08-29 사용자 승인)
   코드 기본값을 true로 바꿨다 - .env 수정이 필요 없다. git pull만 하면 다음 09:00 run부터
   trendCollect 단계가 수집·upsert한다. 끄려면 .env에 GOOGLE_TRENDS_ENABLED=false.
   ⬜ 다음 아침 run에서 Top 10 변화 관찰
5. ⬜ 다음 실시간 트렌드 provider (§6-1)        <- daum.net DOM 실측부터
6. ✅ 커뮤니티 수집 + LLM 엔티티 추출 (§5, §7-2/§7-3/§7-4)
   파이프라인 + 더쿠(theqoo) provider. 맥 dry-run 20건 fetch 실측 완료. dailyKeywordWorkflow
   배선 + community.enabled 코드 기본값 true (2026-08-30 사용자 승인). 네이트판/다음카페/
   네이버카페는 robots.txt가 막아 제외(§7-3). ⬜ 다음 아침 run에서 Top 10 유입 관찰.
--- 여기까지 둘째 브랜치(claude/community-collector) ---
7. ⬜ (관찰 후 판단) clustering 근본 수정 (§7-A)
8. ⬜ (관찰 후 판단) 블로그 무관 키워드 필터 (§7-1)
```

5(다음 실시간)는 여전히 외부 페이지 DOM 구조 실측이 선행돼야 해서 원격 세션에서 진행할 수 없다 -
`npm run recon:community`를 맥에서 먼저 돌려야 한다(§7-2, 대상 URL은 CommunitySource.ts에 더쿠
외에도 추가해야 함). 실측 뒤 파서 작성은 범위가 명확해지므로 `delegate-codex` 위임 후보가 된다
(Creator Advisor Swiper 순회 때와 같은 방식) - 더쿠 provider(§7-3)가 그 패턴의 실제 예시다.

### 관찰 항목 (며칠 Top 10을 보고 판단)

1. 같은 주제 도배가 실제로 사라졌는가 (§2)
2. 병합 실패로 순위가 밀리는 이슈가 있는가 (§7-A) — preDiversityRankings와 rankings 비교
3. 구글 트렌드 유래 키워드가 Top 10에 들어오는가, 들어온다면 쓸 만한가
4. 블로그와 무관한 키워드(반도체·노동·무기)가 quota만 먹고 끝나는가 (§7-1)

### 새 환경변수 (전부 기본 false / 미설정 시 기존 동작)

```
# GOOGLE_TRENDS_ENABLED                        # 코드 기본값 true. 끌 때만 false로 명시.
GOOGLE_TRENDS_MAX_DAILY_CANDIDATES=10
GOOGLE_TRENDS_CANDIDATE_TTL_HOURS=12
DAUM_REALTIME_ENABLED=false                    # 5단계 구현 후
COMMUNITY_TRENDS_ENABLED=false                 # 6단계 구현 후
```
