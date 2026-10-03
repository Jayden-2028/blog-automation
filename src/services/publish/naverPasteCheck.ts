// 네이버 SmartEditor 본문 붙여넣기가 **서식까지** 들어갔는지 판정한다(2026-10-03).
//
// 왜 분리했나: 판정이 NaverBlogPublisher 안에 있으면 브라우저를 띄우지 않고는 검증할 수 없다.
// 실제로 이 판정이 틀려서 서식이 통째로 날아갔으므로(아래), 규칙만 떼어 내 테스트로 고정한다.
//
// **고치는 사고**(2026-10-03 실측 - 티빙 러브 바이러스 글):
// 붙여넣기 결과 검증이 `page.locator(본문).innerText()` 하나였는데, 붙여넣기가 **성공하면**
// 본문이 여러 `.se-component`로 쪼개져 locator가 N개에 매칭되고 Playwright strict mode가
// 예외를 던진다. 그 예외를 `.catch(() => "")`가 삼켜 **빈 문자열**이 되니 "본문이 비었다"로
// 오판하고, Cmd+A -> Backspace로 방금 붙여넣은 서식 본문을 지운 뒤 평문을 타이핑했다.
// 발행된 글에 소제목 크기·굵게·이미지가 전부 없고, 목록만 `• - 강채린`처럼 깨져 보인 이유다
// (타이핑된 `- `를 SmartEditor 자동 목록이 먹은 흔적).
//
// 그래서 판정을 둘로 나눈다:
//   1. 글자가 들어갔나(isBodyFilled)      - 아니면 붙여넣기 자체가 실패다
//   2. 서식이 살아 있나(isPasteFormatted) - 글자는 있는데 굵게·큰 글씨가 없으면 서식이 버려진 것
// 이미지는 **판정에 넣지 않는다**(경고만). SmartEditor가 붙여넣은 외부 이미지를 자기 서버로
// 재업로드하는지 아직 실측 못했고, 여기서 실패로 처리하면 이미지 때문에 발행이 통째로 막힌다.
// 다음 실행의 경고 문구로 실태를 확인한 뒤 툴바 업로드 보강 여부를 정한다.

import { PUBLISH_FONT_PX } from "./renderPublishBlocks.js";

/** 이보다 글자가 적으면 본문이 안 들어간 것으로 본다. */
export const MIN_BODY_CHARS = 50;

/**
 * "큰 글씨"로 칠 최소 px. 본문 15px / 소제목 19px의 가운데(17px)를 경계로 둔다 - SmartEditor가
 * 19px를 자기 크기 등급(se-fs-fsNN)으로 바꿔 넣어도 본문보다 크면 잡힌다.
 */
export const LARGE_FONT_MIN_PX = Math.round((PUBLISH_FONT_PX.body + PUBLISH_FONT_PX.heading) / 2);

/** 붙여넣을 HTML에서 센 기대값. */
export type BodyFormatExpectation = {
  images: number;
  bold: number;
  /** 소제목(본문보다 큰 글씨) 문단 수. */
  large: number;
  /** 공백을 뺀 기대 본문 길이. 절반만 붙여넣어진 경우를 잡는다. */
  chars: number;
};

/** 붙여넣은 뒤 에디터에서 실제로 읽은 값. */
export type BodyFormatObserved = {
  chars: number;
  images: number;
  bold: number;
  large: number;
};

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** 공백을 뺀 실제 글자 수. */
export function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** HTML에서 태그를 걷어낸 대략의 본문 길이(기대 글자 수 계산용). */
function htmlTextLength(html: string): number {
  return nonWhitespaceLength(html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}

/**
 * 붙여넣을 HTML을 읽어 "이만큼은 들어가야 한다"를 센다.
 * renderPublishBlocks가 내는 형태(`<b>`, `font-size:19px`, `<img`)를 기준으로 한다.
 */
export function expectBodyFormat(html: string): BodyFormatExpectation {
  return {
    images: countMatches(html, /<img\b/gi),
    bold: countMatches(html, /<(?:b|strong)[\s>]/gi),
    large: countMatches(html, new RegExp(`font-size:\\s*${PUBLISH_FONT_PX.heading}px`, "gi")),
    chars: htmlTextLength(html),
  };
}

/**
 * 글자가 들어갔나. 기대 길이의 60% 아래면 중간에 잘린 것으로 본다 - 붙여넣기가 통째로 실패한
 * 경우(0자)와, 일부만 들어간 경우를 같이 잡는다.
 */
export function isBodyFilled(expected: BodyFormatExpectation, observed: BodyFormatObserved): boolean {
  const minimum = Math.max(MIN_BODY_CHARS, Math.floor(expected.chars * 0.6));
  return observed.chars >= minimum;
}

/**
 * 서식이 살아 있나. 기대값이 0인 항목은 묻지 않는다(소제목 없는 짧은 원고 등).
 * 이미지는 보지 않는다 - 파일 상단 설명 참고.
 */
export function isPasteFormatted(expected: BodyFormatExpectation, observed: BodyFormatObserved): boolean {
  if (!isBodyFilled(expected, observed)) return false;
  if (expected.bold > 0 && observed.bold === 0) return false;
  if (expected.large > 0 && observed.large === 0) return false;
  return true;
}

/**
 * 사람이 읽을 경고 문구. 실패가 아니어도(= 발행은 되어도) 알아야 하는 차이를 돌려준다.
 * 비어 있으면 기대대로 들어간 것이다.
 */
export function describePasteGap(expected: BodyFormatExpectation, observed: BodyFormatObserved): string[] {
  const warnings: string[] = [];
  if (expected.images > 0 && observed.images < expected.images) {
    warnings.push(`이미지 ${expected.images}장 중 ${observed.images}장만 본문에 들어갔습니다.`);
  }
  if (expected.bold > 0 && observed.bold === 0) {
    warnings.push("굵게 서식이 본문에 반영되지 않았습니다.");
  }
  if (expected.large > 0 && observed.large === 0) {
    warnings.push("소제목 글자 크기가 본문에 반영되지 않았습니다.");
  }
  if (!isBodyFilled(expected, observed)) {
    warnings.push(`본문 글자 수가 모자랍니다(기대 ${expected.chars}자 중 ${observed.chars}자).`);
  }
  return warnings;
}
