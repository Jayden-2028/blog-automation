// 종합 키워드 입력 툴의 **메시지 분류**(KEYWORD-INPUT-TOOL-2026-10.md A-1). 순수 모듈 - 파일·네트워크·LLM 없음.
// 클라우드 웹훅(instagramWebhookHandler)이 접수 답장을 만들 때, 맥 폴러가 큐 항목을 세울 때 같은 규칙을 쓴다.
//
// 메시지 한 통은 셋 중 하나다.
//   1) URL 포함 → instagram 게시물 / threads / 그 외(블로그·뉴스·유튜브 등, B부에서 추출)
//   2) 짧은 일반 글 → **직접 입력**: 명령구 꼬리를 떼고 남은 것을 주제로 쓴다. 질문형은 그대로 둔다.
//   3) 긴 글(카페글 붙여넣기) → 주제가 아니라 **소스 본문**. 주제 한 줄은 답장으로 따로 받는다(needs_topic).

/** 공백을 뺀 글자 수가 이보다 크면 주제가 아니라 소스 본문으로 본다(카페글 붙여넣기). */
export const LONG_TEXT_THRESHOLD = 300;

/** 큐 항목의 출처. 인스타·스레드는 같은 수동 캡처 큐를 쓰고, text는 캡처 없이 바로 job이 된다. */
export type InputSource = "instagram" | "threads" | "text";

export type UrlKind = "instagram" | "threads" | "other";

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const INSTAGRAM_POST_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+/i;
const THREADS_HOST_RE = /^https?:\/\/(?:www\.)?threads\.(?:com|net)\//i;

/** 메시지 안의 첫 URL(끝의 문장부호는 뗀다). 없으면 null. */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_RE);
  return match ? match[0].replace(/[),.]+$/, "") : null;
}

export function classifyUrl(url: string): UrlKind {
  if (INSTAGRAM_POST_RE.test(url)) return "instagram";
  if (THREADS_HOST_RE.test(url)) return "threads";
  return "other";
}

/** 큐 항목의 출처를 URL에서 가른다. URL이 없으면 text. */
export function sourceOfUrl(url: string | null | undefined): InputSource {
  if (!url) return "text";
  const kind = classifyUrl(url);
  return kind === "threads" ? "threads" : kind === "instagram" ? "instagram" : "text";
}

// 명령구 꼬리 제거 규칙(LLM 없음, 정규식 목록). 위에서부터 첫 매칭만 쓴다.
// 동사 앞에 **대상 명사(원고·글·포스팅…)나 연결구(라는 주제로·에 대해)가 있을 때만** 뗀다 - "기사 작성 방법" 같은
// 주제의 일부를 명령으로 오해하지 않기 위해서다(동사 뒤에 다른 말이 남으면 `$`에서 탈락).
const VERB = String.raw`(?:좀\s*)?(?:써|작성|만들)\S*(?:\s*(?:줘|주세요|줄래))?[.!~\s]*$`;
const OBJECT = String.raw`(?:블로그\s*)?(?:원고|글|포스팅|포스트|기사)`;
const COMMAND_TAILS: readonly RegExp[] = [
  // "~(이)라는 주제로 원고 써줘"
  new RegExp(String.raw`^(.+?)\s*이?라는\s*(?:주제|키워드|제목|내용)(?:으로|로|를|을|에\s*대(?:해|한))?\s*(?:${OBJECT}\s*)?${VERB}`),
  // "~에 대해 써줘" / "~에 대한 글 써줘"
  new RegExp(String.raw`^(.+?)\s*에\s*대(?:해|한)\s*(?:${OBJECT}\s*)?${VERB}`),
  // "~ 원고 작성" / "~를 글 써줘"
  new RegExp(String.raw`^(.+?)\s*(?:을|를|으로|로)?\s*${OBJECT}\s*${VERB}`),
  // "~ 주제로 써줘"
  new RegExp(String.raw`^(.+?)\s*(?:을|를)?\s*주제로\s*${VERB}`),
];

/**
 * 명령구 꼬리를 떼고 주제만 남긴다. 떼고 남은 것이 2자 미만이면 원문을 그대로 쓴다.
 * 질문형은 건드리지 않는다 - "민찌는 무슨 고기일까?"의 물음표를 지우면 researcher가 질문을 풀 단서가 줄어든다.
 */
export function stripCommandTail(text: string): string {
  const trimmed = text.trim();
  for (const re of COMMAND_TAILS) {
    const m = trimmed.match(re);
    if (m) {
      const topic = m[1].trim();
      return topic.length >= 2 ? topic : trimmed;
    }
  }
  return trimmed;
}

export function isLongText(text: string): boolean {
  return text.replace(/\s+/g, "").length > LONG_TEXT_THRESHOLD;
}

export type DirectInput =
  | { kind: "topic"; topic: string }
  /** 긴 글: 본문은 sourceText로 보관하고 주제 한 줄은 답장으로 받는다. */
  | { kind: "source"; sourceText: string };

/** URL 없는 일반 글을 직접 입력으로 해석한다. */
export function interpretDirectInput(text: string): DirectInput {
  const trimmed = text.trim();
  if (isLongText(trimmed)) return { kind: "source", sourceText: trimmed };
  return { kind: "topic", topic: stripCommandTail(trimmed) };
}

/** 접수 확인 답장 - 해석 결과를 보여준다(A-1 §3). 트랙은 버튼 또는 단어 답장으로 받는다. */
export function directInputAck(input: DirectInput): string {
  if (input.kind === "topic") {
    return `접수: 주제 "${input.topic.length > 80 ? `${input.topic.slice(0, 80)}…` : input.topic}" — 트랙을 답해주세요 (엔터/사회/일상/테크/인물/국제)`;
  }
  const chars = input.sourceText.replace(/\s+/g, "").length;
  return `접수: 긴 글(공백 제외 ${chars}자)을 소스 본문으로 저장했습니다 — 트랙을 답해주세요 (엔터/사회/일상/테크/인물/국제). 주제 한 줄은 따로 물어봅니다.`;
}

/** 그 외 URL(블로그·뉴스·유튜브)은 B부에서 자동 추출한다. A부 시점의 안내. */
export const UNSUPPORTED_URL_REPLY =
  "이 링크 종류는 아직 자동으로 읽지 못합니다(지원 예정). 본문을 복사해 텍스트로 보내 주세요.";

/**
 * 직접 입력 -> 큐 항목 조각. 클라우드가 수신함 행(rawCaption=원문)에 적고 맥이 풀어 읽을 때, 그리고 폴링 모드 봇이 바로 적재할 때
 * 같은 해석을 쓴다. 주제 입력은 트랙을 기다리고(needs_track), 긴 글은 주제부터 기다린다(needs_topic - 트랙은 그 뒤에 이어 받는다).
 */
export function queueFieldsForDirectInput(rawText: string): {
  source: "text";
  status: "needs_track" | "needs_topic";
  userTopic?: string;
  sourceText?: string;
} {
  const input = interpretDirectInput(rawText);
  return input.kind === "topic"
    ? { source: "text", status: "needs_track", userTopic: input.topic }
    : { source: "text", status: "needs_topic", sourceText: input.sourceText };
}
