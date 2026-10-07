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
import type { JobManuscriptsResult } from "./prepareApprovedManuscripts.js";

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
    "",
    SOCIAL_MANUAL_PUBLISH_GUIDE,
  ];

  const jobId = outcome.topic.jobId;
  let actionRows: TelegramInlineKeyboardButton[][] = [];
  try {
    actionRows = [
      [
        { text: "🖼 이미지 수정", callback_data: buildPublishDecisionCallbackData(jobId, "images") },
        { text: "⬇️ 맥으로 내려받기", callback_data: buildPublishDecisionCallbackData(jobId, "export") },
      ],
      [{ text: "🟠 티스토리 발행", callback_data: buildPublishDecisionCallbackData(jobId, "tistory") }],
    ];
  } catch {
    // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 빼고 알림은 그대로 보낸다.
    actionRows = [];
  }

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (pagesUrl) {
    buttons.push([{ text: "📄 원고 페이지 열기", url: viewerPageLink(pagesUrl, "social", jobId) }]);
  } else {
    lines.push("", `<code>${escapeTelegramHtml(manuscriptPagePath("social"))}</code>`, "위 파일을 브라우저로 열어 확인·복사해 주세요.");
  }
  buttons.push(...actionRows);

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

  const jobId = outcome.topic.jobId;
  let actionRows: TelegramInlineKeyboardButton[][] = [];
  try {
    actionRows = [
      [
        { text: "🖼 이미지 수정", callback_data: buildPublishDecisionCallbackData(jobId, "images") },
        { text: "⬇️ 맥으로 내려받기", callback_data: buildPublishDecisionCallbackData(jobId, "export") },
      ],
      [{ text: "🔵 Blogger 발행", callback_data: buildPublishDecisionCallbackData(jobId, "blogspot") }],
    ];
  } catch {
    // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 빼고 알림은 그대로 보낸다.
    actionRows = [];
  }

  const buttons: TelegramInlineKeyboardButton[][] = [];
  if (pagesUrl) {
    buttons.push([{ text: "📄 원고 페이지 열기", url: viewerPageLink(pagesUrl, "kscene", jobId) }]);
  } else {
    lines.push("", `<code>${escapeTelegramHtml(manuscriptPagePath("kscene"))}</code>`, "위 파일을 브라우저로 열어 확인해 주세요.");
  }
  buttons.push(...actionRows);

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

  const lines = ["📄 <b>원고 준비 완료</b>", "", `<b>${escapeTelegramHtml(job.keyword)}</b>`, lines0];
  let buttons: TelegramInlineKeyboardButton[][] | undefined;

  // 발행 버튼(2026-09-19 사용자 결정): **이미지까지 반영된 최종 원고를 원고 페이지에서 본 뒤**
  // 누르는 공개 발행이다. 사람이 곧 품질 게이트다 - 누르지 않은 원고는 지금처럼 뷰어에서 복사해
  // 올리지 않는다(발행 버튼은 엔터=🟢 네이버, 사회=🟠 티스토리). 페이지 열기와 같은 줄에 둔다(먼저 보고 나서 누르는 순서라 시선이 왼→오른쪽).
  // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 빼고 알림은 그대로 보낸다 - 여기서 예외를
  // 던지면 "원고 준비 완료" 알림 자체가 통째로 사라진다.
  // 2026-09-22 네이버 운영 재개: 버튼이 1개 -> 3개가 됐다. 한 줄에 몰면 텔레그램에서 글자가
  // 잘려 무슨 버튼인지 안 보이므로 줄을 나눈다. 2026-09-29 내려받기가 붙어 4개가 됐고,
  // 그래서 **두 줄로** 나눈다(한 줄 4개는 글자가 잘린다).
  //   · 이미지 수정 - 빈 자리 재수집 + 사용자가 번호·요구사항으로 지정한 자리 다시 만들기
  //   · 맥으로 내려받기 - 보관함 내보내기를 30분 주기 전에 지금 돌린다. 맥의 폴러가 집어 간다
  //   · (블로그 발행 버튼은 2026-10-05에 뺐다 - 아래 참고)
  //   · 네이버 발행 - 공식 API가 없어 로그인된 브라우저가 필요하다. 맥의 로컬 폴러가 집어 간다
  let actionRows: TelegramInlineKeyboardButton[][] = [];
  try {
    const jobId = outcome.topic.jobId;
    actionRows = [
      [
        { text: "🖼 이미지 수정", callback_data: buildPublishDecisionCallbackData(jobId, "images") },
        { text: "⬇️ 맥으로 내려받기", callback_data: buildPublishDecisionCallbackData(jobId, "export") },
      ],
      // 2026-10-05 개편(RESTRUCTURE-PLAN-2026-10.md §2.5): 엔터 트랙은 네이버 발행만 한다. Blogspot
      // 버튼은 뺐다(콜백 처리 코드는 남아 있다 - 3순위에서 사용설명서 트랙이 K-Scene 블로그로 쓴다).
      [{ text: "🟢 네이버 발행", callback_data: buildPublishDecisionCallbackData(jobId, "naver") }],
    ];
  } catch {
    // jobId가 UUID가 아니면(옛 데이터·테스트) 버튼만 빼고 알림은 그대로 보낸다.
    actionRows = [];
  }

  if (pagesUrl) {
    buttons = [[{ text: "📄 원고 페이지 열기", url: `${pagesUrl}/#${outcome.topic.jobId}` }]];
    if (actionRows.length > 0) buttons.push(...actionRows);
  } else {
    if (actionRows.length > 0) buttons = actionRows;
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
