// 네이버 뉴스·블로그 검색을 "최근 N시간 창"이 찰 때까지 페이지네이션하는 공통 헬퍼(2026-11-25).
//
// 왜: 엔터 키워드 수집(18:00 KST 1회)은 검색어마다 sort=date 최신 10건만 가져왔다. "캐스팅" 같은
// 검색어는 18시 직전 몇 분 사이 기사 10건만 잡고, 그날 오전·오후에 나온 캐스팅·공개일 확정·예고편
// 공개 기사를 놓쳤다(수지 '현혹' 공개일 확정 Top 10 탈락, '천천히 강렬하게' 예고편 공개 수집 0건).
// 사용자 지시(2026-11-25): "18시 직전 10분보다 그날 하루 종일 가장 이슈가 되었던 뉴스를 찾자.
// 블로그 포스팅은 22시~새벽 1시라 그 시간대 최신성은 의미가 없다."
//
// 동작(검색어 하나 기준):
// - sort=date, display=100으로 start=1, 101, 201 ... 을 차례로 받는다.
// - 창 밖 문서가 한 건이라도 나오면 그 검색어는 멈춘다(최신순이라 그 뒤는 전부 더 오래됐다).
// - 검색어당 상한(maxDocs)·전체 호출 예산(NaverCallBudget)·네이버 start 상한(1000)에서도 멈춘다.
// - **기존 최신 10건(legacyKeepCount)은 창과 무관하게 그대로 남긴다.** 창 밖이라는 이유로 지금 받던
//   문서를 잃지 않게 하기 위함이다(문서가 적은 시드의 커버리지 보존). 그 바깥의 7일 컷은
//   collectNaverCandidates의 dropStaleRawKeywords가 그대로 맡는다.
// - 날짜를 모르는 문서("unknown")는 버리지 않고, 멈출 근거로도 쓰지 않는다.
//
// 웹문서(webkr)는 날짜가 없어 이 헬퍼를 쓰지 않는다(기존대로 10건).

import { sleep } from "./naverClient.js";

/** 네이버 검색 API display 상한. */
export const NAVER_SEARCH_MAX_DISPLAY = 100;
/** 네이버 검색 API start 상한. start + display - 1이 이 값을 넘는 페이지는 요청하지 않는다. */
export const NAVER_SEARCH_MAX_START = 1000;
/** 창과 무관하게 남기는 앞쪽 문서 수 = 창 도입 전 displayPerQuery 기본값. */
export const DEFAULT_LEGACY_KEEP_COUNT = 10;

/** 창 판정. "unknown"은 날짜를 읽지 못한 경우다. */
export type WindowVerdict = "in" | "out" | "unknown";

export type DailyWindowStopReason = "window" | "exhausted" | "cap" | "startLimit" | "budget" | "pageError";

/**
 * 뉴스·블로그 페이지네이션이 함께 쓰는 호출 예산. **첫 페이지는 항상 보장**하고(기존 커버리지 유지),
 * 추가 페이지만 예산 안에서 허용한다. 첫 페이지 몫은 미리 예약해 두어, 앞 검색어가 예산을 다 써서
 * 뒤 검색어가 첫 페이지조차 못 받는 일이 없게 한다.
 */
export class NaverCallBudget {
  readonly maxCalls: number;
  private reservedFirstPages: number;
  private usedCalls = 0;
  private deniedExtraPages = 0;

  constructor(maxCalls: number, reservedFirstPages: number) {
    this.maxCalls = maxCalls;
    this.reservedFirstPages = Math.max(0, reservedFirstPages);
  }

  /** 첫 페이지 호출. 예산과 무관하게 항상 허용한다. */
  consumeFirstPage(): void {
    this.usedCalls++;
    if (this.reservedFirstPages > 0) this.reservedFirstPages--;
  }

  /** 추가 페이지 호출. 남은 첫 페이지 예약분을 침범하면 거절한다. */
  tryConsumeExtraPage(): boolean {
    if (this.usedCalls + this.reservedFirstPages + 1 > this.maxCalls) {
      this.deniedExtraPages++;
      return false;
    }
    this.usedCalls++;
    return true;
  }

  get used(): number {
    return this.usedCalls;
  }

  get denied(): number {
    return this.deniedExtraPages;
  }
}

export type PaginateUntilWindowOptions<T> = {
  /** (start, display) 페이지 한 장을 받는다. sort=date 고정은 호출자 몫이다. */
  fetchPage: (start: number, display: number) => Promise<T[]>;
  verdict: (item: T) => WindowVerdict;
  /** 검색어당 받을 최대 문서 수(위치 기준). */
  maxDocs: number;
  legacyKeepCount?: number;
  budget?: NaverCallBudget;
  /** 추가 페이지 사이 지연(ms). rate limit 보호. */
  requestDelayMs?: number;
};

export type PaginateUntilWindowResult<T> = {
  items: T[];
  pages: number;
  /** 받은 문서 수(창 밖으로 버린 것 포함). */
  fetched: number;
  /** 창 밖이라 버린 문서 수(legacyKeepCount 안쪽은 버리지 않으므로 세지 않는다). */
  droppedOutOfWindow: number;
  stopReason: DailyWindowStopReason;
  /** 추가 페이지가 실패해 그때까지 받은 것으로 끝낸 경우의 오류. */
  pageError?: string;
};

/**
 * 창이 찰 때까지 페이지를 넘긴다. **첫 페이지 실패는 그대로 던진다**(provider의 기존 검색어 단위
 * 실패 처리를 따른다). 추가 페이지 실패는 그때까지 받은 문서로 끝낸다 - 하루치 중 뒤쪽 일부를
 * 잃는 쪽이 검색어 전체를 잃는 것보다 낫다.
 */
export async function paginateUntilWindow<T>(
  options: PaginateUntilWindowOptions<T>
): Promise<PaginateUntilWindowResult<T>> {
  const legacyKeepCount = options.legacyKeepCount ?? DEFAULT_LEGACY_KEEP_COUNT;
  const maxDocs = Math.max(1, Math.floor(options.maxDocs));
  const items: T[] = [];
  let fetched = 0;
  let pages = 0;
  let droppedOutOfWindow = 0;
  let start = 1;

  for (;;) {
    const display = Math.min(NAVER_SEARCH_MAX_DISPLAY, maxDocs - fetched);

    if (pages > 0) {
      if (options.budget && !options.budget.tryConsumeExtraPage()) {
        return { items, pages, fetched, droppedOutOfWindow, stopReason: "budget" };
      }
      if (options.requestDelayMs && options.requestDelayMs > 0) await sleep(options.requestDelayMs);
    } else {
      options.budget?.consumeFirstPage();
    }

    let page: T[];
    try {
      page = await options.fetchPage(start, display);
    } catch (error) {
      if (pages === 0) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { items, pages, fetched, droppedOutOfWindow, stopReason: "pageError", pageError: message };
    }
    pages++;

    let sawOutOfWindow = false;
    page.forEach((item, index) => {
      const position = fetched + index;
      const verdict = options.verdict(item);
      if (verdict === "out") sawOutOfWindow = true;
      if (verdict !== "out" || position < legacyKeepCount) {
        items.push(item);
      } else {
        droppedOutOfWindow++;
      }
    });
    fetched += page.length;

    if (sawOutOfWindow) return { items, pages, fetched, droppedOutOfWindow, stopReason: "window" };
    if (page.length < display) return { items, pages, fetched, droppedOutOfWindow, stopReason: "exhausted" };
    if (fetched >= maxDocs) return { items, pages, fetched, droppedOutOfWindow, stopReason: "cap" };

    const nextStart = start + display;
    if (nextStart > NAVER_SEARCH_MAX_START) {
      return { items, pages, fetched, droppedOutOfWindow, stopReason: "startLimit" };
    }
    start = nextStart;
  }
}

// ---------- 창 판정 ----------

const HOUR_MS = 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * HOUR_MS;

/** 뉴스 pubDate(RFC 822) 판정. 미래 시각(시차·오기재)은 창 안으로 본다. */
export function newsWindowVerdict(pubDate: string | undefined, now: Date, windowHours: number): WindowVerdict {
  if (!pubDate) return "unknown";
  const publishedMs = new Date(pubDate).getTime();
  if (Number.isNaN(publishedMs)) return "unknown";
  return now.getTime() - publishedMs <= windowHours * HOUR_MS ? "in" : "out";
}

/** KST 기준 yyyyMMdd. */
export function toKstCompactDate(date: Date): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * 블로그 postdate(yyyyMMdd) 판정. 블로그는 **날짜까지만** 준다 - 시각이 없어 창 시작 시각과 직접
 * 비교할 수 없으므로, 창 시작 시각이 속한 KST 날짜 이후에 쓴 글을 창 안으로 본다. 그래서 18시 실행·
 * 24시간 창이면 블로그는 어제 0시부터 약 42시간을 받는다(뉴스보다 넓다).
 */
export function blogWindowVerdict(postdate: string | undefined, now: Date, windowHours: number): WindowVerdict {
  if (!postdate || !/^\d{8}$/.test(postdate)) return "unknown";
  const windowStartDate = toKstCompactDate(new Date(now.getTime() - windowHours * HOUR_MS));
  return postdate >= windowStartDate ? "in" : "out";
}

// ---------- provider 옵션·통계 ----------

export type NaverDailyWindowProviderOptions = {
  windowHours: number;
  /** 검색어당 최대 문서 수. */
  maxDocsPerQuery: number;
  legacyKeepCount?: number;
  budget?: NaverCallBudget;
  /** 창 기준 시각. 테스트에서만 고정한다. */
  now?: Date;
};

export type DailyWindowQueryStat = {
  query: string;
  pages: number;
  fetched: number;
  kept: number;
  droppedOutOfWindow: number;
  stopReason: DailyWindowStopReason;
};
