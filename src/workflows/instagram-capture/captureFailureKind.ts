// 캡처 실패가 **게시물 탓인지 우리 설비 탓인지** 가린다.
//
// 2026-11-02 사고: 맥미니의 claude 로그인이 만료돼 슬라이드 판정이 전부 실패했는데, 재시도 3회를
// 소진하고 링크를 버렸다(skipped). 알림도 "게시물이 비공개이거나 인스타 화면이 바뀌었을 수
// 있습니다"로 나가 원인이 흐려졌다. 로그인을 고친 뒤 사용자가 링크를 다시 보내야 했다.
//
// 설비 고장은 **그 링크의 잘못이 아니다** - 재시도 횟수를 쓰지 않고 수신함에 그대로 두고
// (deferred), 고쳐지면 다음 폴링에서 알아서 처리된다. 티스토리 로그인 풀림을 실패가 아니라
// 대기로 다루는 것과 같은 결정이다(CLAUDE.md).
//
// 판정은 **문자열 짜맞추기**다. 모델·브라우저·DB가 저마다 다른 문장을 올려 보내므로 구조화된
// 오류 타입이 없다. 그래서 **좁게** 적는다 - 애매하면 post(게시물 탓)로 두는 편이 안전하다.
// 설비 탓으로 잘못 보면 그 링크가 영원히 재시도되고, 게시물 탓으로 잘못 보면 예전처럼 3회 뒤
// 포기한다(지금까지의 동작).

/** 설비 고장의 종류. post는 "게시물·화면 탓"이라 예전 재시도 규칙을 그대로 쓴다. */
export type CaptureFailureKind = "claude_auth" | "claude_usage" | "network" | "post";

/**
 * 맥미니 claude CLI의 인증 실패. 영문 문장만 본다 - 인스타 로그인 풀림("로그인 만료" 등)은
 * 여기가 아니라 checkInstagramLogin이 가린다(ig:login 안내).
 */
const CLAUDE_AUTH = [
  /OAuth session expired/i,
  /could not be refreshed/i,
  /Not logged in/i,
  /Please run \/login/i,
  /Failed to authenticate/i,
  /Invalid API key/i,
  /authentication[_ ]error/i,
];

/** 사용량·크레딧. 고치는 방법이 로그인과 달라 따로 가린다(기다리거나 결제). */
const CLAUDE_USAGE = [/credit balance/i, /usage limit/i, /rate[_ ]limit/i, /quota exceeded/i];

/** 네트워크가 끊긴 것. 좁게 적는다 - 브라우저 타임아웃은 비공개 게시물일 수도 있어 넣지 않는다. */
const NETWORK = [
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_(RESET|REFUSED|CLOSED))/,
];

export function classifyCaptureFailure(error: string): CaptureFailureKind {
  if (CLAUDE_AUTH.some((re) => re.test(error))) return "claude_auth";
  if (CLAUDE_USAGE.some((re) => re.test(error))) return "claude_usage";
  if (NETWORK.some((re) => re.test(error))) return "network";
  return "post";
}

/** 이 실패가 그 링크의 잘못인가. 아니면 재시도 횟수를 쓰지 않는다. */
export function isOurFault(kind: CaptureFailureKind): boolean {
  return kind !== "post";
}

/** 사람이 무엇을 해야 하는지. 추측하지 않고 종류별로 정해진 문장만 쓴다. */
export function describeOurFault(kind: CaptureFailureKind): string {
  if (kind === "claude_auth") {
    return [
      "🔑 맥미니 claude 로그인이 풀렸습니다(인스타 로그인이 아닙니다).",
      "   맥미니에서: claude setup-token → 나온 토큰을",
      "   ~/blog-automation/prod/.env의 CLAUDE_CODE_OAUTH_TOKEN= 에 넣기",
    ].join("\n");
  }
  if (kind === "claude_usage") {
    return "⏳ claude 사용량·크레딧 한도에 걸렸습니다. 한도가 풀리면 자동으로 이어집니다.";
  }
  return "🌐 네트워크가 끊겼습니다. 연결이 돌아오면 자동으로 이어집니다.";
}
