// 연예 뉴스 피드 provider. 두 공개 소스를 인증 없이 GET한다.
//
// DaumRealtimeProvider.ts와 같은 층위다: 브라우저도 로그인도 persistent profile도 필요 없고,
// 정직한 Accept 헤더로 그냥 받아 온다(UA를 위장하지 않는다 - 기존 스크래핑 운영 원칙).
// 파싱은 순수 함수가 맡고 이 파일은 네트워크 호출과 실패 표면만 담당한다.
//
// **한쪽이 죽어도 다른 쪽으로 진행한다.** Google 뉴스가 이슈를, 다음 랭킹이 순위를 주는데 둘의
// 역할이 달라서다 - Google이 죽으면 후보가 없고(그건 수집 실패), 다음이 죽으면 순위 신호만
// 없어진다(피드 순서로 폴백). 그 차이를 호출자가 알 수 있도록 오류를 소스별로 돌려준다.

import { parseDaumEntRanking, type DaumEntRankingItem } from "./parseDaumEntRanking.js";
import { parseGoogleNewsRss, type GoogleNewsStory } from "./parseGoogleNewsRss.js";

/** Google 뉴스 한국판 ENTERTAINMENT 토픽 RSS. 2026-11-11 실측: 302 리다이렉트 후 70 item. */
export const GOOGLE_NEWS_ENT_RSS_URL =
  "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=ko&gl=KR&ceid=KR:ko";

/** 다음 연예 메인. 「많이 본 뉴스」 10건을 읽는다. */
export const DAUM_ENTERTAIN_URL = "https://entertain.daum.net/";

export type FetchNewsFeedEntOptions = {
  /** 요청 타임아웃(ms). 기본 15초. */
  timeoutMs?: number;
  /** 테스트에서 네트워크 대신 RSS 본문을 주입하는 지점. */
  fetchRss?: (url: string) => Promise<string>;
  /** 테스트에서 네트워크 대신 다음 HTML을 주입하는 지점. */
  fetchDaumHtml?: (url: string) => Promise<string>;
  /** false면 다음 랭킹을 아예 조회하지 않는다(순위 신호 없이 피드 순서로 간다). 기본 true. */
  includeDaumRanking?: boolean;
};

export type FetchNewsFeedEntResult = {
  stories: GoogleNewsStory[];
  daumRanking: DaumEntRankingItem[];
  /** 소스별 조회 실패 사유. 성공한 소스는 key가 없다. */
  sourceErrors: Partial<Record<"google_news" | "daum_entertain", string>>;
  collectedAt: string;
};

async function fetchText(url: string, timeoutMs: number, accept: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: accept } });
    if (!response.ok) {
      throw new Error(`요청 실패: ${response.status} ${response.statusText} (${url})`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 연예 뉴스 피드를 1회 가져온다. **예외를 던지지 않는다** - 어느 소스가 왜 실패했는지는
 * sourceErrors로 알리고, Google 쪽이 비면 stories가 빈 배열이 된다(호출자가 실패로 판정한다).
 */
export async function fetchNewsFeedEnt(
  options: FetchNewsFeedEntOptions = {}
): Promise<FetchNewsFeedEntResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const sourceErrors: FetchNewsFeedEntResult["sourceErrors"] = {};
  const collectedAt = new Date().toISOString();

  let stories: GoogleNewsStory[] = [];
  try {
    const fetchRss = options.fetchRss ?? ((url: string) => fetchText(url, timeoutMs, "application/rss+xml,application/xml"));
    stories = parseGoogleNewsRss(await fetchRss(GOOGLE_NEWS_ENT_RSS_URL));
  } catch (error) {
    sourceErrors.google_news = describe(error);
    console.error("⚠️ [fetchNewsFeedEnt] Google 뉴스 RSS 조회 실패 -", sourceErrors.google_news);
  }

  let daumRanking: DaumEntRankingItem[] = [];
  if (options.includeDaumRanking ?? true) {
    try {
      const fetchDaumHtml =
        options.fetchDaumHtml ?? ((url: string) => fetchText(url, timeoutMs, "text/html,application/xhtml+xml"));
      daumRanking = parseDaumEntRanking(await fetchDaumHtml(DAUM_ENTERTAIN_URL));
    } catch (error) {
      // 순위 신호만 잃는다 - 수집 자체는 계속한다.
      sourceErrors.daum_entertain = describe(error);
      console.error("⚠️ [fetchNewsFeedEnt] 다음 연예 랭킹 조회 실패(순위 신호 없이 진행) -", sourceErrors.daum_entertain);
    }
  }

  return { stories, daumRanking, sourceErrors, collectedAt };
}
