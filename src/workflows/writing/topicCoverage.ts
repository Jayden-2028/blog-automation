// 완성된 원고가 **사용자가 말한 주제를 실제로 다뤘는가**를 코드로 잰다(2026-10-30).
//
// 왜 필요한가(실측 사고): 변환기로 받은 "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록"이
// "부산 기념품 판매처 4곳" 원고로 끝났다. 각 단계는 규칙을 지켰다 - 조사가 부산만 찾아오자 2차
// 브리프가 질문을 갈아끼웠고 집필은 그 질문에 충실히 답했다. 브리프 쪽은 `brief/topicScope.ts`가
// 막지만(2026-10-30), 다른 경로로 같은 일이 생겨도 **조용히 통과**한다. 그래서 마지막에 한 번 더 센다.
//
// 재는 방법은 단순하다: 사용자가 쓴 주제의 내용어가 원고(제목+본문)에 몇 개나 나오는가.
// 10월 원고 341건 실측 분포 - 주제어 50% 미만은 17건(5%)이고, **변환기 출처 131건 중에는 3건**뿐이다.
// 부산 건은 43%로 걸린다. 그래서 기본 문턱을 0.5로 잡았다(드물게 걸리는 신호여야 쓸모가 있다).
//
// 언어가 어긋나면 재지 않는다: 사용설명서 트랙은 keyword가 영문인데 초고는 한글이라 토큰이 하나도
// 안 맞는다(실측 0% 사례들이 전부 이 경우다). 그런 job은 `comparable: false`로 두고 게이트를 건너뛴다.
//
// 순수 함수다 - 파일·네트워크·LLM 없음.

/** 흔해서 비교에 쓸모없는 말. 주제어에서 뺀다. */
const STOP_WORDS = new Set([
  "한국",
  "korea",
  "korean",
  "방법",
  "정보",
  "관련",
  "그리고",
  "하는",
  "있는",
  "대한",
  "등등",
  "무엇",
  "어디",
  "언제",
  "누구",
  "유명",
]);

const TOKEN_PATTERN = /[가-힣]{2,}|[a-z]{4,}|\d{1,3}/g;

/** 비교용 토큰(중복 제거, 불용어 제외). */
export function contentTokens(text: string): string[] {
  const found = String(text ?? "").toLowerCase().match(TOKEN_PATTERN) ?? [];
  return [...new Set(found.filter((t) => !STOP_WORDS.has(t)))];
}

/** 한글 비중. 언어 어긋남 판정에 쓴다. */
function hangulRatio(text: string): number {
  const s = String(text ?? "");
  const letters = s.match(/[가-힣a-zA-Z]/g) ?? [];
  if (letters.length === 0) return 0;
  return (s.match(/[가-힣]/g) ?? []).length / letters.length;
}

export type TopicCoverage = {
  /** 주제에서 뽑은 내용어. */
  tokens: string[];
  /** 그중 원고에 실제로 나온 것. */
  covered: string[];
  /** 빠진 것(사용자에게 보여 준다). */
  missing: string[];
  /** covered / tokens. tokens가 비면 1. */
  ratio: number;
  /**
   * 주제와 원고의 언어가 같아 비교가 성립하는가. 사용설명서처럼 영문 keyword + 한글 초고면 false다
   * (토큰이 안 맞는 것이 당연하므로 게이트를 걸면 안 된다).
   */
  comparable: boolean;
};

export function measureTopicCoverage(keyword: string, text: string): TopicCoverage {
  const tokens = contentTokens(keyword);
  const body = String(text ?? "").toLowerCase();
  const covered = tokens.filter((t) => body.includes(t));
  const missing = tokens.filter((t) => !body.includes(t));

  // 주제는 영문인데 원고는 한글(또는 그 반대)이면 토큰 비교가 성립하지 않는다.
  const keywordHangul = hangulRatio(keyword);
  const bodyHangul = hangulRatio(text);
  const comparable = tokens.length > 0 && Math.abs(keywordHangul - bodyHangul) < 0.5;

  return {
    tokens,
    covered,
    missing,
    ratio: tokens.length === 0 ? 1 : covered.length / tokens.length,
    comparable,
  };
}

/** 10월 341건 실측으로 고른 값 - 이 아래는 변환기 131건 중 3건뿐이다. */
export const SCOPE_COVERAGE_THRESHOLD = 0.5;

export type ScopeHoldInput = {
  keyword: string;
  /** 원고 제목 + 본문. */
  text: string;
  /** 사용자가 직접 쓴 주제인가(변환기 출처). false면 재지 않는다. */
  userAuthoredTopic: boolean;
  threshold?: number;
};

export type ScopeHoldResult =
  | { hold: false; reason: "not_user_topic" | "not_comparable" | "covered"; coverage: TopicCoverage }
  | { hold: true; coverage: TopicCoverage; message: string };

/**
 * 자동 승인을 멈추고 사람에게 물어야 하는가.
 *
 * **사용자가 직접 쓴 주제**에서만 센다. 파이프라인이 스스로 뽑은 키워드는 원래 "그 말 그대로"를
 * 약속한 적이 없고(자동완성 질의다), 여기서 막으면 매일 발행이 멈춘다.
 */
export function shouldHoldForScope(input: ScopeHoldInput): ScopeHoldResult {
  const coverage = measureTopicCoverage(input.keyword, input.text);
  if (!input.userAuthoredTopic) return { hold: false, reason: "not_user_topic", coverage };
  if (!coverage.comparable) return { hold: false, reason: "not_comparable", coverage };

  const threshold = input.threshold ?? SCOPE_COVERAGE_THRESHOLD;
  if (coverage.ratio >= threshold) return { hold: false, reason: "covered", coverage };

  const percent = Math.round(coverage.ratio * 100);
  return {
    hold: true,
    coverage,
    message:
      `보내주신 주제에서 ${coverage.tokens.length}개 가운데 ${coverage.covered.length}개만 원고에 들어갔습니다(${percent}%). ` +
      `빠진 것: ${coverage.missing.slice(0, 8).join(", ")}`,
  };
}
