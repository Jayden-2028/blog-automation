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
import { buildPublishDecisionCallbackData } from "../../notifications/publishDecisionCallbackData.js";
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
        // 폴링은 폐지됐다(2026-09-14). 승인 콜백으로만 돌기 때문에 자동 재시도가 없다.
        "자동 재시도는 없습니다 - 승인 버튼을 다시 눌러주세요.",
      ].join("\n"),
    };
  }

  const imageCount = outcome.topic.manuscript.images.filter((i) => i.url).length;
  const summary = imageCount > 0 ? `🔵 Blogspot · 이미지 ${imageCount}장` : "🔵 Blogspot";

  const lines = ["📄 <b>원고 준비 완료</b>", "", `<b>${escapeTelegramHtml(job.keyword)}</b>`, summary];
  let buttons: TelegramInlineKeyboardButton[][] | undefined;

  // 발행 버튼(2026-09-19 사용자 결정): **이미지까지 반영된 최종 원고를 원고 페이지에서 본 뒤**
  // 누르는 공개 발행이다. 사람이 곧 품질 게이트다 - 누르지 않은 원고는 지금처럼 뷰어에서 복사해
  // 수동 발행한다. 페이지 열기와 같은 줄에 둔다(먼저 보고 나서 누르는 순서라 시선이 왼→오른쪽).
  // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 빼고 알림은 그대로 보낸다 - 여기서 예외를
  // 던지면 "원고 준비 완료" 알림 자체가 통째로 사라진다.
  // 2026-09-22 네이버 운영 재개: 버튼이 1개 -> 3개가 됐다. 한 줄에 몰면 텔레그램에서 글자가
  // 잘려 무슨 버튼인지 안 보이므로 줄을 나눈다.
  //   · 이미지 수정 - 빈 자리 재수집 + 사용자가 번호·요구사항으로 지정한 자리 다시 만들기
  //   · 블로그 발행 - Blogspot 공식 API라 GitHub Actions에서 바로 끝난다
  //   · 네이버 발행 - 공식 API가 없어 로그인된 브라우저가 필요하다. 맥의 로컬 폴러가 집어 간다
  let actionRow: TelegramInlineKeyboardButton[] = [];
  try {
    const jobId = outcome.topic.jobId;
    actionRow = [
      { text: "🖼 이미지 수정", callback_data: buildPublishDecisionCallbackData(jobId, "images") },
      { text: "🔵 블로그 발행", callback_data: buildPublishDecisionCallbackData(jobId, "blogspot") },
      { text: "🟢 네이버 발행", callback_data: buildPublishDecisionCallbackData(jobId, "naver") },
    ];
  } catch {
    // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 빼고 알림은 그대로 보낸다.
    actionRow = [];
  }

  if (pagesUrl) {
    buttons = [[{ text: "📄 원고 페이지 열기", url: `${pagesUrl}/#${outcome.topic.jobId}` }]];
    if (actionRow.length > 0) buttons.push(actionRow);
  } else {
    if (actionRow.length > 0) buttons = [actionRow];
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
