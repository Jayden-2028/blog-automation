// Creator Advisor trends 페이지 DOM 스냅샷 캡처(조사 전용, 일회성).
//
// 목적: 프로덕션 경로(BrowserCreatorAdvisorProvider)가 topic card는 찾지만 그 안에서
// .u_ni_trend_item을 0개로 읽는 원인을 찾기 위해, 프로덕션과 "동일한 순서"로 페이지를 조작하면서
// 단계별 HTML을 파일로 남긴다. 분석은 이 파일이 하지 않는다 - 저장만 한다.
//
// 안전: 읽기 전용이다. DB/Telegram/외부 쓰기 없음. 저장물은 .local/dom-snapshots/(gitignore)에만 둔다.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

import { CREATOR_ADVISOR_CONFIG } from "../../../../config/creatorAdvisor.js";
import { creatorAdvisorTrendsPageUrl, TRENDS_RENDER_WAIT_TIMEOUT_MS } from "../BrowserCreatorAdvisorProvider.js";
import { findLatestAvailableTrendDate } from "./trendDateNavigation.js";
import {
  CREATOR_ADVISOR_VIEWPORT,
  ensureTrendsViewState,
  waitForTrendsPageRendered,
} from "./trendsPageReadiness.js";
import type { Page } from "playwright";

const OUT_DIR = ".local/dom-snapshots";

// 브라우저 안에서 실행할 조사 코드. tsconfig의 lib에 "dom"이 없으므로(ES2022만) TypeScript가
// document/Element를 알지 못한다 - 그래서 함수가 아니라 문자열 소스로 넘겨 page.evaluate가
// 브라우저 컨텍스트에서 그대로 평가하게 한다.
const PROBE_SOURCE = `(() => {
  const cards = Array.from(document.querySelectorAll(".u_ni_trend_list_box"));
  const allRows = document.querySelectorAll(".u_ni_trend_item");

  return {
    cardCount: cards.length,
    globalRowCount: allRows.length,
    // 각 card의 제목 + 자손 row 수. 프로덕션 파서와 정확히 같은 방식(card 내부 조회)이다.
    cards: cards.map((card, i) => ({
      i,
      title: (card.querySelector(".u_ni_trend_title") || {}).textContent
        ? card.querySelector(".u_ni_trend_title").textContent.trim()
        : null,
      descendantRows: card.querySelectorAll(".u_ni_trend_item").length,
      cardClass: String(card.className || "").slice(0, 160),
      parentClass: String((card.parentElement && card.parentElement.className) || "").slice(0, 160),
      hiddenByOffsetParent: card.offsetParent === null,
      rectW: Math.round(card.getBoundingClientRect().width),
      rectH: Math.round(card.getBoundingClientRect().height)
    })),
    // 120개 row가 실제로 어느 조상 아래 있는지 역추적한다 - card의 자손이 아니라면 어디에 있는가?
    rowAncestry: Array.from(allRows).slice(0, 8).map((row) => {
      const chain = [];
      let el = row.parentElement;
      for (let d = 0; d < 12 && el; d++) {
        chain.push(el.tagName.toLowerCase() + "." + String(el.className || "").split(/\\s+/).slice(0, 3).join("."));
        el = el.parentElement;
      }
      return {
        closestCardFound: row.closest(".u_ni_trend_list_box") !== null,
        ancestorChain: chain
      };
    }),
    // swiper 관련 컨테이너 진단(중복 슬라이드/가상 렌더링 여부).
    swiper: {
      slideCount: document.querySelectorAll(".swiper-slide").length,
      duplicateSlideCount: document.querySelectorAll(".swiper-slide-duplicate").length,
      activeSlideCount: document.querySelectorAll(".swiper-slide-active").length,
      lazyPlaceholders: document.querySelectorAll("[class*='lazy'],[class*='skeleton'],[class*='loading']").length
    }
  };
})()`;

/** 페이지에서 조사에 필요한 구조 지표만 뽑는다(원문 텍스트/개인정보는 담지 않는다). */
async function measure(page: Page, label: string): Promise<Record<string, unknown>> {
  const result = (await page.evaluate(PROBE_SOURCE)) as Record<string, unknown>;
  return { label, ...result };
}

async function snapshot(page: Page, name: string, notes: Record<string, unknown>[]): Promise<void> {
  const html = await page.content();
  writeFileSync(`${OUT_DIR}/${name}.html`, html, "utf8");
  const m = await measure(page, name);
  notes.push(m);
  console.log(`  📸 ${name}: cards=${m.cardCount}, globalRows=${m.globalRowCount}, html=${html.length}바이트`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const notes: Record<string, unknown>[] = [];

  const context = await chromium.launchPersistentContext(CREATOR_ADVISOR_CONFIG.profileDir, {
    headless: true,
    viewport: CREATOR_ADVISOR_VIEWPORT,
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(creatorAdvisorTrendsPageUrl(CREATOR_ADVISOR_CONFIG.blogId), {
      waitUntil: "domcontentloaded",
    });

    console.log("▶ 단계별 스냅샷 캡처");

    await waitForTrendsPageRendered(page, TRENDS_RENDER_WAIT_TIMEOUT_MS);
    await snapshot(page, "01-after-render-wait", notes);

    const viewState = await ensureTrendsViewState(page);
    console.log(`  화면 상태: ${JSON.stringify(viewState)}`);
    await snapshot(page, "02-after-view-state", notes);

    // 뷰 전환 직후 비동기 렌더가 끝나지 않았을 가능성 - 시간을 두고 다시 측정한다.
    for (const waitMs of [2000, 5000, 10000]) {
      await page.waitForTimeout(waitMs);
      await snapshot(page, `03-after-wait-${waitMs}ms`, notes);
    }

    const dateResult = await findLatestAvailableTrendDate(page);
    console.log(`  latestAvailableTrendDate: ${dateResult.latestAvailableTrendDate}`);
    await snapshot(page, "04-after-date-navigation", notes);

    await page.waitForTimeout(5000);
    await snapshot(page, "05-after-date-nav-plus-5s", notes);

    writeFileSync(`${OUT_DIR}/measurements.json`, JSON.stringify({ viewState, dateResult, notes }, null, 2), "utf8");
    console.log(`\n✅ 스냅샷 저장 완료 -> ${OUT_DIR}/`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
