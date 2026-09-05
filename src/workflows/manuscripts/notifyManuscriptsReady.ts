// prepareApprovedManuscripts()의 job별 결과를 Telegram으로 알린다. notifyMultiPublish.ts를 대체.
// 결정 버튼이 없다 - 사람이 로컬 index.html을 열어 직접 복사해 붙여넣으므로 알림은 "준비 완료 +
// 여는 방법"만 짧게 전한다(최근 텔레그램 메시지 간소화 방침 유지).

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { manuscriptIndexPagePath } from "../../config/pipelinePaths.js";
import type { ManuscriptChannel } from "../../config/pipelinePaths.js";
import type { JobManuscriptsResult } from "./prepareApprovedManuscripts.js";

const CHANNEL_LABEL: Record<ManuscriptChannel, string> = {
  naver: "🟢 네이버",
  tistory: "🟠 티스토리",
  blogspot: "🔵 Blogspot",
};

export function buildManuscriptReadyMessage(result: JobManuscriptsResult): TelegramOutgoingMessage {
  const { job, result: outcome } = result;

  if (outcome.status === "failed") {
    return {
      text: [
        "⚠️ <b>채널 원고 준비 실패</b>",
        "",
        `<b>${escapeTelegramHtml(job.keyword)}</b>`,
        escapeTelegramHtml(outcome.reason),
        "",
        "다음 폴링에서 재시도합니다.",
      ].join("\n"),
    };
  }

  const channelList = outcome.topic.channels.map((c) => CHANNEL_LABEL[c.channel]).join(" · ");
  return {
    text: [
      "📄 <b>3채널 원고 준비 완료</b>",
      "",
      `<b>${escapeTelegramHtml(job.keyword)}</b>`,
      channelList,
      "",
      `<code>${escapeTelegramHtml(manuscriptIndexPagePath())}</code>`,
      "위 파일을 브라우저로 열어 채널별 원고를 확인·복사해 붙여넣어 주세요.",
    ].join("\n"),
  };
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
  await sendMessages(results.map(buildManuscriptReadyMessage));
}
