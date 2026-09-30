// 커뮤니티 인기글 소스 공통 인터페이스.
//
// 이 파일은 "사이트 하나를 어떻게 붙일지"의 계약을 정의한다. 이 원격 세션은 외부 사이트로 나가는
// egress가 전부 막혀 있어(agent proxy가 theqoo.net 등을 EGRESS_BLOCKED로 거부함) 직접 실측을 할
// 수 없다 - 그래서 사용자가 맥에서 scripts/communityRecon.ts(robots.txt 확인 + HTML 캡처) +
// scripts/communityProbe.ts(DOM 구조 진단)를 실행해 실측 데이터를 확보하고, 그 결과를 공유받아
// 파서를 썼다. 실제 페이지 구조 없이 파서를 추측해 쓰지 않는다는 원칙은 그대로다 - 구글 트렌드
// RSS도 실제 실측 데이터(trendingRss.sample.xml)를 먼저 확보한 뒤에야 파서를 썼다(같은 원칙).
//
// 실측 결과(2026-08-30, KEYWORD_SOURCE_EXPANSION.md §7-2):
// - **더쿠(theqoo.net/hot)**: robots.txt에 disallow 없음, 실제 목록 페이지 정상 응답 확인 ->
//   TheqooProvider.ts 구현 완료, 아래 목록에 포함.
// - **네이트판/네이버카페**: robots.txt가 정확히 우리가 쓰려던 목록 경로를 disallow함 ->
//   §5-3 원칙("robots.txt가 금지하면 그 소스는 제외한다")에 따라 이 경로로는 붙이지 않는다.
//   다른 접근 경로(공식 API 등)를 찾으면 재검토 대상이지만, 지금은 없다.
//
// 2차 실측(2026-09-30, 사용자 요청으로 후보 6곳 추가 검토):
// - **루리웹(bbs.ruliweb.com/best)**: robots.txt 금지 없음, 정상 응답(164,812자) 확인 ->
//   RuliwebProvider.ts 구현 완료, 아래 목록에 포함.
// - **클리앙/인스티즈/디시인사이드**: robots.txt가 ClaudeBot·anthropic-ai·Claude-Web를 명시적으로
//   차단한다 -> §5-3에 따라 제외. 사이트의 의사가 분명해 재검토 대상도 아니다.
// - **에펨코리아(/best)**: robots.txt는 `Allow: /best`로 열어뒀고 실제 응답도 정상(70,175자)이다.
//   다만 제목 anchor의 클래스명이 난독화된 형태(`a.hotdeal_var8`)라, 그 이름이 날마다 바뀌는지
//   확인한 뒤 파서를 쓴다 - 지금 붙이면 하루 만에 0건이 될 수 있다.
// - **MLB파크(/mp/best.php)**: robots.txt 금지 없음. 루리웹 다음 순서.
// - **다음카페**: robots.txt는 /_c21_/home을 허용하지만 그 URL이 HTTP 500을 반환한다(URL이 낡음).
//
// 이전 주석에 "펨코는 Cloudflare 때문에 제외"라고 적혀 있었지만, 그건 robots.txt 판정 버그가
// 섞인 판단이었다(Allow를 무시해 잘못 제외 - scripts/testRobotsMatcher.ts 참고). 실제로는 위와 같다.
//
// COMMUNITY_SOURCE_PROVIDERS가 비어 있던 시절과 달리 지금은 provider가 1개 이상 있지만,
// runCommunityCollection.ts는 여전히 provider 0개에서도 안전하게 "0건 수집"을 반환한다 - 사이트가
// 하나씩 붙거나 빠져도 나머지 파이프라인(LLM 추출 -> 매핑 -> upsert)은 손댈 필요가 없다.

import { theqooProvider } from "./theqoo/TheqooProvider.js";
import { ruliwebProvider } from "./ruliweb/RuliwebProvider.js";

/** 커뮤니티 인기글 목록 항목. 제목만 쓴다 - 본문/이미지/작성자는 저장하지 않는다(§5-3). */
export type CommunityPost = {
  title: string;
  /** 그 사이트 인기글 목록 안에서의 1-based 순위. */
  siteRank: number;
};

export type CommunitySourceProvider = {
  /** trend_candidates.metadata.site / QueryPoolEntry 표시에 쓰는 짧은 식별자. 예: "natepann" */
  site: string;
  /** 사람이 읽는 이름. 로그/CLI 출력용. */
  label: string;
  /** 인기글 제목 목록을 가져온다. 개별 provider의 실패는 호출자(runCommunityCollection)가 격리한다. */
  fetchPosts: () => Promise<CommunityPost[]>;
};

/**
 * 실측으로 (1) robots.txt가 허용하고 (2) 실제 목록 페이지가 정상 응답하며 (3) 파서를 쓸 만큼
 * DOM 구조가 안정적이라고 확인된 소스만 여기 등록한다. 제외 사유는 파일 상단 주석에 있다.
 *
 * 한 소스가 실패해도 runCommunityCollection.ts가 provider별로 격리하므로, 여기 추가·제거는
 * 나머지 파이프라인(LLM 추출 -> 매핑 -> upsert)에 영향을 주지 않는다.
 */
export const COMMUNITY_SOURCE_PROVIDERS: readonly CommunitySourceProvider[] = [
  theqooProvider,
  ruliwebProvider,
];
