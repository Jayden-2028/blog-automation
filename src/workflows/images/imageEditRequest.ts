// "🖼 이미지 수정" 버튼의 답장을 읽는다(2026-09-22 사용자 결정 - 번호 + 요구사항).
//
// 흐름: 버튼을 누르면 봇이 자리 목록을 보내고, 사용자가 그 메시지에 답장한다.
//
//   "2번은 인물 단독샷으로, 5번은 제품 컷으로"
//   "2,5"
//   "3번 더 큰 사진"
//
// 빈 자리는 지정하지 않아도 자동으로 다시 채운다(사용자 결정) - 답장은 **마음에 안 드는
// 자리**를 고르는 용도다.
//
// 파싱을 느슨하게 두는 이유: 사람이 텔레그램에서 급히 치는 글이라 형식을 강제하면 실패한다.
// 숫자를 찾고 그 뒤에 붙은 말을 그 번호의 요구로 본다. 대신 **찾은 것을 되읽어 보여줘서**
// 잘못 읽었으면 사용자가 바로 안다.

/** 한 자리에 대한 재작업 요청. requirement가 비면 "그냥 다시 찾아라"는 뜻이다. */
export type ImageEditRequest = { index: number; requirement: string };

/** 숫자 뒤에 "번"이 붙어도 되고 안 붙어도 된다. 조사(은/는/이/가/도/만)까지 흡수한다. */
const INDEX_TOKEN = /(\d{1,2})\s*번?\s*(?:은|는|이|가|도|만|의)?\s*/g;

/** 요구사항에서 잘라낼 꼬리 - 다음 항목으로 넘어가는 구분자다. */
const TRAILING_SEPARATORS = /[,、/·]+\s*$/;

/**
 * 답장에서 (자리 번호, 요구사항)을 뽑는다.
 *
 * 같은 번호가 두 번 나오면 뒤에 쓴 것을 쓴다 - 사람이 고쳐 쓴 것으로 본다.
 * 번호가 하나도 없으면 빈 배열을 돌려준다(호출부가 "빈 자리만 다시 채웁니다"로 처리한다).
 */
export function parseImageEditReply(text: string, maxIndex = 20): ImageEditRequest[] {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const matches = [...cleaned.matchAll(INDEX_TOKEN)];
  if (matches.length === 0) return [];

  const byIndex = new Map<number, string>();
  matches.forEach((match, i) => {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > maxIndex) return;

    // 이 번호의 요구사항 = 이 토큰 끝 ~ 다음 번호 토큰 시작.
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[i + 1];
    const end = next ? next.index ?? cleaned.length : cleaned.length;
    const requirement = cleaned.slice(start, end).replace(TRAILING_SEPARATORS, "").trim();
    byIndex.set(index, requirement);
  });

  return [...byIndex.entries()]
    .map(([index, requirement]) => ({ index, requirement }))
    .sort((a, b) => a.index - b.index);
}

/** 사용자가 읽고 "내가 말한 게 맞나" 확인할 수 있게 되읽어준다. */
export function describeImageEditRequests(requests: readonly ImageEditRequest[]): string {
  if (requests.length === 0) return "지정하신 자리가 없어 빈 자리만 다시 채웁니다.";
  return requests
    .map((request) => (request.requirement ? `${request.index}번 - ${request.requirement}` : `${request.index}번 - 다시 찾기`))
    .join("\n");
}

/** 마커 끝에 붙는 획득 방식 표기. parseImageAcquisition이 읽는 문구와 1:1이어야 한다. */
export const ACQUISITION_LABEL = {
  search: "웹 검색",
  ai: "AI 생성",
  table: "표 생성",
  capture: "페이지 캡처",
} as const;

export type RequestedAcquisition = keyof typeof ACQUISITION_LABEL;

/**
 * 요구사항에서 **사용자가 원한 획득 방식**을 읽는다(2026-09-22 사용자 결정 - "지시대로 해라").
 *
 * 애매하면 `null`을 돌려주고 호출부가 **현재 방식을 유지**한다. 잘못 바꾸면 멀쩡한 자리를
 * 망치므로, 명확히 지시했을 때만 전환한다.
 *
 * 순서가 규칙이다. "검색해서 나오는 카카오톡 캡쳐"처럼 여러 단서가 섞이면 **검색이 이긴다** -
 * 사용자가 "검색"이라고 말한 이상 어디서 구할지는 정해진 것이고, "캡쳐"는 무엇을 구할지다.
 */
export function inferAcquisition(requirement: string): RequestedAcquisition | null {
  const text = (requirement ?? "").trim();
  if (!text) return null;

  // 1) 검색 - 가장 강한 신호다. 검색어까지 지정한 경우가 여기 들어온다.
  if (/검색|찾아|구글|네이버/.test(text)) return "search";
  // 2) AI 생성 - 실물이 없어도 되는 그림을 원하는 경우.
  if (/AI|에이아이|일러스트|그려|그림으로|생성해/i.test(text)) return "ai";
  // 3) 표 - 데이터 정리를 원하는 경우.
  if (/표로|표\s*생성|도표|차트|인포그래픽/.test(text)) return "table";
  // 4) 페이지 캡처 - "페이지"가 함께 나올 때만. "카카오톡 캡쳐"를 여기로 보내면 안 된다.
  if (/페이지\s*캡처|사이트\s*캡처|홈페이지.*캡처/.test(text)) return "capture";

  return null;
}

/**
 * 요구사항에서 **검색어와 원하는 그림**을 갈라낸다(2026-09-22 실측 사고).
 *
 * 사용자는 보통 "<검색어> 로 검색해서 나오는 <어떤 그림>" 형태로 쓴다. 이 문장을 통째로
 * 검색창에 넣으면 당연히 아무것도 안 나온다 - 실제로 그렇게 돌려서 1·5번 자리가 비었다.
 *
 *   "SNL 주현영과 김원훈 으로 검색해서 나오는 투샷 이미지 넣어주세요."
 *     -> query: "SNL 주현영과 김원훈"   want: "투샷 이미지 넣어주세요."
 *
 * "검색"이라는 말이 없으면 갈라낼 수 없다 - 그때는 query를 비우고 호출부가 기존 검색어를 쓴다.
 */
export function splitSearchInstruction(requirement: string): { query: string; want: string } {
  const text = (requirement ?? "").trim();
  const matched = text.match(/^(.*?)\s*(?:으로|로|를|을)?\s*검색(?:해서|하면|해|해보면)?\s*(?:나오는|나온)?\s*(.*)$/);
  if (!matched) return { query: "", want: text };

  const query = matched[1].trim();
  const want = matched[2].trim();
  // 앞이 비면("검색해서 나오는 투샷") 검색어를 못 뽑은 것이다.
  if (!query) return { query: "", want: text };
  return { query, want: want || text };
}
