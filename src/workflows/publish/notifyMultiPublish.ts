// publishApprovedArticles()의 job별 결과를 Telegram으로 알린다. SPRINT_5_DESIGN.md §5 step 6.
//
// 채널별로 다음 행동이 다르다:
//  - 네이버: 임시저장 완료 -> 사람이 네이버 앱에서 '발행' 클릭 (버튼으로 대체 불가)
//  - Blogspot: 공개 발행 완료(또는 draft) -> URL 확인만
//  - 티스토리(Phase 5): 임시저장 -> 사람이 발행
// 그래서 결정 버튼은 없고, 각 채널 URL을 여는 링크 버튼만 붙인다.

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import type { JobPublishResult } from "./publishApprovedArticles.js";

const CHANNEL_LABEL: Record<string, string> = {
  naver: "네이버",
  blogspot: "Blogspot",
  tistory: "티스토리",
};

const STATUS_LINE: Record<string, string> = {
  published: "✅ 공개 발행",
  draft: "📝 비공개(draft) 저장",
  already_done: "↩︎ 이미 발행됨",
  skipped: "· 건너뜀",
  deferred: "⏳ 보류(다음 폴링 재시도)",
  failed: "⚠️ 실패",
};

export function buildMultiPublishMessage(result: JobPublishResult): TelegramOutgoingMessage {
  const { job, channels } = result;
  const lines = [
    "📤 <b>다채널 발행 결과</b>",
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
  ];

  const buttons: TelegramInlineKeyboardButton[][] = [];
  for (const c of channels) {
    const label = CHANNEL_LABEL[c.channel] ?? c.channel;
    const statusText = STATUS_LINE[c.status] ?? c.status;
    if (c.status === "failed" || c.status === "deferred" || c.status === "skipped") {
      lines.push(`${label}: ${statusText} — ${escapeTelegramHtml(("reason" in c ? c.reason : "") ?? "").slice(0, 200)}`);
    } else {
      lines.push(`${label}: ${statusText}`);
      const url = "url" in c ? c.url : "";
      if (url) buttons.push([{ text: `${label} 열기`, url }]);
    }
  }

  if (result.markedPublished) {
    lines.push("", "모든 활성 채널 처리 완료 — job을 published로 이동했습니다.");
  }
  lines.push(
    "",
    "네이버·티스토리·Blogspot 모두 임시저장(draft)까지입니다. 본문 [IMAGE: ...] 자리에 이미지를 삽입한 뒤 앱/편집화면에서 직접 '발행'을 눌러주세요."
  );
  if (channels.some((c) => c.channel === "tistory" && (c.status === "draft" || c.status === "already_done"))) {
    lines.push("(티스토리 임시저장 글은 글쓰기 화면 하단 '임시저장' 숫자 버튼을 눌러 목록에서 확인)");
  }

  return {
    text: lines.join("\n"),
    replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  };
}

export async function notifyMultiPublish(results: JobPublishResult[]): Promise<void> {
  const QUIET: ReadonlyArray<string> = ["already_done", "skipped", "deferred"];
  const messages = results
    // 이번 실행에서 실제로 뭔가 일어난 job만 알린다. 전부 already_done/skipped/deferred면 조용히
    // 넘어간다 - deferred(상한초과, 정리 필요)는 10분마다 반복되므로 매번 알리면 소음이 된다.
    .filter((r) => r.channels.some((c) => !QUIET.includes(c.status)))
    .map(buildMultiPublishMessage);
  if (messages.length === 0) return;
  await TelegramNotifier.fromEnv().sendMessages(messages);
}
