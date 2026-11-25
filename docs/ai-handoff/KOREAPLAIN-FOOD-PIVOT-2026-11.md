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

## 이미지 (2026-11-25 추가 - 실제 사진 우선)

음식 글은 사진이 곧 정보다. AI가 지역 음식 모양을 틀리게 그리는 위험(평양냉면 등) 때문에 **실제 사진을 먼저** 쓰고, AI는 설명 그림으로만 쓴다.
사용자 결정: **한식진흥원 사진은 쓰지 않는다.** 일반 웹 검색 사진(언론·블로그·상업)은 기존 화이트리스트(`koreaplainImageSources.ts`) 정책 그대로 금지.

### 수집 순서 (koreaplain만)

> **2026-11-25 개정(같은 날, 사용자 지시)**: 첫 음식 원고(ea83b215, 함흥·평양냉면)에서 5자리 중 2자리가 플랫 일러스트로 나왔다 -
> 기획이 "먹는 방법" 자리를 처음부터 `ai`로 정해 웹 검색을 타지 않았다. 지시: **AI 이미지는 실사로, 빈 자리는 웹 검색으로(엔터와 같은
> 프로세스)**. 그래서 ② 웹 검색은 엔터와 같은 후보 풀에서 **언론사만** 빼고(`isUsableKoreaplainCandidate`), 기획 기본값은 `search`,
> ④ AI는 실사 스타일(`KOREAPLAIN_AI_PHOTO_STYLE`)·캡션 `Image: AI-generated`다. 되돌리기: repo variable
> `KOREAPLAIN_IMAGE_SOURCES=whitelist`(②가 아래 옛 화이트리스트로, 기획이 "기본은 ai"로 돌아간다. AI 실사 스타일은 그대로).

| 순서 | 출처 | 파일 | 비고 |
|---|---|---|---|
| ① | 한국관광공사 관광사진 API(data.go.kr 15101914, 공공누리 제1유형) | `collectKtoPhotos.ts`, `services/images/ktoPhotoGallery.ts` | 한글 키워드 검색. 키 `KTO_SERVICE_KEY` 없으면 조용히 건너뜀 |
| ② | 웹 검색(네이버 + 구글, **언론사만 제외** - 11-25 개정. `whitelist`면 정부·지자체·공공기관·visitkorea·위키미디어만) | `collectWebImages.ts` | ①이 못 채운 자리만 |
| ③ | 공식 페이지 캡처 | `capturePagesForJob.ts` | 정보 화면 자리(요금표·운영시간) |
| ④ | AI 생성 = **실사 사진**(11-25 개정, 전에는 설명 그림) | `generateManuscriptImages.ts` | 고정 스타일 `KOREAPLAIN_AI_PHOTO_STYLE`(자연광·따뜻한 중성 톤 다큐 사진) 한 줄이 앞에 붙고 일러스트 지시어는 지워진다. 캡션 `Image: AI-generated` |

### 한글 음식명 (관광사진 검색어)

`koreanFoodNames.ts` `buildKoreaplainKtoHints` - 자리마다 아래 순서로 정한다. 자리당 키워드 최대 2개(구체 이름 → 일반 이름, 예: 나주곰탕 → 곰탕).
1. 이미지 기획(imagePlan)의 그 자리 검색어 - 기획 프롬프트에 "음식 자리는 `search`, `queries[0]`에 한글 음식명만"을 넣었다(`planImageSlots.ts`).
2. 한글 초안(기준 원고)의 같은 번호 마커(설명 + IMAGE PROMPT).
3. 기획 검색어가 사전에 없는 음식이면 그 검색어 그대로(띄어쓰기 없는 한 단어일 때만).
4. 원고 단위: 한글 초안 제목 → job 키워드(로마자)를 사전으로 옮긴 것.
- 사전: `src/config/koreaplainDishHangul.ts`(음식 141개 로마자→한글, 지역 55개). **목록은 여기서 고친다.**
- 지역은 검색어에 넣지 않고 촬영지(`galPhotographyLocation`)·제목 가점으로만 쓴다.

### 선택 기준 (`scoreKtoPhoto`)

- **음식명 일치 필수**: 제목 일치 +60(둘째 키워드 +45), 검색키워드만 일치 +30(+20), 제목이 거의 음식명뿐이면 +10. 일치가 없으면 후보 아님.
- 지역 일치 +15, 최근 촬영 최대 +8.
- 감점: 사람 위주(관광객·체험·축제 등) −35, 글자 위주(간판·메뉴판·안내) −25, 장소 위주(전경·외관·야경) −15.
- 한 원고 안 중복 회피: 앞 자리의 1순위 사진은 뒤 자리 후보에서 빠지고, 중복 검사기(바이트·지문)가 한 번 더 막는다.
- 자리당 상위 3장을 내려받아 긴 변 600px 미만은 버리고, 비전 판정(기존 `chooseImage`)이 하나를 고른다. 판정이 비우면 ② 웹 검색으로 넘어간다.
- 호출 상한: **원고당 8호출**, 같은 키워드는 원고 안에서 한 번만(음식 글은 자리 대부분이 같은 음식). 개발계정 하루 1,000건.

### 출처 표기

- 캡션 = 사진 소개 한 문장 + `Photo: Korea Tourism Organization (Kim Jiho), KOGL Type 1`(공공누리 제1유형 출처 표시).
- 촬영자는 기관 접두("한국관광공사")를 떼고 2~4자 한글 이름이면 로마자로 옮긴다(성씨 관용 표기). 옮길 수 없으면 괄호를 뺀다(영문 본문에 한글을 새게 하지 않는다).
- manifest `license` = "공공누리 제1유형(KOGL Type 1) - 한국관광공사 관광사진 · galContentId …", `sourcePage` = 데이터셋 페이지(data.go.kr).

### 톤 보정 (실제 사진만)

`services/images/photoGrade.ts` `KOREAPLAIN_PHOTO_GRADE` - **강도는 이 상수 한 곳**(`strength` 하나로 함께 조절). 기존 WebP 변환(Chromium canvas, `optimizeImage`) 위에서 돈다.
- 16:9 중앙 크롭 → 최대 1600×900(작은 사진은 확대하지 않는다), WebP 화질 0.86.
- 밝기: 평균 휘도 → 0.50 쪽으로, 배율 0.88~1.12. 대비: 휘도 표준편차 → 0.22 쪽으로, 배율 0.95~1.12. 따뜻함: R +3.5%, B −3.5%.
- 대상: koreaplain의 관광사진 + 허용 출처 웹 사진(`collectWebImagesForJob` 업로드). AI 일러스트·페이지 캡처·다른 트랙은 건드리지 않는다.
- **변경 금지 라이선스(CC BY-ND, 공공누리 제3·4유형)는 보정 대신 수집에서 제외**한다(`isNoDerivativesLicense`).

### 배포 시 필요한 것

- GitHub secret `KTO_SERVICE_KEY`(공공데이터포털 인증키 - Encoding/Decoding 어느 쪽이든 된다). `job-publish-prepare.yml`에 env를 넣었다.
- 맥 로컬 CLI(`images:collect` 등)는 env만 있으면 같은 코드가 돈다 - 맥미니에서 돌리려면 맥미니 `.env`에도 키가 있어야 한다.

## 되돌리기

- 저장소 변수 `KSCENE_TOPIC_MODE=legacy` 하나로 이전 시드·규칙이 돌아온다(코드 수정 없음). 이전 규칙은 `testKoreaplainTopics.ts`가 legacy 모드로 계속 검증한다.
- 집필·조사 규격 절은 음식 keyword일 때만 적용되도록 쓰여 있어 legacy로 돌아가도 생활정보 글은 기존 규칙을 따른다.

## 남은 위험·결정 필요

- **혐오 식품 목록 확정**(사용자): 현재 초안. 경계 사례 - 곱창·막창·순대(내장)·육회·산낙지 아닌 낙지볶음·홍어 아닌 홍어무침 등은 **포함(소개 대상)**으로 두었다.
- 이미지: 위 「이미지」 절로 실제 사진 우선이 됐다(관광사진 → 허용 웹 → 캡처 → AI 설명 그림). 한식진흥원 사진은 쓰지 않는다(사용자 결정).
  남은 위험: 관광사진에 없는 음식(사전·기획에 없는 이름)은 ② 이후로 넘어간다, 16:9 중앙 크롭이 세로 사진의 주제를 자를 수 있다,
  뷰어의 후보 클릭 교체(`applyImagePick`)는 톤 보정을 거치지 않는다.
- 기발행·기제안과의 중복 대조는 운영 DB를 읽어야 해서 오프라인 시뮬레이션에서는 하지 않았다 - 첫 운영 알림에서 이전 음식 글(korean bbq 등)과 겹치는지 본다.
- 봇 직접 입력의 한글 keyword는 하위 라벨 분류를 못 한다(기본 라벨 `Living in Korea`로 나간다).
- `CLAUDE.md` 「키워드 수집·알림 스케줄」의 사용설명서 문단(시드 241개·실용 하한)은 이 문서 이전 기준이다.
