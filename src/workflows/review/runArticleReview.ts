// 검수 규칙 4종을 한 번에 돌리고 결과를 요약한다(SPRINT_3_DESIGN.md 3절).
//
// runWritingStage 안에서 원고 저장 직후·Telegram 알림 직전에 자동으로 호출한다. 조사 체크포인트처럼
// 별도 CLI로 분리하지 않는 이유는 규칙 기반이라 비용이 사실상 0이고, 결과가 곧 알림 내용의
// 일부이기 때문이다 - 분리하면 사람이 명령을 한 번 더 쳐야 하는데 그 대가로 얻는 게 없다.
//
// ⚠️ 이 결과는 원고를 차단하지 않는다(설계 6절). 알림에 함께 표시되고 사람이 판단한다.

import {
  checkAdDisclosure,
  checkAttributionHedging,
  checkFacts,
  checkImagePrompts,
  checkInstitutionAttribution,
  checkLegal,
  checkQuality,
  checkVoice,
} from "./articleReviewChecks.js";
import type { ReviewCheck } from "./articleReviewChecks.js";
import type { ArticleJobRow, ArticleRow, SourceRow } from "../../types/database.js";

export type ArticleReviewInput = {
  job: Pick<ArticleJobRow, "category">;
  article: Pick<ArticleRow, "title" | "content" | "created_at">;
  sources: ReadonlyArray<Pick<SourceRow, "content">>;
  hashtags: ReadonlyArray<string>;
  isMedical: boolean;
  /** 자료조사 verdict(ok | thin | blocked). thin이면 분량 미달을 "자료 얇음"으로 표시한다. */
  researchVerdict?: string | null;
  /** 자료조사 파일 원문. 기관 귀속을 official 근거와 대조한다(2026-10-02). */
  researchText?: string | null;
  /** 이 job의 메인 키워드. 제목 첫 마디 검사에 쓴다(2026-10-02). */
  keyword?: string | null;
};

export type ArticleReviewResult = {
  checks: ReviewCheck[];
  errorCount: number;
  warningCount: number;
  /** 걸린 항목이 하나도 없으면 true. */
  passed: boolean;
};

export function runArticleReview(input: ArticleReviewInput): ArticleReviewResult {
  const checks: ReviewCheck[] = [
    ...checkFacts({ article: input.article, sources: input.sources }),
    ...checkLegal(input.article.content, input.job.category),
    ...checkAdDisclosure(input.article.content),
    ...checkQuality({
      title: input.article.title,
      body: input.article.content,
      hashtags: input.hashtags,
      isMedical: input.isMedical,
      researchThin: input.researchVerdict === "thin",
      keyword: input.keyword,
    }),
    ...checkAttributionHedging(input.article.content),
    ...checkInstitutionAttribution(input.article.content, input.researchText),
    ...checkVoice(input.article.content),
    ...checkImagePrompts(input.article.content, input.job.category),
  ];

  // error를 먼저 보여준다 - 알림에서 잘릴 때 중요한 것이 남아야 한다.
  checks.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

  const errorCount = checks.filter((c) => c.severity === "error").length;

  return {
    checks,
    errorCount,
    warningCount: checks.length - errorCount,
    passed: checks.length === 0,
  };
}

const CATEGORY_LABEL: Record<ReviewCheck["category"], string> = {
  fact: "팩트",
  legal: "법적",
  ad: "광고",
  quality: "품질",
};

/** Telegram 알림에 넣을 줄들을 만든다. 통과했으면 한 줄로 끝낸다. */
export function formatReviewLines(result: ArticleReviewResult): string[] {
  if (result.passed) return ["✅ 검수 통과"];

  const header = `⚠️ 검수 ${result.checks.length}건 (오류 ${result.errorCount} · 경고 ${result.warningCount})`;
  const lines = result.checks.map((c) => `· [${CATEGORY_LABEL[c.category]}] ${c.message}`);
  return [header, ...lines];
}
