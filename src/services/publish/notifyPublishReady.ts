// publishArticleToNaver() 성공 결과를 Telegram으로 알린다. SPRINT_4_DESIGN.md §10 item 6.
//
// notifyArticleReady.ts와 달리 결정 버튼(승인/반려)이 없다 - 이 시점의 유일한 다음 행동은
// "네이버 앱/브라우저에서 초안을 열어 사람이 직접 발행 버튼을 누르는 것"뿐이고, 그건 Telegram
// 버튼으로 대신할 수 없는 행동이다(§7 - 발행은 여전히 수동). 그래서 초안 URL을 여는 버튼
// 하나만 붙인다.
//
// ⚠️ draftUrl이 실제로 "방금 저장한 그 초안"을 정확히 여는지는 아직 라이브로 검증하지 못했다
// (NaverBlogPublisher.ts clickSave()의 미검증 사항 - §10 item 7에서 확정). 그래서 메시지에도
// 이 불확실성을 그대로 알린다 - 링크가 예상과 다른 화면(예: 새 글쓰기 화면)을 열면 초안함에서
// 직접 찾아야 할 수 있다는 걸 미리 안내한다.

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";

export type NotifyPublishReadyInput = {
  keyword: string;
  title: string | null;
  draftUrl: string;
  imageCount: number;
};

export function buildPublishReadyMessage(input: NotifyPublishReadyInput): TelegramOutgoingMessage {
  const lines = [
    "📤 <b>네이버 블로그 임시저장 완료</b>",
    "",
    `<b>${escapeTelegramHtml(input.title ?? input.keyword)}</b>`,
  ];

  if (input.imageCount > 0) {
    lines.push(`🖼 이미지 ${input.imageCount}장 업로드 시도됨`);
  }

  lines.push(
    "",
    "아래 버튼으로 열어 내용을 직접 확인한 뒤, 문제없으면 사람이 직접 '발행' 버튼을 눌러주세요.",
    "(링크가 초안이 아닌 다른 화면을 열면 블로그 관리 화면의 임시저장함에서 직접 찾아주세요)"
  );

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: [[{ text: "📝 초안 확인하기", url: input.draftUrl }]] },
  };
}

/** 실제 발송한다. 발송 실패는 예외를 던진다 - 임시저장은 끝났는데 알림만 조용히 실패하면 안 된다. */
export async function notifyPublishReady(input: NotifyPublishReadyInput): Promise<void> {
  await TelegramNotifier.fromEnv().sendMessages([buildPublishReadyMessage(input)]);
}
