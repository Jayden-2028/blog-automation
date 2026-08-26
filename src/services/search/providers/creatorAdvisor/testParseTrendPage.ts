// parseTrendPage() mock fixture 테스트.
// 실제 Creator Advisor 페이지를 호출하지 않고 fixture HTML 문자열만으로 동작한다(네트워크/브라우저 없음).
// SeedQueryRepository 테스트(testSeedQueryRepository.ts)와 동일하게, 별도 테스트 프레임워크 없이
// assert 헬퍼 + 콘솔 로그로 검증한다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDemographicTopicTitle, parseTrendPage, TrendPageSelectorError } from "./parseTrendHtml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function main() {
  console.log("▶ parseTrendPage 테스트 시작");

  const fixtureHtml = readFileSync(
    path.join(__dirname, "fixtures/trendPage.sample.html"),
    "utf-8"
  );
  const collectedAt = new Date().toISOString();
  const result = parseTrendPage(fixtureHtml, collectedAt);

  // 1. trendDate: "2026. 08. 24." -> "2026-08-24"로 normalize.
  assert(result.trendDate === "2026-08-24", `trendDate가 "2026-08-24"로 normalize되어야 합니다 (실제: ${result.trendDate})`);
  console.log(`✅ trendDate normalize 검증 완료: ${result.trendDate}`);

  // 2. 3번째 card(제목 없음)는 topicErrors로 격리되고, 나머지 2개 card는 정상 파싱되어야 한다.
  assert(result.topics.length === 2, `제목이 없는 card는 격리되고 나머지 2개 topic만 성공해야 합니다 (실제: ${result.topics.length})`);
  assert(Object.keys(result.topicErrors).length === 1, `깨진 card 1개가 topicErrors에 담겨야 합니다 (실제: ${JSON.stringify(result.topicErrors)})`);
  console.log("✅ 제목 없는 card 격리(나머지 card는 계속 파싱) 검증 완료:", result.topicErrors);

  // 3. 1번째 topic("스타·연예인"): flat/up/new/down 4가지 케이스 모두 검증.
  const starTopic = result.topics[0];
  assert(starTopic.topic === "스타·연예인", `1번째 topic 제목이 일치해야 합니다 (실제: ${starTopic.topic})`);
  assert(starTopic.candidates.length === 4, `1번째 topic은 keyword 4개여야 합니다 (실제: ${starTopic.candidates.length})`);

  const [flatItem, upItem, newItem, downItem] = starTopic.candidates;

  assert(flatItem.keyword === "우서윤", "1번째 keyword가 일치해야 합니다");
  assert(flatItem.rank === 1, "1번째 rank는 1이어야 합니다(card 내 순서 기반)");
  assert(flatItem.movementType === "flat", `class에 up/down/new가 없으면 flat이어야 합니다 (실제: ${flatItem.movementType})`);
  assert(flatItem.rankChange === 0, `flat은 rankChange=0이어야 합니다 (실제: ${flatItem.rankChange})`);
  assert(flatItem.previousRank === 1, `flat은 previousRank===rank여야 합니다 (실제: ${flatItem.previousRank})`);
  console.log("✅ flat(변동 없음) 케이스 검증 완료:", flatItem);

  assert(upItem.movementType === "up", `class="up"은 movementType="up"이어야 합니다 (실제: ${upItem.movementType})`);
  assert(upItem.rankChange === 47, `up은 textContent 숫자 그대로 양수여야 합니다 (실제: ${upItem.rankChange})`);
  assert(upItem.rank === 2 && upItem.previousRank === 49, `previousRank = rank(2) + rankChange(47) = 49여야 합니다 (실제: ${upItem.previousRank})`);
  console.log("✅ up(상승) 케이스 검증 완료:", upItem);

  assert(newItem.movementType === "new", `class="new"는 movementType="new"여야 합니다 (실제: ${newItem.movementType})`);
  assert(newItem.rankChange === null, `new는 rankChange=null이어야 합니다 (실제: ${newItem.rankChange})`);
  assert(newItem.previousRank === null, "신규 진입은 previousRank가 null이어야 합니다");
  console.log("✅ new(신규) 케이스 검증 완료:", newItem);

  assert(downItem.movementType === "down", `class="down"은 movementType="down"이어야 합니다 (실제: ${downItem.movementType})`);
  assert(downItem.rankChange === -1, `down은 textContent 숫자의 음수여야 합니다 (실제: ${downItem.rankChange})`);
  assert(downItem.rank === 4 && downItem.previousRank === 3, `previousRank = rank(4) + rankChange(-1) = 3이어야 합니다 (실제: ${downItem.previousRank})`);
  console.log("✅ down(하락) 케이스 검증 완료:", downItem);

  // 4. 2번째 topic("드라마")도 독립적으로 파싱되어야 한다(각 card 내부 순서로 rank가 다시 1부터 시작).
  const dramaTopic = result.topics[1];
  assert(dramaTopic.topic === "드라마", `2번째 topic 제목이 일치해야 합니다 (실제: ${dramaTopic.topic})`);
  assert(dramaTopic.candidates.length === 2, `2번째 topic은 keyword 2개여야 합니다 (실제: ${dramaTopic.candidates.length})`);
  assert(dramaTopic.candidates[0].rank === 1, "2번째 topic의 rank도 card 내부에서 1부터 다시 시작해야 합니다");
  console.log("✅ 2번째 topic(독립적 rank 시작) 검증 완료");

  // 5. demographic(성별·연령별) card는 topic card와 같은 selector를 쓰지만 결과(topics)에
  //    섞이면 안 되고, topicErrors로도 취급되면 안 된다 - cardScope로만 집계된다.
  const demographicTitlesInTopics = result.topics.map((t) => t.topic).filter(isDemographicTopicTitle);
  assert(
    demographicTitlesInTopics.length === 0,
    `demographic card가 topics에 섞이면 안 됩니다 (실제로 섞인 것: ${JSON.stringify(demographicTitlesInTopics)})`
  );
  assert(
    Object.keys(result.topicErrors).every((key) => !isDemographicTopicTitle(key)),
    "demographic card는 topicErrors에도 담기면 안 됩니다"
  );
  console.log("✅ topic card + demographic card가 섞인 fixture -> topic card만 topics에 반환 검증 완료");

  // 6. cardScope 집계: allTrendCardCount = topicCardCount + demographicCardCount + ignoredCardCount.
  //    fixture 구성: topic 2개(스타·연예인/드라마) + demographic 3개(30-34세 여자/35-39세 남자/
  //    60세- 여자) + 제목 없는 card 1개 = 총 6개.
  const { cardScope } = result;
  assert(cardScope.allTrendCardCount === 6, `allTrendCardCount는 6이어야 합니다 (실제: ${cardScope.allTrendCardCount})`);
  assert(cardScope.topicCardCount === 2, `topicCardCount는 2여야 합니다 (실제: ${cardScope.topicCardCount})`);
  assert(cardScope.demographicCardCount === 3, `demographicCardCount는 3이어야 합니다 (실제: ${cardScope.demographicCardCount})`);
  assert(cardScope.ignoredCardCount === 1, `ignoredCardCount는 1이어야 합니다 (실제: ${cardScope.ignoredCardCount})`);
  assert(
    cardScope.allTrendCardCount === cardScope.topicCardCount + cardScope.demographicCardCount + cardScope.ignoredCardCount,
    "allTrendCardCount는 topicCardCount+demographicCardCount+ignoredCardCount의 합과 같아야 합니다"
  );
  assert(
    cardScope.topicTitles.join(",") === "스타·연예인,드라마",
    `topicTitles가 실제 topic 제목만 순서대로 담아야 합니다 (실제: ${cardScope.topicTitles.join(",")})`
  );
  assert(
    cardScope.demographicTitleSamples.length === 3,
    `demographicTitleSamples는 3개(fixture의 demographic 전부)여야 합니다 (실제: ${cardScope.demographicTitleSamples.length})`
  );
  console.log("✅ cardScope 집계(allTrendCardCount/topicCardCount/demographicCardCount/ignoredCardCount) 검증 완료:", cardScope);

  // 7. isDemographicTopicTitle: 공백/하이픈 표기 변형을 허용하되, 일반 topic 제목은 오탐하지 않아야 한다.
  const demographicSamples = ["30-34세 여자", "35 - 39 세 남자", "60세- 여자", "0-12세 남자", "19-24세 여자"];
  for (const title of demographicSamples) {
    assert(isDemographicTopicTitle(title), `"${title}"는 demographic 형식으로 판별되어야 합니다`);
  }
  const normalTopicSamples = ["스타·연예인", "드라마", "방송", "육아·결혼", "일상·생각", "IT·컴퓨터", "국내여행"];
  for (const title of normalTopicSamples) {
    assert(!isDemographicTopicTitle(title), `"${title}"는 demographic으로 오탐되면 안 됩니다`);
  }
  console.log("✅ isDemographicTopicTitle 형식 변형/오탐 방지 검증 완료");

  // 8. topic card 자체가 하나도 없는 HTML -> TrendPageSelectorError(페이지 전체 실패)
  const emptyHtml = "<html><body><div>트렌드 데이터 없음</div></body></html>";
  try {
    parseTrendPage(emptyHtml, collectedAt);
    throw new Error("topic card가 없는 HTML에서는 TrendPageSelectorError가 발생해야 합니다");
  } catch (error) {
    assert(error instanceof TrendPageSelectorError, "topic card 없음 케이스는 TrendPageSelectorError 타입이어야 합니다");
    assert((error as TrendPageSelectorError).topic === "(page)", "페이지 전체 실패는 topic이 \"(page)\"여야 합니다");
    console.log("✅ topic card 없음(페이지 구조 변경 추정) -> TrendPageSelectorError 검증 완료:", (error as Error).message);
  }

  console.log("\n✅ parseTrendPage 테스트 완료");
}

main();
