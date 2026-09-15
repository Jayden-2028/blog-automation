// prepareApprovedManuscripts()의 job별 결과를 Telegram으로 알린다. notifyMultiPublish.ts를 대체.
// 결정 버튼이 없다 - 사람이 index.html을 열어 직접 복사해 붙여넣으므로 알림은 "준비 완료 +
// 여는 방법"만 짧게 전한다(최근 텔레그램 메시지 간소화 방침 유지).
//
// Cloudflare Pages가 설정돼 있으면(2026-09-06) 로컬 경로 문구 대신 그 원고로 바로 열리는
// 딥링크 버튼(#jobId, renderManuscriptPage.ts 참고)을 붙인다. 미설정이면 지금처럼
// 로컬 경로 텍스트로 폴백 - Cloudflare 설정 전에도 알림이 무의미해지지 않는다.
//
// 2026-09-15 Blogspot 단독 운영: 채널 목록 줄이 사라지고 이미지 장수를 대신 보여준다.

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { manuscriptIndexPagePath } from "../../config/pipelinePaths.js";
import { cloudflarePagesUrl } from "../../config/manuscriptsPageTargets.js";
import type { JobManuscriptsResult } from "./prepareApprovedManuscripts.js";

/** pagesUrl은 테스트 주입용. 생략하면 cloudflarePagesUrl()(환경변수 기반)을 쓴다. */
export function buildManuscriptReadyMessage(
  result: JobManuscriptsResult,
  pagesUrl: string | null = cloudflarePagesUrl()
): TelegramOutgoingMessage {
  const { job, result: outcome } = result;

  if (outcome.status === "failed") {
    return {
      text: [
        "⚠️ <b>원고 준비 실패</b>",
        "",
        `<b>${escapeTelegramHtml(job.keyword)}</b>`,
        escapeTelegramHtml(outcome.reason),
        "",
        "다음 폴링에서 재시도합니다.",
      ].join("\n"),
    };
  }

  const imageCount = outcome.topic.manuscript.images.filter((i) => i.url).length;
  const summary = imageCount > 0 ? `🔵 Blogspot · 이미지 ${imageCount}장` : "🔵 Blogspot";

  const lines = ["📄 <b>원고 준비 완료</b>", "", `<b>${escapeTelegramHtml(job.keyword)}</b>`, summary];
  let buttons: TelegramInlineKeyboardButton[][] | undefined;

  if (pagesUrl) {
    buttons = [[{ text: "📄 원고 페이지 열기", url: `${pagesUrl}/#${outcome.topic.jobId}` }]];
  } else {
    lines.push("", `<code>${escapeTelegramHtml(manuscriptIndexPagePath())}</code>`, "위 파일을 브라우저로 열어 원고를 확인·복사해 붙여넣어 주세요.");
  }

  return { text: lines.join("\n"), replyMarkup: buttons ? { inline_keyboard: buttons } : undefined };
}

export type NotifyManuscriptsReadyOptions = {
  sendMessages?: (messages: TelegramOutgoingMessage[]) => Promise<void>;
};

export async function notifyManuscriptsReady(
  results: JobManuscriptsResult[],
  options: NotifyManuscriptsReadyOptions = {}
): Promise<void> {
  const sendMessages = options.sendMessages ?? ((messages) => TelegramNotifier.fromEnv().sendMessages(messages));
  if (results.length === 0) return;
  await sendMessages(results.map((result) => buildManuscriptReadyMessage(result)));
}
