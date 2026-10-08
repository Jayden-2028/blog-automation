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
import { manuscriptPagePath, viewerPageLink } from "../../config/manuscriptViewerPages.js";
import { TRACK_LABEL, trackOfJob } from "../../notifications/telegramTracks.js";
import type { Track } from "../../notifications/telegramTracks.js";
import { buildPublishDecisionCallbackData } from "../../notifications/publishDecisionCallbackData.js";
import { buildArticleReviewCallbackData } from "../../notifications/articleReviewCallbackData.js";
import { isAutoApproved } from "../../config/pipelineGate.js";
import type { ArticleJobRow } from "../../types/database.js";
import type { JobManuscriptsResult } from "./prepareApprovedManuscripts.js";

/**
 * 통합 알림의 **수정 요청 / 반려** 버튼 줄(PIPELINE-MERGE-2026-10.md §1-b). 초안 승인 단계가 없어진 대신 이 알림이
 * 단일 승인 지점이다 - 발행 버튼이 "승인", 이 줄이 "고쳐라/버려라"다. 콜백은 옛 초안 알림의 것을 재사용한다
 * (`review:edit` -> 답장으로 수정 방향 받기, `review:discard` -> 반려). 자동 승인으로 올라온 job에만 붙는다.
 */
function buildReviewActionRow(job: ArticleJobRow): TelegramInlineKeyboardButton[] | null {
  if (!isAutoApproved(job)) return null;
  try {
    return [
      { text: "✏️ 수정 요청", callback_data: buildArticleReviewCallbackData("edit", job.id) },
      { text: "🗑 반려", callback_data: buildArticleReviewCallbackData("discard", job.id) },
    ];
  } catch {
    return null; // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 뺀다.
  }
}

/**
 * 옛 초안 알림이 보여주던 것 중 승인 판단에 쓰이던 두 가지를 통합 알림에 옮긴다: 의학 주제 경고와 검수(팩트·법률·광고)
 * 결과. 초안 단계가 없어졌으므로 여기서 안 보여주면 사람이 볼 기회가 사라진다. 검수 결과는 차단하지 않는 참고 정보다.
 */
function buildAutoApprovedNotes(job: ArticleJobRow): string[] {
  if (!isAutoApproved(job)) return [];
  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (metadata.requiresMedicalReview === true) {
    lines.push("⚕️ <b>의학 주제 — 원고와 출처를 직접 확인한 뒤 발행해 주세요</b>");
  }
  const checks = Array.isArray(metadata.reviewChecks) ? (metadata.reviewChecks as { message?: unknown }[]) : [];
  const messages = checks.map((check) => (typeof check.message === "string" ? check.message : "")).filter(Boolean);
  if (messages.length > 0) {
    lines.push(`⚠️ 검수 ${messages.length}건`, ...messages.slice(0, 3).map((message) => `· ${escapeTelegramHtml(message)}`));
    if (messages.length > 3) lines.push(`· 외 ${messages.length - 3}건 (뷰어에서 확인)`);
  }
  return lines;
}

/**
 * 준비 완료 알림의 키보드 전체(페이지 열기 링크 제외 줄 + 링크 줄). 알림 생성과 **키보드 복원**이 같은 함수를 쓴다 -
 * Cloudflare 릴레이가 어떤 버튼이든 누르는 순간 키보드를 "⏳ 처리 중…" 하나로 덮어쓰므로(telegram-relay lockButtons),
 * 러너가 처리 뒤에 원래 구성을 다시 세워야 한다(TelegramBot.markReviewButtonsDecided).
 *
 * 줄 구성: [📄 페이지 열기] / [✏️ 수정 요청][🗑 반려](자동 승인 job만) / [🖼 이미지 수정][⬇️ 내려받기] / [트랙별 발행].
 * 한 줄에 4개를 몰면 텔레그램이 글자를 자르므로 줄을 나눈다(2026-09-29). jobId가 UUID가 아니면 버튼만 뺀다.
 */
export function buildReadyKeyboard(
  job: ArticleJobRow,
  pagesUrl: string | null = cloudflarePagesUrl()
): TelegramInlineKeyboardButton[][] {
  const track: Track = trackOfJob(job);
  const jobId = job.id;
  const rows: TelegramInlineKeyboardButton[][] = [];
  if (pagesUrl) {
    const url = track === "entertainment" ? `${pagesUrl}/#${jobId}` : viewerPageLink(pagesUrl, track, jobId);
    rows.push([{ text: "📄 원고 페이지 열기", url }]);
  }
  // 수정/반려 줄은 링크 바로 아래에 둔다(2026-10-08 사용자 요청) - 발행 버튼 위에서 먼저 판단하게 한다.
  if (track !== "kscene") rows.push(...reviewActionRows(job));
  try {
    const publishButton: TelegramInlineKeyboardButton =
      track === "social"
        ? { text: "🟠 티스토리 발행", callback_data: buildPublishDecisionCallbackData(jobId, "tistory") }
        : track === "kscene"
          ? { text: "🔵 Blogger 발행", callback_data: buildPublishDecisionCallbackData(jobId, "blogspot") }
          : // 엔터는 네이버 발행만 한다(RESTRUCTURE-PLAN-2026-10.md §2.5 - Blogspot 버튼은 2026-10-05에 뺐다).
            { text: "🟢 네이버 발행", callback_data: buildPublishDecisionCallbackData(jobId, "naver") };
    rows.push(
      [
        { text: "🖼 이미지 수정", callback_data: buildPublishDecisionCallbackData(jobId, "images") },
        { text: "⬇️ 맥으로 내려받기", callback_data: buildPublishDecisionCallbackData(jobId, "export") },
      ],
      [publishButton]
    );
  } catch {
    // jobId가 UUID가 아니면(옛 데이터·테스트) 발행 줄을 뺀다 - 여기서 던지면 알림 전체가 사라진다.
  }
  return rows;
}

function reviewActionRows(job: ArticleJobRow): TelegramInlineKeyboardButton[][] {
  const row = buildReviewActionRow(job);
  return row ? [row] : [];
}

function withLeadingBlank(lines: string[]): string[] {
  return lines.length > 0 ? ["", ...lines] : [];
}

/** 사회 트랙의 발행 안내. 🟠 티스토리 발행 버튼을 누르면 맥미니가 올리므로, 누르기 전에 할 일(수정본 저장)을 문구로 알린다. */
const SOCIAL_MANUAL_PUBLISH_GUIDE =
  "🟠 티스토리 발행을 누르면 맥미니가 올립니다(첫 운영은 비공개). 뷰어에서 고쳤다면 먼저 '💾 수정본 저장'을 누르세요.";

/**
 * 사회 이슈 트랙(2026-10-05 §3.3 → 2026-10-06 TISTORY_AUTO_PUBLISH_DESIGN.md): 네이버·Blogger 버튼 없이
 * **티스토리 발행** 버튼만 붙는다. 티스토리도 로그인된 브라우저가 필요해 맥미니 폴러가 처리한다.
 */
function buildSocialReadyMessage(
  result: JobManuscriptsResult,
  outcome: Extract<JobManuscriptsResult["result"], { status: "success" }>,
  pagesUrl: string | null
): TelegramOutgoingMessage {
  const { job } = result;
  const imageCount = outcome.topic.manuscript.images.filter((i) => i.url).length;
  const markerCount = (outcome.topic.manuscript.body.match(/\[IMAGE:/g) ?? []).length;
  const emptyCount = Math.max(0, markerCount - imageCount);
  const summary = imageCount > 0 ? `🖼 이미지 ${imageCount}장` : "🖼 이미지 없음";
  const detail = emptyCount > 0 ? `${summary} · ⬜ 빈 자리 ${emptyCount}개` : summary;

  const lines = [
    `📄 <b>원고 준비 완료</b> · ${TRACK_LABEL.social}`,
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
    detail,
    ...withLeadingBlank(buildAutoApprovedNotes(job)),
    "",
    SOCIAL_MANUAL_PUBLISH_GUIDE,
  ];

  const buttons = buildReadyKeyboard(job, pagesUrl);
  if (!pagesUrl) {
    lines.push("", `<code>${escapeTelegramHtml(manuscriptPagePath("social"))}</code>`, "위 파일을 브라우저로 열어 확인·복사해 주세요.");
  }

  return { text: lines.join("\n"), replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined };
}

/**
 * 사용설명서 트랙(개편3): **영어본**이 최종 원고다(한글 승인 -> 영어본 생성 -> 영어본 재승인을 거쳤다). 🔵 Blogger 발행 버튼만 붙는다 -
 * The Korea Manual(K-Scene blogId)로 **공개 발행**되고, 그 순간 발행 이미지가 공개 이미지 서버(Pages)로 옮겨진다.
 */
function buildKsceneReadyMessage(
  result: JobManuscriptsResult,
  outcome: Extract<JobManuscriptsResult["result"], { status: "success" }>,
  pagesUrl: string | null
): TelegramOutgoingMessage {
  const { job } = result;
  const imageCount = outcome.topic.manuscript.images.filter((i) => i.url).length;
  const markerCount = (outcome.topic.manuscript.body.match(/\[IMAGE:/g) ?? []).length;
  const emptyCount = Math.max(0, markerCount - imageCount);
  const summary = imageCount > 0 ? `🖼 이미지 ${imageCount}장` : "🖼 이미지 없음";
  const detail = emptyCount > 0 ? `${summary} · ⬜ 빈 자리 ${emptyCount}개` : summary;

  const lines = [
    `📄 <b>원고 준비 완료</b> · ${TRACK_LABEL.kscene} (영어본)`,
    "",
    `<b>${escapeTelegramHtml(outcome.topic.manuscript.title || job.keyword)}</b>`,
    detail,
    "",
    "🔵 Blogger 발행을 누르면 The Korea Manual에 공개 발행됩니다. 뷰어에서 고쳤다면 먼저 '💾 수정본 저장'을 누르세요.",
  ];

  const buttons = buildReadyKeyboard(job, pagesUrl);
  if (!pagesUrl) {
    lines.push("", `<code>${escapeTelegramHtml(manuscriptPagePath("kscene"))}</code>`, "위 파일을 브라우저로 열어 확인해 주세요.");
  }

  return { text: lines.join("\n"), replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined };
}

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

  // 트랙은 job이 정한다(metadata.track). 사회 트랙은 🟠 티스토리 발행 버튼만 붙는 별도 알림이다(네이버·블로그스팟 버튼 없음).
  const track: Track = trackOfJob(job);
  if (track === "social") return buildSocialReadyMessage(result, outcome, pagesUrl);
  if (track === "kscene") return buildKsceneReadyMessage(result, outcome, pagesUrl);

  const imageCount = outcome.topic.manuscript.images.filter((i) => i.url).length;
  // 빈 자리 수를 함께 알린다(2026-10-01). 전까지는 "이미지 N장"만 보여서, 자리 6개 중 2개가 빈
  // 원고와 6개가 다 찬 원고가 알림에서 구분되지 않았다 - 뷰어를 열어야만 알 수 있었다.
  const markerCount = (outcome.topic.manuscript.body.match(/\[IMAGE:/g) ?? []).length;
  const emptyCount = Math.max(0, markerCount - imageCount);
  const summary = imageCount > 0 ? `🟢 네이버 · 이미지 ${imageCount}장` : "🟢 네이버";
  const lines0 = emptyCount > 0 ? `${summary} · ⬜ 빈 자리 ${emptyCount}개` : summary;

  const lines = [
    "📄 <b>원고 준비 완료</b>",
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
    lines0,
    ...withLeadingBlank(buildAutoApprovedNotes(job)),
  ];
  // 발행 버튼(2026-09-19 사용자 결정): **이미지까지 반영된 최종 원고를 원고 페이지에서 본 뒤** 누르는 공개 발행이다.
  // 사람이 곧 품질 게이트다 - 누르지 않은 원고는 올라가지 않는다. 버튼 구성(줄 나눔·트랙별 발행 버튼)은 buildReadyKeyboard 한 곳에 둔다.
  const keyboard = buildReadyKeyboard(job, pagesUrl);
  const buttons = keyboard.length > 0 ? keyboard : undefined;
  if (!pagesUrl) {
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
  if (results.length === 0) return;

  // 주입된 발송 함수는 트랙을 모른다(테스트) - 기존처럼 한 번에 보낸다.
  if (options.sendMessages) {
    await options.sendMessages(results.map((result) => buildManuscriptReadyMessage(result)));
    return;
  }

  // 트랙마다 봇이 다르다. 한 번의 준비 실행에 엔터·사회 원고가 섞여 있어도 각자 자기 봇으로 간다.
  const byTrack = new Map<Track, TelegramOutgoingMessage[]>();
  for (const result of results) {
    const track = trackOfJob(result.job);
    byTrack.set(track, [...(byTrack.get(track) ?? []), buildManuscriptReadyMessage(result)]);
  }
  for (const [track, messages] of byTrack) {
    await TelegramNotifier.fromEnv(track).sendMessages(messages);
  }
}
