// 블로그 문서 총 개수(total) -> 포화도(saturation) / 기회도(opportunity) 순수 함수.
//
// 설계 의도(2026-09-03):
// - saturation: "이 주제로 이미 블로그 글이 얼마나 많은가". log10 스케일로 정규화한다.
//   선형으로 보면 안 되는 이유는 블로그 문서 수가 자릿수 단위로 흩어지기 때문이다
//   (희소 이슈 수백 건 vs 상시 키워드 수십만 건). 100 -> 1,000의 체감 차이와
//   100,000 -> 101,000의 체감 차이는 전혀 다르다.
// - opportunity: "수요는 있는데 공급이 아직 적은가". saturation만으로 점수를 주면
//   아무도 찾지 않는 키워드(공급 0)가 만점을 받으므로, 수요 신호를 곱해서 게이트를 건다.
//   수요 신호로는 이미 계산돼 있는 contentCountPercentile(batch 내 상대 활동성)을 재사용한다 -
//   추가 API 호출이 필요 없고, "이번 배치 안에서 실제로 논의되고 있는가"를 그대로 나타낸다.
//
// 이 파일은 순수 함수만 담는다. 실제 점수 반영 여부(applyToScore)는 호출자가 판단한다 -
// Phase A에서는 관측 리포트에만 쓰이고 scoreKeyword()는 이 파일을 참조하지 않는다.

import { BLOG_COMPETITION_CONFIG } from "../../config/keywordCompetition.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 블로그 문서 총 개수를 0~1 포화도로 정규화한다. total을 모르면(프로브 실패) null.
 *
 * total <= lowTotalThreshold  -> 0 (공급 희소 = 선점 기회)
 * total >= highTotalThreshold -> 1 (포화)
 * 그 사이는 log10 스케일 선형 보간.
 */
export function computeSaturation(
  blogTotal: number | null,
  config: { lowTotalThreshold: number; highTotalThreshold: number } = BLOG_COMPETITION_CONFIG
): number | null {
  if (blogTotal === null || !Number.isFinite(blogTotal) || blogTotal < 0) return null;

  const low = Math.max(1, config.lowTotalThreshold);
  const high = Math.max(low + 1, config.highTotalThreshold);

  if (blogTotal <= low) return 0;
  if (blogTotal >= high) return 1;

  const logLow = Math.log10(low);
  const logHigh = Math.log10(high);
  const logValue = Math.log10(Math.max(1, blogTotal));

  return clamp((logValue - logLow) / (logHigh - logLow), 0, 1);
}

/**
 * 기회도(0~1) = (1 - 포화도) x 수요 게이트.
 *
 * demandSignal은 0~1 범위의 수요 신호로, daily 파이프라인에서는
 * KeywordScoreInput.contentCountPercentile을 그대로 넘긴다.
 * 프로브 실패(saturation=null)면 config.neutralScoreRatio를 반환한다 -
 * "측정 실패"를 "완전 포화"와 같게 취급하지 않기 위함.
 */
export function computeOpportunityRatio(
  blogTotal: number | null,
  demandSignal: number,
  config: {
    lowTotalThreshold: number;
    highTotalThreshold: number;
    neutralScoreRatio: number;
  } = BLOG_COMPETITION_CONFIG
): number {
  const saturation = computeSaturation(blogTotal, config);
  if (saturation === null) return clamp(config.neutralScoreRatio, 0, 1);

  const demand = clamp(demandSignal, 0, 1);
  return clamp((1 - saturation) * demand, 0, 1);
}

/** 관측 리포트용 사람이 읽는 등급. 임계값 확정 전 분포를 눈으로 보기 위한 보조 표시다. */
export function describeSaturation(saturation: number | null): string {
  if (saturation === null) return "측정실패";
  if (saturation <= 0.2) return "희소";
  if (saturation <= 0.5) return "여유";
  if (saturation <= 0.8) return "혼잡";
  return "포화";
}
