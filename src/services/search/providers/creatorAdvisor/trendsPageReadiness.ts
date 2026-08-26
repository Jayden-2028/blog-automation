// trends 페이지가 실제로 마운트됐는지 확인하고, 필요한 화면 상태(검색 유입 트렌드 탭 / 주제별
// 인기유입검색어 보기 / 설정순 보기)를 맞추는 헬퍼. BrowserCreatorAdvisorProvider(프로덕션 추출)와
// debugCreatorAdvisor.ts(디버그)가 공유한다 - 실 DOM 조작 로직을 두 곳에서 따로 관리하지 않는다.
//
// 실측 확인(2026-08-26): Creator Advisor trends 페이지의 selector(.u_ni_trend_list_box 등)는
// DevTools에서 400x778 반응형 viewport로 검증한 마크업 기준이다 - desktop viewport(Playwright
// 기본값)에서는 같은 selector가 하나도 안 잡힌다. userAgent/모바일 기기 emulation은 아직 건드리지
// 않는다(viewport만으로 먼저 확인한다).

import { CREATOR_ADVISOR_TREND_SELECTORS, DEMOGRAPHIC_TITLE_PATTERN } from "./parseTrendHtml.js";
import type { Page } from "playwright";

export const CREATOR_ADVISOR_VIEWPORT = { width: 400, height: 778 } as const;

export const TRENDS_TAB_LABEL = "검색 유입 트렌드";
export const TRENDS_TOPIC_VIEW_LABEL = "주제별 인기유입검색어";
export const TRENDS_SORT_LABEL = "설정순 보기";
export const TRENDS_READY_TEXT_CANDIDATES = [TRENDS_TAB_LABEL, TRENDS_TOPIC_VIEW_LABEL, TRENDS_SORT_LABEL] as const;

/**
 * 위 3개 텍스트 중 하나 이상이 visible해질 때까지 대기한다 - SPA라 단순 networkidle만으로는
 * 실제 컨텐츠 렌더링 완료를 보장할 수 없다. 못 찾으면(timeout) null을 반환한다(호출자가 판단).
 */
export async function waitForTrendsPageRendered(page: Page, timeoutMs: number): Promise<string | null> {
  const attempts = TRENDS_READY_TEXT_CANDIDATES.map(async (text) => {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: timeoutMs });
    return text;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

export type OptionSelectionResult = "already-active" | "clicked" | "not-found";

/**
 * label 텍스트를 가진 tab/button이 이미 활성 상태인지 확인하고, 아니면 클릭한다. 활성 상태
 * 판정은 class(active/selected/on)/aria-selected 휴리스틱이다(전용 selector 미확인 - 남은
 * issue) - 이미 활성 상태로 보이면 불필요한 재클릭을 하지 않는다.
 */
export async function ensureVisibleOptionSelected(page: Page, label: string): Promise<OptionSelectionResult> {
  const locator = page.getByText(label, { exact: false }).first();
  if ((await locator.count()) === 0) return "not-found";

  const isActive = await locator.evaluate((el) => {
    const target = el.closest('[role="tab"], button, a') ?? el;
    const className = (target.getAttribute("class") ?? "").toLowerCase();
    const ariaSelected = target.getAttribute("aria-selected");
    return /(^|[\s_-])(active|selected|on)([\s_-]|$)/.test(className) || ariaSelected === "true";
  });

  if (isActive) return "already-active";

  await locator.click();
  return "clicked";
}

/** 3개 옵션(탭/보기/정렬)을 순서대로 확인하고 필요한 것만 클릭한다. label -> 결과. */
export async function ensureTrendsViewState(page: Page): Promise<Record<string, OptionSelectionResult>> {
  const results: Record<string, OptionSelectionResult> = {};
  for (const label of TRENDS_READY_TEXT_CANDIDATES) {
    results[label] = await ensureVisibleOptionSelected(page, label);
  }
  return results;
}


// ---------- topic card row 로딩 대기 ----------
//
// 왜 필요한가(2026-08-26 실측으로 근본 원인 확정):
// keyword row(.u_ni_trend_item)는 topic card보다 늦게 비동기로 채워지는데, 성별·연령별
// (demographic) card가 topic card보다 "먼저" 채워진다. 그래서 전역 .u_ni_trend_item 개수로
// 준비 완료를 판정하면 demographic row만 60개 있는 시점에 곧바로 available로 오판하고,
// 그 상태에서 page.content()를 캡처하면 topic card는 전부 row 0개인 HTML이 나온다
// (파서가 topic마다 "keyword row를 찾지 못했습니다"를 내던 원인).
//
// 실측 타임라인:
//   렌더 대기 직후      cards=22(demographic만) topicRows=0   globalRows=0
//   화면 상태 전환 직후  cards=33(topic 11 추가) topicRows=0   globalRows=60  <- 여기서 오판했다
//   +2초               cards=33                topicRows=60  globalRows=120 <- 실제 준비 완료
//
// 그래서 전역 개수가 아니라 "비-demographic topic card 안의 row"를 기준으로 기다린다. 고정 sleep을
// 쓰지 않는 이유는 네트워크 상황에 따라 2초가 부족할 수도, 과할 수도 있기 때문이다 - 대신 카드별
// row 개수 시그니처가 일정 시간 변하지 않을 때까지 폴링한다.
//
// Creator Advisor는 topic card를 전부 DOM에 만들되 viewport 주변 3장만 내용을 채운다(lazy
// rendering). waitForTopicCardRowsSettled()는 "더 이상 늘지 않을 때까지" 기다릴 뿐 순회하지
// 않으므로, 전체 topic이 필요할 때는 traverseTopicSwiper()를 먼저 호출해야 한다.

export const TOPIC_ROWS_POLL_INTERVAL_MS = 200;
export const TOPIC_ROWS_STABLE_MS = 1_000;
export const TOPIC_ROWS_WAIT_TIMEOUT_MS = 20_000;

export type TopicRowsReadiness = {
  /** 최소 1개 topic card가 row를 갖고, 시그니처가 stableMs 동안 안정됐는지. */
  ready: boolean;
  /** 비-demographic topic card 수(row 유무 무관). */
  topicCardCount: number;
  /** 그중 row가 1개 이상 채워진 card 수. */
  loadedTopicCardCount: number;
  /** topic card 안의 row 합계(demographic row는 제외). */
  topicRowCount: number;
  /** 전역 row 수(진단용 - 이 값으로 판정하지 않는다). */
  globalRowCount: number;
  /** "제목:rowCount" 시그니처. 안정화 판정에 쓴다. */
  signature: string;
  waitedMs: number;
};

// 브라우저 컨텍스트에서 실행할 측정 코드. tsconfig의 lib에 "dom"이 없으므로(ES2022만) 함수가 아니라
// 문자열 소스로 넘긴다. demographic 판정 정규식은 parseTrendHtml.ts의 것을 그대로 주입해
// Node 쪽 분류(isDemographicTopicTitle)와 어긋나지 않게 한다.
const TOPIC_ROWS_PROBE_SOURCE = `(() => {
  const demoPattern = new RegExp(${JSON.stringify(DEMOGRAPHIC_TITLE_PATTERN.source)});
  const cards = Array.from(document.querySelectorAll(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicCard)}));
  const topicCards = cards.filter((card) => {
    const el = card.querySelector(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle)});
    const title = el && el.textContent ? el.textContent.trim() : "";
    return title.length > 0 && !demoPattern.test(title);
  });

  const perCard = topicCards.map((card) => {
    const el = card.querySelector(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle)});
    const title = el && el.textContent ? el.textContent.trim() : "";
    return { title: title, rows: card.querySelectorAll(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.keywordRow)}).length };
  });

  return {
    topicCardCount: topicCards.length,
    loadedTopicCardCount: perCard.filter((c) => c.rows > 0).length,
    topicRowCount: perCard.reduce((sum, c) => sum + c.rows, 0),
    globalRowCount: document.querySelectorAll(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.keywordRow)}).length,
    signature: perCard.map((c) => c.title + ":" + c.rows).join("|")
  };
})()`;

type TopicRowsProbe = Omit<TopicRowsReadiness, "ready" | "waitedMs">;

/** 현재 시점의 topic card row 상태를 1회 측정한다(대기하지 않는다). */
export async function measureTopicCardRows(page: Page): Promise<TopicRowsProbe> {
  return (await page.evaluate(TOPIC_ROWS_PROBE_SOURCE)) as TopicRowsProbe;
}

export type WaitForTopicCardRowsOptions = {
  timeoutMs?: number;
  stableMs?: number;
  pollIntervalMs?: number;
};

/**
 * 비-demographic topic card에 keyword row가 채워지고 그 상태가 안정될 때까지 기다린다.
 * timeout이 나도 예외를 던지지 않고 ready:false와 마지막 측정치를 반환한다 - "그 날짜에 데이터가
 * 없는 것"과 "페이지 구조가 깨진 것"의 구분은 호출자가 하기 때문이다.
 */
export async function waitForTopicCardRowsSettled(
  page: Page,
  options: WaitForTopicCardRowsOptions = {}
): Promise<TopicRowsReadiness> {
  const timeoutMs = options.timeoutMs ?? TOPIC_ROWS_WAIT_TIMEOUT_MS;
  const stableMs = options.stableMs ?? TOPIC_ROWS_STABLE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? TOPIC_ROWS_POLL_INTERVAL_MS;

  const startedAt = Date.now();
  let lastSignature: string | null = null;
  let signatureHeldSince = startedAt;
  let probe: TopicRowsProbe = {
    topicCardCount: 0,
    loadedTopicCardCount: 0,
    topicRowCount: 0,
    globalRowCount: 0,
    signature: "",
  };

  while (Date.now() - startedAt < timeoutMs) {
    probe = await measureTopicCardRows(page);

    if (probe.signature !== lastSignature) {
      lastSignature = probe.signature;
      signatureHeldSince = Date.now();
    } else if (probe.loadedTopicCardCount > 0 && Date.now() - signatureHeldSince >= stableMs) {
      return { ready: true, ...probe, waitedMs: Date.now() - startedAt };
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  return { ready: false, ...probe, waitedMs: Date.now() - startedAt };
}


// ---------- topic Swiper 순회 ----------

export type TopicSwiperTraversalResult = {
  /** topic swiper를 찾아 slideTo 순회를 시도했는지. */
  traversed: boolean;
  /** topic swiper의 전체 슬라이드 수. */
  slideCount: number;
  /** 순회가 끝난 뒤 row가 1개 이상 채워진 topic card 수. */
  loadedTopicCardCount: number;
  /** 순회가 끝난 뒤 topic card 안의 row 합계. */
  topicRowCount: number;
  /** 순회 중 실제로 slideTo를 호출한 인덱스(첫 방문 순서). */
  visitedIndexes: number[];
  /** 탐색/순회/복귀 중 발생한 실패 사유. */
  error?: string;
};

type TopicSwiperProbe = {
  found: boolean;
  hasSwiperApi: boolean;
  slideCount: number;
  slideRowCounts: number[];
};

// 클래스가 같은 demographic swiper와 topic swiper가 함께 있으므로, 각 swiper 안의 슬라이드 제목을
// DEMOGRAPHIC_TITLE_PATTERN으로 분류한다. DOM 타입을 tsconfig에 추가하지 않기 위해 문자열 소스로
// 실행한다.
const TOPIC_SWIPER_PROBE_SOURCE = `(() => {
  const demoPattern = new RegExp(${JSON.stringify(DEMOGRAPHIC_TITLE_PATTERN.source)});
  const swiperRoots = Array.from(document.querySelectorAll(".u_ni_search_swiper"));
  const topicRoot = swiperRoots.find((root) => {
    const slides = Array.from(root.querySelectorAll(".swiper-slide"));
    return slides.some((slide) => {
      const titleEl = slide.querySelector(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle)});
      const title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
      return title.length > 0 && !demoPattern.test(title);
    });
  });

  if (!topicRoot) {
    return { found: false, hasSwiperApi: false, slideCount: 0, slideRowCounts: [] };
  }

  const slides = Array.from(topicRoot.querySelectorAll(".swiper-slide"));
  return {
    found: true,
    hasSwiperApi: !!topicRoot.swiper && typeof topicRoot.swiper.slideTo === "function",
    slideCount: slides.length,
    slideRowCounts: slides.map((slide) => {
      const card = slide.matches(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicCard)})
        ? slide
        : slide.querySelector(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicCard)});
      return card ? card.querySelectorAll(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.keywordRow)}).length : 0;
    })
  };
})()`;

function topicSwiperSlideToSource(index: number): string {
  return `(() => {
    const demoPattern = new RegExp(${JSON.stringify(DEMOGRAPHIC_TITLE_PATTERN.source)});
    const swiperRoots = Array.from(document.querySelectorAll(".u_ni_search_swiper"));
    const topicRoot = swiperRoots.find((root) => {
      const slides = Array.from(root.querySelectorAll(".swiper-slide"));
      return slides.some((slide) => {
        const titleEl = slide.querySelector(${JSON.stringify(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle)});
        const title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
        return title.length > 0 && !demoPattern.test(title);
      });
    });

    if (!topicRoot) return { ok: false, error: "topic swiper를 찾지 못했습니다." };
    if (!topicRoot.swiper || typeof topicRoot.swiper.slideTo !== "function") {
      return { ok: false, error: "topic swiper의 slideTo API를 찾지 못했습니다." };
    }

    topicRoot.swiper.slideTo(${index});
    return { ok: true };
  })()`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * topic Swiper의 모든 슬라이드를 방문해 lazy-rendered keyword row를 채운다. Creator Advisor는
 * enrichment source이므로 탐색, slideTo, 대기, 원위치 복귀 중 어떤 실패도 밖으로 던지지 않는다.
 */
export async function traverseTopicSwiper(
  page: Page,
  options: { perSlideTimeoutMs?: number; stableMs?: number } = {}
): Promise<TopicSwiperTraversalResult> {
  const perSlideTimeoutMs = Math.max(0, options.perSlideTimeoutMs ?? TOPIC_ROWS_WAIT_TIMEOUT_MS);
  const stableMs = Math.max(0, options.stableMs ?? TOPIC_ROWS_STABLE_MS);
  const result: TopicSwiperTraversalResult = {
    traversed: false,
    slideCount: 0,
    loadedTopicCardCount: 0,
    topicRowCount: 0,
    visitedIndexes: [],
  };
  const errors: string[] = [];

  const updateFinalCounts = async (): Promise<void> => {
    try {
      const rows = await measureTopicCardRows(page);
      result.loadedTopicCardCount = rows.loadedTopicCardCount;
      result.topicRowCount = rows.topicRowCount;
    } catch (error) {
      errors.push(`topic row 최종 측정 실패: ${toErrorMessage(error)}`);
    }
  };

  try {
    const initialRows = await measureTopicCardRows(page);
    result.loadedTopicCardCount = initialRows.loadedTopicCardCount;
    result.topicRowCount = initialRows.topicRowCount;

    const initialSwiper = (await page.evaluate(TOPIC_SWIPER_PROBE_SOURCE)) as TopicSwiperProbe;
    if (!initialSwiper.found) {
      errors.push("비-demographic 제목을 가진 topic swiper를 찾지 못했습니다.");
      result.error = errors.join(" ");
      return result;
    }

    result.slideCount = initialSwiper.slideCount;
    if (!initialSwiper.hasSwiperApi) {
      errors.push("topic swiper의 slideTo API를 찾지 못했습니다.");
      result.error = errors.join(" ");
      return result;
    }

    result.traversed = true;
    try {
      for (let index = 0; index < result.slideCount; index += 1) {
        try {
          const beforeRows = await measureTopicCardRows(page);
          const beforeSwiper = (await page.evaluate(TOPIC_SWIPER_PROBE_SOURCE)) as TopicSwiperProbe;
          const slideResult = (await page.evaluate(topicSwiperSlideToSource(index))) as {
            ok: boolean;
            error?: string;
          };
          if (!slideResult.ok) {
            errors.push(`slide[${index}] 이동 실패: ${slideResult.error ?? "알 수 없는 오류"}`);
            continue;
          }
          result.visitedIndexes.push(index);

          // 이미 채워진 슬라이드는 slideTo만 수행하고 불필요한 안정화 대기는 생략한다.
          if ((beforeSwiper.slideRowCounts[index] ?? 0) > 0) continue;

          const startedAt = Date.now();
          let lastSignature = beforeRows.signature;
          let signatureHeldSince = startedAt;
          let loaded = false;

          while (Date.now() - startedAt < perSlideTimeoutMs) {
            await page.waitForTimeout(TOPIC_ROWS_POLL_INTERVAL_MS);
            const rows = await measureTopicCardRows(page);
            const swiper = (await page.evaluate(TOPIC_SWIPER_PROBE_SOURCE)) as TopicSwiperProbe;
            const now = Date.now();

            if (rows.signature !== lastSignature) {
              lastSignature = rows.signature;
              signatureHeldSince = now;
            }

            const targetHasRows = (swiper.slideRowCounts[index] ?? 0) > 0;
            const loadedCardCountIncreased = rows.loadedTopicCardCount > beforeRows.loadedTopicCardCount;
            const signatureStable = now - signatureHeldSince >= stableMs;
            if (targetHasRows && (loadedCardCountIncreased || signatureStable)) {
              loaded = true;
              break;
            }
          }

          if (!loaded) {
            errors.push(`slide[${index}] row가 ${perSlideTimeoutMs}ms 안에 로딩되지 않았습니다.`);
          }
        } catch (error) {
          errors.push(`slide[${index}] 순회 실패: ${toErrorMessage(error)}`);
        }
      }
    } finally {
      try {
        const restoreResult = (await page.evaluate(topicSwiperSlideToSource(0))) as {
          ok: boolean;
          error?: string;
        };
        if (!restoreResult.ok) {
          errors.push(`첫 슬라이드 복귀 실패: ${restoreResult.error ?? "알 수 없는 오류"}`);
        }
      } catch (error) {
        errors.push(`첫 슬라이드 복귀 실패: ${toErrorMessage(error)}`);
      }
    }
  } catch (error) {
    errors.push(`topic swiper 순회 실패: ${toErrorMessage(error)}`);
  }

  await updateFinalCounts();
  if (errors.length > 0) result.error = errors.join(" ");
  return result;
}
