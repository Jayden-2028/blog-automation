# Korea Plain 한국 음식 소개 전환 (2026-11-25)

## 결정

- **배경**: 2026-11-22 애드센스가 www.koreaplain.com(사용설명서 트랙, 내부 이름 kscene/koreaplain)을 "가치 없는 콘텐츠"로 반려했다.
  "외국인용 한국 생활 가이드" 전반은 주제가 너무 넓고, 외국인 저자 블로그·대형 매체가 이미 포화시킨 영역이다.
- **사용자 결정(2026-11-25)**: 앞으로 새 주제는 **한국 음식 소개**로 좁힌다.
  - 포함: 한국 음식(요리·메뉴 단위), **지역 향토 음식**(전주 비빔밥, 춘천 닭갈비, 안동 찜닭, 부산 돼지국밥·밀면, 통영 충무김밥, 강릉 초당순두부,
    제주 고기국수·흑돼지, 의정부 부대찌개, 수원 왕갈비, 나주 곰탕, 광주 떡갈비, 속초 아바이순대, 마산 아귀찜, 평양·함흥냉면, 천안 호두과자,
    경주 황남빵, 대구 막창 등), 길거리 음식·디저트, 대표 국·찌개·면·밥 요리.
  - 제외: **혐오 식품**, **식재료·양념·재료 소개**, **레시피 의도**, 해외 식당 질의(기존 `isOverseasLocalTopic` 유지).
  - 글의 각도: 레시피가 아니라 "한국인 로컬 필자가 알려주는 그 음식" - 무엇인지, 지역·유래, 한국인이 언제·어떻게·무엇과 먹는지, 어디서 먹는지,
    대략 가격, 주문할 때 쓰는 한국어(한글+로마자), 지역별 변형, 외국인이 자주 오해하는 점.
- 이미 발행된 글·라벨·URL은 건드리지 않는다. 기존 라벨 5개 이름도 그대로다(라벨 URL이 묶여 있다).

## 무엇이 바뀌었나

| 영역 | 파일 | 내용 |
|---|---|---|
| 시드 | `src/config/koreaplainSeeds.ts` | 이전 241개 → `KOREAPLAIN_LEGACY_SEEDS`(비활성 보관). 새 `KOREAPLAIN_FOOD_SEEDS` 171개. 수집 시드 `KOREAPLAIN_SEEDS`는 모드가 정한다 |
| 어휘표 | `src/config/koreaplainFoodTerms.ts`(신설) | 음식 이름·일반어, 지역명, 혐오 식품·식재료·레시피·서비스·잡음 목록, 초포화 음식, 음식 각도, 하위 라벨 분류 |
| 선정 규칙 | `src/workflows/koreaplain/koreaplainTopics.ts` | `mode`(food/legacy) 분기 - 아래 「선정 규칙」 |
| 수집 실행 | `runKoreaplainTopicCollection.ts` | 음식 모드는 음식 시드만, 구글 트렌드 급상승어 보강 끔, 알림 헤더 "· 한국 음식" |
| 발행 라벨 | `publishArticleToBlogspot.ts`, `tkmPostStructure.ts` | 음식 글은 라벨 두 개(상위+하위). All Guides는 상위 라벨로 묶는다 |
| 집필 | `prompts/writing/style/koreaplain.md` 「음식 소개 글」 | 구조·레시피 금지·근거 규칙. 생활정보 규칙과 충돌하면 이 절이 우선 |
| 번역 | `prompts/translation/koreaplain-ko-en.md` | 메뉴·주문 한국어는 한글 먼저, 레시피 단계·Recipe 소제목 금지 |
| 조사 | `prompts/research/researcher.md` §4-2a, `buildResearchPrompt.ts` | 음식 체크리스트 8행, 공식·공공·백과 4건, 레시피 미수집 |
| 워크플로 | `.github/workflows/kscene-topic.yml` | 저장소 변수 `KSCENE_TOPIC_MODE`를 넘긴다(미설정 = food) |
| 테스트 | `testKoreaplainFoodTopics.ts`(신설), `testKoreaplainTopics.ts`(legacy 고정), `testPublishArticleToBlogspot.ts`, `testBuildResearchPrompt.ts` | |

## 라벨

- 음식 글: 상위 라벨 `Food & Dining`(기존 5개 중 하나) + 하위 라벨 하나: **`Korean Dishes` / `Regional Food` / `Street Food & Desserts`**.
- 라벨은 글을 낳은 시드가 정한다(`koreaplainLabelsFor`). 이전 시드 글은 라벨 하나 그대로다 - 음식 시드는 이전 시드와 문구가 겹치지 않게 했다(테스트 단언).
- 시드 없는 봇 직접 입력 job(`metadata.source=keyword_input`)은 음식 모드에서 keyword가 **영문** 음식 주제면 `Food & Dining` + 문구로 정한 하위 라벨,
  아니면 기존 기본 라벨(`Living in Korea`). 한글 keyword는 분류하지 못한다(남은 위험).
- All Guides 페이지는 글의 **상위 라벨**(5개 중 첫 것)로 묶는다 - Blogger가 라벨을 어떤 순서로 돌려줘도 하위 라벨로 새 묶음이 생기지 않는다.

## 시드 (171개)

| 하위 라벨 | 수 | 예 |
|---|---|---|
| Korean Dishes | 75 | kimchi jjigae, seolleongtang, what is naengmyeon, bulgogi vs galbi, korean hangover soup, types of kimchi |
| Regional Food | 57 | jeonju bibimbap, chuncheon dakgalbi, busan milmyeon, chungmu gimbap, pyongyang naengmyeon, hodu gwaja, jeju food |
| Street Food & Desserts | 39 | what is tteokbokki, hotteok, bungeoppang, gwangjang market food, patbingsu, yakgwa, sikhye |

**걸러 낸 방법(2026-11-25 실측)**: 후보 203개를 구글 영문 자동완성(공개 GET, `autocompleteQueriesForSeed`가 만드는 질의 그대로 = 시드 + 알파벳 변형,
406회 호출)에 넣고, 새 음식 규칙을 통과한 후보 수를 셌다.

- **빈 시드(통과 후보 2건 미만) 12개 버림**: dak bokkeumtang, galbijjim, damyang tteokgalbi, tongyeong food, jeonju choco pie, namwon chueotang,
  gun goguma, gukhwappang, pojangmacha, yeot gangjeong, tteok, hodugwaja.
- **품질로 20개 버림**(후보는 나오지만 글이 안 되는 것): bulgogi·kimchi·tteokbokki 일반형(초포화, 대신 what is … 형 유지), korean rice dishes(쌀 재료 질의),
  gyeongju bread(hwangnam bread와 같음), korean local food(regional food와 겹침), incheon food(공항 푸드코트), tanghulu korea(중국 간식 유행),
  korean bakery(프랜차이즈), korean donut·waffle·ice cream·popsicle·candy·cookies·cake·pastry·bread(포장 제품·재료 질의), korean market food(해외 한인마트),
  bingsu(슬라임 구슬 질의, 대신 patbingsu 유지).
- 회전: 하루 20개를 하위 라벨 3개에 번갈아 뽑는다 → 대표 요리 75개 기준 약 11일에 한 바퀴.

## 선정 규칙 (음식 모드)

이 트랙의 선정은 LLM이 아니라 `koreaplainTopics.ts` 규칙이 전부다. 음식 모드에서 바뀐 것:

1. **음식 게이트**: 음식 이름(로마자·영어)이나 음식 일반어(food·dish·eat·menu…)가 없으면 버린다.
2. **제외**(어휘는 `koreaplainFoodTerms.ts` 한 곳):
   - 혐오 식품 `AVERSIVE_FOOD_TERMS` - 개고기·보신탕, 번데기·곤충, 산낙지, 개불, 삭힌 홍어, 뱀·자라, "weird/bizarre/disgusting" 각도. **초안 - 사용자 확정 필요.**
   - 식재료·양념: 제품·양념 명사(sauce·paste·oil·marinade·instant noodles·kit·pan·mold…)는 늘 제외, 재료 이름(gochujang·perilla·sesame·korean pear…)은
     **음식 이름이 같이 없을 때만** 제외("doenjang jjigae"는 통과).
   - 레시피 의도: recipe·how to make·ingredients·at home·easy·maangchi·batter·filling·ideas…
   - 서비스(delivery·catering·franchise), 잡음(pronunciation·crossword·reviews·photos·외국어 뜻·해외 지명 flushing·chennai 등).
3. **시드 고유어 요구**: food·bread 같은 범용어 하나로 이어진 엉뚱한 제안("sokcho food" → "what happens if a mosquito lands on your food")을 막는다.
4. **모양**: 음식 이름이 든 2단어("busan milmyeon")도 받는다.
5. **점수**(기본 5 + 수요 35 + 교차 15 + 구체성 15 + 의도 15 + 로컬 우위 15 + 음식 각도 15, 100에서 자름):
   - 로컬 우위 +15 = **지역 향토 음식**(지역명·지역 고유 음식명) 또는 한국인의 먹는 때(hangover·with soju·boknal…).
   - **운영 정보 축(+15) 대신 음식 각도 축(+15)**: what is·how to eat·eat with·where to eat·price·vs·difference·spicy·origin·history….
   - **초포화 음식 -10**: kimchi·bibimbap·bulgogi·korean bbq·tteokbokki 등 **일반형만**. 지역 변형이나 다른 요리 이름이 있으면 감점하지 않는다.
   - 관광 포화(-10)는 음식 모드에서 쓰지 않는다(jeju·busan이 향토 음식에서 감점되면 안 된다). 의미 포화(-10)는 그대로.
6. **선정**: 실용 하한(practicalFloor) **끔**, 로컬 우위(향토) 하한 = topN/3(5건이면 2건), 라벨 상한은 **하위 라벨** 기준(5건이면 2) → 대개 2·2·1.
7. 그대로인 것: 하루 5건, 중복 판정(자카드 0.6 + 포함 관계), 기발행·기제안 대조, 해외 지명 제외, 레딧 보조(기본 꺼짐).

## 집필·조사 규격

- 집필: `style/koreaplain.md` 「음식 소개 글」 - 구조 9칸(무엇인지 → 지역·유래 → 언제·어떻게·무엇과 → 어디서 → 가격 → 주문 한국어 → 지역 변형 →
  외국인 오해 → 마무리 한마디), **레시피 금지**(조리법은 한두 문장 개요까지), 가격·가게는 공식 근거가 있을 때만, 지어낸 경험담 금지(기존 규칙 유지).
- 조사: `researcher.md` §4-2a - 음식 체크리스트 8행, 공식·공공·백과 4건(한식진흥원·한국관광공사·지자체·한국민족문화대백과·한국민속대백과·가게 공식),
  레시피 미수집, 현지 관행 한글 질의 예.

## 되돌리기

- 저장소 변수 `KSCENE_TOPIC_MODE=legacy` 하나로 이전 시드·규칙이 돌아온다(코드 수정 없음). 이전 규칙은 `testKoreaplainTopics.ts`가 legacy 모드로 계속 검증한다.
- 집필·조사 규격 절은 음식 keyword일 때만 적용되도록 쓰여 있어 legacy로 돌아가도 생활정보 글은 기존 규칙을 따른다.

## 남은 위험·결정 필요

- **혐오 식품 목록 확정**(사용자): 현재 초안. 경계 사례 - 곱창·막창·순대(내장)·육회·산낙지 아닌 낙지볶음·홍어 아닌 홍어무침 등은 **포함(소개 대상)**으로 두었다.
- 이미지: 음식 사진은 AI 생성이 기본이다. 한식진흥원(hansik.or.kr)은 이미지 화이트리스트(`koreaplainImageSources.ts`)에 없어 그 사진은 쓰이지 않는다 - 추가 여부는 사용자 판단.
  AI가 지역 음식의 모양(평양냉면 등)을 틀리게 그릴 위험이 있다.
- 기발행·기제안과의 중복 대조는 운영 DB를 읽어야 해서 오프라인 시뮬레이션에서는 하지 않았다 - 첫 운영 알림에서 이전 음식 글(korean bbq 등)과 겹치는지 본다.
- 봇 직접 입력의 한글 keyword는 하위 라벨 분류를 못 한다(기본 라벨 `Living in Korea`로 나간다).
- `CLAUDE.md` 「키워드 수집·알림 스케줄」의 사용설명서 문단(시드 241개·실용 하한)은 이 문서 이전 기준이다.
