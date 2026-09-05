// formatNotificationMessage 테스트. DB 없이 payload를 직접 구성해 메시지 조립만 검증한다.
// 2026-09-04: 원문(headline)·항목별 배점표(scoreBreakdown)를 메시지에서 뺐다 - 항목은 이제
// 제목(rank+keyword)과 seedQuery/category 한 줄만 보여준다.
import { formatNotificationMessage } from "./formatNotificationMessage.js";
import type { KeywordNotificationPayload, NotificationKeywordItem } from "../../types/keywordNotification.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function item(overrides: Partial<NotificationKeywordItem> = {}): NotificationKeywordItem {
  return {
    rank: 1,
    keyword: "영화 옵세션 정보 뜻 해석 결말 출연진 관람평",
    headline: "영화 옵세션 정보 뜻 해석 결말 출연진 관람평 후기",
    seedQuery: "영화 옵세션 정보",
    category: "ott",
    totalScore: 63,
    scoreBreakdown: {
      trendMomentum: 30,
      newsVelocity: 0,
      contentDemand: 10,
      freshness: 15,
      crossSourceSignal: 0,
      clickPotential: 8,
      total: 63,
    },
    trendDirection: "accelerating",
    ...overrides,
  };
}

function payload(items: NotificationKeywordItem[]): KeywordNotificationPayload {
  return {
    run: {
      id: 1,
      startedAt: "2026-09-04T00:30:00.000Z",
      seedQueries: ["영화 옵세션 정보"],
      activeSeedsCount: 44,
      candidatesCount: 100,
      clustersCount: 40,
      categories: ["ott"],
    },
    items,
  };
}

function main(): void {
  console.log("▶ formatNotificationMessage 테스트 시작\n");

  const [, itemChunk] = formatNotificationMessage(payload([item()]));

  // 1) 주제(rank+keyword), seedQuery, category는 남아야 한다.
  assert(itemChunk.text.includes("1. 영화 옵세션 정보 뜻 해석 결말 출연진 관람평"), "주제(rank+keyword) 줄이 있어야 한다");
  assert(itemChunk.text.includes("seedQuery: 영화 옵세션 정보 · category: ott"), "seedQuery/category 줄이 있어야 한다");
  console.log("✅ 주제 + seedQuery + category 유지");

  // 2) 원문(headline)은 빠져야 한다.
  assert(!itemChunk.text.includes("원문"), "원문 줄이 빠져야 한다");
  assert(!itemChunk.text.includes("관람평 후기"), "headline 텍스트가 남아있으면 안 된다");
  console.log("✅ 원문(headline) 제거");

  // 3) 항목별 배점표(총점 포함)는 빠져야 한다.
  assert(!itemChunk.text.includes("63점"), "총점이 빠져야 한다");
  assert(!itemChunk.text.includes("trend"), "배점표(trend/news/...)가 빠져야 한다");
  assert(!itemChunk.text.includes("🚀"), "트렌드 방향 이모지도 빠져야 한다");
  console.log("✅ 배점표 + 총점 + 트렌드 이모지 제거");

  // 4) category가 없으면 "N/A"로 대체된다(기존 동작 유지).
  const [, noCategoryChunk] = formatNotificationMessage(payload([item({ category: null })]));
  assert(noCategoryChunk.text.includes("category: N/A"), "category 없으면 N/A로 대체돼야 한다");
  console.log("✅ category 없음 -> N/A");

  // 5) seedQuery가 없으면 그 줄 자체가 생략된다.
  const [, noSeedChunk] = formatNotificationMessage(payload([item({ seedQuery: null })]));
  assert(!noSeedChunk.text.includes("seedQuery"), "seedQuery 없으면 그 줄이 아예 없어야 한다");
  console.log("✅ seedQuery 없음 -> 줄 생략");

  console.log("\n✅ 전체 테스트 통과");
}

main();
