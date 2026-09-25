// "인스타 포스팅 변환기" 전용 텔레그램 봇. 기존 TelegramBot.ts(키워드 선택 버튼 상태머신)와는
// 완전히 분리한다(2026-09-21 사용자 요청) - 이 봇은 인라인 버튼도, article_jobs 상태 전이도 모른다.
// 하는 일은 둘이다.
//   1) "instagram.com URL이 포함된 메시지"를 로컬 큐(instagramQueue.ts)에 적재하고 접수 확인
//   2) 주제를 물어본 항목(needs_topic)에 대한 **답장**을 받아 그 항목에 붙인다(2026-09-23)
//
// 2)가 필요한 이유: 링크만 받는 설계에서 게시물에 읽을 글자가 하나도 없으면 원고를 쓸 근거가
// 0이다. 그때만 사용자에게 주제를 묻고, 답을 이 봇이 받아 큐로 돌려보낸다.

import { listAwaitingTopic, markEntry } from "../workflows/instagram-capture/instagramQueue.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
/** 메시지 안에서 인스타그램 게시물/릴스 URL만 골라낸다(프로필 URL은 제외). */
const INSTAGRAM_POST_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?[^\s]*/;

export type TelegramUpdateLike = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    caption?: string;
    /** 어느 메시지에 답장한 것인지. needs_topic 항목을 짚을 때 쓴다. */
    reply_to_message?: { message_id: number };
  };
};

export type InstagramCaptureBotOptions = {
  botToken?: string;
  /** 이 chat id에서 온 메시지만 처리한다(누구나 봇을 찾아 URL을 보내도 무시하기 위함). */
  allowedChatId?: string;
  fetchUpdates?: (offset?: number) => Promise<TelegramUpdateLike[]>;
  sendMessage?: (chatId: string, text: string) => Promise<number | null>;
  getStoredOffset?: () => Promise<number | null>;
  advanceStoredOffset?: (updateId: number) => Promise<unknown>;
  enqueue?: (entry: import("../workflows/instagram-capture/types.js").InstagramQueueEntry) => Promise<void>;
  /**
   * 어디에도 붙지 않은 **답장**을 넘겨받는다(2026-09-25).
   *
   * 왜 필요한가: 텔레그램 getUpdates는 봇당 소비자가 하나여야 해서, 수신을 클라우드로 옮기면
   * 주제 답장도 클라우드가 받는다. 그런데 "어느 항목에 대한 답인지"는 맥의 큐에만 있다
   * (askedMessageId를 맥이 붙인다). 그래서 클라우드는 **판단하지 않고 그대로 넘겨** 두고,
   * 맥이 가져가 자기 큐에 맞춘다. 이 훅이 없으면 답장이 `ignored`로 버려지고 offset만 올라간다.
   */
  onUnmatchedReply?: (input: {
    updateId: number;
    chatId: string;
    messageId: number;
    replyToMessageId: number;
    text: string;
  }) => Promise<void>;
  /** 주제를 기다리는 항목들. 답장을 어디에 붙일지 고를 때 쓴다. */
  listAwaitingTopic?: () => import("../workflows/instagram-capture/types.js").InstagramQueueEntry[];
  /** 답으로 받은 주제를 항목에 붙이고 다시 대기로 돌린다. */
  applyTopic?: (entryId: string, topic: string) => void;
};

export type InstagramCaptureBotPollResult = {
  processed: number;
  enqueued: number;
  ignored: number;
  /** 주제 답장으로 처리한 건수. */
  topicsAnswered: number;
};

export class InstagramCaptureBot {
  private readonly botToken: string;
  private readonly allowedChatId: string | null;
  private readonly fetchUpdates: (offset?: number) => Promise<TelegramUpdateLike[]>;
  private readonly sendMessage: (chatId: string, text: string) => Promise<number | null>;
  private readonly getStoredOffset: () => Promise<number | null>;
  private readonly advanceStoredOffset: (updateId: number) => Promise<unknown>;
  private readonly enqueue: NonNullable<InstagramCaptureBotOptions["enqueue"]>;
  private readonly onUnmatchedReply: InstagramCaptureBotOptions["onUnmatchedReply"];
  private readonly listAwaitingTopic: NonNullable<InstagramCaptureBotOptions["listAwaitingTopic"]>;
  private readonly applyTopic: NonNullable<InstagramCaptureBotOptions["applyTopic"]>;

  constructor(options: InstagramCaptureBotOptions = {}) {
    this.botToken = options.botToken ?? process.env.INSTAGRAM_BOT_TOKEN ?? "";
    this.allowedChatId = options.allowedChatId ?? process.env.INSTAGRAM_BOT_CHAT_ID ?? null;
    if (!this.botToken) {
      throw new Error(
        "Missing INSTAGRAM_BOT_TOKEN. @BotFather에서 새 봇을 만들고 .env에 INSTAGRAM_BOT_TOKEN=<token>을 넣어주세요."
      );
    }

    this.fetchUpdates = options.fetchUpdates ?? ((offset) => this.getUpdates(offset));
    this.sendMessage =
      options.sendMessage ??
      (async (chatId, text) => {
        // message_id를 돌려준다 - 주제를 물어본 메시지에 사용자가 답장하면 그걸로 항목을 짚는다.
        const sent = await this.post<{ message_id?: number }>("sendMessage", { chat_id: chatId, text });
        return typeof sent?.message_id === "number" ? sent.message_id : null;
      });
    this.getStoredOffset =
      options.getStoredOffset ??
      (async () => {
        const { TelegramOffsetRepository } = await import("../repositories/TelegramOffsetRepository.js");
        return TelegramOffsetRepository.getLastUpdateId("instagram-capture-bot");
      });
    this.advanceStoredOffset =
      options.advanceStoredOffset ??
      (async (updateId) => {
        const { TelegramOffsetRepository } = await import("../repositories/TelegramOffsetRepository.js");
        return TelegramOffsetRepository.setLastUpdateId(updateId, "instagram-capture-bot");
      });
    this.onUnmatchedReply = options.onUnmatchedReply;
    this.enqueue =
      options.enqueue ??
      (async (entry) => {
        const { appendQueueEntry } = await import("../workflows/instagram-capture/instagramQueue.js");
        await appendQueueEntry(entry);
      });
    this.listAwaitingTopic =
      options.listAwaitingTopic ??
      // 큐는 파일 읽기뿐이라 로드만으로 터지지 않는다(supabase와 다르다) - 정적 import로 쓴다.
      (() => listAwaitingTopic());
    this.applyTopic =
      options.applyTopic ??
      ((entryId, topic) => {
        markEntry(entryId, { status: "pending", userTopic: topic });
      });
  }

  static fromEnv(options: Omit<InstagramCaptureBotOptions, "botToken"> = {}): InstagramCaptureBot {
    return new InstagramCaptureBot(options);
  }

  private async post<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Telegram ${method} 실패: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`);
    }
    const json = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} 실패: ${json.description ?? "알 수 없는 오류"}`);
    return json.result ?? null;
  }

  private async getUpdates(offset?: number): Promise<TelegramUpdateLike[]> {
    const body: Record<string, unknown> = { timeout: 0, limit: 50 };
    if (offset !== undefined) body.offset = offset;
    const result = await this.post<TelegramUpdateLike[]>("getUpdates", body);
    return result ?? [];
  }

  /** 텍스트에서 인스타 URL을 빼고 나머지를 캡션 후보로 돌려준다. URL이 없으면 null. */
  private static splitUrlAndCaption(text: string): { url: string; caption: string } | null {
    const match = text.match(INSTAGRAM_POST_URL_RE);
    if (!match) return null;
    const url = match[0].replace(/[),.]+$/, "");
    const caption = text.replace(match[0], "").trim();
    return { url, caption };
  }

  /**
   * 주제 답장이 어느 항목에 대한 것인지 짚는다.
   *
   * 답장(reply_to_message)이면 물어본 메시지 id로 정확히 짚는다. 모바일에서 답장 기능을 쓰지
   * 않고 그냥 타이핑하는 경우가 많아, **기다리는 항목이 하나뿐이면** 그것으로 본다. 둘 이상이면
   * 어느 것인지 알 수 없으므로 받지 않는다 - 엉뚱한 게시물에 주제를 붙이는 것보다 낫다.
   */
  private matchAwaitingEntry(
    replyToMessageId: number | undefined
  ): import("../workflows/instagram-capture/types.js").InstagramQueueEntry | null {
    const waiting = this.listAwaitingTopic();
    if (waiting.length === 0) return null;
    if (replyToMessageId !== undefined) {
      const exact = waiting.find((e) => e.askedMessageId === replyToMessageId);
      if (exact) return exact;
    }
    return waiting.length === 1 ? waiting[0] : null;
  }

  /**
   * 이 봇으로 질문을 보내고 message_id를 돌려준다.
   *
   * 폴러가 주제를 물을 때 쓴다. 메인 알림 봇(TelegramNotifier)이 아니라 **이 봇**이어야 한다 -
   * 답장은 보낸 봇에게만 돌아오기 때문이다.
   */
  async ask(chatId: string, text: string): Promise<number | null> {
    return this.sendMessage(chatId, text).catch(() => null);
  }

  async pollOnce(): Promise<InstagramCaptureBotPollResult> {
    const storedOffset = await this.getStoredOffset();
    const updates = await this.fetchUpdates(storedOffset === null ? undefined : storedOffset + 1);

    let enqueued = 0;
    let ignored = 0;
    let topicsAnswered = 0;

    for (const update of updates) {
      const message = update.message;
      const text = message?.text ?? message?.caption ?? "";
      const chatId = message ? String(message.chat.id) : null;
      const allowed = !!message && !!chatId && (!this.allowedChatId || chatId === this.allowedChatId);

      const parsed = text ? InstagramCaptureBot.splitUrlAndCaption(text) : null;

      if (!allowed || !message || !chatId) {
        ignored += 1;
      } else if (parsed) {
        await this.enqueue({
          id: `tg-${update.update_id}`,
          instagramUrl: parsed.url,
          rawCaption: parsed.caption,
          telegramChatId: chatId,
          telegramMessageId: message.message_id,
          receivedAt: new Date().toISOString(),
          status: "pending",
        });
        enqueued += 1;
        await this.sendMessage(chatId, "링크 접수했습니다. 원고 초안이 준비되면 알려드립니다.").catch(() => {
          // 알림 실패는 큐 적재를 막지 않는다.
        });
      } else if (text.trim() && this.matchAwaitingEntry(message.reply_to_message?.message_id)) {
        // URL이 없는 메시지는 원래 버린다. 단, 주제를 물어본 항목이 있으면 그 답으로 본다.
        const target = this.matchAwaitingEntry(message.reply_to_message?.message_id);
        if (target) {
          this.applyTopic(target.id, text.trim());
          topicsAnswered += 1;
          await this.sendMessage(chatId, `주제를 받았습니다. 이 주제로 원고를 씁니다:\n${text.trim().slice(0, 100)}`).catch(
            () => {}
          );
        } else {
          ignored += 1;
        }
      } else if (text.trim() && message.reply_to_message?.message_id && this.onUnmatchedReply) {
        // 여기서 못 붙인 답장은 **버리지 않고 넘긴다**(2026-09-25). 붙일 큐를 가진 쪽이 맞춘다.
        await this.onUnmatchedReply({
          updateId: update.update_id,
          chatId,
          messageId: message.message_id,
          replyToMessageId: message.reply_to_message.message_id,
          text: text.trim(),
        });
        topicsAnswered += 1;
      } else {
        ignored += 1;
      }

      await this.advanceStoredOffset(update.update_id);
    }

    return { processed: updates.length, enqueued, ignored, topicsAnswered };
  }
}
