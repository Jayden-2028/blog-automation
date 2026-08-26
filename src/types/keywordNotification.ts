// Telegram keyword notification 워크플로우 전용 타입.
// keyword_rankings row + score breakdown + (placeholder) 추천 제목을 묶어 알림 메시지로 변환하는 데 쓴다.

import type { KeywordRankingScoreBreakdownJson } from "./database.js";

export type NotificationKeywordItem = {
  rank: number;
  keyword: string;
  headline: string | null;
  seedQuery: string | null;
  category: string | null;
  totalScore: number;
  scoreBreakdown: KeywordRankingScoreBreakdownJson | null;
  trendDirection: string | null;
  /**
   * 이 키워드에 대한 추천 블로그 제목 3개.
   * 지금은 generateTitleSuggestions.ts의 규칙 기반 placeholder이며, 실제로 쓸 만한 제목이 아니라
   * "여기에 나중에 LLM 등으로 생성한 제목이 들어간다"는 자리표시자임을 명확히 한다.
   */
  titleSuggestions: string[];
};

export type NotificationSourceRun = {
  id: number;
  startedAt: string;
  /** 이 run에 사용된 seed 검색어 전체 목록. Telegram header에는 개수만 표시하고, 목록 자체는 노출하지 않는다. */
  seedQueries: string[];
  activeSeedsCount: number;
  candidatesCount: number;
  clustersCount: number;
  /** 최종 Top N 항목들의 category 집합(중복 제거). */
  categories: string[];
};

export type KeywordNotificationPayload = {
  run: NotificationSourceRun;
  items: NotificationKeywordItem[];
};

export type SendKeywordNotificationOptions = {
  /** true면 Telegram으로 실제 발송하지 않고 메시지 내용만 만들어서 반환한다. 기본 false. */
  dryRun?: boolean;
  /** Top N. 기본 10. */
  topN?: number;
  /** 조회할 discovery_run id. 생략하면 가장 최근에 완료된 run을 찾는다(fetchTopKeywordsForNotification 참고). */
  runId?: number;
};

export type SendKeywordNotificationResult = {
  sent: boolean;
  reason?: "no_data" | "dry_run";
  payload: KeywordNotificationPayload | null;
  /** 실제 Telegram으로 보낸(혹은 dryRun이면 보낼 예정인) 메시지 chunk 목록. */
  messages: string[];
};
