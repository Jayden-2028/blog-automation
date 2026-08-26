// trends 페이지의 "최신 유효 날짜" 탐색 헬퍼.
//
// 실측 확인(2026-08-26): trendDate가 최신(예: 2026-08-25)이어도 Creator Advisor가 아직 그 날짜의
// topic별 키워드 데이터를 계산해두지 않은 경우가 있다 - topic card/제목은 정상 렌더링되고
// (topicCard=11, selector 정상) keyword row만 0개이며 "조회할 기간의 데이터가 없습니다. 데이터를
// 준비 중입니다." empty-state가 표시된다. 실제로 하루 전(2026-08-24) 날짜에는 keyword 데이터가
// 존재하는 것을 사용자가 브라우저에서 직접 확인했다 - 이는 "이 계정에 데이터가 없음"이 아니라
// "최신 날짜 데이터가 아직 준비되지 않음"이다.
//
// 그래서 이 모듈은 topic card가 있는데 row가 0인 상태를 selector 실패로 취급하지 않고
// (dataStatus="not_ready"), 날짜를 하루씩 뒤로 이동하며 keyword 데이터가 있는 가장 최신 날짜를
// 찾는다. 최대 MAX_DATE_LOOKBACK_DAYS일을 모두 확인했는데도 하나도 없을 때만 계정 레벨 문제로
// 보고 CreatorAdvisorDataUnavailableError를 던진다.

import type { ElementHandle, Page } from "playwright";
import { waitForTopicCardRowsSettled } from "./trendsPageReadiness.js";
import { CREATOR_ADVISOR_TREND_SELECTORS } from "./parseTrendHtml.js";

/** 오늘 날짜에서 최대 이만큼 이전까지 되돌아가며 유효한 날짜를 찾는다. */
export const MAX_DATE_LOOKBACK_DAYS = 7;
const DATE_CHANGE_WAIT_TIMEOUT_MS = 10_000;
const CARD_RENDER_WAIT_TIMEOUT_MS = 15_000;

export type CreatorAdvisorDataStatus = "available" | "not_ready" | "unknown";

export type DateCheckResult = {
  trendDate: string | null;
  topicCardCount: number;
  keywordRowCount: number;
  dataStatus: CreatorAdvisorDataStatus;
};

/** MAX_DATE_LOOKBACK_DAYS일을 전부 확인했는데도 유효한(keyword row가 있는) 날짜를 하나도 못 찾았을 때만 던진다. */
export class CreatorAdvisorDataUnavailableError extends Error {
  constructor(
    message: string,
    public readonly checkedDates: DateCheckResult[]
  ) {
    super(message);
    this.name = "CreatorAdvisorDataUnavailableError";
  }
}

export type FindLatestAvailableResult = {
  requestedAt: string;
  initialTrendDate: string | null;
  latestAvailableTrendDate: string;
  checkedDates: DateCheckResult[];
};

function normalizeTrendDateText(raw: string | null): string | null {
  if (!raw) return null;
  const match = /(\d{4})\.\s*(\d{2})\.\s*(\d{2})\.?/.exec(raw);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month}-${day}`;
}

// 이 파일의 브라우저-컨텍스트 콜백(page.evaluate 등)은 tsconfig에 "dom" lib이 없어 document/
// Element 같은 DOM 전역 타입을 프로젝트 코드에서 직접 참조할 수 없다(Node 전용 프로젝트라 의도적으로
// 뺀 것으로 보여 tsconfig를 바꾸지 않는다). 콜백 안에서 globalThis를 any로 캐스팅해 우회한다 -
// 실제로는 브라우저 안에서 실행되는 코드라 타입 체크 대상이 아니다.

/** 화면에 보이는 원문 날짜 텍스트("2026. 08. 25.")를 가진 leaf element의 텍스트를 읽는다. 못 찾으면 null. */
export async function readRawDateText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const DATE_PATTERN = /\d{4}\.\s*\d{2}\.\s*\d{2}\.?/;
    const nodes: any[] = Array.from(doc.querySelectorAll("body *"));
    for (const el of nodes) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? "").trim();
      const match = DATE_PATTERN.exec(text);
      if (match) return match[0];
    }
    return null;
  });
}

/**
 * 날짜 텍스트 근처(최대 6단계 조상)에서 prev 버튼을 찾아 ElementHandle로 반환한다 - Swiper의
 * prev 버튼과 섞이지 않도록 날짜 텍스트 주변으로만 scope한다("u_ni_btn_prev" 계열을 우선 후보로
 * 쓰되, 정확한 전체 class명이 다를 수 있어 부분일치로 찾는다). 못 찾으면 null.
 */
async function findDatePrevButtonHandle(page: Page): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle(() => {
    const doc: any = (globalThis as any).document;
    const DATE_PATTERN = /\d{4}\.\s*\d{2}\.\s*\d{2}\.?/;
    const PREV_BUTTON_SELECTOR = '[class*="u_ni_btn_prev" i], [class*="btn_prev" i], [aria-label*="이전"]';

    const nodes: any[] = Array.from(doc.querySelectorAll("body *"));
    let dateEl: any = null;
    for (const el of nodes) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? "").trim();
      if (DATE_PATTERN.test(text)) {
        dateEl = el;
        break;
      }
    }
    if (!dateEl) return null;

    let scope: any = dateEl;
    for (let depth = 0; depth < 6 && scope; depth++) {
      const button = scope.querySelector(PREV_BUTTON_SELECTOR);
      if (button) return button;
      scope = scope.parentElement;
    }
    return null;
  });

  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element;
}

const KEYWORD_ROW_SETTLE_WAIT_MS = 10_000;

/**
 * 현재 화면에서 topic card/keyword row 개수를 세고 dataStatus를 판정한다.
 * topic card 자체가 없으면(selector/렌더링 문제로 추정) "unknown" - 이건 날짜 데이터 문제가 아니다.
 *
 * keyword row는 topic card보다 한 단계 더 늦게 비동기로 채워진다(실측 확인) - 날짜 이동 직후
 * 바로 count하면 실제로 데이터가 있는 날짜에서도 오탐(not_ready)이 나올 수 있어서, count 전에
 * row가 나타날 때까지 짧게 기다린다(그래도 못 찾으면 진짜 not_ready로 판단).
 */
export async function checkCurrentDateStatus(page: Page): Promise<DateCheckResult> {
  const rawDateText = await readRawDateText(page);
  const trendDate = normalizeTrendDateText(rawDateText);

  const topicCardCount = await page.locator(CREATOR_ADVISOR_TREND_SELECTORS.topicCard).count();

  if (topicCardCount === 0) {
    return { trendDate, topicCardCount, keywordRowCount: 0, dataStatus: "unknown" };
  }

  // 전역 .u_ni_trend_item 개수로 판정하면 안 된다(2026-08-26 실측): 성별·연령별(demographic) card가
  // topic card보다 먼저 채워지기 때문에, topic card가 아직 전부 비어 있는 시점에도 전역 개수는
  // 이미 60개가 넘어 "available"로 오판한다. 그 상태로 캡처한 HTML은 topic row가 0개다.
  // 그래서 비-demographic topic card 안의 row가 채워지고 안정될 때까지 기다려 판정한다.
  const readiness = await waitForTopicCardRowsSettled(page, { timeoutMs: KEYWORD_ROW_SETTLE_WAIT_MS });

  const keywordRowCount = readiness.topicRowCount;
  const dataStatus: CreatorAdvisorDataStatus = readiness.loadedTopicCardCount > 0 ? "available" : "not_ready";

  return { trendDate, topicCardCount, keywordRowCount, dataStatus };
}

/**
 * prev 버튼을 클릭해 하루 전 날짜로 이동한다. 단순 sleep이 아니라 날짜 텍스트가 실제로 바뀔 때까지
 * 기다린다. 성공하면 새 날짜 원문 텍스트, 실패(버튼을 못 찾았거나 텍스트가 안 바뀜)하면 null.
 */
export async function goToPreviousDate(page: Page): Promise<string | null> {
  const oldRawDateText = await readRawDateText(page);
  const prevButton = await findDatePrevButtonHandle(page);
  if (!prevButton) return null;

  try {
    await prevButton.click();
  } finally {
    await prevButton.dispose();
  }

  try {
    await page.waitForFunction(
      (old) => {
        const doc: any = (globalThis as any).document;
        const DATE_PATTERN = /\d{4}\.\s*\d{2}\.\s*\d{2}\.?/;
        const nodes: any[] = Array.from(doc.querySelectorAll("body *"));
        for (const el of nodes) {
          if (el.children.length > 0) continue;
          const text = (el.textContent ?? "").trim();
          const match = DATE_PATTERN.exec(text);
          if (match && match[0] !== old) return true;
        }
        return false;
      },
      oldRawDateText,
      { timeout: DATE_CHANGE_WAIT_TIMEOUT_MS }
    );
  } catch {
    return null;
  }

  // topic card가 새 날짜 데이터로 다시 렌더링될 시간을 준다 - 못 기다려도 치명적이지 않으므로
  // (checkCurrentDateStatus가 어차피 다시 count한다) 여기서는 던지지 않는다.
  await page
    .waitForSelector(CREATOR_ADVISOR_TREND_SELECTORS.topicCard, { timeout: CARD_RENDER_WAIT_TIMEOUT_MS })
    .catch(() => {});

  return readRawDateText(page);
}

/**
 * 현재 화면 날짜에서 시작해 keyword 데이터가 있는 가장 최신 날짜를 찾는다. 최대
 * MAX_DATE_LOOKBACK_DAYS(7)일 전까지 하루씩 되돌아가며 확인한다.
 *
 * 최신 날짜 하나가 not_ready라는 이유로 "이 계정에 데이터가 없다"고 단정하지 않는다 - 확인 범위
 * 안에서 available인 날짜를 하나라도 찾으면 바로 반환한다. 전부 확인했는데도 available이 하나도
 * 없을 때만 CreatorAdvisorDataUnavailableError를 던진다.
 */
export async function findLatestAvailableTrendDate(page: Page): Promise<FindLatestAvailableResult> {
  const requestedAt = new Date().toISOString();
  const checkedDates: DateCheckResult[] = [];

  let current = await checkCurrentDateStatus(page);
  checkedDates.push(current);
  const initialTrendDate = current.trendDate;

  for (let day = 0; day < MAX_DATE_LOOKBACK_DAYS; day++) {
    if (current.dataStatus === "available" && current.trendDate) {
      return { requestedAt, initialTrendDate, latestAvailableTrendDate: current.trendDate, checkedDates };
    }
    if (current.dataStatus === "unknown") {
      // topic card 자체가 사라진 상태 - 날짜 데이터 문제가 아니라 selector/렌더링 문제로 추정된다.
      // 데이터 없음(CreatorAdvisorDataUnavailableError)과는 다른 문제이므로 구분해서 던진다.
      throw new Error(
        `날짜 탐색 중 topic card를 찾을 수 없게 되었습니다(selector/렌더링 문제로 추정, 데이터 없음과는 ` +
          `다른 문제) - trendDate=${current.trendDate ?? "알 수 없음"}. 지금까지 확인한 날짜: ` +
          `${checkedDates.map((d) => `${d.trendDate ?? "?"}(${d.dataStatus})`).join(", ")}`
      );
    }

    // not_ready: 하루 전 날짜로 이동해서 다시 확인한다.
    const newRawDate = await goToPreviousDate(page);
    if (!newRawDate) {
      // prev 버튼을 못 찾았거나 날짜가 실제로 안 바뀌었다 - 더 이상 되돌릴 수 없으므로 중단한다.
      break;
    }

    current = await checkCurrentDateStatus(page);
    checkedDates.push(current);
  }

  throw new CreatorAdvisorDataUnavailableError(
    `${checkedDates.length}개 날짜(${checkedDates.map((d) => d.trendDate ?? "?").join(", ")})를 모두 확인했지만 ` +
      `keyword 데이터가 있는 날짜를 찾지 못했습니다.`,
    checkedDates
  );
}
