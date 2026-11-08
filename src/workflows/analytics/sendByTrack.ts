// 측정 리포트(색인 점검·주간 성과)를 속성(=채널)의 텔레그램 봇으로 나눠 보낸다.
// 메시지는 이미 속성별로 만들어져 있다 - 여기는 "어느 봇으로 보내는가"만 정한다.
//
// 원칙:
//   · 트랙을 모르는 속성은 기본 봇(엔터)으로 보내고 "트랙 미상" 한 줄을 남긴다. 새 속성이 늘었을 때
//     리포트가 소리 없이 사라지는 쪽이 오배송보다 나쁘다.
//   · 메시지 하나의 발송 실패가 나머지를 멈추지 않는다. 실패는 로그에 남기고 계속 보낸다.
//   · 네이버(엔터)는 GSC·GA4에 없어 지금은 이 경로로 오는 메시지가 없다. 매핑(trackOfSite)에만 자리가 있다.
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import { DEFAULT_TRACK, TRACK_LABEL } from "../../notifications/telegramTracks.js";
import type { Track } from "../../notifications/telegramTracks.js";
import { siteLabel, trackOfSite } from "./siteUrls.js";

export type SiteMessage = { siteUrl: string; text: string };
export type TrackSender = (track: Track, messages: { text: string }[]) => Promise<void>;

export type TrackSendResult = { sent: number; failed: number };

/** 실제 발송. 테스트는 이 자리에 가짜 함수를 주입한다. */
export const sendViaTelegram: TrackSender = (track, messages) => TelegramNotifier.fromEnv(track).sendMessages(messages);

export async function sendMessagesByTrack(
  items: readonly SiteMessage[],
  send: TrackSender = sendViaTelegram,
  log: Pick<Console, "log" | "warn" | "error"> = console
): Promise<TrackSendResult> {
  let sent = 0;
  let failed = 0;

  for (const item of items) {
    const label = siteLabel(item.siteUrl);
    let track = trackOfSite(item.siteUrl);
    if (!track) {
      log.warn(`⚠️ 트랙 미상: ${label} → 기본 봇(${TRACK_LABEL[DEFAULT_TRACK]})으로 보냅니다. siteUrls.ts의 trackOfSite 매핑에 추가하세요.`);
      track = DEFAULT_TRACK;
    }
    try {
      await send(track, [{ text: item.text }]);
      sent += 1;
      log.log(`✅ ${label} → ${TRACK_LABEL[track]} 봇 발송`);
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      log.error(`❌ ${label} → ${TRACK_LABEL[track]} 봇 발송 실패: ${reason}`);
    }
  }
  return { sent, failed };
}
