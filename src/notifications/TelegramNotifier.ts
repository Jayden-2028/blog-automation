// Telegram Bot API(https://core.telegram.org/bots/api) 발송 클래스.
// credential(botToken/chatId)은 절대 로그로 출력하지 않는다.

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
// Telegram 메시지 본문 최대 길이(4096자). 여유를 두고 이보다 낮은 값에서 chunk를 자른다.
export const TELEGRAM_MESSAGE_CHAR_LIMIT = 4000;

// Telegram parse_mode="HTML"에서 안전하지 않은 문자를 escape한다.
// keyword/headline은 뉴스/블로그 title 원문(외부 입력)이므로 <, >, & 를 이스케이프하지 않으면
// Telegram이 메시지를 HTML로 파싱하다 깨지거나(400 에러) 의도치 않은 태그로 해석될 수 있다.
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 줄바꿈 단위로 잘라 charLimit을 넘지 않는 chunk 배열을 만든다(단어/태그 중간을 끊지 않기 위함).
// export하는 이유: notifyArticleReady.ts가 원고 본문을 Telegram 메시지로 보낼 때 같은 분할
// 규칙을 재사용한다 - 원고 길이 제한(1500~2500자)은 대부분 한 메시지 안에 들어가지만, 넘는
// 경우를 대비해 정확히 같은 chunk 로직을 쓴다(로직이 두 곳에서 갈리면 한쪽만 고쳐질 수 있다).
export function splitIntoChunks(text: string, charLimit: number): string[] {
  if (text.length <= charLimit) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    // 줄 하나가 그 자체로 charLimit을 넘으면(개행 없는 긴 URL·문단 등) 줄 단위 로직으로는 절대
    // 못 자른다 - current가 비어 있으면 아래 join 분기의 길이 조건이 항상 거짓이 되기 때문이다.
    // 이런 줄은 강제로 charLimit 길이씩 잘라 별도 chunk로 만든다.
    if (line.length > charLimit) {
      flush();
      for (let i = 0; i < line.length; i += charLimit) {
        chunks.push(line.slice(i, i + charLimit));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > charLimit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks;
}

export type TelegramNotifierCredentials = {
  botToken: string;
  chatId: string;
};

// Telegram Bot API의 InlineKeyboardButton은 callback_data(봇이 받는 콜백)와 url(외부 링크를
// 여는 버튼) 중 정확히 하나만 가진다. url 버튼을 추가한 이유(2026-08-27): 원고를 Telegraph
// 페이지로 발행해 "원고 보기" 버튼으로 서식 있는 화면을 열어주기 위해서다(services/telegraph/).
export type TelegramInlineKeyboardButton =
  | { text: string; callback_data: string; url?: never }
  | { text: string; url: string; callback_data?: never };
export type TelegramReplyMarkup = { inline_keyboard: TelegramInlineKeyboardButton[][] };
export type TelegramOutgoingMessage = { text: string; replyMarkup?: TelegramReplyMarkup };

export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;

  constructor(credentials: TelegramNotifierCredentials) {
    this.botToken = credentials.botToken;
    this.chatId = credentials.chatId;
  }

  static fromEnv(): TelegramNotifier {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      throw new Error(
        "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Copy .env.example to .env and fill in your Telegram bot credentials."
      );
    }

    return new TelegramNotifier({ botToken, chatId });
  }

  // 긴 메시지는 Telegram 글자 수 제한에 걸릴 수 있으므로 여러 건으로 나눠 순차 발송한다.
  async send(text: string): Promise<void> {
    const chunks = splitIntoChunks(text, TELEGRAM_MESSAGE_CHAR_LIMIT);
    for (const chunk of chunks) {
      await this.postSendMessage(chunk);
    }
  }

  // 이미 chunk로 나눠둔 메시지 목록(예: formatNotificationMessage.ts 결과)을 chunk 경계를 다시
  // 나누지 않고 그대로 순차 발송한다. 순서를 보장하기 위해 Promise.all이 아니라 순차 await로 보낸다.
  async sendMany(chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      await this.postSendMessage(chunk);
    }
  }

  // 본문과 선택 버튼을 함께 순차 발송한다. 메시지 순서는 keyword rank 표시 순서이므로 병렬화하지 않는다.
  async sendMessages(messages: TelegramOutgoingMessage[]): Promise<void> {
    for (const message of messages) {
      await this.postSendMessage(message.text, message.replyMarkup);
    }
  }

  private async postSendMessage(text: string, replyMarkup?: TelegramReplyMarkup): Promise<void> {
    const url = `${TELEGRAM_API_BASE_URL}/bot${this.botToken}/sendMessage`;

    const body: {
      chat_id: string;
      text: string;
      parse_mode: "HTML";
      disable_web_page_preview: true;
      reply_markup?: TelegramReplyMarkup;
    } = {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // 오류 응답 본문에는 credential이 포함되지 않으므로 그대로 노출해도 안전하다.
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Telegram sendMessage 실패: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`
      );
    }
  }
}
