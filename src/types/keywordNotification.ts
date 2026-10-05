// Telegram keyword notification 워크플로우 전용 타입.
// keyword_rankings row + score breakdown을 묶어 알림 메시지로 변환하는 데 쓴다.
// 추천 제목은 이 payload에 없다 - 알림 시점이 아니라 사용자가 버튼으로 키워드를 고른 뒤
// 그 1건에 대해서만 생성하기 때문이다(SPRINT_1_DESIGN.md 7절, TelegramBot이 담당).

import type { KeywordRankingScoreBreakdownJson } from "./database.js";
import type { Track } from "../notifications/telegramTracks.js";

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
   * 헤드리스 LLM이 만드는 20자 내외 한 줄 요약(generateKeywordSummaries.ts, 2026-09-15).
   * fetchTopKeywordsForNotification 시점엔 없고, sendKeywordNotification이 나중에 채운다 -
   * 실패해도 null로 두고 알림 자체는 막지 않는다.
   */
  summary: string | null;
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

/**
 * 알림을 섹션으로 묶는 설정(2026-10-05 사회 데일리 리포트). 항목마다 섹션 키를 정하고, 섹션 제목 메시지(버튼 없음)
 * 아래에 그 섹션의 항목을 이어서 보낸다. 생략하면 기존처럼 순위대로 평평하게 보낸다.
 */
export type KeywordSectionConfig = {
  /** 항목 -> 섹션 키. isCommunity는 커뮤니티 유래(📡) 여부. */
  sectionOf: (item: NotificationKeywordItem, context: { isCommunity: boolean }) => string;
  /** 표시 순서와 제목. 항목이 없는 섹션은 건너뛴다. 목록에 없는 키는 맨 뒤에 키 이름으로 붙는다. */
  sections: readonly { key: string; title: string }[];
};

export type SendKeywordNotificationOptions = {
  /** 어느 봇으로 보낼지(telegramTracks.ts). 생략하면 메인봇(엔터). Go/Pass로 만든 job은 이 트랙을 이어받는다. */
  track?: Track;
  /** 섹션별로 묶어 보낼 때만. */
  sections?: KeywordSectionConfig;
  /** true면 Telegram으로 실제 발송하지 않고 메시지 내용만 만들어서 반환한다. 기본 false. */
  dryRun?: boolean;
  /** Top N. 기본 10. */
  topN?: number;
  /** 조회할 discovery_run id. 생략하면 가장 최근에 완료된 run을 찾는다(fetchTopKeywordsForNotification 참고). */
  runId?: number;
  /** 알림 헤더 첫 줄 override. 오후 커뮤니티 전용 run이 "📡 오후 커뮤니티 키워드" 문구를 넘긴다. */
  headerTitle?: string;
  /**
   * 커뮤니티 유래 키워드의 seedQuery 목록. 해당 항목에 📡를 붙여 "커뮤니티 화제"임을 보여 준다
   * (2026-10-05 개편 - 커뮤니티 수집이 엔터 회차에 통합돼 독립 알림이 사라졌다).
   */
  communityQueries?: readonly string[];
};

export type SendKeywordNotificationResult = {
  sent: boolean;
  reason?: "no_data" | "dry_run";
  payload: KeywordNotificationPayload | null;
  /** 실제 Telegram으로 보낸(혹은 dryRun이면 보낼 예정인) 메시지 chunk 목록. */
  messages: string[];
};
