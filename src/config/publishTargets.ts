// 다채널 발행(Sprint 5) 채널별 설정. trendSources.ts / naverPublish.ts와 같은 패턴 -
// 숫자·문자열을 로직 코드에 흩뿌리지 않고 이 파일만 참조한다.
//
// 채널별 enabled 기준: "사람의 사전 준비 없이 자동으로 돌 수 있는가".
// - blogspot: Blogger API v3. refresh token이 있어야 동작(setup:blogger 1회).
//
// 2026-09-15 티스토리 운영 중단(BLOGSPOT_ONLY_DESIGN.md)으로 걷어냈던 TISTORY_CONFIG를
// 2026-10-06 사회 이슈 트랙 자동 발행(TISTORY_AUTO_PUBLISH_DESIGN.md)으로 되살린다. 전제가 바뀌었다 -
// 로그인이 풀리면 사용자가 바로 개입할 수 있는 트랙이라, 로그인 풀림을 "대기"로 두고 재개한다.

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
 * 사용설명서 트랙(Korea Plain)의 Blogger blogId(개편3, 2026-10-05 확정. 2026-10-28 맞춤 도메인 www.koreaplain.com 연결 -
 * 구 주소 thekoreamanual.blogspot.com은 Blogger가 301로 넘긴다).
 * whynowissue와 **같은 구글 계정**이라 OAuth refresh token(BLOGGER_REFRESH_TOKEN)은 그대로 쓰고 blogId만 다르다.
 *
 * ⚠️ 이 값이 비어 있으면 사용설명서 글은 **발행하지 않는다**(BLOGGER_BLOG_ID로 폴백하지 않는다) - 폴백하면 영어 글이
 * whynowissue(한국어 블로그)에 올라간다. publishArticleToBlogspot.ts가 이 경우 `disabled`로 돌려준다.
 */
export const KSCENE_BLOGGER_BLOG_ID: string | undefined = process.env.KSCENE_BLOGGER_BLOG_ID?.trim() || undefined;

/**
 * 사용설명서 트랙(Korea Plain)의 공개 주소(origin, 끝 슬래시 없음). 2026-10-28 맞춤 도메인 전환.
 * 코드가 이 블로그의 호스트를 가정하는 자리(Related·All Guides 링크, JSON-LD, Bing siteUrl, 분석 매칭, 발행 기록 URL)는
 * 전부 이 값과 normalizeTkmUrl을 거친다. `KSCENE_PUBLIC_ORIGIN`으로 덮어쓸 수 있다(되돌릴 때는 blogspot 주소를 넣는다).
 */
export const KSCENE_PUBLIC_ORIGIN: string = parseOrigin(process.env.KSCENE_PUBLIC_ORIGIN) ?? "https://www.koreaplain.com";

/**
 * 같은 블로그를 가리키는 옛 호스트. 구 주소는 301 소스로 영구 보존하므로 들어오는 URL에 계속 나타난다
 * (Blogger API 응답·옛 발행 기록·옛 GSC 행·이미 넣은 본문 링크).
 */
export const KSCENE_LEGACY_HOSTS: readonly string[] = ["thekoreamanual.blogspot.com"];

function parseOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/** 이 블로그의 호스트인가: 옛 blogspot, 공개 호스트, 공개 호스트의 apex(www 없는 형태). */
function isTkmHost(host: string, origin: string): boolean {
  const publicHost = new URL(origin).host.toLowerCase();
  const apex = publicHost.replace(/^www\./, "");
  const lower = host.toLowerCase();
  return KSCENE_LEGACY_HOSTS.includes(lower) || lower === publicHost || lower === apex;
}

/**
 * TKM 주소를 공개 주소로 바꾼다 - 스킴·호스트만 바꾸고 경로·쿼리·해시는 그대로. 다른 블로그 주소나 URL이 아닌 값은 그대로 돌려준다.
 * `http://www.koreaplain.com/...`(Blogger API가 맞춤 도메인 글을 http로 돌려줄 수 있다)도 https로 맞춘다.
 */
export function normalizeTkmUrl(url: string, origin: string = KSCENE_PUBLIC_ORIGIN): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol) || !isTkmHost(parsed.host, origin)) return url;
  return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** 같은 글의 다른 호스트 표기들(공개 주소 + 옛 blogspot 주소). TKM 주소가 아니면 [url]. 분석 매칭용. */
export function tkmUrlAliases(url: string, origin: string = KSCENE_PUBLIC_ORIGIN): string[] {
  if (!isTkmUrl(url, origin)) return [url];
  const normalized = normalizeTkmUrl(url, origin);
  const path = normalized.slice(origin.length);
  return [...new Set([url, normalized, ...KSCENE_LEGACY_HOSTS.map((host) => `https://${host}${path}`)])];
}

export function isTkmUrl(url: string, origin: string = KSCENE_PUBLIC_ORIGIN): boolean {
  try {
    return isTkmHost(new URL(url).host, origin);
  } catch {
    return false;
  }
}

/** 본문 HTML·텍스트 안의 옛 blogspot **절대 URL**(`https://`, `http://`, `//`)을 공개 주소로. 스킴 없는 호스트 언급은 건드리지 않는다. */
export function rewriteTkmLegacyUrls(text: string, origin: string = KSCENE_PUBLIC_ORIGIN): { text: string; count: number } {
  let count = 0;
  const hosts = KSCENE_LEGACY_HOSTS.map((host) => host.replace(/\./g, "\\.")).join("|");
  const re = new RegExp(String.raw`(?:https?:)?//(?:${hosts})(?![\w.-])`, "gi");
  const next = text.replace(re, () => {
    count += 1;
    return origin;
  });
  return { text: next, count };
}

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

export type TistoryConfig = {
  /** 마스터 게이트. false면 발행 요청은 큐에 남고 폴러가 처리하지 않는다. */
  enabled: boolean;
  blogUrl: string;
  /** 티스토리(카카오) 로그인 세션을 담는 Playwright 프로필. 네이버·Creator Advisor 프로필과 분리한다. */
  profileDir: string;
  /** 첫 운영은 비공개로 눈으로 확인한 뒤 공개로 바꾼다(네이버와 같은 원칙). TISTORY_PUBLISH_VISIBILITY=public. */
  visibility: "public" | "private";
  /** 로그인 풀림으로 미뤄진 발행이 이 일수를 넘기면 자동 재개하지 않는다(2026-10-06 사용자 결정: 3일). */
  deferredMaxDays: number;
};

export const TISTORY_CONFIG: TistoryConfig = {
  enabled: parseBooleanEnv(process.env.TISTORY_ENABLED, false),
  blogUrl: process.env.TISTORY_BLOG_URL || "https://wooahpapa.tistory.com/",
  profileDir: process.env.TISTORY_PROFILE_DIR || ".local/tistory-publish-profile",
  visibility: process.env.TISTORY_PUBLISH_VISIBILITY === "public" ? "public" : "private",
  deferredMaxDays: parseIntEnv(process.env.TISTORY_DEFERRED_MAX_DAYS, 3),
};

/** https://wooahpapa.tistory.com/ -> wooahpapa. 주소가 이상하면 빈 문자열. */
export function tistoryBlogName(blogUrl: string = TISTORY_CONFIG.blogUrl): string {
  try {
    return new URL(blogUrl).host.split(".")[0] ?? "";
  } catch {
    return "";
  }
}
