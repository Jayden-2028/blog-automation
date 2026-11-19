// 인물 제미나이 그림자 트랙(Gemini shadow) 설정. 상세는 workflows/gemini-person/runGeminiPerson.ts 머리 주석.
//
// 목적: person 원고마다 "기존 파이프라인(Claude 조사+집필)"과 "Gemini가 처음부터 끝까지 혼자 쓴 글"을
// 나란히 놓고 비교해, 나중에 사용자가 어느 쪽이 인물 글을 쓸지 정한다. 기존 흐름은 건드리지 않는다.
//
// 실행은 **맥미니의 Antigravity CLI(`agy`)** 가 한다 - 사용자의 Google AI 구독 로그인으로 돌아 API 요금이 없다.

/** `agy --model`에 넘길 값. 비우면 agy의 기본 모델을 쓴다(`agy models`로 목록 확인). */
export function geminiPersonModel(raw: string | undefined = process.env.GEMINI_PERSON_MODEL): string | undefined {
  const value = (raw ?? "").trim();
  return value || undefined;
}

/** `AGY_EXTRA_ARGS` - 공백으로 나눈 추가 인자(예: `--mode plan`). 따옴표 묶음은 지원하지 않는다. */
export function agyExtraArgs(raw: string | undefined = process.env.AGY_EXTRA_ARGS): string[] {
  return (raw ?? "").split(/\s+/).filter(Boolean);
}

/**
 * 끄는 스위치. repo variable `PERSON_GEMINI_SHADOW` - 미설정·빈 값 = **켜짐**, `false`(또는 0/off/no) = 꺼짐.
 * 큐에 올리는 쪽(Actions)은 repo variable로, 맥미니 폴러는 맥의 .env로 읽는다 - 둘 다 같은 값이어야 완전히 꺼진다.
 */
export function isGeminiPersonShadowEnabled(raw: string | undefined = process.env.PERSON_GEMINI_SHADOW): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(value);
}
