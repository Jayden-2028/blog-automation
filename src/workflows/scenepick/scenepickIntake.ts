// 사회 봇 일반 메시지 = scenepick 주제 접수(2026-11-21 사용자 결정). GitHub Actions(telegram-update.yml -> runTelegramUpdateCli)에서 돈다.
//
// 규칙: 사회 봇 채팅(SOCIAL_TELEGRAM_CHAT_ID)에서 온, **답장이 아니고 `/`로 시작하지 않는 글자 메시지**는 전부 새 주제다 -
// 받는 즉시 job을 만들고 맥미니 Codex 대기열(metadata.scenepickCodex.status=requested)에 올린다. 답장은 예전 뜻(원고 수정 피드백,
// TelegramBot.handleEditFeedbackMessage) 그대로이고, 버튼(callback)도 그대로 TelegramBot으로 간다.
//
// **triggerResearch를 부르지 않는다** - 이 트랙은 우리 researcher/writer를 쓰지 않는다(조사·집필·이미지 전부 Codex).
// 대기열은 맥미니 폴러(scenepickPollJob)가 2분마다 본다.
import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import { capUtf8 } from "../research/personSourcePack.js";
import { SCENEPICK_JOB_CATEGORY, SCENEPICK_SOURCE, SCENEPICK_TRACK } from "./scenepickTypes.js";
import type { ScenepickCodexState } from "./scenepickTypes.js";

/** 주제 원문 상한(바이트). job.metadata가 비대해지지 않게 자른다(긴 글을 붙여 넣어도 주문서는 짧아야 한다). */
export const INPUT_TOPIC_MAX_BYTES = 4 * 1024;
export const KEYWORD_MAX_CHARS = 60;

export type IntakeMessage = {
  message_id?: number;
  chat?: { id?: number | string };
  text?: string;
  reply_to_message?: unknown;
};

/** 이 update가 scenepick 주제인가. 아니면 null(호출부가 TelegramBot으로 넘긴다). 순수 함수. */
export function parseScenepickTopic(
  update: { message?: IntakeMessage | null; callback_query?: unknown } | null | undefined,
  allowedChatId: string | null | undefined
): { text: string; chatId: string; messageId: number | null } | null {
  if (!update || update.callback_query) return null;
  const message = update.message;
  if (!message || typeof message !== "object") return null;
  if (message.reply_to_message) return null; // 답장 = 원고 수정 피드백(기존 의미)
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text || text.startsWith("/")) return null; // 명령(/start 등)은 주제가 아니다
  const chatId = message.chat?.id;
  // 설정된 사회 봇 채팅에서 온 것만 받는다 - 봇 주소를 아는 다른 사람이 발주를 넣을 수 없게.
  if (!allowedChatId || chatId === undefined || String(chatId) !== String(allowedChatId)) return null;
  return { text, chatId: String(chatId), messageId: typeof message.message_id === "number" ? message.message_id : null };
}

/** 첫 줄(빈 줄 제외)을 60자로 - 텔레그램 답장·알림·뷰어 사이드바에 보이는 이름이다. */
export function scenepickKeyword(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return Array.from(first).slice(0, KEYWORD_MAX_CHARS).join("").trim();
}

export type ScenepickJobFields = {
  keyword: string;
  headline: string;
  category: string;
  metadata: Record<string, unknown>;
};

export function scenepickJobFields(input: { text: string; messageId: number | null; now: Date }): ScenepickJobFields {
  const keyword = scenepickKeyword(input.text);
  const codex: ScenepickCodexState = { status: "requested", requestedAt: input.now.toISOString(), attempts: 0 };
  return {
    keyword,
    headline: keyword,
    category: SCENEPICK_JOB_CATEGORY,
    metadata: {
      track: SCENEPICK_TRACK,
      source: SCENEPICK_SOURCE,
      inputTopic: capUtf8(input.text, INPUT_TOPIC_MAX_BYTES),
      // 같은 메시지가 두 번 배달돼도(웹훅·dispatch 재시도) job이 두 개 생기지 않게 메시지 번호로 막는다.
      ...(input.messageId !== null ? { scenepickMessageId: input.messageId } : {}),
      scenepickCodex: codex,
    },
  };
}

export function acceptedReply(keyword: string): string {
  // 답장은 parse_mode=HTML로 나간다 - 주제에 <, & 가 있으면 깨지므로 이스케이프한다.
  return `📝 접수했습니다: ${escapeTelegramHtml(keyword)}\nCodex에 원고·이미지를 발주했습니다. 보통 15~30분 걸립니다.`;
}

export type ScenepickIntakeDeps = {
  allowedChatId: string | null;
  createJob: (fields: ScenepickJobFields) => Promise<{ id: string }>;
  /** 같은 메시지 번호로 이미 만든 job. 없으면 null. */
  findByMessageId: (messageId: number) => Promise<{ id: string } | null>;
  reply: (text: string) => Promise<void>;
  now?: () => Date;
};

export type ScenepickIntakeOutcome =
  | { handled: false }
  | { handled: true; status: "created"; jobId: string; keyword: string }
  | { handled: true; status: "duplicate"; jobId: string };

/** 주제면 job을 만들고 답한다. 주제가 아니면 handled=false(호출부가 TelegramBot.processUpdate로 넘긴다). */
export async function handleScenepickTopic(
  update: Parameters<typeof parseScenepickTopic>[0],
  deps: ScenepickIntakeDeps
): Promise<ScenepickIntakeOutcome> {
  const parsed = parseScenepickTopic(update, deps.allowedChatId);
  if (!parsed) return { handled: false };
  if (parsed.messageId !== null) {
    const existing = await deps.findByMessageId(parsed.messageId);
    if (existing) return { handled: true, status: "duplicate", jobId: existing.id };
  }
  const fields = scenepickJobFields({ text: parsed.text, messageId: parsed.messageId, now: (deps.now ?? (() => new Date()))() });
  const job = await deps.createJob(fields);
  await deps.reply(acceptedReply(fields.keyword)).catch((error) => {
    // 답장이 실패해도 job은 이미 대기열에 있다 - 완료 알림은 따로 간다.
    console.error(`⚠️ [scenepick] 접수 답장 실패: ${error instanceof Error ? error.message : error}`);
  });
  return { handled: true, status: "created", jobId: job.id, keyword: fields.keyword };
}
