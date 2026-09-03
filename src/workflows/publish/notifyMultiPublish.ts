// publishApprovedArticles()의 job별 결과를 Telegram으로 알린다. SPRINT_5_DESIGN.md §5 step 6.
//
// 채널별로 다음 행동이 다르다:
//  - 네이버: 임시저장 완료 -> 사람이 네이버 앱에서 '발행' 클릭 (버튼으로 대체 불가)
//  - Blogspot: 공개 발행 완료(또는 draft) -> URL 확인만
//  - 티스토리(Phase 5): 임시저장 -> 사람이 발행
// 그래서 결정 버튼은 없고, 각 채널 URL을 여는 링크 버튼만 붙인다.

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramInlineKeyboardButton, TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import type { ChannelName, JobPublishResult } from "./publishApprovedArticles.js";

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

const QUIET: ReadonlyArray<string> = ["already_done", "skipped", "deferred"];

type NotifiedFailures = Partial<Record<ChannelName, string>>;

function getNotifiedFailures(job: JobPublishResult["job"]): NotifiedFailures {
  const raw = job.metadata?.notifiedFailures;
  return raw && typeof raw === "object" ? (raw as NotifiedFailures) : {};
}

/**
 * 이번 실행이 알림을 보낼 가치가 있는지 판정한다. QUIET 상태는 원래도 무시하고, "failed"는
 * job.metadata.notifiedFailures에 기록된 직전 알림 사유와 같으면 이미 알린 것으로 보고 무시한다
 * (사유가 다르면 새 문제, 채널이 그새 성공/draft로 바뀌었다가 다시 실패해도 새 문제 - 아래
 * recordNotifiedFailures가 실패 아닌 상태에서 기록을 지우므로 자동으로 처리된다).
 */
export function hasReportableChange(result: JobPublishResult): boolean {
  const notified = getNotifiedFailures(result.job);
  return result.channels.some((c) => {
    if (QUIET.includes(c.status)) return false;
    if (c.status !== "failed") return true;
    return notified[c.channel] !== c.reason;
  });
}

type MergeMetadataFn = (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;

/** 이번 실행의 채널별 상태로 notifiedFailures를 다시 만든다 - failed가 아닌 채널은 빠지므로 자동으로 "해소" 처리된다. */
async function recordNotifiedFailures(result: JobPublishResult, mergeMetadata: MergeMetadataFn): Promise<void> {
  const previous = getNotifiedFailures(result.job);
  const next: NotifiedFailures = {};
  for (const c of result.channels) {
    if (c.status === "failed") next[c.channel] = c.reason;
  }
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  await mergeMetadata(result.job.id, { notifiedFailures: next }).catch(() => {});
}

export type NotifyMultiPublishOptions = {
  sendMessages?: (messages: TelegramOutgoingMessage[]) => Promise<void>;
  mergeMetadata?: MergeMetadataFn;
};

export async function notifyMultiPublish(
  results: JobPublishResult[],
  options: NotifyMultiPublishOptions = {}
): Promise<void> {
  const sendMessages = options.sendMessages ?? ((messages) => TelegramNotifier.fromEnv().sendMessages(messages));
  const mergeMetadata = options.mergeMetadata ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));

  // 이번 실행에서 실제로 알릴 가치가 있는 job만 남긴다. 전부 already_done/skipped/deferred거나
  // failed가 직전과 똑같은 사유면 조용히 넘어간다(중복 알림 방지).
  const reportable = results.filter(hasReportableChange);
  if (reportable.length === 0) return;

  const messages = reportable.map(buildMultiPublishMessage);
  await sendMessages(messages);
  await Promise.all(reportable.map((r) => recordNotifiedFailures(r, mergeMetadata)));
}
