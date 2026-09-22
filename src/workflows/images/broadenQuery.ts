// 좁은 검색어를 고유명사 위주로 넓힌다.
//
// 왜 필요한가(2026-09-21 사용자 지적): 원고가 만든 검색어가 "지창욱 2022년 인스타그램 셀카 사진"
// 처럼 **특정 시점·형식까지 박아** 넣는 경우가 많다. 그런 캡션이 붙은 사진은 웹에 거의 없어
// 후보가 0건으로 끝난다. 반면 "지창욱 인스타 셀카"로만 검색하면 쓸 만한 사진이 쏟아진다.
// 맥락을 설명할 수 있으면 2022년이 아니어도 된다(사용자 판단).
//
// §8-1-1로 작성 단계 규칙은 이미 고쳤지만, **그 전에 쓰인 원고는 검색어가 이미 굳어 있다.**
// 그래서 수집 단계에서도 한 번 더 넓혀 본다 - 옛 원고까지 같이 구제된다.

/** 검색어를 좁게 만드는 군더더기. 이게 빠져도 무엇을 찾는지는 그대로다. */
const NOISE_WORDS = [
  "사진", "장면", "모습", "이미지", "캡처", "캡쳐", "화면", "컷", "포즈", "당시", "현장",
  "관련", "공식", "최근", "시절", "정리", "비교",
];

/** 연도·날짜 표현. "2022년", "2026년 9월", "9월 20일" 등. */
const DATE_RE = /\b(19|20)\d{2}\s*년?|\d{1,2}\s*월(\s*\d{1,2}\s*일)?/g;

/**
 * 원래 검색어에서 연도·군더더기를 걷어내 고유명사 위주로 남긴다.
 * 넓힐 것이 없으면(이미 짧으면) null - 호출부가 재검색을 건너뛴다.
 */
export function broadenQuery(query: string): string | null {
  const withoutDates = query.replace(DATE_RE, " ");

  const kept = withoutDates
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !NOISE_WORDS.includes(token))
    // "인스타그램" 같은 긴 표기는 그대로 두되, 한 글자 토큰은 변별력이 없어 버린다.
    .filter((token) => token.replace(/[^0-9A-Za-z가-힣]/g, "").length >= 2);

  const broadened = kept.join(" ").trim();
  if (!broadened) return null;
  // 원문과 같으면 넓힌 게 없다 - 같은 검색을 두 번 할 이유가 없다.
  if (broadened === query.trim()) return null;
  return broadened;
}
