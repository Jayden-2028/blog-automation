// buildImageBrief() 결과를 Telegram 메시지로 만들고 보낸다.
//
// 승인(confirm) 직후 자동으로 호출된다(TelegramBot.ts) - "원고 확정 -> 이미지 브리프 전달"이
// 설계 §9-1의 흐름이다. 실패해도 승인 자체를 막지 않는다(호출자가 이미 그렇게 처리한다).

import { escapeTelegramHtml, TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramOutgoingMessage } from "../../notifications/TelegramNotifier.js";
import { buildImageBrief } from "./buildImageBrief.js";
import type { BuildImageBriefInput, ImageBriefOptions, ParsedImageBrief } from "./buildImageBrief.js";

export function buildImageBriefMessage(jobId: string, keyword: string, brief: ParsedImageBrief): TelegramOutgoingMessage {
  const lines = [
    "🖼 <b>이미지 브리프</b>",
    "",
    `<b>${escapeTelegramHtml(keyword)}</b>`,
    "",
    "<b>장면</b>",
    escapeTelegramHtml(brief.scene),
    "",
    "<b>생성 프롬프트 (ChatGPT에 그대로 붙여넣기)</b>",
    `<code>${escapeTelegramHtml(brief.prompt)}</code>`,
    "",
    "<b>대체 텍스트</b>",
    escapeTelegramHtml(brief.altText || "(직접 작성 필요)"),
    "",
    "<b>금지 항목</b>",
    escapeTelegramHtml(brief.prohibited || "실존 인물, 브랜드 로고, 실제 제품 사진"),
    "",
    "이미지를 확보하셨으면 아래 명령으로 기록해주세요:",
    // "<이미지 URL>"처럼 꺾쇠괄호를 그대로 쓰면 Telegram이 HTML 태그로 오해해 발송 전체가
    // 400으로 거부된다(2026-08-28 실측에서 실제로 발생) - 안내 문구도 escapeTelegramHtml을 거친다.
    escapeTelegramHtml(`npm run job:image -- ${jobId} "<이미지 URL>" "ai-generated:chatgpt"`),
  ];

  return { text: lines.join("\n") };
}

export type NotifyImageBriefResult =
  | { status: "sent" }
  | { status: "failed"; error: string };

/**
 * 브리프를 만들고 발송까지 한다. 실패해도 예외를 던지지 않는다 - 호출자(TelegramBot 승인 처리)가
 * best-effort로 다루도록 결과 객체로만 알린다.
 */
export async function notifyImageBrief(
  jobId: string,
  input: BuildImageBriefInput,
  options: ImageBriefOptions = {}
): Promise<NotifyImageBriefResult> {
  const result = await buildImageBrief(input, options);
  if (!result.ok) {
    return { status: "failed", error: result.error };
  }

  try {
    await TelegramNotifier.fromEnv().sendMessages([buildImageBriefMessage(jobId, input.keyword, result.brief)]);
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
