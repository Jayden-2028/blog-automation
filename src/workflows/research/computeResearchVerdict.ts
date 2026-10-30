// 자료조사 `verdict`를 **카테고리에 맞게, 코드가** 계산한다(2026-10-31).
//
// 왜 필요한가(10월 351건 실측):
//   · 규격 §7의 `ok` 조건은 "official + medical ≥ 2, 전체 ≥ 8" 하나뿐이고 전 카테고리에 똑같이 걸린다.
//   · 그런데 엔터는 공식(정부·기관) 출처가 **존재할 수 없는** 주제다. 드라마 캐스팅 소식에 .go.kr 문서는 없다.
//     실측: 엔터 85건 중 79건이 공식 0건이고 **99%가 thin**. OTT 93%, 사건 90%.
//     반대로 사용설명서는 관공서 안내를 인용하므로 공식 평균 2.6건, thin 57%로 가장 낮다.
//   · 결과: 351건 중 306건(85%)이 thin이다. thin은 사람이 "조사가 부실하다"를 알아채는 **유일한 신호**인데,
//     늘 켜져 있으면 신호가 아니라 배경 소음이다. 부산 특산품 건처럼 진짜 부실한 조사가 그 속에 묻힌다.
//   · 게다가 thin 306건 중 **31건은 규격상 이미 ok 조건을 충족**한다 - 에이전트가 자기가 쓴 숫자와 어긋나게
//     판정을 적었다(약 10% 오기). 그래서 판정을 글이 아니라 **숫자에서 코드가** 계산한다.
//
// 바꾸지 않은 것: 의료·법률·금융은 공식/의학 근거 2건 미만이면 그대로 `blocked`다(규격 §7 마지막 줄).
// `blocked` 조건(전부 community이거나 전체 < 5)도 그대로다 - 다만 **순서를 바로잡았다**(아래 주석 참고).
//
// 순수 함수다 - 파일·네트워크·LLM 없음.

import type { ResearchVerdict } from "./parseResearchFile.js";
import type { SourceAuthorityLevel } from "../../types/database.js";

export type VerdictCounts = Record<SourceAuthorityLevel, number>;

/**
 * 근거의 성격이 다른 두 묶음.
 *
 * `news`: 공식 문서가 존재하지 않는 주제다(연예·작품·인물). 여기서는 **교차확인된 뉴스**가 가장 강한 근거이고,
 *   공식 출처를 요구하면 영원히 통과할 수 없다.
 * `official`: 제도·절차·요금·사건처럼 소관 기관의 1차 자료가 있는 주제다. 기존 기준을 그대로 쓴다.
 */
export type VerdictProfile = "news" | "official";

/** 공식 자료가 없는 것이 정상인 카테고리. 나머지는 전부 official 프로파일이다. */
const NEWS_PROFILE_CATEGORIES = new Set(["entertainment", "ott", "person"]);

export function verdictProfileFor(category: string | null | undefined): VerdictProfile {
  const key = (category ?? "").trim().toLowerCase();
  return NEWS_PROFILE_CATEGORIES.has(key) ? "news" : "official";
}

export type ComputeVerdictInput = {
  counts: VerdictCounts;
  category?: string | null;
  /** 의료·법률·금융 주제. true면 공식/의학 2건 미만이 곧 blocked다(규격 §7). */
  isMedical?: boolean;
};

/** 규격 §7 + 2026-10-31 카테고리 분기. */
export function computeResearchVerdict(input: ComputeVerdictInput): ResearchVerdict {
  const { official, medical, news, community } = input.counts;
  const total = official + medical + news + community;
  const firstParty = official + medical;

  // blocked를 **가장 먼저** 본다. 옛 코드(enforceGeminiGroundingUrls)는 `news >= 3`을 먼저 검사해서
  // 전체 4건·뉴스 3건짜리 파일을 thin으로 돌려줬다 - 규격은 전체 < 5면 blocked다.
  if (total < 5 || (total > 0 && community === total)) return "blocked";
  // 의료·법률·금융은 1차 근거가 없으면 통과시키지 않는다(규격 §7 마지막 줄).
  if (input.isMedical && firstParty < 2) return "blocked";

  if (firstParty >= 2 && total >= 8) return "ok";

  // 연예·작품·인물: 공식 문서가 없는 것이 정상이라 교차확인된 뉴스를 1차 근거로 인정한다.
  // (뉴스 3건은 researcher.md §3의 "보도됨" 판정 기준인 2곳 교차확인보다 한 단계 높다.)
  if (verdictProfileFor(input.category) === "news" && news >= 3 && total >= 8) return "ok";

  return "thin";
}

/**
 * 에이전트가 파일에 적은 verdict와 코드 계산이 다른지 본다. 다르면 **코드 값을 쓰고** 그 사실을 남긴다.
 * (10월 실측 오기 31건 - 전부 "ok 조건을 채웠는데 thin이라고 적은" 경우였다.)
 */
export function reconcileVerdict(
  written: ResearchVerdict,
  input: ComputeVerdictInput
): { verdict: ResearchVerdict; corrected: boolean; written: ResearchVerdict } {
  const verdict = computeResearchVerdict(input);
  return { verdict, corrected: verdict !== written, written };
}
