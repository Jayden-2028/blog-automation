// 커뮤니티 인기글 소스 공통 인터페이스.
//
// 이 파일은 "사이트 하나를 어떻게 붙일지"의 계약만 정의한다. 실제 사이트별 구현(더쿠/네이트판/
// 다음·네이버 카페 인기글)은 아직 없다 - KEYWORD_SOURCE_EXPANSION.md §5-2가 "⚠️ 맥에서 실측 필요"로
// 표시한 그대로, 이 원격 세션은 외부 사이트로 나가는 egress가 전부 막혀 있어(agent proxy가
// theqoo.net 등을 EGRESS_BLOCKED로 거부함, 2026-08-30 확인) DOM 구조를 볼 수가 없다.
// 실제 페이지 구조 없이 파서를 쓰면 추측으로 코드를 만드는 것이라 오히려 위험하다 - 구글 트렌드
// RSS도 실제 실측 데이터(trendingRss.sample.xml)를 먼저 확보한 뒤에야 파서를 썼다(같은 원칙).
//
// 그래서 이 파일은 인터페이스 + 빈 provider 목록만 두고, runCommunityCollection.ts는 provider가
// 0개여도(=아직 아무 사이트도 안 붙었어도) 정상적으로 "0건 수집"을 반환하도록 설계했다. 사이트가
// 하나씩 붙을 때마다 COMMUNITY_SOURCE_PROVIDERS에 추가하기만 하면 나머지 파이프라인(LLM 추출 ->
// 매핑 -> upsert)은 이미 완성돼 있어 손댈 필요가 없다.
//
// 사이트 실측 순서는 scripts/communityRecon.ts 참고(§5-3 robots.txt 확인 포함, 맥에서 실행).

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
 * 결정 C(KEYWORD_SOURCE_EXPANSION.md §7)의 대상: 네이트판 오늘의 톡, 더쿠 핫게시판,
 * 다음/네이버 카페 인기글. 펨코는 Cloudflare Bot Management가 강해 명시적으로 제외했다(§5-2).
 *
 * 지금은 실제 실측 전이라 비어 있다. 사이트 하나를 실측하고 파서를 쓸 준비가 되면 여기에
 * CommunitySourceProvider 하나를 추가한다.
 */
export const COMMUNITY_SOURCE_PROVIDERS: readonly CommunitySourceProvider[] = [];
