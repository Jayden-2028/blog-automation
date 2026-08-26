// Telegram keyword notification 파이프라인 orchestration.
// 흐름: 최근 완료된 discovery_run 조회 -> 그 run의 keyword_rankings TOP N -> 항목별 추천 제목 placeholder
//      생성 -> Telegram HTML 메시지로 포맷 -> Telegram Bot API로 발송.
// 스케줄링(매일 오전 8시)은 이 함수 안에서 하지 않는다 — runKeywordNotification.ts 주석 참고.

import { fetchTopKeywordsForNotification } from "./fetchTopKeywordsForNotification.js";
import { formatNotificationMessage } from "./formatNotificationMessage.js";
import { generateTitleSuggestions } from "./generateTitleSuggestions.js";
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type {
  KeywordNotificationPayload,
  SendKeywordNotificationOptions,
  SendKeywordNotificationResult,
} from "../../types/keywordNotification.js";

export async function sendKeywordNotification(
  options: SendKeywordNotificationOptions = {}
): Promise<SendKeywordNotificationResult> {
  const topN = options.topN ?? 10;
  const dryRun = options.dryRun ?? false;

  const fetched = await fetchTopKeywordsForNotification(topN, options.runId);
  if (!fetched) {
    return { sent: false, reason: "no_data", payload: null, messages: [] };
  }

  const payload: KeywordNotificationPayload = {
    run: fetched.run,
    items: fetched.items.map((item) => ({
      ...item,
      titleSuggestions: generateTitleSuggestions(item.keyword),
    })),
  };

  const messages = formatNotificationMessage(payload);

  if (dryRun) {
    return { sent: false, reason: "dry_run", payload, messages };
  }

  await TelegramNotifier.fromEnv().sendMany(messages);
  return { sent: true, payload, messages };
}
