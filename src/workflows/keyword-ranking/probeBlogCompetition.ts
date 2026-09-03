// 키워드 목록의 블로그 경쟁도(문서 총 개수)를 순차 조회한다.
//
// **이 단계는 절대 파이프라인을 멈추지 않는다.** 경쟁도는 보조 관측 신호이고, Phase A에서는
// 점수에 반영조차 하지 않으므로(config/keywordCompetition.ts) 실패가 랭킹/알림을 막아선 안 된다.
// 그래서 개별 실패는 errors에 모으고, 전부 실패해도 예외 대신 status로만 알린다
// (runCreatorAdvisorCollection 등 다른 보조 수집기와 같은 패턴).
//
// 순차 호출인 이유: 기존 provider들과 동일하게 rate limit을 보호하기 위함이다. Top 10 기준
// 10회 x 150ms = 약 2초로, daily run 전체(약 80초)에 유의미한 부담이 되지 않는다.

import { BLOG_COMPETITION_CONFIG } from "../../config/keywordCompetition.js";
import { fetchBlogDocumentTotal } from "../../services/search/naver/fetchBlogTotal.js";
import { describeError } from "../../services/describeError.js";
import { sleep } from "../../services/search/naver/naverClient.js";

/** 키워드 -> 블로그 문서 총 개수. 조회 실패한 키워드는 null. */
export type BlogTotalByKeyword = Map<string, number | null>;

/** 테스트/오프라인 재현에서 실제 API 대신 주입할 수 있는 조회 함수. */
export type FetchBlogTotalFn = (keyword: string) => Promise<number | null>;

export type ProbeBlogCompetitionOptions = {
  /** 기본 BLOG_COMPETITION_CONFIG.probeMaxKeywords. 넘치면 앞에서부터 자른다(입력이 점수 내림차순 전제). */
  maxKeywords?: number;
  requestDelayMs?: number;
  /** 기본은 실제 NAVER API 호출. 테스트에서 fake를 주입한다. */
  fetchTotal?: FetchBlogTotalFn;
};

export type ProbeBlogCompetitionResult = {
  status: "success" | "partial" | "failed" | "skipped";
  totalByKeyword: BlogTotalByKeyword;
  probedCount: number;
  failedCount: number;
  /** 키워드별 실패 사유. 성공한 키워드는 key가 없다. */
  errors: Record<string, string>;
};

export async function probeBlogCompetition(
  keywords: readonly string[],
  options: ProbeBlogCompetitionOptions = {}
): Promise<ProbeBlogCompetitionResult> {
  const totalByKeyword: BlogTotalByKeyword = new Map();
  const errors: Record<string, string> = {};

  const maxKeywords = options.maxKeywords ?? BLOG_COMPETITION_CONFIG.probeMaxKeywords;
  const requestDelayMs = options.requestDelayMs ?? BLOG_COMPETITION_CONFIG.requestDelayMs;
  const fetchTotal = options.fetchTotal ?? fetchBlogDocumentTotal;

  // 같은 키워드를 두 번 호출하지 않는다(cluster 대표가 겹칠 수 있다).
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
    if (unique.length >= maxKeywords) break;
  }

  if (unique.length === 0) {
    return { status: "skipped", totalByKeyword, probedCount: 0, failedCount: 0, errors };
  }

  for (let i = 0; i < unique.length; i++) {
    const keyword = unique[i];

    try {
      totalByKeyword.set(keyword, await fetchTotal(keyword));
    } catch (error) {
      totalByKeyword.set(keyword, null);
      errors[keyword] = describeError(error);
    }

    if (i < unique.length - 1 && requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }
  }

  const failedCount = Object.keys(errors).length;
  const status: ProbeBlogCompetitionResult["status"] =
    failedCount === 0 ? "success" : failedCount === unique.length ? "failed" : "partial";

  return { status, totalByKeyword, probedCount: unique.length, failedCount, errors };
}
