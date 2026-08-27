// Telegram 수신기. 발송 전용인 TelegramNotifier와 의도적으로 분리한다.
//
// 구조 원칙(SPRINT_1_DESIGN.md 5~6절): handleCallbackQuery()는 "update가 어떻게 도착했는지"를
// 모른다. 지금은 launchd가 짧게 반복 실행하며 getUpdates로 긁어오지만, 나중에 webhook 서버로
// 바꿔도 핸들러는 그대로 쓴다. 그래서 수신 루프(pollOnce)와 처리(handleCallbackQuery)를 나눠 둔다.
//
// credential은 절대 로그로 출력하지 않는다.

import { getKeywordRankingByRunAndRank } from "../services/supabase/repositories/keywordRankingRepository.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import { DEFAULT_TELEGRAM_RECEIVER_ID, TelegramOffsetRepository } from "../repositories/TelegramOffsetRepository.js";
import { escapeTelegramHtml } from "./TelegramNotifier.js";
import { parseKeywordSelectionCallbackData } from "./telegramCallbackData.js";
import type { CreateArticleJobResult } from "../repositories/ArticleJobRepository.js";
import type { ArticleJobRow, KeywordRankingRow } from "../types/database.js";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

/** getUpdates 한 번에 가져올 최대 개수. */
const UPDATES_LIMIT = 100;

// ---------- Telegram API 응답 타입 (필요한 필드만) ----------

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: {
    message_id: number;
    chat: { id: number | string };
    reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] };
  };
  from?: { id: number | string };
};

export type TelegramUpdate = {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
};

export type HandleCallbackOutcome =
  | { status: "ignored"; reason: "not_a_selection" | "wrong_chat" }
  | { status: "expired" }
  | { status: "created"; job: ArticleJobRow }
  | { status: "already_selected"; job: ArticleJobRow };

export type HandleCallbackResult = {
  outcome: HandleCallbackOutcome;
  /** 사용자에게 보여줄 짧은 안내(토스트/확인 메시지에 쓴다). */
  message: string;
};

export type TelegramBotOptions = {
  botToken: string;
  /** 이 chat에서 온 callback만 처리한다. */
  chatId: string;
  receiverId?: string;
  /**
   * job이 새로 생겼을 때만 호출된다(중복 클릭으로 토큰을 태우지 않기 위해). 추천 제목을 만들어
   * 반환하면 job.metadata.titleSuggestions에 저장하고 확인 메시지에 함께 보낸다.
   */
  generateTitles?: (job: ArticleJobRow) => Promise<string[]>;

  // 아래 셋은 테스트에서 DB 접근을 대체하기 위한 주입 지점이다.
  // 운영 호출은 전부 생략하고 기본 구현(실제 repository)을 쓴다.
  // buildDailyQueryPool의 loadActiveSeeds, runCreatorAdvisorCollection의 fetchCandidates와 같은 패턴.
  loadRanking?: (runId: number, rank: number) => Promise<KeywordRankingRow | null>;
  createJob?: (ranking: KeywordRankingRow) => Promise<CreateArticleJobResult>;
  saveTitles?: (jobId: string, titles: string[]) => Promise<void>;
};

export class TelegramBot {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly receiverId: string;
  private readonly generateTitles?: (job: ArticleJobRow) => Promise<string[]>;
  private readonly loadRanking: (runId: number, rank: number) => Promise<KeywordRankingRow | null>;
  private readonly createJob: (ranking: KeywordRankingRow) => Promise<CreateArticleJobResult>;
  private readonly saveTitles: (jobId: string, titles: string[]) => Promise<void>;

  constructor(options: TelegramBotOptions) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.receiverId = options.receiverId ?? DEFAULT_TELEGRAM_RECEIVER_ID;
    this.generateTitles = options.generateTitles;
    this.loadRanking = options.loadRanking ?? getKeywordRankingByRunAndRank;
    this.createJob = options.createJob ?? ((ranking) => ArticleJobRepository.createFromRanking(ranking));
    this.saveTitles =
      options.saveTitles ??
      (async (jobId, titles) => {
        await ArticleJobRepository.mergeMetadata(jobId, { titleSuggestions: titles });
      });
  }

  static fromEnv(options: Omit<TelegramBotOptions, "botToken" | "chatId"> = {}): TelegramBot {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      throw new Error(
        "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Copy .env.example to .env and fill in your Telegram bot credentials."
      );
    }

    return new TelegramBot({ ...options, botToken, chatId });
  }

  // ---------- 핵심 처리 ----------

  /**
   * callback query 하나를 처리한다. 수신 경로와 무관하게 동작한다.
   *
   * 어떤 경우에도 예외를 밖으로 던지지 않게 하려는 것이 아니다 - DB 오류 같은 진짜 문제는
   * 호출자(pollOnce)가 update 단위로 잡아 나머지 update 처리를 계속한다.
   */
  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<HandleCallbackResult> {
    const parsed = parseKeywordSelectionCallbackData(query.data);
    if (!parsed) {
      // 봇이 들어 있는 대화에는 다른 기능의 버튼이나 오래된 메시지가 섞일 수 있다. 정상 흐름이다.
      return { outcome: { status: "ignored", reason: "not_a_selection" }, message: "" };
    }

    // 봇 토큰이 유출되지 않아도, 봇이 초대된 다른 대화에서 온 callback은 거부해야 한다.
    const fromChatId = query.message?.chat?.id;
    if (fromChatId !== undefined && String(fromChatId) !== this.chatId) {
      return { outcome: { status: "ignored", reason: "wrong_chat" }, message: "" };
    }

    // callback_data는 참조 키만 담으므로 실제 키워드를 여기서 읽는다.
    // 조회 실패는 곧 "만료됐거나 위조된 callback_data"라는 뜻이다.
    const ranking = await this.loadRanking(parsed.runId, parsed.rank);
    if (!ranking) {
      return {
        outcome: { status: "expired" },
        message: "이미 만료된 항목입니다. 최신 키워드 알림에서 다시 선택해주세요.",
      };
    }

    const { job, created } = await this.createJob(ranking);

    if (!created) {
      return {
        outcome: { status: "already_selected", job },
        message: `이미 선택한 키워드입니다 (상태: ${job.status})`,
      };
    }

    // 제목 생성은 job이 새로 생겼을 때만 한다 - 중복 클릭으로 LLM 호출을 반복하지 않기 위해서다.
    let titleSuggestions: string[] = [];
    if (this.generateTitles) {
      try {
        titleSuggestions = await this.generateTitles(job);
        if (titleSuggestions.length > 0) {
          await this.saveTitles(job.id, titleSuggestions);
        }
      } catch (error) {
        // 제목 생성 실패가 선택 자체를 무효로 만들면 안 된다 - job은 이미 만들어졌고,
        // 제목은 나중에 다시 만들 수 있다.
        const reason = error instanceof Error ? error.message : String(error);
        console.error("⚠️ 추천 제목 생성 실패 (job은 정상 생성됨) -", reason);
      }
    }

    return { outcome: { status: "created", job }, message: this.buildConfirmationMessage(job, titleSuggestions) };
  }

  private buildConfirmationMessage(job: ArticleJobRow, titleSuggestions: string[]): string {
    const lines = [
      `✅ <b>선택 완료</b>`,
      ``,
      `<b>${escapeTelegramHtml(job.keyword)}</b>`,
      `category: ${escapeTelegramHtml(job.category ?? "N/A")} · ${job.total_score ?? "?"}점`,
    ];

    if (job.headline && job.headline !== job.keyword) {
      lines.push(`원문: ${escapeTelegramHtml(job.headline)}`);
    }

    if (titleSuggestions.length > 0) {
      lines.push(``, `<b>추천 제목</b>`);
      titleSuggestions.forEach((title, index) => lines.push(`${index + 1}. ${escapeTelegramHtml(title)}`));
    }

    return lines.join("\n");
  }

  // ---------- 수신 루프 ----------

  /**
   * 저장된 offset 이후의 update를 한 번 받아 처리한다. launchd가 이 함수를 주기적으로 호출한다.
   *
   * update 하나가 실패해도 나머지를 계속 처리한다. 하나의 깨진 update가 이후 모든 클릭을 막으면
   * 안 되기 때문이다. 다만 offset은 성공/실패와 무관하게 전진시킨다 - 실패한 update를 영원히
   * 재시도하면 같은 지점에서 계속 막힌다.
   */
  async pollOnce(): Promise<{ processed: number; results: HandleCallbackResult[]; errors: string[] }> {
    const lastUpdateId = await TelegramOffsetRepository.getLastUpdateId(this.receiverId);
    const updates = await this.getUpdates(lastUpdateId === null ? undefined : lastUpdateId + 1);

    const results: HandleCallbackResult[] = [];
    const errors: string[] = [];
    let maxUpdateId = lastUpdateId ?? -1;

    for (const update of updates) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);

      if (!update.callback_query) continue;

      try {
        const result = await this.handleCallbackQuery(update.callback_query);
        results.push(result);
        await this.respondToCallback(update.callback_query, result);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`⚠️ update ${update.update_id} 처리 실패 -`, reason);
        errors.push(`update ${update.update_id}: ${reason}`);
      }
    }

    if (updates.length > 0 && maxUpdateId >= 0) {
      await TelegramOffsetRepository.setLastUpdateId(maxUpdateId, this.receiverId);
    }

    return { processed: updates.length, results, errors };
  }

  /**
   * 처리 결과를 사용자에게 알린다.
   *
   * answerCallbackQuery는 실패해도 무시한다: Telegram은 callback query에 약 15초 안에 응답하기를
   * 기대하는데, 주기적 폴링 방식에서는 그 시점에 이미 만료돼 있다. 버튼의 로딩 표시만 사라질 뿐
   * 아래의 확인 메시지 발송과 버튼 상태 갱신은 만료와 무관하게 동작한다.
   */
  private async respondToCallback(query: TelegramCallbackQuery, result: HandleCallbackResult): Promise<void> {
    if (result.outcome.status === "ignored") return;

    await this.answerCallbackQuery(query.id, result.message.slice(0, 200)).catch(() => {});

    if (result.outcome.status === "created" || result.outcome.status === "already_selected") {
      await this.markButtonSelected(query, result.outcome.job.source_rank).catch(() => {});
    }

    if (result.message) {
      await this.sendMessage(result.message);
    }
  }

  /** 선택된 버튼만 체크 표시로 바꾼다. 하루에 여러 건 고를 수 있어야 하므로 나머지는 그대로 둔다. */
  private async markButtonSelected(query: TelegramCallbackQuery, rank: number): Promise<void> {
    const keyboard = query.message?.reply_markup?.inline_keyboard;
    const messageId = query.message?.message_id;
    if (!keyboard || messageId === undefined) return;

    const selectedLabel = String(rank);
    const updated = keyboard.map((row) =>
      row.map((button) =>
        button.text === selectedLabel ? { ...button, text: `✅ ${selectedLabel}` } : button
      )
    );

    await this.post("editMessageReplyMarkup", {
      chat_id: this.chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: updated },
    });
  }

  // ---------- Telegram API ----------

  private async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      limit: UPDATES_LIMIT,
      // callback_query만 받는다. 일반 메시지까지 받으면 offset만 소모하고 처리할 것이 없다.
      allowed_updates: ["callback_query"],
    };
    if (offset !== undefined) body.offset = offset;

    const result = await this.post<TelegramUpdate[]>("getUpdates", body);
    return result ?? [];
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.post("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  async sendMessage(text: string): Promise<void> {
    await this.post("sendMessage", {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  private async post<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // 오류 응답 본문에는 credential이 포함되지 않으므로 그대로 노출해도 안전하다.
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Telegram ${method} 실패: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`
      );
    }

    const json = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} 실패: ${json.description ?? "알 수 없는 오류"}`);
    return json.result ?? null;
  }
}
