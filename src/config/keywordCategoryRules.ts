// 키워드 자체의 어휘로 내부 category를 판정하는 규칙.
//
// 왜 필요한가(2026-08-26 실측): Creator Advisor는 category를 topic card 단위로만 준다. 그래서
// creatorAdvisorTopicMapping.ts만 쓰면 한 카드에 들어온 키워드가 전부 같은 category가 된다.
// 실제 "육아·결혼" 카드 20건을 확인해보니 진짜 육아는 7건뿐이고, 나머지는 정부 지원금(근로장려금
// 지급일/금액 조회)과 연예 뉴스(양준모 재혼, 장동윤 결혼 발표)였다 - 65%가 오분류였다.
//
// category는 표시용이 아니다: selectDiverseTopN의 category backfill에 쓰이고, 이후 원고 생성 단계에서
// 어떤 블로그 작성 스킬로 보낼지를 정하는 기준이 된다(연예 -> entertainment, 육아 -> parenting,
// 지원금/정책 -> living). 그래서 틀리면 엉뚱한 스킬로 원고가 만들어진다.
//
// 설계 원칙:
// - 보수적으로 동작한다. 확실한 신호가 있을 때만 topic 매핑을 덮어쓰고, 애매하면 폴백한다.
//   (규칙을 늘려 억지로 다 맞추려 하면 오히려 오탐이 늘어난다.)
// - 순서가 의미를 가진다. 먼저 매칭되는 규칙이 이긴다.
//   특히 entertainment가 parenting보다 앞에 있어야 한다: "양준모 재혼 상대 양지원, 임신 소식"은
//   "임신"이 들어 있지만 육아 정보가 아니라 연예 뉴스다.
//   반대로 parenting은 living보다 앞이어야 한다: "아동수당 신청방법"은 "신청"이 들어 있지만
//   지원금 일반이 아니라 육아 정보다.

export type KeywordCategory = "entertainment" | "ott" | "parenting" | "living";

export type KeywordCategoryRule = {
  category: KeywordCategory;
  /** 키워드에 이 중 하나라도 포함되면 매칭된다(부분 문자열, 소문자 비교). */
  terms: readonly string[];
};

// 순서가 곧 우선순위다. 위에서부터 첫 매칭이 이긴다.
export const KEYWORD_CATEGORY_RULES: readonly KeywordCategoryRule[] = [
  {
    // 인물 신변 이벤트. "임신/결혼"이 들어가도 육아 정보가 아니라 연예 뉴스인 경우를 잡는다.
    category: "entertainment",
    terms: [
      "재혼", "이혼", "열애", "결별", "파경", "결혼 발표", "결혼발표",
      "예비신부", "예비신랑", "동반출연", "열애설", "근황", "하차", "복귀",
      "컴백", "데뷔", "소속사", "은퇴", "입대", "제대", "피소", "사생활",
    ],
  },
  {
    category: "ott",
    terms: [
      "드라마", "영화", "시즌", "등장인물", "출연진", "개봉", "방영", "결말",
      "회차", "넷플릭스", "티빙", "웨이브", "디즈니", "쿠팡플레이", "왓챠",
      "예고편", "관람평", "박스오피스", "스포",
    ],
  },
  {
    // living의 지원금 어휘보다 먼저 판정해야 "아동수당", "부모급여"가 육아로 남는다.
    category: "parenting",
    terms: [
      "육아", "아동수당", "부모급여", "양육", "자녀장려금", "출산", "임신",
      "착상", "수유", "이유식", "기저귀", "어린이집", "유치원", "산후",
      "수족구", "예방접종", "아기", "신생아", "영유아", "키즈", "돌잔치",
      "젖병", "분유", "유모차", "카시트",
    ],
  },
  {
    category: "living",
    terms: [
      "근로장려금", "장려금", "지원금", "실업급여", "급여", "연금", "환급",
      "지급일", "바우처", "공제", "세금", "연말정산", "보조금", "멤버십",
      "요금", "날씨", "태풍", "한파", "폭염", "청약", "대출", "적금", "금리",
    ],
  },
] as const;

/**
 * 키워드 어휘만으로 category를 판정한다. 확실한 신호가 없으면 null을 반환해 호출자가
 * topic 기반 매핑으로 폴백하게 한다.
 */
export function classifyKeywordCategory(keyword: string): KeywordCategory | null {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return null;

  for (const rule of KEYWORD_CATEGORY_RULES) {
    if (rule.terms.some((term) => normalized.includes(term))) {
      return rule.category;
    }
  }

  return null;
}
