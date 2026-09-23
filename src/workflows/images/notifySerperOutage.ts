// 구글 이미지 검색(Serper)이 멈추면 한 번 알린다(2026-09-21 사용자 요청).
//
// 왜 필요한가: 검색이 실패해도 수집은 **네이버 후보만으로 조용히 계속 돈다**. 장애가 아니라서
// 파이프라인은 멀쩡히 success로 끝나고, 아무도 모르는 사이 이미지 품질만 슬그머니 떨어진다.
// 무료 크레딧 2,500건은 두 달쯤 뒤 소진되는데 그 순간이 바로 이 상황이다.
//
// 사유를 맞히려 들지 않는다. 소진 시 어떤 상태 코드가 오는지 문서화돼 있지 않아서, 응답을
// 그대로 실어 보낸다 - 크레딧 소진이든 키 오류든 사람이 보고 판단하는 편이 정확하다.

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { isRateLimited, takeSerperOutage } from "./searchSerperImages.js";
import type { SerperOutage } from "./searchSerperImages.js";

export function buildSerperOutageMessage(outage: SerperOutage): TelegramOutgoingMessage {
  // 429(속도 초과)와 크레딧 소진을 **구분해서** 쓴다(2026-09-24 사용자 지적).
  // 예전에는 무슨 코드가 오든 "크레딧 소진이면 충전하라"고 적어, 크레딧이 멀쩡한데도 대시보드를
  // 확인하러 가게 만들었다. 429는 충전할 일이 아니라 잠깐 초과한 것이다.
  const rateLimited = isRateLimited(outage.status);

  const lines = rateLimited
    ? [
        "⏳ <b>구글 이미지 검색이 잠시 밀렸습니다</b>",
        "",
        "초당 요청 한도(5건/초)를 넘겨 일부 검색이 건너뛰어졌습니다.",
        "<b>크레딧 문제가 아닙니다</b> - 충전할 필요 없습니다.",
        "",
        "자동으로 간격을 두고 재시도하지만, 그래도 못 받은 검색어가 있으면 그 자리는",
        "네이버 후보만으로 채워집니다.",
      ]
    : [
        "⚠️ <b>구글 이미지 검색이 멈췄습니다</b>",
        "",
        "네이버 후보만으로 계속 돌고 있습니다. 파이프라인은 멈추지 않지만 <b>이미지 품질이 떨어집니다</b>.",
      ];

  lines.push("", `응답: <code>HTTP ${outage.status}</code>`);
  if (outage.message) lines.push(`<code>${escapeTelegramHtml(outage.message)}</code>`);
  lines.push("", `검색어: ${escapeTelegramHtml(outage.query)}`);

  if (!rateLimited) {
    lines.push("", "크레딧 소진이면 serper.dev에서 충전하거나, 네이버만으로 갈지 정해주세요.");
  }
  return { text: lines.join("\n") };
}

export type NotifySerperOutageOptions = {
  /** 테스트 주입용. */
  takeOutage?: () => SerperOutage | null;
  sendMessages?: (messages: TelegramOutgoingMessage[]) => Promise<unknown>;
};

/** 이번 실행에서 장애가 있었으면 한 번 알린다. 없으면 아무것도 하지 않는다. */
export async function notifySerperOutage(options: NotifySerperOutageOptions = {}): Promise<boolean> {
  const takeOutage = options.takeOutage ?? takeSerperOutage;
  const outage = takeOutage();
  if (!outage) return false;

  const sendMessages =
    options.sendMessages ?? ((messages) => TelegramNotifier.fromEnv().sendMessages(messages));
  await sendMessages([buildSerperOutageMessage(outage)]);
  return true;
}
