// 사용자가 직접 쓴 주제의 **범위 표지**를 읽는다(2026-10-30).
//
// 왜 필요한가(실측): 변환기로 받은 "한국 전국 10대 도시 지역별 특산품, 유명한 것 목록" job에서
// 자료조사가 부산 한 곳만 찾아오자 2차 브리프 재작성이 "자료에 맞게" Q1~Q3을 **부산 판매처 질문으로
// 교체**했고, 집필은 바뀐 질문에 충실히 답해 "부산 기념품 판매처 4곳" 원고가 나왔다. 파이프라인은
// 규칙을 어기지 않았다 - 목표가 조용히 바뀐 것이다.
//
// 2차 브리프 재작성(reviseBriefWithResearch)은 원래 **제목 오독**을 고치려고 만든 장치다
// (드라마 제목을 사람 이름으로 읽은 2026-09-22 사고). 그 전제는 "1차 브리프는 제목만 보고 만든
// 추정"인데, 변환기로 들어온 주제는 추정이 아니라 **사용자가 직접 쓴 문장**이라 고칠 오독이 없다.
// 그래서 사용자 입력 주제에서는 범위를 줄이는 교체를 막는다.
//
// 순수 함수다 - 파일·네트워크·LLM 없음.

/** 주제가 "여러 항목을 다루겠다"고 말하는 표지. 하나라도 있으면 범위를 줄이면 안 된다. */
export type TopicScope = {
  /** 원문에서 찾은 범위 표지(프롬프트에 그대로 인용한다). */
  markers: string[];
  /** "10대 도시", "5가지"처럼 개수를 명시했으면 그 수. */
  count: number | null;
  /** 범위 표지가 하나라도 있는가. */
  hasScope: boolean;
};

/** 개수 + 단위("10대 도시", "5곳", "3가지"). 단위는 한국어 수 분류사와 흔한 명사. */
const COUNT_PATTERN = /(\d{1,3})\s*(대|개|가지|곳|군데|선|위|종|품목|도시|지역|나라|명)/g;
/** 개수 없이도 "전부 다루라"는 뜻이 되는 말. */
const BREADTH_WORDS = [
  "전국",
  "전체",
  "모든",
  "모두",
  "각",
  "지역별",
  "도시별",
  "종류별",
  "분야별",
  "총정리",
  "목록",
  "리스트",
  "정리",
  "비교",
  "순위",
  "best",
  "top",
  "all",
  "list",
  "every",
  "each",
] as const;

/** 주제 문장에서 범위 표지를 읽는다. */
export function readTopicScope(keyword: string): TopicScope {
  const text = (keyword ?? "").trim();
  const markers: string[] = [];
  let count: number | null = null;

  COUNT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COUNT_PATTERN)) {
    markers.push(match[0].trim());
    const n = Number.parseInt(match[1], 10);
    // 가장 큰 수를 대표로 잡는다("10대 도시 5곳"이면 10이 범위다).
    if (Number.isFinite(n) && (count === null || n > count)) count = n;
  }

  const lower = text.toLowerCase();
  for (const word of BREADTH_WORDS) {
    if (lower.includes(word)) markers.push(word);
  }

  const unique = [...new Set(markers)];
  return { markers: unique, count, hasScope: unique.length > 0 };
}

/**
 * 재작성된 질문 목록이 원래 범위를 **버렸는가**.
 *
 * 판정은 보수적이다 - 1차 질문들이 담고 있던 범위 표지가 2차에서 **전부** 사라졌을 때만 참이다.
 * 표지 하나라도 남아 있으면 통과시킨다(각도 교정은 막지 않는다).
 */
export function droppedScope(scope: TopicScope, before: readonly string[], after: readonly string[]): boolean {
  if (!scope.hasScope) return false;

  const joined = (questions: readonly string[]): string => questions.join(" ").toLowerCase();
  const beforeText = joined(before);
  const afterText = joined(after);

  const present = scope.markers.filter((m) => beforeText.includes(m.toLowerCase()));
  // 1차 질문이 범위를 아예 안 담고 있었으면 2차를 탓할 수 없다.
  if (present.length === 0) return false;

  return present.every((m) => !afterText.includes(m.toLowerCase()));
}
