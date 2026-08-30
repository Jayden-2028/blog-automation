// 다채널 발행(Sprint 5) 채널별 설정. trendSources.ts / naverPublish.ts와 같은 패턴 -
// 숫자·문자열을 로직 코드에 흩뿌리지 않고 이 파일만 참조한다.
//
// 채널별 enabled 기준: "사람의 사전 준비 없이 자동으로 돌 수 있는가".
// - blogspot: Blogger API v3. refresh token이 있어야 동작(setup:blogger 1회).
// - tistory: Playwright + 로그인된 프로필. 반자동(임시저장까지).

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export type BloggerConfig = {
  enabled: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  blogId: string | undefined;
  /** OAuth 스코프. posts.insert에 이것 하나면 충분하다. */
  scope: string;
  /** 하루 발행 상한(하드 가드). publications에서 오늘 이 채널 발행 수를 세어 초과 시 발행 안 함. */
  dailyLimit: number;
  /** 가동 초기 관찰용. true면 posts.insert 시 isDraft로 올린다(비공개). */
  publishAsDraft: boolean;
};

export type TistoryConfig = {
  enabled: boolean;
  blogUrl: string;
  profileDir: string;
  dailyLimit: number;
};

export const BLOGGER_CONFIG: BloggerConfig = {
  enabled: parseBooleanEnv(process.env.BLOGGER_ENABLED, false),
  clientId: process.env.BLOGGER_CLIENT_ID || undefined,
  clientSecret: process.env.BLOGGER_CLIENT_SECRET || undefined,
  refreshToken: process.env.BLOGGER_REFRESH_TOKEN || undefined,
  blogId: process.env.BLOGGER_BLOG_ID || undefined,
  scope: "https://www.googleapis.com/auth/blogger",
  dailyLimit: parseIntEnv(process.env.BLOGGER_DAILY_LIMIT, 5),
  // 기본 true - 가동 첫 며칠은 비공개로 올려 형태 확인 후 BLOGGER_PUBLISH_AS_DRAFT=false로 공개 전환(§10-A).
  publishAsDraft: parseBooleanEnv(process.env.BLOGGER_PUBLISH_AS_DRAFT, true),
};

export const TISTORY_CONFIG: TistoryConfig = {
  enabled: parseBooleanEnv(process.env.TISTORY_ENABLED, false),
  blogUrl: process.env.TISTORY_BLOG_URL || "https://wooahpapa.tistory.com/",
  profileDir: process.env.TISTORY_PROFILE_DIR || ".local/tistory-publish-profile",
  dailyLimit: parseIntEnv(process.env.TISTORY_DAILY_LIMIT, 5),
};

/** 내부 category → 각 채널 분류 (SPRINT_5_DESIGN.md §9-1 / §9-2). */
export const TISTORY_CATEGORY_BY_INTERNAL: Record<string, string> = {
  entertainment: "연예계 뉴스",
  ott: "영화, 드라마, OTT",
  parenting: "육아팁 나누기",
  living: "일상 생활 정보",
  community: "일상 생활 정보",
};

export const BLOGSPOT_LABEL_BY_INTERNAL: Record<string, string> = {
  entertainment: "연예",
  ott: "OTT",
  parenting: "육아",
  living: "생활정보",
  community: "이슈",
};
