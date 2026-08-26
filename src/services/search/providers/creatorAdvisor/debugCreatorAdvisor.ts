// Creator Advisor 실 연결 검증 debug script.
// 실행: npm run debug:creator-advisor            (실 데이터 추출 모드, topic 3개 x keyword 10개)
// 실행: npm run debug:creator-advisor -- --inspect  (확정 selector 재검증 + swiper 컨트롤 탐색 모드)
//
// 이번 단계 범위(요구사항 명시):
// - Daily Workflow 전체를 실행하지 않는다. Supabase 저장/migration/daily workflow 투입/Telegram
//   발송 없음 (이 파일은 그런 모듈을 import조차 하지 않는다). 기존 ranking/scoring/relevance/
//   clustering 코드도 건드리지 않는다.
// - cookie/token/secret은 절대 출력하지 않는다. inspect 모드도 페이지 전체 HTML을 출력하지 않는다.
//
// URL/DOM 구조(실측 확인 완료, 2026-08-26):
//   https://creator-advisor.naver.com/naver_blog/{blogId}/trends
//   topic card=.u_ni_trend_list_box, 제목=.u_ni_trend_title, keyword row=.u_ni_trend_item,
//   keyword=.u_ni_trend_text, 등락=.u_ni_data(class: up/down/new, 없으면 flat)
//
// 접근 상태는 서로 다른 3가지로 관리한다("NAVER 로그인 성공" ≠ "Creator Advisor 준비 완료"):
//   - naverLoginRequired: nid.naver.com에 머물러 있음 (NAVER 로그인 자체가 안 됨)
//   - creatorAdvisorSetupRequired: NAVER 로그인은 됐지만 아직 /naver_blog/{blogId}/trends에
//     도달하지 못함(예: /introduction으로 redirect). persistent profile에 Creator Advisor
//     초기 진입/블로그 선택/서비스 이용 세션이 아직 없다는 뜻 - 로그인 실패가 아니다.
//   - creatorAdvisorReady: 최종 URL pathname이 /naver_blog/{blogId}/trends 계열에 도달함.
// creatorAdvisorSetupRequired 상태에서는 selector 탐색을 하지 않는다(둘 다 아래 phase 2에서
// ensureLoggedIn이 creatorAdvisorReady를 반환한 뒤에만 실행된다).
//
// 흐름:
// 1) phase 1(ensureLoggedIn): raw Playwright로 persistent profile을 열고 trends URL로 이동한 뒤,
//    naverLoginRequired -> creatorAdvisorSetupRequired -> creatorAdvisorReady 순서로 상태를
//    폴링한다. 각 상태는 최대 5분까지 기다리며, creatorAdvisorSetupRequired여도 즉시 브라우저를
//    닫지 않고 안내 메시지만 출력한 채 사용자가 브라우저에서 직접 블로그 선택/Creator Advisor
//    진입을 마칠 때까지 열어둔다. creatorAdvisorReady가 되면 DOM에 존재하는 topic card/title/
//    keyword row 개수를 출력한다(Swiper 밖 topic까지 이미 DOM에 있는지 판단하기 위해 - 있다면
//    Swiper 조작 없이 전부 수집하고, 일부만 있을 때만 다음 단계에서 Swiper 순회를 추가로 구현한다).
// 2) phase 1이 creatorAdvisorReady로 끝나면:
//    - 기본 모드: 실제 프로덕션 코드인 BrowserCreatorAdvisorProvider를 headless:false로 실행해
//      topic 최대 3개 x keyword 10개를 추출해 trendDate + topic별 keyword/rank/movementType/
//      rankChange만 출력한다.
//    - --inspect 모드: 확정된 selector들이 실제로 몇 개씩 잡히는지 + 샘플을 재검증하고, 아직 안 쓰는
//      Swiper 컨트롤(다음/이전 버튼) 후보를 안전하게 제한된 정보로만 출력한다.

import "dotenv/config";
import { chromium, type Page } from "playwright";
import { CREATOR_ADVISOR_CONFIG } from "../../../../config/creatorAdvisor.js";
import {
  BrowserCreatorAdvisorProvider,
  CreatorAdvisorAccessError,
  CreatorAdvisorLoginRequiredError,
  creatorAdvisorTrendsPageUrl,
  TRENDS_RENDER_WAIT_TIMEOUT_MS,
} from "../BrowserCreatorAdvisorProvider.js";
import { CREATOR_ADVISOR_TREND_SELECTORS, parseTrendPage, type TrendCardScope } from "./parseTrendHtml.js";
import {
  CREATOR_ADVISOR_VIEWPORT,
  ensureTrendsViewState,
  TRENDS_READY_TEXT_CANDIDATES,
  waitForTrendsPageRendered,
} from "./trendsPageReadiness.js";
import {
  CreatorAdvisorDataUnavailableError,
  type DateCheckResult,
  findLatestAvailableTrendDate,
  MAX_DATE_LOOKBACK_DAYS,
} from "./trendDateNavigation.js";

const INSPECT_MODE = process.argv.includes("--inspect");
const NAVER_LOGIN_WAIT_TIMEOUT_MS = 5 * 60_000;
const CREATOR_ADVISOR_SETUP_WAIT_TIMEOUT_MS = 5 * 60_000;
const STATE_POLL_INTERVAL_MS = 2000;
const MAX_CANDIDATES_PRINTED = 25;
const TEXT_TRUNCATE_LENGTH = 40;
const DEBUG_MAX_TOPICS = 3;
const DEBUG_MAX_KEYWORDS_PER_TOPIC = 10;
// item 5 진단용: 사용자가 실제 화면에서 본 topic 제목 예시(스타·연예인/드라마/방송). selector가
// 여전히 안 맞을 때 이 텍스트들이 페이지에 존재하는지만 참고용으로 확인한다.
const DIAGNOSTIC_TOPIC_TEXT_SAMPLES = ["스타·연예인", "드라마", "방송"];

function truncateText(text: string, length = TEXT_TRUNCATE_LENGTH): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized;
}

type CreatorAdvisorAccessState = "naverLoginRequired" | "creatorAdvisorSetupRequired" | "creatorAdvisorReady";

/** 최종 URL pathname이 /naver_blog/{blogId}/trends 계열에 도달했는지 확인한다. */
function isTrendsReadyUrl(url: string, blogId: string): boolean {
  try {
    return new URL(url).pathname.startsWith(`/naver_blog/${blogId}/trends`);
  } catch {
    return false;
  }
}

/**
 * NAVER 로그인 성공과 Creator Advisor 서비스 접근 성공은 서로 다른 상태다("로그인 도메인을
 * 벗어남"만으로 creatorAdvisorReady로 판단하지 않는다) - nid.naver.com이면 로그인 자체가 안 된
 * 것이고, 로그인은 됐지만 아직 trends pathname에 도달하지 못했으면(예: /introduction) Creator
 * Advisor 쪽 초기 설정이 안 된 것이다.
 */
function classifyState(url: string, blogId: string): CreatorAdvisorAccessState {
  if (url.includes("nid.naver.com")) return "naverLoginRequired";
  if (isTrendsReadyUrl(url, blogId)) return "creatorAdvisorReady";
  return "creatorAdvisorSetupRequired";
}

/** predicate가 true가 될 때까지 폴링한다. timeoutMs 안에 만족하지 못하면 false. */
async function pollUntil(page: Page, timeoutMs: number, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(STATE_POLL_INTERVAL_MS);
  }
  return true;
}

type LoginPhaseResult = {
  ok: boolean;
};

/**
 * phase 1: naverLoginRequired -> creatorAdvisorSetupRequired -> creatorAdvisorReady 상태 폴링 +
 * (creatorAdvisorReady가 되면) DOM에 이미 존재하는 topic card/title/keyword row 개수 확인.
 * creatorAdvisorSetupRequired여도 즉시 브라우저를 닫지 않고, 사용자가 브라우저에서 직접
 * 블로그 선택/Creator Advisor 진입을 마칠 때까지 최대 5분 열어둔다.
 */
async function ensureLoggedIn(trendsUrl: string, blogId: string): Promise<LoginPhaseResult> {
  console.log(`profile: ${CREATOR_ADVISOR_CONFIG.profileDir}`);
  console.log(`trends URL: ${trendsUrl}`);
  console.log("브라우저 창이 열립니다. 최초 실행이라면 직접 NAVER 로그인을 완료해주세요.\n");

  const context = await chromium.launchPersistentContext(CREATOR_ADVISOR_CONFIG.profileDir, {
    headless: false,
    // 실측 확인(2026-08-26): Creator Advisor trends selector는 400x778 반응형 viewport 기준
    // 마크업이다 - desktop viewport에서는 selector가 하나도 안 잡힌다.
    viewport: CREATOR_ADVISOR_VIEWPORT,
  });
  const failed: LoginPhaseResult = { ok: false };

  try {
    const page = await context.newPage();
    await page.goto(trendsUrl, { waitUntil: "networkidle" });

    let state = classifyState(page.url(), blogId);

    // phase A: naverLoginRequired 대기 (NAVER 로그인 자체)
    if (state === "naverLoginRequired") {
      console.log("⏳ 상태: naverLoginRequired - 브라우저에서 NAVER 로그인을 완료해주세요 (최대 5분 대기)");
      const loggedIn = await pollUntil(
        page,
        NAVER_LOGIN_WAIT_TIMEOUT_MS,
        () => classifyState(page.url(), blogId) !== "naverLoginRequired"
      );
      if (!loggedIn) {
        console.error("\n❌ 상태: naverLoginRequired (5분 내 로그인 완료를 확인하지 못했습니다)");
        console.error("   브라우저에서 NAVER 로그인을 완료한 뒤 스크립트를 다시 실행하세요.");
        return failed;
      }
      console.log("\n✅ NAVER 로그인 성공 확인됨 (로그인 도메인을 벗어남)");
      state = classifyState(page.url(), blogId);
    } else {
      console.log("✅ NAVER 로그인 이미 확인됨 (persistent profile 세션 재사용)");
    }

    // phase B: creatorAdvisorSetupRequired 대기 (NAVER 로그인과는 별개 상태) - 즉시 실패로
    // 기록하되 브라우저는 닫지 않고, 사용자가 직접 설정을 마칠 때까지 최대 5분 열어둔다.
    if (state === "creatorAdvisorSetupRequired") {
      console.error(
        "\n❌ 상태: creatorAdvisorSetupRequired\n" +
          "Creator Advisor 초기 설정이 필요합니다.\n" +
          "열린 브라우저에서 블로그를 선택하고 Creator Advisor 화면에 진입해주세요."
      );
      console.log(`(현재 URL: ${page.url()})`);
      console.log("설정을 완료하면 자동으로 감지합니다 - 최대 5분 대기...");

      const ready = await pollUntil(
        page,
        CREATOR_ADVISOR_SETUP_WAIT_TIMEOUT_MS,
        () => classifyState(page.url(), blogId) === "creatorAdvisorReady"
      );
      if (!ready) {
        console.error(
          `\n❌ 상태: creatorAdvisorSetupRequired (5분 내 trends 페이지 도달을 확인하지 못했습니다, ` +
            `현재 URL: ${page.url()})`
        );
        return failed;
      }
    }

    const readyUrl = page.url();
    console.log(`\n✅ 상태: creatorAdvisorReady (${readyUrl})`);
    console.log(
      "(topic card/keyword row 개수는 화면 렌더링 대기 + 화면 상태 확정 이후에 다음 단계에서 확인합니다.)"
    );

    return { ok: true };
  } finally {
    // persistent context이므로 close해도 profileDir에 로그인 세션이 그대로 남는다.
    await context.close();
  }
}

async function runExtraction(): Promise<void> {
  console.log("\n▶ 실 데이터 추출 (BrowserCreatorAdvisorProvider, headless:false)\n");

  const provider = new BrowserCreatorAdvisorProvider({
    headless: false,
    maxTopics: DEBUG_MAX_TOPICS,
    maxKeywordsPerTopic: DEBUG_MAX_KEYWORDS_PER_TOPIC,
  });

  let result;
  try {
    result = await provider.fetchTrendKeywordsDetailed();
  } catch (error) {
    if (error instanceof CreatorAdvisorLoginRequiredError) {
      console.error(`\n❌ 상태: 로그인 필요 - ${error.message}`);
      return;
    }
    if (error instanceof CreatorAdvisorAccessError) {
      console.error(`\n❌ 상태: trends 페이지 접근 실패 - ${error.message}`);
      return;
    }
    if (error instanceof CreatorAdvisorDataUnavailableError) {
      console.error(`\n❌ 상태: 데이터 없음 - ${error.message}`);
      printDateChecks(error.checkedDates);
      return;
    }
    throw error;
  }

  console.log("✅ 상태: trends 페이지 접근 성공 + 최신 유효 날짜 탐색 완료");
  printDateChecks(result.dateChecks);
  console.log(`requestedAt: ${result.requestedAt}`);
  console.log(`initialTrendDate: ${result.initialTrendDate ?? "N/A"}`);
  console.log(`latestAvailableTrendDate: ${result.latestAvailableTrendDate}`);
  printCardScope(result.cardScope);

  if (result.topics.length === 0) {
    console.error("\n❌ 상태: selector 탐색 실패 - 추출된 topic이 없습니다.");
    for (const [key, message] of Object.entries(result.topicErrors)) {
      console.error(`   ${key}: ${message}`);
    }
    console.error("   npm run debug:creator-advisor -- --inspect 로 실제 DOM 상태를 재확인하세요.");
    return;
  }

  if (Object.keys(result.topicErrors).length > 0) {
    console.log("\n⚠️ 일부 topic card는 파싱 실패(격리됨, 나머지는 정상 출력):");
    for (const [key, message] of Object.entries(result.topicErrors)) {
      console.log(`  ${key}: ${message}`);
    }
  }

  printTrendResult(result.trendDate, result.topics);
}

/**
 * topic category card vs 성별·연령별(demographic) card 구성을 출력한다(요구사항 6): 실제 topic
 * 제목 전체 목록과, demographic 제목은 최대 5개 샘플로만 별도 출력한다.
 */
function printCardScope(scope: TrendCardScope): void {
  console.log("\n[card 구성 (topic vs demographic)]");
  console.log(`allTrendCardCount = ${scope.allTrendCardCount}`);
  console.log(`topicCardCount = ${scope.topicCardCount}`);
  console.log(`demographicCardCount = ${scope.demographicCardCount}`);
  console.log(`ignoredCardCount = ${scope.ignoredCardCount}`);
  console.log(`topic titles: ${scope.topicTitles.join(", ") || "(없음)"}`);
  if (scope.demographicTitleSamples.length > 0) {
    console.log(`demographic 제목 샘플(최대 5개): ${scope.demographicTitleSamples.join(", ")}`);
  }
}

/** 날짜별 확인 기록을 "trendDate / cards=N / rows=N / status=..." 형식으로 출력한다. */
function printDateChecks(checks: DateCheckResult[]): void {
  console.log("\n[날짜별 확인 기록]");
  for (const c of checks) {
    console.log(`${c.trendDate ?? "?"}`);
    console.log(`cards=${c.topicCardCount}`);
    console.log(`rows=${c.keywordRowCount}`);
    console.log(`status=${c.dataStatus}`);
    console.log("");
  }
}

/** trendDate + topic별 "순위. 키워드 | movementType | rankChange" 형식으로 출력한다(runExtraction/runInspect 공용). */
function printTrendResult(
  trendDate: string | null,
  topics: { topic: string; candidates: { rank: number; keyword: string; movementType: string; rankChange: number | null }[] }[]
): void {
  console.log(`\ntrendDate: ${trendDate ?? "N/A"}\n`);

  for (const topicGroup of topics) {
    console.log(`[${topicGroup.topic}]`);
    for (const candidate of topicGroup.candidates) {
      console.log(
        `${candidate.rank}. ${candidate.keyword} | ${candidate.movementType} | ${candidate.rankChange ?? "null"}`
      );
    }
    console.log("");
  }
}

async function runInspect(trendsUrl: string, blogId: string): Promise<void> {
  console.log("\n▶ selector 재검증 모드 (전체 HTML/개인정보 없음)\n");

  const context = await chromium.launchPersistentContext(CREATOR_ADVISOR_CONFIG.profileDir, {
    headless: false,
    // 실측 확인(2026-08-26): Creator Advisor trends selector는 400x778 반응형 viewport 기준
    // 마크업이다 - desktop viewport에서는 selector가 하나도 안 잡힌다.
    viewport: CREATOR_ADVISOR_VIEWPORT,
  });

  try {
    const page = await context.newPage();
    await page.goto(trendsUrl, { waitUntil: "networkidle" });

    // phase 1(ensureLoggedIn)이 이미 creatorAdvisorReady를 확인한 뒤에만 호출되지만, 방어적으로
    // 여기서도 같은 3-상태 판정을 다시 확인한다 - creatorAdvisorSetupRequired 상태에서는 selector
    // 탐색을 하지 않는다(요구사항).
    const state = classifyState(page.url(), blogId);
    if (state !== "creatorAdvisorReady") {
      console.error(
        `❌ 상태: ${state} - inspect 모드는 creatorAdvisorReady 상태에서만 selector를 탐색합니다. ` +
          `(url=${page.url()}) npm run debug:creator-advisor -- --inspect 를 다시 실행하세요.`
      );
      return;
    }

    const viewport = page.viewportSize();
    console.log(`viewport: ${viewport ? `${viewport.width}x${viewport.height}` : "N/A"}`);

    console.log(
      `\n페이지 렌더링 대기 중 (다음 텍스트 중 하나: ${TRENDS_READY_TEXT_CANDIDATES.join(", ")}, ` +
        `최대 ${TRENDS_RENDER_WAIT_TIMEOUT_MS / 1000}초)...`
    );
    const renderedText = await waitForTrendsPageRendered(page, TRENDS_RENDER_WAIT_TIMEOUT_MS);
    if (renderedText) {
      console.log(`✅ 렌더링 확인됨 (텍스트: "${renderedText}")`);
    } else {
      console.log(
        `⚠️ 렌더링 확인 실패 - 위 텍스트 중 어느 것도 ${TRENDS_RENDER_WAIT_TIMEOUT_MS / 1000}초 내에 나타나지 않았습니다. ` +
          `아래 진단으로 계속 진행합니다.`
      );
    }

    const viewState = await ensureTrendsViewState(page);
    console.log("\n[화면 상태 확인/설정] (이미 활성 상태면 재클릭하지 않음)");
    for (const [label, result] of Object.entries(viewState)) {
      console.log(`  "${label}": ${result}`);
    }

    // 탭/보기/정렬 클릭 직후에는 topic card가 아직 비동기로 로딩 중일 수 있다(실측 확인: 클릭 직후
    // count()는 0이었지만 몇 백 ms 뒤 진단 스캔에서는 카드가 이미 채워져 있었다) - count 전에
    // topicCard selector가 나타날 때까지 기다린다.
    const cardAppeared = await page
      .waitForSelector(CREATOR_ADVISOR_TREND_SELECTORS.topicCard, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    console.log(
      cardAppeared
        ? "✅ 화면 상태 전환 후 topic card 로딩 확인됨"
        : "⚠️ 화면 상태 전환 후 15초 내에 topic card가 나타나지 않았습니다"
    );

    if (!cardAppeared) {
      // topic card 자체가 없으면 날짜 문제가 아니라 selector/렌더링 문제다 - Swiper/날짜 탐색으로
      // 넘어가지 않고 안전한 진단만 출력한다.
      await printZeroSelectorDiagnostics(page);
      return;
    }

    // "최신 날짜에 keyword 데이터가 아직 없음"은 selector 실패도 계정에 데이터가 없는 것도 아니다
    // (실측 확인: 2026-08-25는 not_ready, 2026-08-24는 실제 keyword 데이터 존재) - 데이터가 있는
    // 가장 최신 날짜를 찾을 때까지 최대 7일 전으로 하루씩 이동하며 확인한다.
    console.log(`\n▶ 최신 유효 날짜 탐색 (최대 ${MAX_DATE_LOOKBACK_DAYS}일 이전까지)`);
    let dateResult;
    try {
      dateResult = await findLatestAvailableTrendDate(page);
    } catch (error) {
      if (error instanceof CreatorAdvisorDataUnavailableError) {
        console.error(`\n❌ 상태: 데이터 없음 - ${error.message}`);
        printDateChecks(error.checkedDates);
        return;
      }
      throw error;
    }

    printDateChecks(dateResult.checkedDates);
    console.log(`requestedAt: ${dateResult.requestedAt}`);
    console.log(`initialTrendDate: ${dateResult.initialTrendDate ?? "N/A"}`);
    console.log(`latestAvailableTrendDate: ${dateResult.latestAvailableTrendDate}`);

    const counts = {
      topicCard: await page.locator(CREATOR_ADVISOR_TREND_SELECTORS.topicCard).count(),
      topicTitle: await page.locator(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle).count(),
      keywordRow: await page.locator(CREATOR_ADVISOR_TREND_SELECTORS.keywordRow).count(),
      keywordText: await page.locator(CREATOR_ADVISOR_TREND_SELECTORS.keywordText).count(),
      movement: await page.locator(CREATOR_ADVISOR_TREND_SELECTORS.movement).count(),
    };
    console.log(`\n[selector count] (latestAvailableTrendDate=${dateResult.latestAvailableTrendDate} 기준)`);
    console.log(`  topic card(${CREATOR_ADVISOR_TREND_SELECTORS.topicCard}): ${counts.topicCard}개`);
    console.log(`  topic title(${CREATOR_ADVISOR_TREND_SELECTORS.topicTitle}): ${counts.topicTitle}개`);
    console.log(`  keyword row(${CREATOR_ADVISOR_TREND_SELECTORS.keywordRow}): ${counts.keywordRow}개`);
    console.log(`  keyword text(${CREATOR_ADVISOR_TREND_SELECTORS.keywordText}): ${counts.keywordText}개`);
    console.log(`  movement(${CREATOR_ADVISOR_TREND_SELECTORS.movement}): ${counts.movement}개`);

    // 이 날짜에서 즉시 실제 parser로 추출한다.
    const html = await page.content();
    const collectedAt = new Date().toISOString();
    const parsed = parseTrendPage(html, collectedAt);

    printCardScope(parsed.cardScope);

    if (Object.keys(parsed.topicErrors).length > 0) {
      console.log("\n⚠️ 일부 topic card 파싱 실패:");
      for (const [key, message] of Object.entries(parsed.topicErrors)) {
        console.log(`  ${key}: ${message}`);
      }
    }
    if (parsed.cardScope.topicCardCount < DEBUG_MAX_TOPICS) {
      // Swiper 조작은 여전히 보류 - parsed.topics.length(파싱 성공분)가 아니라
      // cardScope.topicCardCount(demographic 제외한 실제 topic category card 수)로 비교한다 -
      // topic card는 있는데 그 날짜에 keyword row가 없는 건 Swiper 문제가 아니다.
      console.log(
        `⚠️ DOM에 존재하는 topic category card(${parsed.cardScope.topicCardCount}개)가 요청한 topic ` +
          `개수(${DEBUG_MAX_TOPICS})보다 적습니다. Swiper 순회가 필요한지는 이번 단계에서는 판단만 하고 ` +
          `구현하지 않았습니다.`
      );
    }

    const topics = parsed.topics.slice(0, DEBUG_MAX_TOPICS).map((topicGroup) => ({
      topic: topicGroup.topic,
      candidates: topicGroup.candidates.slice(0, DEBUG_MAX_KEYWORDS_PER_TOPIC),
    }));
    printTrendResult(parsed.trendDate, topics);
  } finally {
    await context.close();
  }
}

/**
 * selector count가 여전히 0일 때만 쓰는 안전한 진단 출력. 전체 HTML/쿠키/토큰은 출력하지 않는다.
 * viewport/최종 URL/document.title/알려진 visible text 존재 여부 + class에 "trend"가 포함된
 * element(태그+class+짧은 text 샘플) 최대 25개만 출력한다.
 */
async function printZeroSelectorDiagnostics(page: Page): Promise<void> {
  console.log("\n▶ selector 미발견 진단 (전체 HTML/개인정보 없음)\n");

  const viewport = page.viewportSize();
  console.log(`viewport: ${viewport ? `${viewport.width}x${viewport.height}` : "N/A"}`);
  console.log(`final URL: ${page.url()}`);
  console.log(`document.title: ${await page.title()}`);

  const textsToCheck = [...TRENDS_READY_TEXT_CANDIDATES, ...DIAGNOSTIC_TOPIC_TEXT_SAMPLES];
  console.log("\n[visible text 존재 여부]");
  for (const text of textsToCheck) {
    const locator = page.getByText(text, { exact: false });
    const exists = (await locator.count()) > 0;
    const visible = exists ? await locator.first().isVisible().catch(() => false) : false;
    console.log(`  "${text}": ${exists ? (visible ? "존재(visible)" : "존재(hidden)") : "없음"}`);
  }

  const trendClassElements = await page.$$eval(
    '[class*="trend" i]',
    (nodes, max) =>
      nodes.slice(0, max).map((el) => ({
        tag: el.tagName.toLowerCase(),
        className: (el.getAttribute("class") ?? "").slice(0, 80),
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
      })),
    MAX_CANDIDATES_PRINTED
  );
  console.log(`\n[class에 "trend" 포함된 element] (최대 ${MAX_CANDIDATES_PRINTED}개)`);
  if (trendClassElements.length === 0) console.log("  (없음)");
  trendClassElements.forEach((el, i) =>
    console.log(`  [${i}] <${el.tag} class="${el.className}"> "${truncateText(el.text)}"`)
  );
}

async function main() {
  console.log("▶ Creator Advisor 실 연결 디버그");
  console.log(`mode: ${INSPECT_MODE ? "확정 selector 재검증(inspect)" : "실 데이터 추출"}\n`);

  if (!CREATOR_ADVISOR_CONFIG.blogId) {
    console.error("❌ CREATOR_ADVISOR_BLOG_ID가 설정되지 않았습니다. .env에 설정하세요.");
    process.exitCode = 1;
    return;
  }

  const blogId = CREATOR_ADVISOR_CONFIG.blogId;
  const trendsUrl = creatorAdvisorTrendsPageUrl(blogId);

  const loginResult = await ensureLoggedIn(trendsUrl, blogId);
  if (!loginResult.ok) {
    process.exitCode = 1;
    return;
  }

  if (INSPECT_MODE) {
    await runInspect(trendsUrl, blogId);
  } else {
    await runExtraction();
  }
}

main().catch((error) => {
  console.error("❌ Creator Advisor 디버그 실패:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
