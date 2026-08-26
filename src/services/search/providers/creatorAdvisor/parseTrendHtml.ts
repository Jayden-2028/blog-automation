// Creator Advisor trends 페이지의 렌더링된 HTML(문자열)에서 topic card별 키워드/순위/등락 정보를
// 추출하는 순수 함수.
//
// 실제 DOM 구조(2026-08-26 실측 확인 완료 - 더 이상 placeholder 아님):
// - topic card: .u_ni_trend_list_box (Swiper 슬라이드 1개 = topic 1개)
// - topic 제목: card 안의 .u_ni_trend_title
// - keyword row: card 안의 .u_ni_trend_item (0-based 순서 + 1 = rank)
// - keyword 링크/텍스트: row 안의 .u_ni_trend_link > .u_ni_trend_text
// - 등락 표시: row 안의 .u_ni_data. ▲/▼ 문자에 의존하지 않고 classList를 1차 신호로 쓴다
//   (up/down/new, 셋 다 없으면 flat). 숫자는 textContent에서 숫자만 추출한다.
//
// BrowserCreatorAdvisorProvider(Playwright)와 testParseTrendPage.ts(mock fixture 기반 테스트)가
// 이 파일을 공유한다: 프로덕션에서는 Playwright로 렌더링한 page.content()를, 테스트에서는 fixture
// HTML 파일을 그대로 이 함수에 넘긴다.

import { parse, type HTMLElement } from "node-html-parser";
import type { CreatorAdvisorMovementType, CreatorAdvisorTrendCandidate } from "../CreatorAdvisorProvider.js";

export const CREATOR_ADVISOR_TREND_SELECTORS = {
  topicCard: ".u_ni_trend_list_box",
  topicTitle: ".u_ni_trend_title",
  keywordList: ".u_ni_item_list",
  keywordRow: ".u_ni_trend_item",
  keywordLink: ".u_ni_trend_link",
  keywordText: ".u_ni_trend_text",
  movement: ".u_ni_data",
} as const;

// topic category card와 성별·연령별(demographic) card 구분(실측 확인, 2026-08-26):
// "주제별 인기유입검색어 > 설정순 보기"의 topic category card와 성별·연령별 인기유입검색어 card가
// 동일한 selector(.u_ni_trend_list_box)를 쓰고, 같은 swiper 인스턴스 안에 나란히 렌더링된다 -
// :visible이나 조상 DOM(최대 8단계 확인)으로는 구분되지 않는다. 그래서 DOM scope 대신 card 제목이
// "N-N세 남자/여자" 형식인지로 구분한다. topic 개수를 하드코딩하지 않는다 - 사용자가 Creator
// Advisor "주제 설정"을 바꾸면 topic card 개수가 달라질 수 있다.
// 공백/하이픈 표기 변형 허용: "30-34세 여자", "30 - 34 세 남자", "60세- 여자"(상한 없는 구간) 등.
const DEMOGRAPHIC_TITLE_PATTERN = /\d+\s*-?\s*\d*\s*세\s*-?\s*(남자|여자)/;

export function isDemographicTopicTitle(title: string): boolean {
  return DEMOGRAPHIC_TITLE_PATTERN.test(title.trim());
}

// topic card 자체를 하나도 못 찾을 때만 던진다(페이지 전체 단위 실패 - 페이지 구조가 크게
// 바뀌었거나 엉뚱한 페이지에 있다는 신호). card 하나 안에서 제목/row를 못 찾는 것은 그 card만의
// 실패로 간주해 parseTrendPage가 topicErrors에 격리하고 나머지 card는 계속 파싱한다 - card 하나가
// 깨졌다고 나머지 topic까지 버리지 않는다.
export class TrendPageSelectorError extends Error {
  constructor(
    message: string,
    public readonly topic: string
  ) {
    super(message);
    this.name = "TrendPageSelectorError";
  }
}

// "2026. 08. 24." 형태의 트렌드 기준일 텍스트 패턴.
const TREND_DATE_PATTERN = /(\d{4})\.\s*(\d{2})\.\s*(\d{2})\.?/;

/**
 * 페이지 상단 트렌드 기준일을 찾아 "YYYY-MM-DD"로 normalize한다.
 * 전용 selector가 아직 확인되지 않아 페이지 전체 텍스트에서 첫 매치를 사용하는 best-effort다 -
 * 못 찾아도 파싱 전체를 실패시키지 않고 null을 반환한다.
 */
function extractTrendDate(root: HTMLElement): string | null {
  const match = TREND_DATE_PATTERN.exec(root.text);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month}-${day}`;
}

function extractDigits(text: string | undefined | null): number {
  const match = /\d+/.exec(text ?? "");
  return match ? Number.parseInt(match[0], 10) : 0;
}

/**
 * .u_ni_data의 class를 1차 신호로 movementType/rankChange를 결정한다. 화면의 ▲/▼ 문자에는
 * 의존하지 않는다(요구사항) - up/down/new 중 아무 class도 없으면 flat으로 취급한다.
 */
function parseMovement(movementEl: HTMLElement | null): {
  movementType: CreatorAdvisorMovementType;
  rankChange: number | null;
} {
  const classes = (movementEl?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  const text = movementEl?.text ?? "";

  if (classes.includes("up")) return { movementType: "up", rankChange: extractDigits(text) };
  if (classes.includes("down")) return { movementType: "down", rankChange: -extractDigits(text) };
  if (classes.includes("new")) return { movementType: "new", rankChange: null };
  return { movementType: "flat", rankChange: 0 };
}

export type ParsedTrendTopic = {
  /** card의 실제 표시 제목 원문 (예: "스타·연예인"). */
  topic: string;
  candidates: CreatorAdvisorTrendCandidate[];
};

export type TrendCardScope = {
  /** .u_ni_trend_list_box selector에 잡힌 전체 card 수. topicCardCount + demographicCardCount + ignoredCardCount와 같다. */
  allTrendCardCount: number;
  /** 제목이 있고 demographic 패턴이 아닌 topic category card 수(파싱 성공/실패 무관 - 실패분은 topicErrors에 있다). */
  topicCardCount: number;
  /** "N-N세 남자/여자" 형식 제목으로 판별해 건너뛴 card 수. topicErrors에는 담기지 않는다. */
  demographicCardCount: number;
  /** 제목(.u_ni_trend_title) 자체를 못 찾아 topic/demographic 어느 쪽으로도 분류 못한 card 수(topicErrors에는 기록된다). */
  ignoredCardCount: number;
  /** demographic으로 판별된 제목 샘플(diagnostic 전용, 최대 5개). */
  demographicTitleSamples: string[];
  /** 실제 topic category 제목 전체 목록(파싱 성공/실패 무관, DOM에 나온 순서 그대로). */
  topicTitles: string[];
};

export type ParsedTrendPage = {
  /** 페이지 상단 트렌드 기준일, "YYYY-MM-DD". 못 찾으면 null. */
  trendDate: string | null;
  topics: ParsedTrendTopic[];
  /** 실패한 card만 담는다("card[인덱스]" 또는 파악된 topic 제목 -> 실패 사유). 성공한 card는 topics에 포함된다. */
  topicErrors: Record<string, string>;
  /** topic/demographic/무제목 card 개수 집계(diagnostic). */
  cardScope: TrendCardScope;
};

/**
 * Creator Advisor trends 페이지 HTML 전체에서 DOM에 존재하는 모든 topic category card를 파싱한다.
 * 성별·연령별(demographic) card는 제목 패턴으로 걸러 topics/topicErrors 어디에도 넣지 않는다
 * (cardScope로만 집계 - 요구사항: demographic card는 topicError로 취급하지 않는다).
 * (몇 개까지 쓸지 - maxTopics/maxKeywordsPerTopic - 는 호출자가 결정한다: 이 함수는 페이지에 있는
 * 그대로를 다 반환하는 순수 파싱 함수다.)
 * @throws TrendPageSelectorError topic card 자체가 하나도 없는 경우(페이지 구조 변경 추정)
 */
export function parseTrendPage(html: string, collectedAt: string): ParsedTrendPage {
  const root = parse(html);
  const trendDate = extractTrendDate(root);
  const cards = root.querySelectorAll(CREATOR_ADVISOR_TREND_SELECTORS.topicCard);

  if (cards.length === 0) {
    throw new TrendPageSelectorError(
      `topic card를 찾지 못했습니다 (selector="${CREATOR_ADVISOR_TREND_SELECTORS.topicCard}"). ` +
        `Creator Advisor 페이지 구조가 변경되었을 수 있습니다.`,
      "(page)"
    );
  }

  const topics: ParsedTrendTopic[] = [];
  const topicErrors: Record<string, string> = {};
  const demographicTitleSamples: string[] = [];
  const topicTitles: string[] = [];
  let topicCardCount = 0;
  let demographicCardCount = 0;
  let ignoredCardCount = 0;

  cards.forEach((card, cardIndex) => {
    const rawTitle = card.querySelector(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle)?.text?.trim();

    if (rawTitle && isDemographicTopicTitle(rawTitle)) {
      demographicCardCount++;
      if (demographicTitleSamples.length < 5) demographicTitleSamples.push(rawTitle);
      return; // topicErrors에 넣지 않는다 - demographic은 실패가 아니라 애초에 topic이 아니다.
    }

    if (rawTitle) {
      topicCardCount++;
      topicTitles.push(rawTitle);
    } else {
      ignoredCardCount++;
    }

    try {
      topics.push(parseTopicCard(card, cardIndex, collectedAt, trendDate));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = error instanceof TrendPageSelectorError ? error.topic : `card[${cardIndex}]`;
      topicErrors[key] = message;
    }
  });

  return {
    trendDate,
    topics,
    topicErrors,
    cardScope: {
      allTrendCardCount: cards.length,
      topicCardCount,
      demographicCardCount,
      ignoredCardCount,
      demographicTitleSamples,
      topicTitles,
    },
  };
}

function parseTopicCard(
  card: HTMLElement,
  cardIndex: number,
  collectedAt: string,
  trendDate: string | null
): ParsedTrendTopic {
  const topicTitle = card.querySelector(CREATOR_ADVISOR_TREND_SELECTORS.topicTitle)?.text?.trim();
  if (!topicTitle) {
    throw new TrendPageSelectorError(
      `card[${cardIndex}]: topic 제목을 찾지 못했습니다 (selector="${CREATOR_ADVISOR_TREND_SELECTORS.topicTitle}").`,
      `card[${cardIndex}]`
    );
  }

  const rows = card.querySelectorAll(CREATOR_ADVISOR_TREND_SELECTORS.keywordRow);
  if (rows.length === 0) {
    throw new TrendPageSelectorError(
      `topic="${topicTitle}": keyword row를 찾지 못했습니다 (selector="${CREATOR_ADVISOR_TREND_SELECTORS.keywordRow}").`,
      topicTitle
    );
  }

  const candidates = rows.map((row, index) => {
    const keywordText = row.querySelector(CREATOR_ADVISOR_TREND_SELECTORS.keywordText)?.text?.trim();
    if (!keywordText) {
      throw new TrendPageSelectorError(
        `topic="${topicTitle}": ${index + 1}번째 row에서 keyword를 찾지 못했습니다 ` +
          `(selector="${CREATOR_ADVISOR_TREND_SELECTORS.keywordText}").`,
        topicTitle
      );
    }

    const movementEl = row.querySelector(CREATOR_ADVISOR_TREND_SELECTORS.movement);
    const { movementType, rankChange } = parseMovement(movementEl);
    const rank = index + 1;
    const previousRank = rankChange !== null ? rank + rankChange : null;

    return {
      keyword: keywordText,
      topic: topicTitle,
      rank,
      movementType,
      previousRank,
      rankChange,
      collectedAt,
      metadata: {
        trendDate,
        rawMovementClass: movementEl?.getAttribute("class") ?? null,
        rawMovementText: movementEl?.text?.trim() ?? null,
      },
    } satisfies CreatorAdvisorTrendCandidate;
  });

  return { topic: topicTitle, candidates };
}
