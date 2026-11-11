// 뉴스 피드 스토리 -> "검색에 넣을 이슈 구" 만들기 + 다음 랭킹 매칭(둘 다 순수 함수).
//
// 왜 헤드라인을 그대로 쓰지 않는가(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R1): 헤드라인은
// 수식어와 인용구가 섞인 문장이라 NAVER 검색어로 쓰면 "그 어투를 쓴 문서"를 찾는다. 2026-11-10
// Top 10의 키워드가 전부 제목 조각이었던 것이 그 결과다. 시드는 2~5어절 명사구여야 한다.
//
// 구를 만드는 길은 둘이다.
//  ① LLM(extractTopicQueries) - 운영 기본. run당 1콜.
//  ② **그룹 공유 토큰**(이 파일) - LLM이 실패했을 때. 2026-11-10에 LLM이 60/60 실패했으므로
//     폴백 품질이 곧 그날의 품질이다. `buildCompetitionQuery`의 "앞에서부터 핵심 명사 2개"는
//     한국어가 head-final이라 무너진다(extractTopicQueries.ts 상단 실측: `딸은 죽었는데`).
//     그런데 여기서는 **Google이 이미 같은 이슈 기사 여러 건을 묶어 줬다** - 여러 매체 제목에
//     공통으로 나오는 명사가 곧 그 사건의 고유명사다. 위치가 아니라 **빈도**로 뽑으므로
//     head-final 문제를 타지 않는다.
//     2026-11-11 실측 「인강 강사 이도」 클러스터(5개 매체)에서 공유 토큰은 이도·강의·중단·수능·
//     예능이었고, 위치 기반 폴백은 `수능 앞두고`를 줬다.
//
// 분류어·범용 수식어는 topicGrouping과 **같은 목록**으로 걷어낸다(TOPIC_GROUPING_CONFIG). 두
// 경로의 기준이 어긋나면 "여기선 주제인데 저기선 분류어"가 생긴다. clustering·다양성 로직은
// 읽기만 하고 바꾸지 않는다.

import { TOPIC_GROUPING_CONFIG } from "../../config/keywordScoring.js";
import { extractCoreNouns, tokenize } from "../keyword-ranking/clustering/textNormalize.js";
import type { GoogleNewsStory } from "../../services/search/providers/newsFeedEnt/parseGoogleNewsRss.js";

/** 이슈 구의 최대 어절 수. extractTopicQueries의 MAX_TOPIC_WORDS(5)와 같은 상한을 쓴다. */
export const MAX_ISSUE_PHRASE_WORDS = 5;
/** 이슈 구의 최소 어절 수. 한 낱말만 남으면 검색이 너무 넓어진다. */
export const MIN_ISSUE_PHRASE_WORDS = 2;
/** 다음 랭킹 기사가 Google 클러스터와 같은 이슈로 인정되는 최소 공유 핵심명사 수. */
export const DAUM_MATCH_MIN_INTERSECTION = 2;

/**
 * 헤드라인에 흔한 **비주제 어휘**. 분류어·범용 수식어(TOPIC_GROUPING_CONFIG)와 달리 이쪽은
 * 접속·부사·용언 연결형이라 검색어에 넣으면 주제를 좁히지 못하고 자릿수만 먹는다.
 *
 * 왜 접미사 규칙(`…고`로 끝나면 용언)을 쓰지 않는가: `광고`·`사고`·`예고`·`보고`·`경고`가 전부
 * 명사다. 한 글자 규칙으로 자르면 `김지원 광고`가 `김지원`이 된다. 그래서 **관측된 낱말만** 나열한다
 * (genericTokens와 같은 방식 - 통계로는 드문 고유명사와 드문 부사를 구분할 수 없다).
 *
 * 2026-11-11 실측 「인강 강사 이도」 클러스터의 공유 토큰은
 * 이도(5)·결국(4)·수능(3)·강의(3)·중단(3)·앞두고(2)·출연(2)·사과(2)·활동(2)이었다.
 * `결국`·`앞두고`가 상위에 끼어 "수능 앞두고 출연 이도 결국" 같은 구가 나왔다.
 */
export const HEADLINE_FILLER_TOKENS: readonly string[] = [
  "결국", "앞두고", "앞두", "한편", "여전히", "다시", "또다시", "이어", "만에", "통해", "대해",
  "위해", "따라", "끝내", "역시", "처음", "당장", "모두", "전부", "직접", "사실", "그대로",
  "하지만", "그런데", "때문", "이번", "지난", "오늘", "내일", "어제", "현재", "최근", "아직",
  "무려", "결과", "상황", "모습", "순간", "이제", "진짜", "정말", "완전", "갑자기", "급기야",
];

const EXCLUDED_TOKENS = new Set(
  [
    ...TOPIC_GROUPING_CONFIG.genericTokens,
    ...TOPIC_GROUPING_CONFIG.categoryTerms,
    ...HEADLINE_FILLER_TOKENS,
  ].map((token) => token.toLowerCase())
);

/** 제목 -> 분류어·범용어를 걷어낸 핵심 명사 목록(등장 순서 유지, 중복 제거). */
export function issueTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const noun of extractCoreNouns(tokenize(text))) {
    const normalized = noun.toLowerCase();
    if (EXCLUDED_TOKENS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push(noun);
  }
  return tokens;
}

/**
 * 클러스터 안에서 **두 건 이상의 제목에 나오는** 핵심 명사. 그 이슈를 특정하는 고유명사가 여기 모인다.
 * 기사가 한 건뿐인 클러스터는 공유 토큰을 만들 수 없으므로 빈 배열이다(호출자가 폴백한다).
 */
export function sharedIssueTokens(titles: readonly string[]): string[] {
  if (titles.length < 2) return [];

  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  for (const title of titles) {
    for (const token of issueTokens(title)) {
      const key = token.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!display.has(key)) display.set(key, token);
    }
  }

  // 많이 공유된 것이 먼저. 동률은 대표 제목 등장 순서, 그래도 동률이면 사전순(run마다 결과가
  // 흔들리지 않게 결정적으로 고른다 - 기존 compareForRank와 같은 철학).
  const leadPosition = new Map<string, number>();
  issueTokens(titles[0]).forEach((token, index) => leadPosition.set(token.toLowerCase(), index));

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const posA = leadPosition.get(a[0]) ?? Number.POSITIVE_INFINITY;
      const posB = leadPosition.get(b[0]) ?? Number.POSITIVE_INFINITY;
      if (posA !== posB) return posA - posB;
      return a[0].localeCompare(b[0], "ko");
    })
    .map(([key]) => display.get(key)!);
}

/** 이슈 구에 담을 최대 공유 토큰 수. 4어절이면 사안이 특정되고, 더 붙이면 검색이 0건으로 간다. */
export const ISSUE_PHRASE_SHARED_TOKENS = 4;

/**
 * 스토리 -> 이슈 구(LLM 없이). **공유 횟수가 많은 토큰부터** 이어 붙인다.
 *
 * 왜 대표 제목 등장 순서가 아닌가: 한국어 헤드라인은 주인공을 뒤에 두는 일이 흔하다
 * ("…사탐 강사 **이도** 결국"). 등장 순서로 붙이면 사안의 주체가 구 끝으로 밀려
 * "수능 앞두고 출연 이도"가 된다. 반면 **여러 매체가 공통으로 쓴 횟수**는 그 사안의 주체가
 * 1위다(실측: 이도 5회 > 수능·강의·중단 3회). 횟수 순으로 붙이면 "이도 수능 강의 중단"이 되어
 * NAVER 검색어로 바로 쓸 수 있다. head-final 문제를 위치가 아니라 빈도로 피하는 것이 이 폴백의 요지다.
 *
 * 공유 토큰이 모자라면(기사 1건짜리 클러스터) 대표 제목 앞쪽 핵심 명사로 채운다.
 */
export function buildIssuePhraseFromStory(story: GoogleNewsStory): string {
  const shared = sharedIssueTokens(story.related.map((article) => article.title));
  if (shared.length >= MIN_ISSUE_PHRASE_WORDS) {
    return shared.slice(0, Math.min(ISSUE_PHRASE_SHARED_TOKENS, MAX_ISSUE_PHRASE_WORDS)).join(" ");
  }

  // 기사 1건짜리 클러스터 등: 공유 토큰을 만들 수 없으므로 대표 제목 앞쪽 핵심 명사 3개로 간다.
  return issueTokens(story.leadTitle).slice(0, 3).join(" ");
}

/** LLM이 돌려준 구가 시드로 쓸 만한지. 문장을 그대로 돌려준 경우와 빈 값을 막는다. */
export function isUsableIssuePhrase(phrase: string | null | undefined): boolean {
  const words = phrase?.trim().split(/\s+/).filter(Boolean) ?? [];
  return words.length >= 1 && words.length <= MAX_ISSUE_PHRASE_WORDS;
}

export type DaumMatch = {
  /** 매칭된 Google 스토리의 대표 제목. */
  leadTitle: string;
  /** 다음 「많이 본 뉴스」 순위. */
  daumRank: number;
  /** 매칭 근거가 된 공유 핵심 명사. */
  sharedTokens: string[];
};

export type MatchDaumRankingResult = {
  /** 스토리 대표 제목 -> 가장 좋은(= 순위가 높은) 다음 매칭. */
  byLeadTitle: Map<string, DaumMatch>;
  /** 어떤 스토리와도 못 맞춘 다음 기사. 시드로 만들지 않고 관측용으로만 남긴다(파일 상단 주석). */
  unmatched: { rank: number; title: string }[];
};

/**
 * 다음 랭킹 기사와 Google 스토리를 핵심 명사 교집합으로 맞춘다. 한 스토리에 여러 다음 기사가
 * 맞으면 **순위가 가장 높은 것**을 쓴다.
 *
 * 교집합 2개를 요구하는 이유: 1개면 `이도`·`사과` 같은 흔한 낱말 하나로 엉뚱한 이슈가 붙는다.
 * 맞추지 못하면 그 스토리는 순위 가점 없이 피드 순서대로 간다 - **실패가 조용히 해롭지 않다**는
 * 점이 이 매칭을 쓸 수 있게 하는 조건이다.
 */
export function matchDaumRanking(
  stories: readonly GoogleNewsStory[],
  daumRanking: readonly { rank: number; title: string }[]
): MatchDaumRankingResult {
  const storyTokens = stories.map((story) => ({
    story,
    tokens: new Set(
      story.related.flatMap((article) => issueTokens(article.title)).map((token) => token.toLowerCase())
    ),
  }));

  const byLeadTitle = new Map<string, DaumMatch>();
  const unmatched: { rank: number; title: string }[] = [];

  for (const item of daumRanking) {
    const tokens = issueTokens(item.title).map((token) => token.toLowerCase());
    let best: { leadTitle: string; shared: string[] } | null = null;

    for (const candidate of storyTokens) {
      const shared = tokens.filter((token) => candidate.tokens.has(token));
      if (shared.length < DAUM_MATCH_MIN_INTERSECTION) continue;
      if (!best || shared.length > best.shared.length) {
        best = { leadTitle: candidate.story.leadTitle, shared };
      }
    }

    if (!best) {
      unmatched.push({ rank: item.rank, title: item.title });
      continue;
    }

    const existing = byLeadTitle.get(best.leadTitle);
    if (!existing || item.rank < existing.daumRank) {
      byLeadTitle.set(best.leadTitle, {
        leadTitle: best.leadTitle,
        daumRank: item.rank,
        sharedTokens: best.shared,
      });
    }
  }

  return { byLeadTitle, unmatched };
}
