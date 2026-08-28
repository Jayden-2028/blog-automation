// Playwright 기반으로 Creator Advisor 트렌드 탭의 실제 렌더링된 데이터를 읽는 provider.
//
// 제약:
// - 공식 공개 API가 있다고 가정하지 않는다.
// - 비공개 API를 reverse engineering해서 직접 호출하지 않는다.
// - 대신 Playwright로 실제 사용자가 보는 페이지를 그대로 렌더링해서 DOM에서 값을 읽는다.
//
// 로그인 전략: 이 provider는 자체적으로 로그인을 수행하지 않는다. 대신 dedicated Playwright
// persistent profile(config의 profileDir, 기본 .local/creator-advisor-profile/)을 재사용한다 —
// 최초 1회 사람이 headless:false로 직접 로그인해두면, 이후 실행은 그 프로필의 쿠키/세션을 그대로
// 재사용한다(debugCreatorAdvisor.ts 참고). 기존에 쓰던 일반 Chrome 프로필과는 별개다.
//
// URL/topic 구조(2026-08-26 실측 확인): trends 페이지는 blogId 하나에 고정된 단일 URL이고
// (https://creator-advisor.naver.com/naver_blog/{blogId}/trends), topic은 URL query param이
// 아니라 그 페이지 안의 topic card(Swiper 슬라이드)들이다. Swiper는 topic card를 모두 DOM에
// 만들지만 viewport 주변 card의 keyword row만 lazy rendering하므로, HTML을 캡처하기 전에 모든
// topic 슬라이드를 순회해 각 card의 row를 채운다.
//
// 이 파일은 "브라우저를 어떻게 조작할지"만 다룬다. "렌더링된 HTML에서 값을 어떻게 뽑을지"는
// parseTrendHtml.ts로 분리되어 있다 — 그래서 파싱 로직은 실제 브라우저 없이 mock fixture로도
// 테스트할 수 있다(testParseTrendPage.ts).
//
// 날짜 fallback(2026-08-26 실측 확인): trends 페이지가 기본으로 보여주는 최신 날짜는 topic
// card/제목까지는 정상 렌더링되지만 keyword 데이터가 아직 계산되지 않은 경우가 있다("이 계정에
// 데이터가 없음"이 아니라 "그 날짜 데이터가 아직 없음"). trendDateNavigation.ts의
// findLatestAvailableTrendDate()가 하루씩 날짜를 되돌려가며 keyword 데이터가 있는 가장 최신 날짜를
// 찾는다. 향후 Daily Workflow에 Creator Advisor를 연결할 때도 "오늘/어제 고정 날짜"가 아니라 이
// 함수가 반환하는 latestAvailableTrendDate를 써야 한다(이번 단계에서는 아직 연결하지 않는다).

import { chromium, type Page } from "playwright";
import { CREATOR_ADVISOR_CONFIG } from "../../../config/creatorAdvisor.js";
import { CREATOR_ADVISOR_TREND_SELECTORS, parseTrendPage, type TrendCardScope } from "./creatorAdvisor/parseTrendHtml.js";
import {
  CREATOR_ADVISOR_VIEWPORT,
  ensureTrendsViewState,
  traverseTopicSwiper,
  waitForTopicCardRowsSettled,
  TRENDS_READY_TEXT_CANDIDATES,
  waitForTrendsPageRendered,
} from "./creatorAdvisor/trendsPageReadiness.js";
import {
  type DateCheckResult,
  findLatestAvailableTrendDate,
} from "./creatorAdvisor/trendDateNavigation.js";
import type {
  CreatorAdvisorProvider,
  CreatorAdvisorTrendCandidate,
  FetchTrendKeywordsOptions,
} from "./CreatorAdvisorProvider.js";

export const TRENDS_RENDER_WAIT_TIMEOUT_MS = 20_000;

// 로그인 필요/만료 상태를 명확히 알리기 위한 전용 에러 타입.
export class CreatorAdvisorLoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorAdvisorLoginRequiredError";
  }
}

// 로그인은 되어 있지만 trends 페이지 자체에 도달하지 못했을 때(예: 권한 없음/블로그 미연동으로
// /introduction에 머무는 경우) 던진다. "/introduction으로 redirect되면 성공으로 판단하지 않는다."
export class CreatorAdvisorAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorAdvisorAccessError";
  }
}

export type BrowserCreatorAdvisorProviderOptions = {
  /** Playwright persistent context 프로필 디렉터리. 기본 CREATOR_ADVISOR_CONFIG.profileDir. */
  profileDir?: string;
  /** 수집할 최대 topic card 개수. 기본 CREATOR_ADVISOR_CONFIG.maxTopics. */
  maxTopics?: number;
  /** topic당 저장할 최대 키워드 개수. 기본 CREATOR_ADVISOR_CONFIG.maxKeywordsPerTopic. */
  maxKeywordsPerTopic?: number;
  /** true면 브라우저 창을 띄운다. 최초 수동 로그인 시에만 false로 실행한다. 기본 true(headless). */
  headless?: boolean;
  /** Creator Advisor trends 페이지 URL. 기본 creatorAdvisorTrendsPageUrl(CREATOR_ADVISOR_CONFIG.blogId). */
  trendsPageUrl?: string;
};

/**
 * Creator Advisor trends 페이지 URL(실측 확인됨): topic은 URL query param이 아니라 페이지 내
 * topic card이므로 blogId 하나에 고정된다.
 */
export function creatorAdvisorTrendsPageUrl(blogId: string): string {
  return `https://creator-advisor.naver.com/naver_blog/${encodeURIComponent(blogId)}/trends`;
}

export type FetchTrendKeywordsResult = {
  /** maxTopics/maxKeywordsPerTopic 적용 후 topic 구분 없이 합친 목록(Repository 저장 등 flat 소비용). */
  candidates: CreatorAdvisorTrendCandidate[];
  /** maxTopics/maxKeywordsPerTopic 적용 후 topic card 순서를 보존한 구조(디버그 출력 등에 사용). */
  topics: { topic: string; candidates: CreatorAdvisorTrendCandidate[] }[];
  /** 실패한 topic card만 담는다("card[인덱스]" 또는 파악된 topic 제목 -> 실패 사유). */
  topicErrors: Record<string, string>;
  /** 실제 파싱에 쓰인(=latestAvailableTrendDate) 날짜. parseTrendPage가 페이지에서 다시 읽은 값. */
  trendDate: string | null;
  /** 이 수집을 시작한 시각(ISO 8601). "오늘 날짜"가 아니라 실제 요청 시각을 남긴다. */
  requestedAt: string;
  /** 페이지 진입 시 Creator Advisor가 기본으로 보여준 날짜("YYYY-MM-DD"). */
  initialTrendDate: string | null;
  /** keyword 데이터가 실제로 존재하는, 확인된 날짜 중 가장 최신 날짜("YYYY-MM-DD"). */
  latestAvailableTrendDate: string;
  /** 날짜별로 확인한 topic card/keyword row 개수와 dataStatus 기록(최신 -> 과거 순). */
  dateChecks: DateCheckResult[];
  /** topic/성별·연령별(demographic)/무제목 card 개수 집계(diagnostic). parseTrendPage 결과 그대로. */
  cardScope: TrendCardScope;
};

export class BrowserCreatorAdvisorProvider implements CreatorAdvisorProvider {
  private readonly profileDir: string;
  private readonly maxTopics: number;
  private readonly maxKeywordsPerTopic: number;
  private readonly headless: boolean;
  private readonly trendsPageUrl: string;

  constructor(options: BrowserCreatorAdvisorProviderOptions = {}) {
    if (!options.trendsPageUrl && !CREATOR_ADVISOR_CONFIG.blogId) {
      throw new Error(
        "CREATOR_ADVISOR_CONFIG.blogId가 비어 있습니다. .env에 CREATOR_ADVISOR_BLOG_ID를 설정하세요 " +
          "(예: https://creator-advisor.naver.com/naver_blog/{blogId}/trends 의 {blogId})."
      );
    }

    this.profileDir = options.profileDir ?? CREATOR_ADVISOR_CONFIG.profileDir;
    this.maxTopics = options.maxTopics ?? CREATOR_ADVISOR_CONFIG.maxTopics;
    this.maxKeywordsPerTopic = options.maxKeywordsPerTopic ?? CREATOR_ADVISOR_CONFIG.maxKeywordsPerTopic;
    this.headless = options.headless ?? true;
    this.trendsPageUrl = options.trendsPageUrl ?? creatorAdvisorTrendsPageUrl(CREATOR_ADVISOR_CONFIG.blogId);
  }

  /** CreatorAdvisorProvider 인터페이스 구현. 로그인/접근 실패 시에는 예외를 던진다(호출자가 감지). */
  async fetchTrendKeywords(options?: FetchTrendKeywordsOptions): Promise<CreatorAdvisorTrendCandidate[]> {
    const { candidates } = await this.fetchTrendKeywordsDetailed(options);
    return candidates;
  }

  /**
   * fetchTrendKeywords()와 동일하게 동작하지만, trendDate/topic별 실패 내역(topicErrors)/topic
   * 구조까지 함께 반환한다.
   *
   * 로그인 필요/만료(CreatorAdvisorLoginRequiredError)와 trends 페이지 접근 실패
   * (CreatorAdvisorAccessError)는 topic 단위 실패가 아니라 페이지 전체 실패이므로 즉시 throw한다.
   * 반면 topic card 하나만 selector가 안 맞는 경우는 parseTrendPage가 이미 topicErrors로
   * 격리해서 반환하므로, 이 메서드는 그 결과를 그대로 얹어 전달하기만 한다.
   */
  async fetchTrendKeywordsDetailed(
    options?: FetchTrendKeywordsOptions
  ): Promise<FetchTrendKeywordsResult> {
    const maxTopics = options?.maxTopics ?? this.maxTopics;
    const maxKeywordsPerTopic = options?.maxKeywordsPerTopic ?? this.maxKeywordsPerTopic;

    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      // 실측 확인(2026-08-26): Creator Advisor trends 페이지의 selector는 400x778 반응형
      // viewport 기준 마크업이다 - desktop viewport에서는 topic card selector가 하나도 안 잡힌다.
      viewport: CREATOR_ADVISOR_VIEWPORT,
    });

    try {
      const page = await context.newPage();
      await page.goto(this.trendsPageUrl, { waitUntil: "networkidle" });

      this.assertLoggedIn(page);
      this.assertTrendsPageReached(page);

      const renderedText = await waitForTrendsPageRendered(page, TRENDS_RENDER_WAIT_TIMEOUT_MS);
      if (!renderedText) {
        throw new CreatorAdvisorAccessError(
          `trends 페이지 렌더링을 확인하지 못했습니다 - 다음 텍스트 중 어느 것도 ` +
            `${TRENDS_RENDER_WAIT_TIMEOUT_MS}ms 내에 나타나지 않았습니다: ${TRENDS_READY_TEXT_CANDIDATES.join(", ")}`
        );
      }
      await ensureTrendsViewState(page);

      await page
        .waitForSelector(CREATOR_ADVISOR_TREND_SELECTORS.topicCard, { timeout: 15_000 })
        .catch(() => {
          // 못 찾아도 여기서 던지지 않는다 - parseTrendPage가 동일 조건에서 더 구체적인
          // TrendPageSelectorError(topic="(page)")를 던지므로 메시지 중복을 피한다.
        });

      // topic card(제목 포함)가 먼저 마운트되고, card 안의 keyword row는 한 단계 더 늦게 비동기로
      // 채워진다(실측 확인). 게다가 "최신 날짜"에 아직 keyword 데이터가 준비되지 않은 경우가 있어서
      // (계정에 데이터가 없는 게 아니라 그 날짜 데이터가 아직 없는 것) - 단순히 한 번 기다리는 게
      // 아니라 keyword 데이터가 있는 가장 최신 날짜를 찾아 그 날짜로 화면을 이동시킨다.
      const dateResult = await findLatestAvailableTrendDate(page);

      // topic과 demographic swiper는 같은 클래스를 쓰므로 제목 패턴으로 topic swiper를 골라 전체
      // 슬라이드를 순회한다. enrichment 수집이므로 순회 실패는 함수 내부에서 격리하고 기존 파싱
      // 흐름을 계속한다.
      await traverseTopicSwiper(page);

      // 날짜 이동 후에도 topic card row가 다시 비동기로 채워진다 - 여기서 한 번 더 안정될 때까지
      // 기다린 뒤 캡처한다. findLatestAvailableTrendDate 내부의 판정만 믿고 바로 content()를 찍으면
      // 마지막 날짜 이동 직후의 미완성 DOM을 잡을 수 있다.
      const rowsReadiness = await waitForTopicCardRowsSettled(page);
      if (!rowsReadiness.ready) {
        console.warn(
          `⚠️ BrowserCreatorAdvisorProvider: topic card row가 ${rowsReadiness.waitedMs}ms 안에 안정되지 ` +
            `않았습니다 (topic card ${rowsReadiness.topicCardCount}개 중 ${rowsReadiness.loadedTopicCardCount}개 로딩, ` +
            `row ${rowsReadiness.topicRowCount}건). 현재 상태 그대로 파싱합니다.`
        );
      }

      const html = await page.content();
      const collectedAt = new Date().toISOString();
      const parsed = parseTrendPage(html, collectedAt);

      if (parsed.cardScope.topicCardCount < maxTopics) {
        // parsed.topics.length가 아니라 cardScope.topicCardCount로 비교한다 - topic card가
        // 있어도 그 날짜에 keyword row가 없어 파싱이 실패할 수 있는데, 그건 Swiper/카드 개수
        // 문제가 아니라 데이터 문제이므로 여기서 경고할 대상이 아니다.
        console.warn(
          `⚠️ BrowserCreatorAdvisorProvider: DOM에 존재하는 topic category card(${parsed.cardScope.topicCardCount}개)가 ` +
            `요청한 maxTopics(${maxTopics})보다 적습니다. 현재 DOM에 있는 만큼만 반환합니다.`
        );
      }

      const topics = parsed.topics.slice(0, maxTopics).map((topicGroup) => ({
        topic: topicGroup.topic,
        candidates: topicGroup.candidates.slice(0, maxKeywordsPerTopic),
      }));
      const candidates = topics.flatMap((topicGroup) => topicGroup.candidates);

      return {
        candidates,
        topics,
        topicErrors: parsed.topicErrors,
        trendDate: parsed.trendDate,
        requestedAt: dateResult.requestedAt,
        initialTrendDate: dateResult.initialTrendDate,
        latestAvailableTrendDate: dateResult.latestAvailableTrendDate,
        dateChecks: dateResult.checkedDates,
        cardScope: parsed.cardScope,
      };
    } finally {
      // persistent context는 close해도 profileDir에 세션이 그대로 남는다(디렉터리 자체가 저장소이므로).
      await context.close();
    }
  }

  /**
   * 로그인 필요/만료 상태 감지. 실제 확인된 신호(NAVER 로그인 도메인으로의 redirect)를 사용한다.
   * "로그인이 안 되어 있음"과 "로그인이 만료됨"은 이 provider 입장에서 관찰 가능한 신호가 동일하다
   * (둘 다 로그인 페이지로 튕겨나감) — 그래서 하나의 에러 타입으로 통일하되, 메시지에서 두 경우 모두
   * 안내한다.
   */
  private assertLoggedIn(page: Page): void {
    const url = page.url();
    if (url.includes("nid.naver.com")) {
      throw new CreatorAdvisorLoginRequiredError(
        `NAVER 로그인이 필요합니다(최초 미로그인 또는 세션 만료). ` +
          `"${this.profileDir}" persistent profile로 headless:false 실행해 수동으로 다시 로그인하세요.`
      );
    }
  }

  /**
   * trends 페이지 도달 여부 확인(실측 확인됨). 로그인은 되어 있어도 권한/연동 문제로
   * "/introduction"으로 redirect되는 경우가 있는데, 이를 성공으로 오판하지 않는다.
   */
  private assertTrendsPageReached(page: Page): void {
    const url = page.url();
    if (url.includes("/introduction")) {
      throw new CreatorAdvisorAccessError(
        `Creator Advisor trends 페이지 접근 실패: "/introduction"으로 redirect되었습니다 ` +
          `(권한 없음 또는 블로그 미연동으로 추정). url=${url}`
      );
    }
    if (!url.includes("creator-advisor.naver.com") || !url.includes("/trends")) {
      throw new CreatorAdvisorAccessError(
        `Creator Advisor trends 페이지 접근 실패: 예상치 못한 URL로 이동했습니다. url=${url}`
      );
    }
  }
}
