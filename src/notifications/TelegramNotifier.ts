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
function splitIntoChunks(text: string, charLimit: number): string[] {
  if (text.length <= charLimit) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > charLimit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export type TelegramNotifierCredentials = {
  botToken: string;
  chatId: string;
};

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

  private async postSendMessage(text: string): Promise<void> {
    const url = `${TELEGRAM_API_BASE_URL}/bot${this.botToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
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
