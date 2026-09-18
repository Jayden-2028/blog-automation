// 정해진 순위 사이트의 순위표를 그대로 캡처한다(2026-09-18 사용자 지정).
//
// 왜(실측): TV 화제성 순위·영화 박스오피스 순위는 **웹 검색으로 영영 못 찾는다.** 기자도 기관도 그
// 수치를 기사 본문 텍스트로 쓰지 그림으로 만들지 않아서다 - 재수집에서 두 자리가 그 이유로 끝까지
// 비었고, 수집기가 가져온 건 키스신 스틸과 본방사수 이벤트 포스터였다. 그렇다고 우리가 직접 그릴
// 수도 없다(그 순위 데이터가 원고에 없다). 원본 사이트를 보여주는 것이 가장 정확하다.
//
// 어디를 쓰는가(사용자 지정):
//   - TV 화제성 순위   -> 펀덱스(FUNdex)
//   - 영화 박스오피스  -> CGV 무비차트
// 둘 다 기업 공식 사이트 화면이라 §8-2의 "행정 절차 화면 캡처 금지" 예외에 해당한다(사용자 결정).
//
// 캡처 범위: 컨테이너 **위쪽부터 지정 비율만큼**만 찍는다. 전체를 찍으면 CGV는 24,000px가 넘어
// 본문에 쓸 수 없다. 위쪽이 곧 1위부터이므로 순위표에서는 위쪽이 언제나 핵심이다.

import { chromium } from "playwright";

/** 헤드리스 티를 지운다 - CGV는 기본 Playwright 컨텍스트를 봇으로 보고 차단한다(실측). */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type RankingSource = {
  id: string;
  /** 로그·캡션에 쓰는 이름. */
  label: string;
  url: string;
  /** 순위표를 감싸는 요소. 클래스 해시가 배포마다 바뀌므로 id나 접두사 매칭을 쓴다. */
  containerSelector: string;
  /** 캡처 영역의 가로/세로. 컨테이너 위쪽부터 이만큼만 찍는다. */
  aspect: number;
  /** 컨테이너 위쪽에 겹쳐 들어오는 요소를 몇 px 건너뛸지(기본 0). CGV는 탭 줄 잔상이 남는다. */
  offsetTop?: number;
  /** 이 자리가 이 출처인지 판정한다. 마커 설명에서 찾는다. */
  match: RegExp;
  /** 캡션에 넣을 출처 표기. */
  attribution: string;
};

export const RANKING_SOURCES: RankingSource[] = [
  {
    id: "tv-buzz",
    label: "펀덱스 TV·OTT 화제성 순위",
    url: "https://www.fundex.co.kr/fxmain.do",
    // #main_g는 제목("TV-OTT ALL BuzzWorthiness")·탭·순위 목록을 함께 감싼다.
    containerSelector: "#main_g",
    aspect: 0.75,
    match: /화제성|버즈\s*워디니스|buzzworthiness|펀덱스|fundex/i,
    attribution: "출처: 펀덱스(FUNdex)",
  },
  {
    id: "box-office",
    label: "CGV 무비차트",
    url: "https://cgv.co.kr/cnm/cgvChart/movieChart?tabParam=75",
    // chartArea가 카드 목록의 시작점이다 - 바깥 section을 쓰면 위쪽 탭 줄이 반만 잘려 들어온다(실측).
    containerSelector: 'div[class*="chartArea"]',
    // 한 줄에 2편씩 들어가는 카드 배치라, 0.55면 상위 4편이 들어온다.
    aspect: 0.55,
    offsetTop: 18,
    match: /박스\s*오피스|무비\s*차트|예매율|누적\s*관객|cgv/i,
    attribution: "출처: CGV 무비차트",
  },
];

/** 마커 설명이 등록된 순위 출처를 가리키면 그것을 돌려준다. 아니면 null(본문 데이터로 표를 그린다). */
export function matchRankingSource(description: string): RankingSource | null {
  return RANKING_SOURCES.find((source) => source.match.test(description)) ?? null;
}

/**
 * 임의 URL을 열어 찍는다(2026-09-18 `페이지 캡처` 신설). 리서처가 실제로 열어본 URL만 여기로 온다
 * - 집필이 주소를 지어내면 없는 페이지를 찍게 되므로 URL 출처를 리서치로 고정했다(사용자 결정).
 *
 * 알려진 사이트(펀덱스·CGV)면 그 전용 영역·비율을 쓰고, 그 외에는 **열었을 때 보이는 화면 그대로**를
 * 찍는다. 사람이 그 페이지를 캡처할 때 하는 행동과 같다.
 */
export async function capturePageImage(url: string): Promise<CaptureRankingImageResult> {
  const known = RANKING_SOURCES.find((source) => sameTarget(source.url, url));
  if (known) return captureRankingImage({ ...known, url });

  return captureWithBrowser(url, async (page) => {
    // 첫 화면(above the fold)을 그대로 찍는다. 4:3이라 본문에 넣기에 무리가 없고, 프로모션·공지
    // 페이지는 핵심이 맨 위에 있다. 컨테이너를 추정해 잘라내려 하면 사이트마다 어긋난다.
    const buffer = await page.screenshot({ type: "jpeg", quality: 88 });
    return { ok: true as const, buffer, mimeType: "image/jpeg", width: 1280 * 2, height: 960 * 2 };
  }, { width: 1280, height: 960 });
}

/** 같은 페이지를 가리키는지(쿼리·해시 차이는 무시). 레지스트리 조회에만 쓴다. */
function sameTarget(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

export type CaptureRankingImageResult =
  | { ok: true; buffer: Buffer; mimeType: string; width: number; height: number }
  | { ok: false; error: string };

export async function captureRankingImage(source: RankingSource): Promise<CaptureRankingImageResult> {
  return captureWithBrowser(source.url, async (page) => {
    // 두 사이트 모두 순위를 스크립트로 채운다 - 컨테이너가 나타날 때까지 기다린다.
    await page.waitForSelector(source.containerSelector, { timeout: 30_000 });
    await page.waitForTimeout(4000);

    const box = await page.locator(source.containerSelector).first().boundingBox();
    if (!box || box.width < 100) return { ok: false as const, error: "순위표 영역을 찾지 못했습니다" };

    const offsetTop = source.offsetTop ?? 0;
    const width = Math.round(box.width);
    const height = Math.round(Math.min(box.height - offsetTop, width / source.aspect));
    // jpeg로 낸다 - 포스터 썸네일이 많아 png로 두면 2MB를 넘는다(실측 2.26MB → jpeg 약 1/5).
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 88,
      clip: { x: box.x, y: box.y + offsetTop, width, height },
    });

    // deviceScaleFactor 2라 실제 픽셀은 2배다.
    return { ok: true as const, buffer, mimeType: "image/jpeg", width: width * 2, height: height * 2 };
  });
}

/**
 * 헤드리스 티를 지운 브라우저로 URL을 열고 `shoot`을 돌린다. CGV는 기본 Playwright 컨텍스트를
 * 봇으로 보고 차단한다(실측 "비정상적으로 CGV에 접속") - UA·locale·webdriver 위장이 필요하다.
 */
async function captureWithBrowser(
  url: string,
  shoot: (page: import("playwright").Page) => Promise<CaptureRankingImageResult>,
  viewport: { width: number; height: number } = { width: 1440, height: 1400 }
): Promise<CaptureRankingImageResult> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport,
      // 글자가 선명해야 순위·수치를 읽을 수 있다.
      deviceScaleFactor: 2,
    });
    await context.addInitScript("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})");
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
    return await shoot(page);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
