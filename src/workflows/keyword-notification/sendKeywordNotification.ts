// Telegram keyword notification 파이프라인 orchestration.
// 흐름: 최근 완료된 discovery_run 조회 -> 그 run의 keyword_rankings TOP N -> 항목별 추천 제목 placeholder
//      -> Telegram HTML 메시지로 포맷 -> 선택 버튼을 붙여 Telegram Bot API로 발송.
// 스케줄링(매일 오전 8시)은 이 함수 안에서 하지 않는다 — runKeywordNotification.ts 주석 참고.

import { fetchTopKeywordsForNotification } from "./fetchTopKeywordsForNotification.js";
import { formatNotificationMessage } from "./formatNotificationMessage.js";
import {
  TelegramNotifier,
  type TelegramInlineKeyboardButton,
  type TelegramOutgoingMessage,
} from "../../notifications/TelegramNotifier.js";
import { buildKeywordSelectionCallbackData } from "../../notifications/telegramCallbackData.js";
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

  // 추천 제목은 여기서 만들지 않는다 - 사용자가 버튼으로 고른 뒤 그 1건에 대해서만 생성한다
  // (SPRINT_1_DESIGN.md 7절). 알림 시점에 10건을 만들면 8~9건은 쓰이지도 않고 버려진다.
  const payload: KeywordNotificationPayload = { run: fetched.run, items: fetched.items };

  const chunks = formatNotificationMessage(payload, { headerTitle: options.headerTitle });
  const messages = chunks.map((chunk) => chunk.text);
  // 항목마다 메시지가 따로 가므로(formatNotificationMessage 참고) 각 메시지에 그 항목의
  // Go/Pass 버튼만 붙인다. 헤더는 ranks가 비어 있어 버튼 없이 나간다.
  const outgoingMessages: TelegramOutgoingMessage[] = chunks.map((chunk) => {
    if (chunk.ranks.length === 0) {
      return { text: chunk.text };
    }

    const inlineKeyboard: TelegramInlineKeyboardButton[][] = chunk.ranks.map((rank) => [
      { text: "✍️ Go", callback_data: buildKeywordSelectionCallbackData("go", payload.run.id, rank) },
      { text: "⏭ Pass", callback_data: buildKeywordSelectionCallbackData("pass", payload.run.id, rank) },
    ] satisfies TelegramInlineKeyboardButton[]);

    return {
      text: chunk.text,
      replyMarkup: { inline_keyboard: inlineKeyboard },
    };
  });

  if (dryRun) {
    return { sent: false, reason: "dry_run", payload, messages };
  }

  await TelegramNotifier.fromEnv().sendMessages(outgoingMessages);
  return { sent: true, payload, messages };
}
