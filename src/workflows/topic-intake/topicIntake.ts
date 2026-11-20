// 엔터 봇·국제(koreaplain) 봇의 일반 글자 메시지 = 새 주제 직접 입력(2026-11-21 사용자 결정).
// 인스타 변환기의 "직접 입력"과 같은 일을 봇에서 바로 한다 - 변환기(맥 큐·수신함)는 거치지 않는다. 사회 봇(scenepickIntake.ts)과
// 같은 구조: 순수 파싱 함수 + deps 주입 핸들러. GitHub Actions(telegram-update.yml -> runTelegramUpdateCli)에서 돈다.
//
//   엔터 봇  글자 메시지 -> "어느 원고로 만들까요?" [엔터][인물] 버튼 -> 누르면 job 생성 + 자료조사 발화
//   국제 봇  글자 메시지 -> 바로 국제(global=kscene) job 생성 + 자료조사 발화
//
// job을 만드는 규칙은 변환기와 **같은 함수**를 쓴다(inputJobFields). 엔터 = 엔터 트랙(category 없음, metadata.track 없음 = 엔터 기본),
// 인물 = category=person(소스팩 폴러가 같은 길로 집는다), 국제 = category=kscene + metadata.track=kscene.
//
// 왜 "버튼을 누를 때 job을 만드는가"(대기 상태 job을 먼저 만들지 않는다):
//   - status=selected job은 어디선가 집힐 위험이 있다(인물 소스팩 폴러는 category=person+selected를 자동으로 집는다). "아무도
//     안 집는 대기 상태"를 새로 만들면 모든 선택기(research-poll·워치독·일일 리포트)를 다시 감사해야 하고, 사용자가 버튼을
//     안 누르면 유령 job이 남는다.
//   - 주제 원문은 봇의 질문 메시지를 **원 메시지에 대한 답장**으로 보내 두면 버튼 callback_query.message.reply_to_message.text에
//     텔레그램이 그대로 실어 준다. callback_data(64바이트)에 글을 못 넣는 문제가 없고 별도 저장소도 필요 없다.
//   - 중복 방지: Worker가 첫 탭 직후 버튼을 잠그고(noop), 핸들러는 원 메시지 번호(metadata.topicInputMessageId)로 이미 만든 job을
//     찾는다 - 더블 탭·dispatch 재시도가 와도 job은 하나, 자료조사도 한 번이다.
import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import { inputJobFields } from "../instagram-capture/inputJobFields.js";
import type { InputJobFields } from "../instagram-capture/inputJobFields.js";
import { interpretDirectInput } from "../instagram-capture/directInput.js";
import type { InstagramTrack } from "../instagram-capture/instagramTrack.js";
import { parseScenepickTopic, scenepickKeyword } from "../scenepick/scenepickIntake.js";
import type { IntakeMessage } from "../scenepick/scenepickIntake.js";

/** 이 봇이 어느 트랙의 봇인가(Telegram 메시지 번호는 채팅마다 따로 센다 - 중복 키에 봇을 함께 쓴다). */
export type TopicBot = "entertainment" | "kscene";

/** callback_data. "tpick:<kind>" - 기존 접두(go: sel: pass: review: research: publish: kw: person…)와 겹치지 않는다. 최대 11바이트. */
export const TOPIC_PICK_PREFIX = "tpick:";
export type TopicPickKind = "ent" | "person";

export function topicPickCallbackData(kind: TopicPickKind): string {
  return `${TOPIC_PICK_PREFIX}${kind}`;
}
export function parseTopicPickCallbackData(data: string | undefined | null): TopicPickKind | null {
  if (!data || !data.startsWith(TOPIC_PICK_PREFIX)) return null;
  const kind = data.slice(TOPIC_PICK_PREFIX.length);
  return kind === "ent" || kind === "person" ? kind : null;
}

export const PICK_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "엔터", callback_data: topicPickCallbackData("ent") },
      { text: "인물", callback_data: topicPickCallbackData("person") },
    ],
  ],
};

const KIND_TRACK: Record<TopicPickKind, InstagramTrack> = { ent: "entertainment", person: "person" };
const KIND_LABEL: Record<TopicPickKind, string> = { ent: "엔터", person: "인물" };

/** 일반 글자 메시지가 주제인가 - 사회 봇과 같은 규칙(답장·명령·다른 채팅 제외). */
export const parseTopicMessage = parseScenepickTopic;

/**
 * 주제 글 -> job 입력값. 변환기 직접 입력과 같은 해석(명령구 꼬리 제거, 300자 넘는 긴 글은 소스 본문)이다.
 * 긴 글은 변환기가 주제 한 줄을 따로 묻지만 여기선 묻지 않는다 - 첫 줄(60자)을 주제로, 전체를 소스 본문으로 쓴다.
 */
export function topicJobFields(input: { text: string; track: InstagramTrack; messageId: number | null; bot: TopicBot }): InputJobFields {
  const interpreted = interpretDirectInput(input.text);
  const fields = inputJobFields(
    interpreted.kind === "topic"
      ? { userTopic: interpreted.topic, track: input.track }
      : { userTopic: scenepickKeyword(interpreted.sourceText), sourceText: interpreted.sourceText, track: input.track }
  );
  return {
    ...fields,
    metadata: {
      ...fields.metadata,
      // 같은 메시지가 두 번 배달돼도(웹훅·dispatch 재시도·버튼 더블 탭) job이 두 개 생기지 않게 원 메시지 번호를 남긴다.
      ...(input.messageId !== null ? { topicInputMessageId: input.messageId } : {}),
      topicInputBot: input.bot,
    },
  };
}

export function askReply(keyword: string): string {
  // 답장은 parse_mode=HTML로 나간다 - 주제에 <, & 가 있으면 깨지므로 이스케이프한다.
  return `📝 주제를 받았습니다: ${escapeTelegramHtml(keyword)}\n어느 원고로 만들까요?`;
}
export function pickedReply(kind: TopicPickKind, keyword: string): string {
  return `✅ ${KIND_LABEL[kind]} 원고로 발주했습니다\n주제: ${escapeTelegramHtml(keyword)}`;
}
export function globalAcceptedReply(keyword: string): string {
  return `📝 접수했습니다: ${escapeTelegramHtml(keyword)}\n국제(Korea Plain) 원고로 발주했습니다.`;
}

export type TopicIntakeDeps = {
  bot: TopicBot;
  allowedChatId: string | null;
  createJob: (fields: InputJobFields) => Promise<{ id: string }>;
  findByMessageId: (bot: TopicBot, messageId: number) => Promise<{ id: string } | null>;
  /** 자료조사 발화(변환기와 같은 dispatchResearch). 실패해도 job은 남는다 - 로그만 남긴다. */
  triggerResearch: (jobId: string) => Promise<void>;
  /** 엔터 봇: 원 메시지(messageId)에 답장으로 질문 + 버튼을 보낸다. */
  sendPrompt: (text: string, replyToMessageId: number | null) => Promise<void>;
  /** 국제 봇: 접수 답장. */
  reply: (text: string) => Promise<void>;
  /** 버튼 메시지를 결과 문구로 바꾸고 버튼을 걷는다. */
  editPromptMessage: (chatId: string, messageId: number, text: string) => Promise<void>;
};

export type TopicIntakeOutcome =
  | { handled: false }
  | { handled: true; status: "asked"; keyword: string }
  | { handled: true; status: "created"; jobId: string; keyword: string }
  | { handled: true; status: "duplicate"; jobId: string }
  | { handled: true; status: "ignored"; reason: string };

function safe(label: string, work: Promise<void>): Promise<void> {
  return work.catch((error) => {
    console.error(`⚠️ [topic-intake] ${label} 실패: ${error instanceof Error ? error.message : error}`);
  });
}

/** 일반 글자 메시지 처리. 엔터 봇은 버튼을 묻고, 국제 봇은 바로 발주한다. 주제가 아니면 handled=false. */
export async function handleTopicMessage(
  update: Parameters<typeof parseTopicMessage>[0],
  deps: TopicIntakeDeps
): Promise<TopicIntakeOutcome> {
  const parsed = parseTopicMessage(update, deps.allowedChatId);
  if (!parsed) return { handled: false };
  const keyword = scenepickKeyword(parsed.text);

  if (deps.bot === "entertainment") {
    // 질문만 보낸다 - job은 버튼을 누를 때 만든다(파일 머리말). 같은 메시지가 두 번 배달되면 질문이 두 번 갈 수 있지만
    // 어느 버튼을 눌러도 job은 하나다(원 메시지 번호 중복 방지).
    await deps.sendPrompt(askReply(keyword), parsed.messageId);
    return { handled: true, status: "asked", keyword };
  }

  if (parsed.messageId !== null) {
    const existing = await deps.findByMessageId(deps.bot, parsed.messageId);
    if (existing) return { handled: true, status: "duplicate", jobId: existing.id };
  }
  const fields = topicJobFields({ text: parsed.text, track: "global", messageId: parsed.messageId, bot: deps.bot });
  const job = await deps.createJob(fields);
  await safe("접수 답장", deps.reply(globalAcceptedReply(keyword)));
  await safe(`자료조사 발화(job ${job.id})`, deps.triggerResearch(job.id));
  return { handled: true, status: "created", jobId: job.id, keyword };
}

export type TopicCallbackQuery = {
  data?: string;
  message?: IntakeMessage & { message_id?: number };
};

/** [엔터]/[인물] 버튼. 우리 버튼이 아니면 handled=false(호출부가 TelegramBot으로 넘긴다). */
export async function handleTopicPick(
  update: { callback_query?: TopicCallbackQuery | null } | null | undefined,
  deps: TopicIntakeDeps
): Promise<TopicIntakeOutcome> {
  const query = update?.callback_query;
  const kind = parseTopicPickCallbackData(query?.data);
  if (!query || !kind) return { handled: false };

  const message = query.message;
  const chatId = message?.chat?.id;
  const promptId = message?.message_id;
  // 설정된 엔터 채팅의 버튼만 받는다(봇 주소를 아는 다른 사람이 발주하지 못하게).
  if (!deps.allowedChatId || chatId === undefined || String(chatId) !== String(deps.allowedChatId) || typeof promptId !== "number") {
    return { handled: true, status: "ignored", reason: "chat_mismatch" };
  }

  const original = message?.reply_to_message as { message_id?: number; text?: string } | undefined;
  const text = typeof original?.text === "string" ? original.text.trim() : "";
  if (!text) {
    // 원 메시지가 지워졌다 - 글을 잃었으니 만들 수 없다. 사용자가 다시 보내면 된다.
    await safe("편집", deps.editPromptMessage(String(chatId), promptId, "⚠️ 원래 메시지를 찾지 못했습니다. 주제를 다시 보내 주세요."));
    return { handled: true, status: "ignored", reason: "original_missing" };
  }
  const originalId = typeof original?.message_id === "number" ? original.message_id : null;
  const keyword = scenepickKeyword(text);

  if (originalId !== null) {
    const existing = await deps.findByMessageId(deps.bot, originalId);
    if (existing) {
      await safe("편집", deps.editPromptMessage(String(chatId), promptId, `✅ 이미 발주한 주제입니다\n주제: ${escapeTelegramHtml(keyword)}`));
      return { handled: true, status: "duplicate", jobId: existing.id };
    }
  }
  const fields = topicJobFields({ text, track: KIND_TRACK[kind], messageId: originalId, bot: deps.bot });
  const job = await deps.createJob(fields);
  await safe("편집", deps.editPromptMessage(String(chatId), promptId, pickedReply(kind, keyword)));
  await safe(`자료조사 발화(job ${job.id})`, deps.triggerResearch(job.id));
  return { handled: true, status: "created", jobId: job.id, keyword };
}
