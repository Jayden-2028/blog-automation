// trends 페이지가 실제로 마운트됐는지 확인하고, 필요한 화면 상태(검색 유입 트렌드 탭 / 주제별
// 인기유입검색어 보기 / 설정순 보기)를 맞추는 헬퍼. BrowserCreatorAdvisorProvider(프로덕션 추출)와
// debugCreatorAdvisor.ts(디버그)가 공유한다 - 실 DOM 조작 로직을 두 곳에서 따로 관리하지 않는다.
//
// 실측 확인(2026-08-26): Creator Advisor trends 페이지의 selector(.u_ni_trend_list_box 등)는
// DevTools에서 400x778 반응형 viewport로 검증한 마크업 기준이다 - desktop viewport(Playwright
// 기본값)에서는 같은 selector가 하나도 안 잡힌다. userAgent/모바일 기기 emulation은 아직 건드리지
// 않는다(viewport만으로 먼저 확인한다).

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
