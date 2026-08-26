import type { KeywordProvider } from "./KeywordProvider.js";
import type { RawKeyword } from "../../../types/keywordDiscovery.js";

// 마지막 항목은 첫 항목의 대소문자/공백만 다른 중복으로, 배치 내 중복 제거 로직 검증용.
const MOCK_KEYWORDS: RawKeyword[] = [
  {
    keyword: "넷플릭스 신작",
    category: "entertainment",
    source: "mock",
    trendScore: 87,
    sourceUrl: "https://example.com/netflix-new",
    publishedAt: new Date().toISOString(),
  },
  {
    keyword: "디즈니플러스 신작",
    category: "entertainment",
    source: "mock",
    trendScore: 74,
    sourceUrl: "https://example.com/disney-new",
    publishedAt: new Date().toISOString(),
  },
  {
    keyword: "육아지원금",
    category: "policy",
    source: "mock",
    trendScore: 65,
    sourceUrl: "https://example.com/childcare-subsidy",
  },
  {
    keyword: "오늘 날씨",
    category: "weather",
    source: "mock",
    trendScore: 92,
  },
  {
    keyword: "연예인 이슈",
    category: "entertainment",
    source: "mock",
    trendScore: 58,
  },
  {
    keyword: "  넷플릭스   신작  ",
    category: "entertainment",
    source: "mock",
    trendScore: 81,
  },
];

export class MockKeywordProvider implements KeywordProvider {
  async fetchKeywords(): Promise<RawKeyword[]> {
    return MOCK_KEYWORDS.map((item) => ({ ...item }));
  }
}
