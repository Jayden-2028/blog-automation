// "인스타 포스팅 변환기" 전용 텔레그램 봇. 기존 TelegramBot.ts(키워드 선택 버튼 상태머신)와는
// 완전히 분리한다(2026-09-21 사용자 요청) - 이 봇은 인라인 버튼도, article_jobs 상태 전이도 모른다.
// 하는 일은 딱 하나: "instagram.com URL이 포함된 메시지"를 받아서 로컬 큐(instagramQueue.ts)에
// 적재하고 접수 확인만 보낸다. 실제 처리(캐러셀 캡처 -> job 생성)는 사람이 부를 때 별도로 돈다
// (README: "인스타 대기열 처리해줘") - 브라우저로 게시물을 직접 봐야 해서 이 폴러(헤드리스) 안에서는
// 할 수 없다.

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
/** 메시지 안에서 인스타그램 게시물/릴스 URL만 골라낸다(프로필 URL은 제외 - 프로필은 승인 단계 임베드용). */
const INSTAGRAM_POST_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?[^\s]*/;

export type TelegramUpdateLike = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    caption?: string;
  };
};

export type InstagramCaptureBotOptions = {
  botToken?: string;
  /** 이 chat id에서 온 메시지만 처리한다(누구나 봇을 찾아 URL을 보내도 무시하기 위함). */
  allowedChatId?: string;
  fetchUpdates?: (offset?: number) => Promise<TelegramUpdateLike[]>;
  sendMessage?: (chatId: string, text: string) => Promise<void>;
  getStoredOffset?: () => Promise<number | null>;
  advanceStoredOffset?: (updateId: number) => Promise<unknown>;
  enqueue?: (entry: import("../workflows/instagram-capture/types.js").InstagramQueueEntry) => Promise<void>;
};

export type InstagramCaptureBotPollResult = {
  processed: number;
  enqueued: number;
  ignored: number;
};

export class InstagramCaptureBot {
  private readonly botToken: string;
  private readonly allowedChatId: string | null;
  private readonly fetchUpdates: (offset?: number) => Promise<TelegramUpdateLike[]>;
  private readonly sendMessage: (chatId: string, text: string) => Promise<void>;
  private readonly getStoredOffset: () => Promise<number | null>;
  private readonly advanceStoredOffset: (updateId: number) => Promise<unknown>;
  private readonly enqueue: NonNullable<InstagramCaptureBotOptions["enqueue"]>;

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
        await this.post("sendMessage", { chat_id: chatId, text });
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
    this.enqueue =
      options.enqueue ??
      (async (entry) => {
        const { appendQueueEntry } = await import("../workflows/instagram-capture/instagramQueue.js");
        await appendQueueEntry(entry);
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

  async pollOnce(): Promise<InstagramCaptureBotPollResult> {
    const storedOffset = await this.getStoredOffset();
    const updates = await this.fetchUpdates(storedOffset === null ? undefined : storedOffset + 1);

    let enqueued = 0;
    let ignored = 0;

    for (const update of updates) {
      const message = update.message;
      const text = message?.text ?? message?.caption ?? "";
      const chatId = message ? String(message.chat.id) : null;

      const parsed = text ? InstagramCaptureBot.splitUrlAndCaption(text) : null;

      if (!message || !chatId || !parsed) {
        ignored += 1;
      } else if (this.allowedChatId && chatId !== this.allowedChatId) {
        ignored += 1;
      } else {
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
        await this.sendMessage(
          chatId,
          parsed.caption
            ? "접수했습니다. 처리되면 원고 뷰어에 올라갑니다."
            : "URL 접수했습니다 - 캡션도 같이 보내주시면 자료조사 품질이 올라갑니다."
        ).catch(() => {
          // 알림 실패는 큐 적재를 막지 않는다.
        });
      }

      await this.advanceStoredOffset(update.update_id);
    }

    return { processed: updates.length, enqueued, ignored };
  }
}
