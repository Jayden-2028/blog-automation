// 네이버 블로그 반자동 발행(임시저장) 설정(SPRINT_4_DESIGN.md).
// creatorAdvisor.ts와 같은 패턴 - 로직 코드(NaverBlogPublisher 등)에 숫자/문자열을 흩뿌리지
// 않고 이 파일만 참조한다.

export type NaverPublishConfig = {
  /**
   * 발행 대상 블로그 ID. CREATOR_ADVISOR_BLOG_ID를 그대로 재사용한다(결정 §9-2, 2026-08-28) -
   * Creator Advisor가 통계를 보는 블로그에 그대로 글을 쓴다. 별도 환경변수를 새로 만들지 않는다.
   */
  blogId: string;
  /**
   * Playwright persistent context 프로필 디렉터리. Creator Advisor(읽기 전용 크롤링) 세션과
   * 절대 공유하지 않는다(로드맵 §6-7) - 쓰기 세션이 별도 최초 로그인을 필요로 한다.
   */
  profileDir: string;
};

export const NAVER_PUBLISH_CONFIG: NaverPublishConfig = {
  // Creator Advisor와 같은 블로그를 쓰기로 결정했으므로(§9-2), 새 환경변수를 만들지 않고
  // 그대로 CREATOR_ADVISOR_BLOG_ID를 읽는다. 나중에 발행 대상 블로그가 분리되면 그때
  // NAVER_PUBLISH_BLOG_ID를 새로 추가한다.
  blogId: process.env.CREATOR_ADVISOR_BLOG_ID ?? "",
  profileDir: process.env.NAVER_PUBLISH_PROFILE_DIR ?? ".local/naver-publish-profile",
};
