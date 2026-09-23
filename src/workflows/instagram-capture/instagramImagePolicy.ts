// 인스타 출신 job의 이미지 생성 정책(2026-09-23 사용자 결정).
//
// 배경: 인스타 변환기는 **게시물 사진을 쓰지 않는다**. 원고 이미지는 전부 기존 파이프라인이
// 채우는데, 그 파이프라인은 웹 검색으로 먼저 채우고 못 채운 자리를 AI 생성으로 메운다
// (prepareManuscript.ts - "빈 자리보다 AI 이미지가 낫다"). 그 AI 폴백은 전역 스위치
// MANUSCRIPT_IMAGE_GENERATION으로 켜지는데, 지금은 꺼져 있다.
//
// 전역으로 켤 수는 없다. 그러면 같은 저장소를 쓰는 **일반 키워드 job까지** 유료 생성이 돈다.
// 그래서 인스타 job에 한해, 그 job의 카테고리를 보고 켠다.
//
// 왜 연예·OTT는 웹 검색만인가: 연예인·드라마·영화는 **실물 사진**이 있어야 한다. AI가 그려낸
// 인물은 실제 인물이 아니고, 그걸 연예 기사에 붙이면 독자를 속이는 셈이 된다. 반면 사건·육아·
// 생활 같은 주제는 개념을 보여주는 그림이면 되므로 빈 자리보다 생성이 낫다.

import { MANUSCRIPT_IMAGE_CONFIG } from "../../config/manuscriptImages.js";
import type { ManuscriptImageConfig } from "../../config/manuscriptImages.js";

/** 실물 사진이 필요한 카테고리 - AI 생성을 쓰지 않는다. */
const PHOTO_ONLY_CATEGORIES = new Set(["entertainment", "ott"]);

export type ImagePolicyInput = {
  source: unknown;
  category: string | null;
};

/**
 * 이 job에서 AI 생성을 켤지.
 *
 * 인스타 job이 아니면 아무것도 바꾸지 않는다(null을 돌려주면 호출부가 전역 설정을 그대로 쓴다).
 * category가 null이면 켜지 않는다 - 판정이 실패한 건에 유료 생성을 태우지 않는다.
 */
export function instagramImageConfig(input: ImagePolicyInput): ManuscriptImageConfig | null {
  if (input.source !== "instagram_manual") return null;
  if (input.category === null || PHOTO_ONLY_CATEGORIES.has(input.category)) {
    return { ...MANUSCRIPT_IMAGE_CONFIG, enabled: false };
  }
  return { ...MANUSCRIPT_IMAGE_CONFIG, enabled: true };
}

/** 사람이 읽을 한 줄. 로그에 남겨 "왜 생성이 돌았나/안 돌았나"를 나중에 따질 수 있게 한다. */
export function describeImagePolicy(input: ImagePolicyInput): string | null {
  const config = instagramImageConfig(input);
  if (!config) return null;
  return config.enabled
    ? `인스타 job(category=${input.category}) - 웹 검색으로 채우고 빈 자리는 AI 생성으로 메웁니다.`
    : `인스타 job(category=${input.category ?? "null"}) - 실물 사진이 필요한 주제라 웹 검색만 씁니다.`;
}
