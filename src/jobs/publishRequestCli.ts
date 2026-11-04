// 뷰어의 발행 버튼이 보낸 요청 1건을 처리한다(TISTORY_AUTO_PUBLISH_DESIGN.md §5).
//
// 경로: 뷰어 발행 버튼 -> Pages Function(functions/api/publish-request.ts, Access 토큰 검증) ->
// repository_dispatch(publish_request) -> .github/workflows/publish-request.yml -> 이 파일.
//
// 채널에 따라 끝이 다르다:
//   · tistory(사회) - 텔레그램 버튼(TelegramBot.handlePublishDecisionCallback)과 **같은 큐**
//     (requestTistoryPublish)에 넣는다. 둘 다 눌러도 한 번만 올라간다. 실제 발행은 맥미니 폴러
//     (job:tistory-poll)가 한다 - 로그인된 브라우저가 필요해 GitHub Actions에서 못 돌린다.
//   · blogspot(사용설명서, 2026-11-05 신설) - 큐가 없다. Blogger API는 토큰만 있으면 되므로
//     텔레그램 🔵 버튼과 **같은 함수**(publishArticleToBlogspot, asDraft:false)를 여기서 바로 부른다.
//     중복 발행은 그 함수의 publication 검사(IN_PROGRESS_OR_DONE)가 막는다.
import "dotenv/config";

import { escapeTelegramHtml } from "../notifications/TelegramNotifier.js";
import { TISTORY_CONFIG } from "../config/publishTargets.js";
import { notifierForJob } from "../notifications/notifierForJob.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import type { ArticleJobRow } from "../types/database.js";
import { isChannelAllowedForTrack, trackOfJob } from "../notifications/telegramTracks.js";
import { isManualPublishOnly, MANUAL_PUBLISH_ONLY_REASON } from "../workflows/publish/manualPublishOnly.js";
import { publishArticleToBlogspot } from "../workflows/publish/publishArticleToBlogspot.js";
import { requestTistoryPublish } from "../workflows/publish/tistoryPublishQueue.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** cloudflare/manuscripts-pages/publishApi.ts의 CHANNELS와 같아야 한다. */
const CHANNELS = ["tistory", "blogspot"] as const;
type Channel = (typeof CHANNELS)[number];

export function parsePublishRequest(raw: unknown): { jobId: string; channel: Channel } {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("요청 형식이 아닙니다");
  const { jobId, channel } = value as { jobId?: unknown; channel?: unknown };
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) throw new Error("jobId가 UUID가 아닙니다");
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) throw new Error(`지원하지 않는 채널: ${String(channel)}`);
  return { jobId, channel: channel as Channel };
}

async function main(): Promise<void> {
  const raw = process.env.PUBLISH_REQUEST_JSON;
  if (!raw) throw new Error("PUBLISH_REQUEST_JSON 환경변수가 없습니다.");
  const { jobId, channel } = parsePublishRequest(raw);

  const job = await ArticleJobRepository.findById(jobId);
  if (!job) throw new Error(`job을 찾을 수 없습니다: ${jobId}`);
  if (job.status !== "approved") throw new Error(`승인된 원고만 발행할 수 있습니다(현재: ${job.status})`);

  // 서버 측 트랙-채널 검증(개편2.5 B-2): 뷰어는 트랙을 모르고 요청을 보낸다 - 엔터 job을 티스토리로 올리면 안 된다.
  if (!isChannelAllowedForTrack(trackOfJob(job), channel)) {
    throw new Error(`${trackOfJob(job)} 트랙 원고는 ${channel}로 발행할 수 없습니다: ${job.keyword}`);
  }
  // 복붙 전용 원고(person·일상·테크)는 어느 채널로도 자동 발행하지 않는다. 티스토리 큐는 자기가
  // 한 번 더 보지만(requestTistoryPublish), Blogger 경로에는 그 검사가 없어 여기서 막는다.
  if (isManualPublishOnly(job)) throw new Error(MANUAL_PUBLISH_ONLY_REASON);

  const messageText = channel === "blogspot" ? await publishToBlogspot(job) : await queueTistory(job);

  await notifierForJob(job)
    .sendMessages([{ text: messageText }])
    .catch((error) => console.warn(`⚠️ 알림 실패(무시): ${error instanceof Error ? error.message : error}`));
}

/** 티스토리: 큐에 넣고 "예약했습니다"만 알린다. 결과 알림은 맥미니 폴러가 따로 보낸다. */
async function queueTistory(job: ArticleJobRow): Promise<string> {
  const draftOnly = TISTORY_CONFIG.publishMode === "draft";
  const queued = await requestTistoryPublish(job, { source: "viewer" });
  console.log(`${queued.queued ? "✅" : "ℹ️"} [publish-request] tistory ${job.keyword}: ${queued.queued ? "예약" : queued.reason}`);

  return [
    // 문구는 발행 모드를 따른다(2026-11-05) - 임시저장 모드인데 "올라갑니다 / 주소를 보내드립니다"라고
    // 하면 올라간 줄 알고 기다리게 된다.
    queued.queued
      ? (draftOnly ? "📝 <b>뷰어에서 티스토리 임시저장을 예약했습니다</b>" : "🟠 <b>뷰어에서 티스토리 발행을 예약했습니다</b>")
      : "ℹ️ <b>티스토리 - 이미 예약돼 있습니다</b>",
    "",
    `<b>${escapeTelegramHtml(job.keyword)}</b>`,
    queued.queued
      ? (draftOnly
        ? "맥미니가 켜져 있으면 곧 임시저장합니다. 끝나면 글 관리 링크를 보내드립니다 - 발행은 직접 해주세요."
        : "맥미니가 켜져 있으면 곧 올라갑니다. 완료되면 주소를 보내드립니다.")
      : escapeTelegramHtml(queued.reason ?? ""),
  ].join("\n");
}

/**
 * Blogger: 여기서 끝까지 올린다. 텔레그램 🔵 버튼과 같은 호출(asDraft:false)이라 "버튼 두 개가 서로
 * 다르게 동작한다"는 상황이 생기지 않는다.
 */
async function publishToBlogspot(job: ArticleJobRow): Promise<string> {
  const published = await publishArticleToBlogspot(job.id, { asDraft: false });
  const head = `<b>${escapeTelegramHtml(job.keyword)}</b>`;

  if (!published.ok) {
    console.error(`❌ [publish-request] blogspot ${job.keyword}: ${published.reason} - ${published.detail}`);
    return ["⚠️ <b>Blogger에 발행하지 못했습니다</b>", "", head, escapeTelegramHtml(published.detail), "", "원고 페이지에서 복사해 직접 발행해 주세요."].join("\n");
  }

  console.log(`✅ [publish-request] blogspot ${job.keyword}: ${published.alreadyDone ? "이미 발행됨" : "발행"} ${published.url}`);
  if (published.alreadyDone) return ["ℹ️ <b>이미 발행된 글입니다</b>", "", head, escapeTelegramHtml(published.url)].join("\n");

  return [
    published.updatedExisting
      ? "♻️ <b>수정본으로 글을 갱신했습니다</b>"
      : published.isDraft
        ? "📝 <b>초안으로 올렸습니다</b>"
        : "🚀 <b>뷰어에서 Blogger에 발행했습니다</b>",
    "",
    head,
    escapeTelegramHtml(published.url),
  ].join("\n");
}

main().catch((error) => {
  console.error(`❌ [publish-request] 실패: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
