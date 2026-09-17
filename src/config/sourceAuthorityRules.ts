// 검색 결과 1건의 출처 URL/검색 소스로 신뢰 등급(SourceAuthorityLevel)을 판정하는 규칙.
//
// 왜 필요한가(2026-08-27 실측): 같은 검색 파이프라인이라도 주제에 따라 근거 품질이 완전히 다르다.
// "2026 근로장려금 지급일" 웹문서 검색은 10건 중 9건이 정부 공식 도메인(hometax.go.kr 등)이었지만,
// "아기 셔더링어택 증상"은 10건 전부 네이버 인플루언서 블로그·커뮤니티였다(공공 0, 의료 0). 이
// 차이를 무시하고 같은 파이프라인에 태우면, 영아 경련 감별 같은 주제를 커뮤니티 게시글 근거로
// 단정적으로 쓰게 된다. 등급을 데이터로 남겨야 원고 프롬프트·검수·의학 주제 교차확인 알림이
// "이 주장이 어느 등급에 기대는지"를 판단할 수 있다(SPRINT_2_DESIGN.md 4절).
//
// community를 최하위로 두되 버리지 않는다: 의학 주제에서는 그게 유일한 근거일 때가 많고, 실제
// 양육자들이 무엇을 궁금해하는지가 담겨 있어 글 구성에 쓸모가 있다. 다만 등급을 노출해 그 위에
// 단정적 주장을 쌓지 않게 한다.

import { SOURCE_AUTHORITY_LEVELS } from "../types/database.js";
import type { SourceAuthorityLevel } from "../types/database.js";

export { SOURCE_AUTHORITY_LEVELS };
export type { SourceAuthorityLevel };

// 공공기관 도메인 접미사. .go.kr(정부) / .or.kr(공익법인·협회, 상당수 준정부기관 포함) / .re.kr(연구기관).
const OFFICIAL_DOMAIN_SUFFIXES = [".go.kr", ".or.kr", ".re.kr"] as const;

// 의료기관 화이트리스트(2026-08-27 WebSearch로 실제 도메인 확인).
//
// 질병관리청(kdca.go.kr, health.kdca.go.kr)은 이미 .go.kr 접미사로 official에 잡히므로 여기 넣지
// 않는다 - 이 목록은 official 접미사로 안 걸리는 의료기관만을 위한 것이다.
//
// 범위를 작게 시작한다(SPRINT_2_DESIGN.md 10절 결정): 필요해지면 추가하되, 추측으로 도메인을
// 넣지 않는다 - 실제로 확인된 곳만 올린다.
const MEDICAL_DOMAIN_WHITELIST = [
  "amc.seoul.kr", // 서울아산병원
  "snuh.org", // 서울대학교병원
] as const;

/** hostname이 도메인(그 자체 또는 그 서브도메인)과 일치하는지. "foo.example.com"은 "example.com"에 매칭된다. */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function extractHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export type ClassifySourceAuthorityInput = {
  url: string | null | undefined;
  /** 이 근거를 가져온 검색 소스. news 검색 결과는 URL이 official/medical에 안 걸려도 news로 분류한다. */
  searchSource: "naver_news" | "naver_web" | "naver_blog" | "naver_kin" | "naver_cafe" | "naver_encyc";
};

/**
 * 출처 하나의 신뢰 등급을 판정한다. URL을 파싱할 수 없으면(예: 상대 경로, 빈 문자열) 가장 낮은
 * 등급(community)으로 취급한다 - "판정 불가"를 "신뢰할 수 있음"으로 오인하면 안 된다.
 */
export function classifySourceAuthority(input: ClassifySourceAuthorityInput): SourceAuthorityLevel {
  const hostname = extractHostname(input.url);

  if (hostname) {
    if (OFFICIAL_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return "official";
    }
    if (MEDICAL_DOMAIN_WHITELIST.some((domain) => hostMatches(hostname, domain))) {
      return "medical";
    }
  }

  if (input.searchSource === "naver_news") return "news";
  return "community";
}
