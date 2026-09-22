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
  // 2026-09-22 네이버 운영 재개: 발행 대상 블로그가 분리됐다(whyissuenow). Creator Advisor가
  // 통계를 보는 블로그(육아)와 **다른 계정**이라 세션 프로필도 따로 쓴다.
  // NAVER_PUBLISH_BLOG_ID가 없으면 예전처럼 CREATOR_ADVISOR_BLOG_ID로 떨어진다 - 다만 그건
  // 이제 잘못된 대상이므로, 둘 다 없으면 빈 값으로 두고 호출부가 막는다.
  blogId: process.env.NAVER_PUBLISH_BLOG_ID || process.env.CREATOR_ADVISOR_BLOG_ID || "",
  profileDir: process.env.NAVER_PUBLISH_PROFILE_DIR ?? ".local/naver-publish-profile",
};
