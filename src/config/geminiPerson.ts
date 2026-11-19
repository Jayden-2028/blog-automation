// 인물 제미나이 그림자 트랙(Gemini shadow) 설정. 상세는 workflows/gemini-person/runGeminiPerson.ts 머리 주석.
//
// 목적: person 원고마다 "기존 파이프라인(Claude 조사+집필)"과 "Gemini가 처음부터 끝까지 혼자 쓴 글"을
// 나란히 놓고 비교해, 나중에 사용자가 어느 쪽이 인물 글을 쓸지 정한다. 기존 흐름은 건드리지 않는다.

/** 이 그림자 트랙이 호출하는 모델. 단가는 config/apiPricing.ts에 등록돼 있어야 한다(testApiPricing이 대조). */
export const GEMINI_PERSON_MODEL = process.env.GEMINI_PERSON_MODEL?.trim() || "gemini-3.1-pro-preview";

/**
 * 끄는 스위치. repo variable `PERSON_GEMINI_SHADOW` - 미설정·빈 값 = **켜짐**, `false`(또는 0/off/no) = 꺼짐.
 * 켜진 쪽이 기본인 이유: 사용자가 "앞으로의 인물 원고마다 비교하고 싶다"고 했고, 끄는 일은 이상 징후가 있을 때뿐이다.
 */
export function isGeminiPersonShadowEnabled(raw: string | undefined = process.env.PERSON_GEMINI_SHADOW): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(value);
}
