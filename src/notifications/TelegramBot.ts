// Telegram 수신기. 발송 전용인 TelegramNotifier와 의도적으로 분리한다.
//
// 구조 원칙(SPRINT_1_DESIGN.md 5~6절): handleCallbackQuery()는 "update가 어떻게 도착했는지"를
// 모른다. 지금은 launchd가 짧게 반복 실행하며 getUpdates로 긁어오지만, 나중에 webhook 서버로
// 바꿔도 핸들러는 그대로 쓴다. 그래서 수신 루프(pollOnce)와 처리(handleCallbackQuery)를 나눠 둔다.
//
// credential은 절대 로그로 출력하지 않는다.

import { getKeywordRankingByRunAndRank } from "../services/supabase/repositories/keywordRankingRepository.js";
import {
  listArticlesByJobId,
  updateArticleStatus as updateArticleStatusRepo,
} from "../services/supabase/repositories/articleRepository.js";
import { ArticleJobRepository } from "../repositories/ArticleJobRepository.js";
import { DEFAULT_TELEGRAM_RECEIVER_ID, TelegramOffsetRepository } from "../repositories/TelegramOffsetRepository.js";
import { runWritingStage } from "../workflows/writing/runArticleJob.js";
import { notifyArticleReady } from "../workflows/writing/notifyArticleReady.js";
import { rejectArticleJob } from "../workflows/writing/rejectArticleJob.js";
import { notifyImageBrief } from "../workflows/writing/notifyImageBrief.js";
import { escapeTelegramHtml } from "./TelegramNotifier.js";
import { parseArticleReviewCallbackData } from "./articleReviewCallbackData.js";
import { parseKeywordSelectionCallbackData } from "./telegramCallbackData.js";
import { parseResearchDecisionCallbackData } from "./researchDecisionCallbackData.js";
import type { CreateArticleJobResult } from "../repositories/ArticleJobRepository.js";
import type { ArticleReviewAction } from "./articleReviewCallbackData.js";
import type { ResearchDecisionAction } from "./researchDecisionCallbackData.js";
import type { ArticleJobRow, ArticleJobStatus, ArticleRow, ArticleStatus, KeywordRankingRow } from "../types/database.js";

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
  /** Go로 새 job을 만들었다. 제목 생성은 이때만 한다. */
  | { status: "created"; job: ArticleJobRow }
  /** Pass로 거부 이력을 남겼다. */
  | { status: "passed"; job: ArticleJobRow }
  /** 이미 같은 결정이 기록돼 있다(중복 클릭). */
  | { status: "unchanged"; job: ArticleJobRow }
  /** Pass -> Go 또는 Go -> Pass로 마음을 바꿨다. */
  | { status: "changed"; job: ArticleJobRow; from: ArticleJobStatus }
  /** 이미 작업이 진행돼 되돌릴 수 없다. */
  | { status: "locked"; job: ArticleJobRow };

export type HandleCallbackResult = {
  outcome: HandleCallbackOutcome;
  /** 사용자에게 보여줄 짧은 안내(토스트/확인 메시지에 쓴다). */
  message: string;
};

// ---------- 의학 주제 교차확인(원고 검수) callback ----------
// SPRINT_2_DESIGN.md 5-2절. 키워드 선택(위)과는 완전히 다른 대상(article_jobs.id 직접 지정)과
// 다른 액션 집합(confirm/edit/discard)을 다루므로 별도 outcome 타입으로 둔다.

export type HandleArticleReviewOutcome =
  | { status: "ignored"; reason: "not_a_review" | "wrong_chat" }
  | { status: "job_not_found" }
  | { status: "reviewed"; action: ArticleReviewAction; job: ArticleJobRow };

export type HandleArticleReviewResult = {
  outcome: HandleArticleReviewOutcome;
  message: string;
};

// ---------- 자료조사 체크포인트(진행/중단) callback ----------
// SPRINT_2_DESIGN.md 13-3절 ①, 2026-08-28 추가. review(위)와도 완전히 다른 액션 집합
// (write/reject)이라 별도 outcome 타입으로 둔다. write는 review의 confirm/edit/discard와 달리
// 가벼운 상태 변경이 아니라 실제로 runWritingStage(최대 수 분)를 호출한다 - Go 버튼이 제목 생성
// (약 25초)을 콜백 처리 안에서 그대로 실행하는 것과 같은 패턴을 그대로 확장한 것이다.

export type TriggerWritingOutcome =
  | { status: "success" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export type HandleResearchDecisionOutcome =
  | { status: "ignored"; reason: "not_a_research_decision" | "wrong_chat" }
  | { status: "job_not_found" }
  /** 이미 조사 단계를 벗어난 job(중복 클릭 등) - write/reject 둘 다 다시 실행하지 않는다. */
  | { status: "already_final"; job: ArticleJobRow }
  | { status: "rejected"; job: ArticleJobRow }
  | { status: "write_result"; job: ArticleJobRow; result: TriggerWritingOutcome };

export type HandleResearchDecisionResult = {
  outcome: HandleResearchDecisionOutcome;
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

  // 아래는 테스트에서 DB 접근을 대체하기 위한 주입 지점이다.
  // 운영 호출은 전부 생략하고 기본 구현(실제 repository)을 쓴다.
  // buildDailyQueryPool의 loadActiveSeeds, runCreatorAdvisorCollection의 fetchCandidates와 같은 패턴.
  loadRanking?: (runId: number, rank: number) => Promise<KeywordRankingRow | null>;
  createJob?: (ranking: KeywordRankingRow, status: ArticleJobStatus) => Promise<CreateArticleJobResult>;
  saveTitles?: (jobId: string, titles: string[]) => Promise<void>;
  updateJobStatus?: (jobId: string, status: ArticleJobStatus) => Promise<ArticleJobRow | null>;
  /** 의학 교차확인 처리에 쓴다. jobId로 job을 직접 조회한다(키워드 선택과 달리 run/rank가 없다). */
  loadJobById?: (jobId: string) => Promise<ArticleJobRow | null>;
  mergeJobMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<ArticleJobRow | null>;
  /** 승인(confirm) 시 원고 상태도 함께 바꾸는 데 쓴다(SPRINT_3_DESIGN.md 8절). job의 최신 원고 1건을 찾는다. */
  findLatestArticleByJobId?: (jobId: string) => Promise<ArticleRow | null>;
  updateArticleStatus?: (articleId: number, status: ArticleStatus) => Promise<ArticleRow | null>;
  /**
   * 승인 직후 이미지 브리프를 만들어 보낸다(SPRINT_3_DESIGN.md 9절 "원고 확정 -> 브리프 전달").
   * best-effort다 - 실패해도 승인 자체는 이미 끝나 있어야 한다(호출자가 그렇게 처리한다).
   */
  sendImageBrief?: (jobId: string, article: ArticleRow, job: ArticleJobRow) => Promise<void>;
  /**
   * research:write 콜백에서 호출한다. 기본 구현은 job:write CLI와 동일하게 runWritingStage 후
   * 성공하면 notifyArticleReady로 알린다(원고 보기 버튼이 붙은 진짜 완료 메시지는 거기서 나간다).
   * 테스트에서는 실제 LLM/Telegram 호출 없이 결과만 주입한다.
   */
  triggerWriting?: (jobId: string) => Promise<TriggerWritingOutcome>;
  /** research:reject 콜백에서 호출한다. rejectJobCli.ts와 같은 함수를 쓴다. */
  rejectJob?: (jobId: string, reason: string) => Promise<Awaited<ReturnType<typeof rejectArticleJob>>>;
};

export class TelegramBot {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly receiverId: string;
  private readonly generateTitles?: (job: ArticleJobRow) => Promise<string[]>;
  private readonly loadRanking: (runId: number, rank: number) => Promise<KeywordRankingRow | null>;
  private readonly createJob: (ranking: KeywordRankingRow, status: ArticleJobStatus) => Promise<CreateArticleJobResult>;
  private readonly saveTitles: (jobId: string, titles: string[]) => Promise<void>;
  private readonly updateJobStatus: (jobId: string, status: ArticleJobStatus) => Promise<ArticleJobRow | null>;
  private readonly loadJobById: (jobId: string) => Promise<ArticleJobRow | null>;
  private readonly mergeJobMetadata: (jobId: string, patch: Record<string, unknown>) => Promise<ArticleJobRow | null>;
  private readonly findLatestArticleByJobId: (jobId: string) => Promise<ArticleRow | null>;
  private readonly updateArticleStatus: (articleId: number, status: ArticleStatus) => Promise<ArticleRow | null>;
  private readonly sendImageBrief: (jobId: string, article: ArticleRow, job: ArticleJobRow) => Promise<void>;
  private readonly triggerWriting: (jobId: string) => Promise<TriggerWritingOutcome>;
  private readonly rejectJob: (jobId: string, reason: string) => Promise<Awaited<ReturnType<typeof rejectArticleJob>>>;

  constructor(options: TelegramBotOptions) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.receiverId = options.receiverId ?? DEFAULT_TELEGRAM_RECEIVER_ID;
    this.generateTitles = options.generateTitles;
    this.loadRanking = options.loadRanking ?? getKeywordRankingByRunAndRank;
    this.createJob =
      options.createJob ?? ((ranking, status) => ArticleJobRepository.createFromRanking(ranking, { status }));
    this.saveTitles =
      options.saveTitles ??
      (async (jobId, titles) => {
        await ArticleJobRepository.mergeMetadata(jobId, { titleSuggestions: titles });
      });
    this.updateJobStatus =
      options.updateJobStatus ?? ((jobId, status) => ArticleJobRepository.updateStatus(jobId, status));
    this.loadJobById = options.loadJobById ?? ((jobId) => ArticleJobRepository.findById(jobId));
    this.mergeJobMetadata =
      options.mergeJobMetadata ?? ((jobId, patch) => ArticleJobRepository.mergeMetadata(jobId, patch));
    this.findLatestArticleByJobId =
      options.findLatestArticleByJobId ??
      (async (jobId) => {
        const articles = await listArticlesByJobId(jobId);
        return articles[articles.length - 1] ?? null;
      });
    this.updateArticleStatus =
      options.updateArticleStatus ?? ((articleId, status) => updateArticleStatusRepo(articleId, status));
    this.sendImageBrief =
      options.sendImageBrief ??
      (async (jobId, article, job) => {
        const seoDescription = job.metadata.seoDescription;
        const result = await notifyImageBrief(jobId, {
          title: article.title ?? job.keyword,
          keyword: job.keyword,
          category: job.category,
          seoDescription: typeof seoDescription === "string" ? seoDescription : null,
        });
        if (result.status === "failed") {
          console.error("⚠️ 이미지 브리프 발송 실패 (승인 자체는 정상 처리됨) -", result.error);
        }
      });
    this.triggerWriting =
      options.triggerWriting ??
      (async (jobId) => {
        const result = await runWritingStage(jobId);
        if (result.status === "success") {
          // 원고 보기 버튼이 붙은 진짜 완료 메시지는 여기서 나간다 - handleResearchDecisionCallback은
          // 짧은 확인 문구만 추가로 보낸다(respondToResearchDecision 참고).
          await notifyArticleReady(result);
          return { status: "success" };
        }
        if (result.status === "skipped") return { status: "skipped", reason: result.reason };
        return { status: "failed", error: result.error };
      });
    this.rejectJob = options.rejectJob ?? ((jobId, reason) => rejectArticleJob(jobId, reason, "telegram"));
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

    const desiredStatus: ArticleJobStatus = parsed.action === "go" ? "selected" : "rejected";
    const { job, created } = await this.createJob(ranking, desiredStatus);

    if (created) {
      // Pass는 거부 이력만 남기면 끝이다 - 원고를 쓰지 않을 키워드에 LLM을 쓸 이유가 없다.
      if (parsed.action === "pass") {
        return { outcome: { status: "passed", job }, message: this.buildPassMessage(job) };
      }
      return this.completeGo(job);
    }

    // 여기부터는 이미 같은 (run, rank)에 결정이 기록돼 있는 경우다.
    if (job.status === desiredStatus) {
      return {
        outcome: { status: "unchanged", job },
        message: parsed.action === "go" ? `이미 선택한 키워드입니다.` : `이미 넘긴 키워드입니다.`,
      };
    }

    // 이미 조사/집필이 시작된 job은 되돌리지 않는다. 진행 중인 작업이 버튼 한 번에 사라지면 안 된다.
    if (job.status !== "selected" && job.status !== "rejected") {
      return {
        outcome: { status: "locked", job },
        message: `이미 진행 중이라 변경할 수 없습니다 (상태: ${job.status})`,
      };
    }

    // selected <-> rejected는 서로 바꿀 수 있다. 잘못 눌렀을 때 되돌릴 방법이 없으면 안 된다.
    const from = job.status;
    const updated = (await this.updateJobStatus(job.id, desiredStatus)) ?? job;

    if (parsed.action === "pass") {
      return { outcome: { status: "changed", job: updated, from }, message: this.buildPassMessage(updated) };
    }

    // rejected -> selected로 되돌렸으면 이제 제목이 필요하다.
    const result = await this.completeGo(updated);
    return { outcome: { status: "changed", job: updated, from }, message: result.message };
  }

  /** Go 확정 처리: 제목을 만들어 저장하고 확인 메시지를 만든다. */
  private async completeGo(job: ArticleJobRow): Promise<HandleCallbackResult> {
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

  private buildPassMessage(job: ArticleJobRow): string {
    return `⏭ <b>넘김</b>\n${escapeTelegramHtml(job.keyword)}`;
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

  // ---------- 의학 주제 교차확인(원고 검수) ----------
  // SPRINT_2_DESIGN.md 5-2절. runArticleJob이 의학 주제로 판정한 원고는
  // article_jobs.metadata.requiresMedicalReview=true로 표시된다.
  //
  // 승인 버튼은 모든 원고 공통이다(SPRINT_3_DESIGN.md 8절, 2026-08-28): 예전에는 confirm이
  // requiresMedicalReview만 내리고 job.status는 건드리지 않았다("발행 승인은 이후 검수 단계에서
  // 이어집니다"). 이제 confirm 자체가 그 승인이다 - job.status와 최신 article.status를
  // approved로 전이시킨다. 의학 주제는 여기에 한 겹을 더한다: requiresMedicalReview가 켜져
  // 있으면 승인 시 그것도 함께 내린다. 버튼을 두 벌(발행 승인 / 의학 확인) 만들지 않는 이유는
  // 화면에 버튼 6개가 뜨면 무엇을 눌러야 하는지 알 수 없기 때문이다.
  //
  // ⚠️ 이 변경은 기존 의미를 바꾼다: 이 통합 이전에 confirm이 눌린 job은 requiresMedicalReview만
  // 내려가고 status는 review에 남아 있다 - approved로 만들려면 다시 confirm을 눌러야 한다.

  /**
   * "review:<action>:<jobId>" callback을 처리한다. handleCallbackQuery(키워드 선택)와 완전히
   * 다른 대상·액션 집합이라 별도 메서드로 둔다 - pollOnce가 키워드 선택 파싱이 실패했을 때만
   * 이걸 시도한다.
   */
  async handleArticleReviewCallback(query: TelegramCallbackQuery): Promise<HandleArticleReviewResult> {
    const parsed = parseArticleReviewCallbackData(query.data);
    if (!parsed) {
      return { outcome: { status: "ignored", reason: "not_a_review" }, message: "" };
    }

    const fromChatId = query.message?.chat?.id;
    if (fromChatId !== undefined && String(fromChatId) !== this.chatId) {
      return { outcome: { status: "ignored", reason: "wrong_chat" }, message: "" };
    }

    const job = await this.loadJobById(parsed.jobId);
    if (!job) {
      return { outcome: { status: "job_not_found" }, message: "해당 원고를 찾을 수 없습니다(이미 정리됐을 수 있습니다)." };
    }

    if (parsed.action === "discard") {
      const updated = (await this.updateJobStatus(job.id, "rejected")) ?? job;
      await this.mergeJobMetadata(job.id, {
        reviewDecision: "discarded",
        reviewedAt: new Date().toISOString(),
        // 의학 주제였다면 이력에도 남긴다(구 필드명 유지 - 과거 job과 조회 방식을 맞춘다).
        ...(job.metadata.requiresMedicalReview
          ? { medicalReviewDecision: "discarded", medicalReviewedAt: new Date().toISOString() }
          : {}),
      });
      return {
        outcome: { status: "reviewed", action: "discard", job: updated },
        message: `🗑 <b>반려됨</b>\n${escapeTelegramHtml(job.keyword)}`,
      };
    }

    if (parsed.action === "edit") {
      // job.status는 review에 남긴다(승인 아님) - "확인했지만 손볼 곳이 있다"는 뜻이라, 실제로
      // 수정된 뒤 다시 confirm이 눌릴 때까지 계속 검수 대기 상태여야 한다. requiresMedicalReview도
      // 켜져 있었다면 그대로 true로 남긴다(같은 이유).
      const timestamp = new Date().toISOString();
      await this.mergeJobMetadata(job.id, {
        reviewDecision: "needs_edit",
        reviewedAt: timestamp,
        ...(job.metadata.requiresMedicalReview
          ? { medicalReviewDecision: "needs_edit", medicalReviewedAt: timestamp }
          : {}),
      });
      return {
        outcome: { status: "reviewed", action: "edit", job },
        message: `✏️ <b>수정 필요로 표시함</b>\n${escapeTelegramHtml(job.keyword)}\n수정 후 원고를 다시 만들어주세요.`,
      };
    }

    // confirm: 승인이다. job.status와 최신 article.status를 approved로 전이시킨다.
    const timestamp = new Date().toISOString();
    const wasMedical = Boolean(job.metadata.requiresMedicalReview);

    await this.mergeJobMetadata(job.id, {
      reviewDecision: "confirmed",
      reviewedAt: timestamp,
      ...(wasMedical
        ? { requiresMedicalReview: false, medicalReviewDecision: "confirmed", medicalReviewedAt: timestamp }
        : {}),
    });
    const updated = (await this.updateJobStatus(job.id, "approved")) ?? job;

    const article = await this.findLatestArticleByJobId(job.id);
    if (article) {
      await this.updateArticleStatus(article.id, "approved");
      // 이미지 브리프는 부가 단계다 - 실패해도 승인 결과(outcome/message)에 영향을 주지 않는다.
      // 별도 메시지로 나가므로 여기서 기다리되(순서상 승인 메시지 다음에 도착), 예외를 밖으로
      // 던지면 안 된다(sendImageBrief 기본 구현이 이미 내부에서 잡는다).
      await this.sendImageBrief(job.id, article, job).catch((error) => {
        console.error("⚠️ 이미지 브리프 처리 중 예외 (승인 자체는 정상 처리됨) -", error);
      });
    }

    return {
      outcome: { status: "reviewed", action: "confirm", job: updated },
      message:
        `✅ <b>승인됨</b>\n${escapeTelegramHtml(job.keyword)}` +
        (wasMedical ? "\n의학 정보 교차확인도 함께 완료됐습니다." : ""),
    };
  }

  // ---------- 자료조사 체크포인트(진행/중단) ----------
  // SPRINT_2_DESIGN.md 13-3절 ①, 2026-08-28 추가.

  /** job이 아직 조사 단계에 머물러 있는지(write/reject 둘 다 아직 유효한지) 확인한다. */
  private isStillAtResearchCheckpoint(job: ArticleJobRow): boolean {
    return job.status === "researching" || job.status === "selected";
  }

  /**
   * "research:<action>:<jobId>" callback을 처리한다. handleCallbackQuery/handleArticleReviewCallback과
   * 완전히 다른 대상·액션 집합이라 별도 메서드로 둔다 - pollOnce가 둘 다 실패했을 때만 이걸 시도한다.
   */
  async handleResearchDecisionCallback(query: TelegramCallbackQuery): Promise<HandleResearchDecisionResult> {
    const parsed = parseResearchDecisionCallbackData(query.data);
    if (!parsed) {
      return { outcome: { status: "ignored", reason: "not_a_research_decision" }, message: "" };
    }

    const fromChatId = query.message?.chat?.id;
    if (fromChatId !== undefined && String(fromChatId) !== this.chatId) {
      return { outcome: { status: "ignored", reason: "wrong_chat" }, message: "" };
    }

    const job = await this.loadJobById(parsed.jobId);
    if (!job) {
      return { outcome: { status: "job_not_found" }, message: "해당 job을 찾을 수 없습니다(이미 정리됐을 수 있습니다)." };
    }

    if (!this.isStillAtResearchCheckpoint(job)) {
      // 중복 클릭이거나, 이미 다른 경로(터미널 등)로 write/reject가 끝난 뒤 눌린 경우다.
      return {
        outcome: { status: "already_final", job },
        message: `⏭ 이미 처리된 job입니다 (상태: ${job.status})`,
      };
    }

    if (parsed.action === "reject") {
      const result = await this.rejectJob(job.id, "Telegram 버튼으로 중단");
      // result.status는 위 isStillAtResearchCheckpoint 확인 직후라 사실상 항상 "rejected"이지만,
      // 두 확인 사이에 다른 경로로 상태가 바뀌는 경합을 대비해 방어적으로 분기한다.
      if (result.status !== "rejected") {
        return {
          outcome: { status: "already_final", job },
          message: `⏭ 이미 처리된 job입니다 (상태: ${job.status})`,
        };
      }
      return {
        outcome: { status: "rejected", job: result.job },
        message: `🗑 <b>중단됨</b>\n${escapeTelegramHtml(job.keyword)}`,
      };
    }

    // write: runWritingStage(최대 수 분)를 실제로 실행한다. 완료/실패와 무관하게 예외를 밖으로
    // 던지지 않는다(triggerWriting의 기본 구현이 이미 그렇게 되어 있다) - pollOnce가 이 update
    // 하나 때문에 죽으면 이후 update가 전부 막힌다.
    const writeResult = await this.triggerWriting(job.id);

    if (writeResult.status === "success") {
      // 원고 보기 버튼이 붙은 진짜 완료 메시지는 triggerWriting 안에서 이미 발송됐다(notifyArticleReady).
      // 여기서 또 보내면 중복이라 빈 메시지를 돌린다 - respondToResearchDecision이 빈 메시지는 안 보낸다.
      return { outcome: { status: "write_result", job, result: writeResult }, message: "" };
    }
    if (writeResult.status === "skipped") {
      return {
        outcome: { status: "write_result", job, result: writeResult },
        message: `⏭ 건너뜀: ${escapeTelegramHtml(writeResult.reason)}`,
      };
    }
    return {
      outcome: { status: "write_result", job, result: writeResult },
      message: `❌ <b>원고 작성 실패</b>\n${escapeTelegramHtml(job.keyword)}\n${escapeTelegramHtml(writeResult.error)}`,
    };
  }

  /**
   * confirm/edit/discard 버튼을 눌린 결과로 갱신한다. 세 버튼 모두 남기되(재확인 흐름을 위해)
   * 눌린 버튼만 체크 표시로 바꾼다.
   */
  private async markReviewButtonsDecided(query: TelegramCallbackQuery, action: ArticleReviewAction): Promise<void> {
    const keyboard = query.message?.reply_markup?.inline_keyboard;
    const messageId = query.message?.message_id;
    if (!keyboard || messageId === undefined) return;

    const LABELS: Record<ArticleReviewAction, string> = {
      confirm: "승인",
      edit: "수정 필요",
      discard: "반려",
    };

    const updated = keyboard.map((row) =>
      row.map((button) => {
        const parsedButton = parseArticleReviewCallbackData(button.callback_data);
        if (!parsedButton) return button;

        const selected = parsedButton.action === action;
        return { ...button, text: selected ? `✅ ${LABELS[parsedButton.action]}` : LABELS[parsedButton.action] };
      })
    );

    await this.post("editMessageReplyMarkup", {
      chat_id: this.chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: updated },
    });
  }

  /**
   * 원고 작성/중단 버튼을 눌린 결과로 갱신한다. reject 실패 후 재시도가 막히는 것과 달리(위
   * handleResearchDecisionCallback 주석 참고), write 실패 시 job.status가 "writing"으로 남아
   * 버튼으로는 재시도할 수 없다(체크포인트 상태 확인을 벗어난다) - 그래도 버튼은 눌린 채로 표시해
   * 사용자가 무엇을 눌렀는지 알 수 있게 한다. 재시도는 `npm run job:write -- <jobId>`로 한다.
   */
  private async markResearchButtonsDecided(query: TelegramCallbackQuery, action: ResearchDecisionAction): Promise<void> {
    const keyboard = query.message?.reply_markup?.inline_keyboard;
    const messageId = query.message?.message_id;
    if (!keyboard || messageId === undefined) return;

    const LABELS: Record<ResearchDecisionAction, string> = {
      write: "원고 작성",
      reject: "중단",
    };

    const updated = keyboard.map((row) =>
      row.map((button) => {
        const parsedButton = parseResearchDecisionCallbackData(button.callback_data);
        if (!parsedButton) return button;

        const selected = parsedButton.action === action;
        return { ...button, text: selected ? `✅ ${LABELS[parsedButton.action]}` : LABELS[parsedButton.action] };
      })
    );

    await this.post("editMessageReplyMarkup", {
      chat_id: this.chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: updated },
    });
  }

  // ---------- 수신 루프 ----------

  /**
   * 저장된 offset 이후의 update를 한 번 받아 처리한다. launchd가 이 함수를 주기적으로 호출한다.
   *
   * update 하나가 실패해도 나머지를 계속 처리한다. 하나의 깨진 update가 이후 모든 클릭을 막으면
   * 안 되기 때문이다. 다만 offset은 성공/실패와 무관하게 전진시킨다 - 실패한 update를 영원히
   * 재시도하면 같은 지점에서 계속 막힌다.
   */
  async pollOnce(): Promise<{
    processed: number;
    results: HandleCallbackResult[];
    reviewResults: HandleArticleReviewResult[];
    researchDecisionResults: HandleResearchDecisionResult[];
    errors: string[];
  }> {
    const lastUpdateId = await TelegramOffsetRepository.getLastUpdateId(this.receiverId);
    const updates = await this.getUpdates(lastUpdateId === null ? undefined : lastUpdateId + 1);

    const results: HandleCallbackResult[] = [];
    const reviewResults: HandleArticleReviewResult[] = [];
    const researchDecisionResults: HandleResearchDecisionResult[] = [];
    const errors: string[] = [];
    let maxUpdateId = lastUpdateId ?? -1;

    for (const update of updates) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);

      if (!update.callback_query) continue;

      try {
        const result = await this.handleCallbackQuery(update.callback_query);

        // 키워드 선택 형식이 아니면(우리 버튼이 아니거나 "review:"/"research:" 형식) 다음 파서를
        // 시도한다. 세 파서는 서로 배타적이라(각 test*CallbackData.ts로 확인) 이중 처리 위험이 없다.
        if (result.outcome.status === "ignored" && result.outcome.reason === "not_a_selection") {
          const reviewResult = await this.handleArticleReviewCallback(update.callback_query);
          if (reviewResult.outcome.status !== "ignored") {
            reviewResults.push(reviewResult);
            await this.respondToArticleReview(update.callback_query, reviewResult);
            continue;
          }

          const researchResult = await this.handleResearchDecisionCallback(update.callback_query);
          if (researchResult.outcome.status !== "ignored") {
            researchDecisionResults.push(researchResult);
            await this.respondToResearchDecision(update.callback_query, researchResult);
            continue;
          }
        }

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

    return { processed: updates.length, results, reviewResults, researchDecisionResults, errors };
  }

  /** respondToCallback과 같은 원칙(§answerCallbackQuery 만료 무시)으로 검수 결과를 알린다. */
  private async respondToArticleReview(query: TelegramCallbackQuery, result: HandleArticleReviewResult): Promise<void> {
    if (result.outcome.status === "ignored") return;

    await this.answerCallbackQuery(query.id, result.message.replace(/<[^>]+>/g, "").slice(0, 200)).catch(() => {});

    if (result.outcome.status === "reviewed") {
      await this.markReviewButtonsDecided(query, result.outcome.action).catch(() => {});
    }

    if (result.message) {
      await this.sendMessage(result.message);
    }
  }

  /**
   * respondToArticleReview와 같은 원칙(§answerCallbackQuery 만료 무시)으로 조사 체크포인트
   * 결정을 알린다. write는 처리에 최대 수 분이 걸리므로 answerCallbackQuery는 거의 항상 만료돼
   * 있다 - 로딩 표시만 사라질 뿐이고, 실제 완료 알림은 triggerWriting 내부(notifyArticleReady)에서
   * 별도로 나간다.
   */
  private async respondToResearchDecision(query: TelegramCallbackQuery, result: HandleResearchDecisionResult): Promise<void> {
    if (result.outcome.status === "ignored") return;

    await this.answerCallbackQuery(query.id, result.message.replace(/<[^>]+>/g, "").slice(0, 200) || "처리 중...").catch(() => {});

    if (result.outcome.status === "rejected") {
      await this.markResearchButtonsDecided(query, "reject").catch(() => {});
    }
    if (result.outcome.status === "write_result") {
      await this.markResearchButtonsDecided(query, "write").catch(() => {});
    }

    if (result.message) {
      await this.sendMessage(result.message);
    }
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

    const decided = result.outcome;
    if (
      decided.status === "created" ||
      decided.status === "passed" ||
      decided.status === "unchanged" ||
      decided.status === "changed"
    ) {
      await this.markButtonDecided(query, decided.job.status).catch(() => {});
    }

    if (result.message) {
      await this.sendMessage(result.message);
    }
  }

  /**
   * 결정된 항목의 버튼을 상태 표시로 바꾼다. 항목마다 메시지가 따로 있으므로 그 메시지의
   * 버튼 두 개(Go/Pass)만 갱신하면 된다.
   *
   * 버튼을 지우지 않고 남겨두는 이유: 잘못 눌렀을 때 반대쪽을 눌러 되돌릴 수 있어야 한다
   * (handleCallbackQuery가 selected <-> rejected 전환을 지원한다).
   */
  private async markButtonDecided(query: TelegramCallbackQuery, status: ArticleJobStatus): Promise<void> {
    const keyboard = query.message?.reply_markup?.inline_keyboard;
    const messageId = query.message?.message_id;
    if (!keyboard || messageId === undefined) return;

    const chosen = status === "rejected" ? "pass" : "go";
    const updated = keyboard.map((row) =>
      row.map((button) => {
        const isGo = button.callback_data?.startsWith("go:") || button.callback_data?.startsWith("sel:");
        const isPass = button.callback_data?.startsWith("pass:");
        if (!isGo && !isPass) return button;

        const selected = (isGo && chosen === "go") || (isPass && chosen === "pass");
        const label = isGo ? "Go" : "Pass";
        return { ...button, text: selected ? `✅ ${label}` : isGo ? "✍️ Go" : "⏭ Pass" };
      })
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
