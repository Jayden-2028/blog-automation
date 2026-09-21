// 다채널 발행(Sprint 5) 채널별 설정. trendSources.ts / naverPublish.ts와 같은 패턴 -
// 숫자·문자열을 로직 코드에 흩뿌리지 않고 이 파일만 참조한다.
//
// 채널별 enabled 기준: "사람의 사전 준비 없이 자동으로 돌 수 있는가".
// - blogspot: Blogger API v3. refresh token이 있어야 동작(setup:blogger 1회).
//
// 2026-09-15 티스토리 운영 중단(BLOGSPOT_ONLY_DESIGN.md) - TISTORY_CONFIG와 카테고리 매핑표를
// 걷어냈다. .env의 TISTORY_* 값은 이제 아무도 읽지 않는다.

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
  /**
   * 글별 댓글 허용 설정(Blogger `readerComments`). 사용자 결정(2026-09-16): 댓글을 받지 않는다.
   * 실측으로 확인한 유효값은 셋뿐이다 - `ALLOW` / `DONT_ALLOW_SHOW_EXISTING` /
   * `DONT_ALLOW_HIDE_EXISTING`(그 외 값은 400 Invalid value).
   */
  readerComments: BloggerReaderComments;
};

export type BloggerReaderComments = "ALLOW" | "DONT_ALLOW_SHOW_EXISTING" | "DONT_ALLOW_HIDE_EXISTING";

const READER_COMMENTS_VALUES: readonly BloggerReaderComments[] = [
  "ALLOW",
  "DONT_ALLOW_SHOW_EXISTING",
  "DONT_ALLOW_HIDE_EXISTING",
];

function parseReaderComments(raw: string | undefined): BloggerReaderComments {
  const value = raw?.trim() as BloggerReaderComments | undefined;
  return value && READER_COMMENTS_VALUES.includes(value) ? value : "DONT_ALLOW_HIDE_EXISTING";
}

export const BLOGGER_CONFIG: BloggerConfig = {
  enabled: parseBooleanEnv(process.env.BLOGGER_ENABLED, false),
  clientId: process.env.BLOGGER_CLIENT_ID || undefined,
  clientSecret: process.env.BLOGGER_CLIENT_SECRET || undefined,
  refreshToken: process.env.BLOGGER_REFRESH_TOKEN || undefined,
  blogId: process.env.BLOGGER_BLOG_ID || undefined,
  scope: "https://www.googleapis.com/auth/blogger",
  // 5 -> 20(2026-09-21 사용자 결정). 5는 하루 3건 생산을 전제로 잡은 값이라, 밀린 원고가
  // 겹치면 바로 걸렸다(실측: 더쿠 원고가 6번째라 막혔고, 재시도하는 스케줄이 없어 그대로 묻혔다).
  // Blogger 자체 한도는 하루 50건이라 20은 한참 아래다.
  dailyLimit: parseIntEnv(process.env.BLOGGER_DAILY_LIMIT, 20),
  // 기본 true. 당분간 draft 고정(2026-09-01, CLAUDE.md 원고 파이프라인 운영 규칙): 이미지
  // 자동생성이 보류 상태라 원고에 이미지가 비어 있고, 사용자가 편집화면에서 이미지를 삽입한 뒤
  // 직접 발행한다. 시스템 안정화 전까지 BLOGGER_PUBLISH_AS_DRAFT=false로 바꾸지 않는다.
  publishAsDraft: parseBooleanEnv(process.env.BLOGGER_PUBLISH_AS_DRAFT, true),
  readerComments: parseReaderComments(process.env.BLOGGER_READER_COMMENTS),
};

/**
 * 내부 category -> Blogspot 라벨 (SPRINT_5_DESIGN.md §9-2).
 * 2026-09-15 단독 운영 전환으로 사회 이슈(incident)·생활(living)도 여기로 오므로 라벨을 추가했다 -
 * 예전엔 이 두 카테고리가 티스토리 담당이라 이 표에 없었다.
 */
export const BLOGSPOT_LABEL_BY_INTERNAL: Record<string, string> = {
  incident: "사건사고",
  entertainment: "연예",
  ott: "OTT",
  parenting: "육아",
  living: "생활정보",
  community: "이슈",
};
