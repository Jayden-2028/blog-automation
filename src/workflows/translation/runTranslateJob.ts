// 사용설명서 트랙의 한→영 번역 단계 `job-translate`(개편3 §4.3-2).
//
// 상태 기계(job.metadata.ksceneStage - 컬럼이 아니라 jsonb라 migration이 필요 없다):
//   (없음)            한글 초고 검수 중. 한글 ✅ 승인이 눌리면 TelegramBot이 "translating"으로 바꾸고 이 job을 띄운다.
//   translating       영어본 생성 중(이 함수가 도는 동안).
//   english_review    영어본 재승인 대기. ✅ 승인이면 job이 approved가 되고 이미지·발행 준비가 이어진다.
//   translation_failed 생성 실패. 알림의 "다시 만들기" 버튼이 같은 ✅ 콜백으로 다시 띄운다.
// job.status는 이 단계 내내 `review`다 - 영어본이 승인되기 전에는 이미지 비용도, 발행 버튼도 열리지 않는다.
//
// 영어본은 **새 article 행**(platform="blogspot")이다. pickFinalArticle이 "기준 원고보다 새로운 blogspot 배리에이션"을
// 최종본으로 고르므로, 준비(prepareManuscript)·발행(publishArticleToBlogspot)이 코드 변경 없이 영어본을 읽는다.
// 한글 원고는 기준 행으로 그대로 남는다(번역 재시도·수정 요청 때 다시 원본이 된다).

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { isAutoApproved, shouldSkipEnglishReview } from "../../config/pipelineGate.js";
import { notifierForJob } from "../../notifications/notifierForJob.js";
import { autoApproveDraft } from "../writing/autoApproveDraft.js";
import { applyUnifiedRevision } from "../writing/applyUnifiedRevision.js";
import type { AutoApproveResult } from "../writing/autoApproveDraft.js";
import type { ApplyUnifiedRevisionResult } from "../writing/applyUnifiedRevision.js";
import { escapeTelegramHtml } from "../../notifications/TelegramNotifier.js";
import { trackOfJob } from "../../notifications/telegramTracks.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { describeError } from "../../services/describeError.js";
import { createArticleForJob, listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { publishArticleToTelegraph } from "../../services/telegraph/telegraphClient.js";
import { splitTrailingHashtags } from "../manuscripts/articleContentParts.js";
import { ksceneStageOf } from "./ksceneStage.js";
import { buildTranslationPrompt } from "./buildTranslationPrompt.js";
import { buildEnglishReviewMarkdown, notifyEnglishReview, notifyTranslationFailed } from "./notifyEnglishReview.js";
import { parseTranslationOutput, validateTranslation } from "./parseTranslationOutput.js";
import type { ParsedTranslation } from "./parseTranslationOutput.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

/** 번역은 도구 없이 텍스트만 변환하지만 원고가 길어 넉넉히 잡는다. */
export const TRANSLATE_TIMEOUT_MS = 15 * 60 * 1000;
/** 계약 검증 실패 시 한 번 더 시도한다(오류 목록을 프롬프트에 되먹인다). */
export const MAX_TRANSLATE_ATTEMPTS = 2;

/** 영어 원고를 담는 article의 platform 값. pickFinalArticle의 LEGACY_BLOGSPOT_PLATFORM과 같다. */
export const ENGLISH_ARTICLE_PLATFORM = "blogspot";

export { ksceneStageOf } from "./ksceneStage.js";
export type { KsceneStage } from "./ksceneStage.js";

export type RunTranslateJobOptions = {
  /** 영어본 재승인 단계의 "수정 필요" 답장. 있으면 직전 영어본을 이 방향으로 다시 쓴다. */
  feedback?: string | null;
  // ---- 테스트 주입 ----
  loadJob?: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles?: (jobId: string) => Promise<ArticleRow[]>;
  runTranslator?: (prompt: string) => Promise<{ ok: true; output: string } | { ok: false; error: string }>;
  saveArticle?: (input: { jobId: string; title: string; content: string }) => Promise<ArticleRow>;
  mergeMetadata?: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
  publishTelegraph?: (title: string, markdown: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  notifyReview?: typeof notifyEnglishReview;
  notifyFailure?: typeof notifyTranslationFailed;
  guide?: string;
  now?: () => Date;
  /** 게이트 환경변수(PIPELINE_SKIP_DRAFT_REVIEW). 생략하면 process.env. */
  env?: NodeJS.ProcessEnv;
  /** 영어본 자동 승인 + 원고 준비 발화(통합 흐름, 최초 번역). */
  autoApprove?: (target: { jobId: string; articleId: number }) => Promise<AutoApproveResult>;
  /** 이미 자동 승인된 job의 영어본 수정 반영(이미지 마커 diff + 원고 준비 재발화). */
  applyRevision?: (job: ArticleJobRow, beforeBody: string, afterBody: string) => Promise<ApplyUnifiedRevisionResult>;
  /** 통합 흐름에서 사용자에게 보낼 단순 안내(실패·발화 실패). */
  notifyText?: (job: ArticleJobRow, text: string) => Promise<void>;
};

export type RunTranslateJobResult =
  | { status: "success"; article: ArticleRow; parsed: ParsedTranslation; attempts: number; telegraphUrl: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

type DraftMeta = { searchDescription?: unknown; slug?: unknown; shortName?: unknown; tags?: unknown };

export async function runTranslateJob(jobId: string, options: RunTranslateJobOptions = {}): Promise<RunTranslateJobResult> {
  const loadJob = options.loadJob ?? ((id) => ArticleJobRepository.findById(id));
  const loadArticles = options.loadArticles ?? listArticlesByJobId;
  const runTranslator =
    options.runTranslator ??
    (async (prompt: string) => {
      const result = await runHeadlessClaude({ prompt, timeoutMs: TRANSLATE_TIMEOUT_MS });
      return result.ok ? { ok: true as const, output: result.output } : { ok: false as const, error: result.error };
    });
  const saveArticle =
    options.saveArticle ??
    ((input) =>
      createArticleForJob({
        job_id: input.jobId,
        title: input.title,
        content: input.content,
        status: skipEnglishReview ? "approved" : "review",
        platform: ENGLISH_ARTICLE_PLATFORM,
        ai_model: "claude-headless(translate ko-en)",
      }));
  const mergeMetadata = options.mergeMetadata ?? ((id, patch) => ArticleJobRepository.mergeMetadata(id, patch));
  const publishTelegraph = options.publishTelegraph ?? publishArticleToTelegraph;
  const notifyReview = options.notifyReview ?? notifyEnglishReview;
  const notifyFailure = options.notifyFailure ?? notifyTranslationFailed;
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const autoApprove = options.autoApprove ?? ((target) => autoApproveDraft(target));
  const applyRevision = options.applyRevision ?? ((j, before, after) => applyUnifiedRevision(j, before, after));
  const notifyText =
    options.notifyText ??
    (async (j: ArticleJobRow, text: string) => {
      await notifierForJob(j).sendMessages([{ text }]);
    });

  const job = await loadJob(jobId);
  if (!job) return { status: "skipped", reason: `job을 찾을 수 없습니다: ${jobId}` };
  if (trackOfJob(job) !== "kscene") return { status: "skipped", reason: "사용설명서(kscene) 트랙 job이 아닙니다" };
  // 통합 흐름: 영어본이 자동 승인(approved)된 뒤의 수정 요청도 받는다(영어본 수정 -> 이미지 마커 diff -> 다시 발행 알림).
  const unifiedRevision = job.status === "approved" && isAutoApproved(job);
  if (job.status !== "review" && !unifiedRevision) return { status: "skipped", reason: `검수 단계가 아닙니다 (상태: ${job.status})` };
  // 최초 번역이 끝나면 영어 재승인을 건너뛰고 곧바로 승인으로 잇는가.
  const skipEnglishReview = unifiedRevision || shouldSkipEnglishReview(job, env);

  const stage = ksceneStageOf(job);
  const feedback = options.feedback?.trim() || null;
  // 한글 승인 뒤(translating) 또는 재번역(수정 요청 english_review / 실패 재시도 translation_failed)만 허용한다.
  if (stage === null) return { status: "skipped", reason: "한글 원고 승인 전입니다" };
  if (stage === "english_review" && !feedback) return { status: "skipped", reason: "이미 영어본이 준비돼 있습니다(수정 요청 없이 다시 만들지 않습니다)" };

  const failWith = async (error: string): Promise<RunTranslateJobResult> => {
    if (unifiedRevision) {
      // 이미 승인된 영어본 - "다시 만들기" 버튼(✅ 콜백)은 approved job에서 막히므로 쓰지 않는다. 직전 영어본은 그대로 유효하다.
      await mergeMetadata(jobId, { ksceneStage: "english_review", lastError: `[translate] ${error}` });
      await notifyText(
        job,
        `⚠️ <b>영어본 수정 반영 실패</b>\n${escapeTelegramHtml(job.keyword)}\n\n${escapeTelegramHtml(error.slice(0, 600))}\n\n` +
          `직전 영어본은 그대로입니다. 원고 알림의 "✏️ 수정 요청"으로 다시 시도해 주세요.`
      ).catch((notifyError) => console.error(`⚠️ [translate] 실패 알림 발송 실패: ${describeError(notifyError)}`));
      return { status: "failed", error };
    }
    // 한글 원고는 승인된 채 남기고 "다시 만들기" 버튼을 보낸다(알림 실패는 삼킨다 - 원인은 metadata에 남는다).
    await mergeMetadata(jobId, { ksceneStage: "translation_failed", lastError: `[translate] ${error}` });
    await notifyFailure(job, error).catch((notifyError) =>
      console.error(`⚠️ [translate] 실패 알림 발송 실패: ${describeError(notifyError)}`)
    );
    return { status: "failed", error };
  };

  try {
    const articles = await loadArticles(jobId);
    const base = [...articles].reverse().find((article) => article.platform == null);
    if (!base?.content) return await failWith("한글 기준 원고를 찾을 수 없습니다");
    const previousEnglish = [...articles].reverse().find((article) => article.platform === ENGLISH_ARTICLE_PLATFORM && article.id > base.id) ?? null;

    const { body: koreanBody, tags: koreanTags } = splitTrailingHashtags(base.content);
    const draftMeta = (job.metadata?.draftMeta ?? {}) as DraftMeta;
    const koreanSearchDescription = typeof draftMeta.searchDescription === "string" ? draftMeta.searchDescription : null;

    await mergeMetadata(jobId, { ksceneStage: "translating", translateStartedAt: now().toISOString() });

    let parsed: ParsedTranslation | null = null;
    let retryErrors: string[] | null = null;
    let attempts = 0;
    let lastError = "";

    while (attempts < MAX_TRANSLATE_ATTEMPTS && !parsed) {
      attempts += 1;
      const prompt = buildTranslationPrompt({
        keyword: job.keyword,
        koreanTitle: base.title ?? job.keyword,
        koreanSearchDescription,
        koreanBody,
        koreanTags,
        feedback,
        previousEnglishBody: feedback && previousEnglish?.content ? splitTrailingHashtags(previousEnglish.content).body : null,
        retryErrors,
        guide: options.guide,
      });

      const ran = await runTranslator(prompt);
      if (!ran.ok) {
        lastError = ran.error;
        continue; // 실행 실패(타임아웃·한도)도 한 번 더 시도한다
      }
      const result = parseTranslationOutput(ran.output);
      const errors = result.ok ? validateTranslation({ koreanBody, parsed: result.parsed }) : result.errors;
      if (errors.length === 0 && result.ok) {
        parsed = result.parsed;
      } else {
        retryErrors = errors;
        lastError = `계약 위반: ${errors.join(" / ")}`;
        console.warn(`⚠️ [translate] ${attempts}번째 시도 검증 실패 - ${lastError}`);
      }
    }
    if (!parsed) return await failWith(lastError || "번역 결과를 받지 못했습니다");

    // 영어 원고 저장: **본문만**(해시태그 줄 없음). 태그는 channelMeta.blogspot.tags에 둔다 - prepareManuscript의
    // "배리에이션 재사용" 경로가 content를 그대로 뷰어 본문으로 쓰므로, 줄 끝 태그가 본문에 섞여 보이면 안 된다.
    const article = await saveArticle({ jobId, title: parsed.title, content: parsed.body });

    // 통합 흐름(2026-10-12)에서는 영어본 단독 알림이 없으니 Telegraph 미리보기도 만들지 않는다.
    let telegraphUrl: string | null = null;
    if (!skipEnglishReview) {
      const telegraph = await publishTelegraph(parsed.title, buildEnglishReviewMarkdown(parsed.body, parsed.koSummary));
      telegraphUrl = telegraph.ok ? telegraph.url : null;
      if (!telegraph.ok) console.error(`⚠️ [translate] Telegraph 발행 실패(본문 dump로 폴백): ${telegraph.error}`);
    }

    // 발행 메타(검색 설명·slug·태그)는 영어 값으로 channelMeta.blogspot에 둔다 - prepareManuscript가 "배리에이션 재사용"
    // 경로에서 이 자리를 읽는다. channelMeta는 다른 키가 있을 수 있어 통째로 덮지 않고 합친다.
    const channelMeta = (job.metadata?.channelMeta ?? {}) as Record<string, unknown>;
    await mergeMetadata(jobId, {
      ksceneStage: "english_review",
      reviewDecision: null,
      reviewedAt: null,
      editRequestMessageId: null,
      translationFeedback: null,
      lastError: null,
      // 통합 흐름: 영어본 승인 시각을 자동 기록한다(옛 흐름에서는 영어본 ✅ 콜백이 남기던 값). 수정 반영 땐 처음 값을 지킨다.
      ...(skipEnglishReview
        ? { englishApprovedAt: (job.metadata?.englishApprovedAt as string | undefined) ?? now().toISOString() }
        : {}),
      channelMeta: {
        ...channelMeta,
        blogspot: {
          searchDescription: parsed.searchDescription || null,
          slug: parsed.slug,
          tags: parsed.tags,
          shortName: typeof draftMeta.shortName === "string" ? draftMeta.shortName : null,
        },
      },
      translation: {
        articleId: article.id,
        translatedAt: now().toISOString(),
        attempts,
        title: parsed.title,
        koSummary: parsed.koSummary,
        telegraphUrl,
        revisedWithFeedback: Boolean(feedback),
      },
    });

    if (skipEnglishReview) {
      // 영어본 재승인 알림 대신 곧바로 원고 준비(이미지)로 잇는다 - 사람은 이미지가 붙은 영어본의 통합 알림(발행/수정/반려)에서 본다.
      const dispatchFailed = async (error: string): Promise<void> => {
        console.error(`⚠️ [translate] job-publish-prepare 발화 실패: ${error}`);
        await notifyText(
          job,
          `⚠️ <b>원고 준비 발화 실패</b>\n${escapeTelegramHtml(job.keyword)}\n\n영어본은 만들어졌습니다. GitHub Actions의 job-publish-prepare를 수동 실행해 주세요.`
        ).catch(() => {});
      };
      if (unifiedRevision) {
        const outcome = await applyRevision(job, previousEnglish?.content ?? "", parsed.body);
        if (!outcome.dispatched) await dispatchFailed(outcome.error ?? "알 수 없음");
        else
          await notifyText(
            job,
            `🔄 <b>영어본 수정을 반영했습니다</b>\n${escapeTelegramHtml(job.keyword)}\n\n` +
              (outcome.plan.kind === "keep"
                ? "이미지는 그대로 두고 원고만 다시 만듭니다. "
                : "이미지 마커가 바뀐 자리만 다시 구합니다. ") +
              "완료되면 발행 버튼과 함께 다시 보내드립니다."
          ).catch(() => {});
      } else {
        const outcome = await autoApprove({ jobId, articleId: article.id });
        if (!outcome.dispatched) await dispatchFailed(outcome.error);
      }
    } else {
      await notifyReview({
        job,
        englishTitle: parsed.title,
        koreanTitle: base.title,
        telegraphUrl,
        koSummary: parsed.koSummary,
        isRevision: Boolean(feedback),
        englishBody: parsed.body,
      });
    }

    return { status: "success", article, parsed, attempts, telegraphUrl };
  } catch (error) {
    return failWith(describeError(error));
  }
}
