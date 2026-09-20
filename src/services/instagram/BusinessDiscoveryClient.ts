// Meta Graph API의 Business Discovery로 **남의 공개 비즈니스 계정** 게시물을 읽는다.
//
// 왜 이 방식인가(2026-09-21 설계 판단): 인스타그램 데이터를 무료로 안정적으로 얻는 길은 이것뿐이다.
// 로그인 세션 기반 크롤링은 이 프로젝트가 티스토리를 접은 이유(세션이 계속 풀려 사람이 매번 개입)와
// 같은 실패를 반복하고, 인스타는 봇 탐지가 더 공격적이라 계정 정지 위험까지 붙는다.
//
// 호출 형태:
//   GET /{내-IG-비즈니스-계정-ID}
//       ?fields=business_discovery.username(TARGET){followers_count,media_count,media{...}}
//
// 못 가져오는 것(설계에 반영해야 한다): 저장수·공유수·도달·노출·시청 지속률(retention).
// 이 값들은 **자기 계정 인사이트에서만** 나온다. 남의 페이지에서는 어떤 방법으로도 못 얻는다.
// 그래서 점수 로직은 좋아요·댓글·시각·캡션 네 가지만으로 짜야 한다.

const DEFAULT_VERSION = "v21.0";

export type InstagramMedia = {
  id: string;
  caption: string | null;
  like_count: number | null;
  comments_count: number | null;
  timestamp: string;
  permalink: string;
  media_type: string | null;
  /** 릴스 조회수. API 버전·미디어 유형에 따라 없을 수 있어 probe로 실측한다. */
  media_product_type?: string | null;
};

export type BusinessDiscoveryResult =
  | {
      ok: true;
      username: string;
      followersCount: number;
      mediaCount: number;
      media: InstagramMedia[];
      /** 응답 원문에 실제로 들어 있던 미디어 필드 이름들(무엇을 쓸 수 있는지 실측용). */
      observedFields: string[];
    }
  | { ok: false; username: string; error: string; code?: number; hint?: string };

export type BusinessDiscoveryOptions = {
  accessToken?: string;
  /** 내 인스타그램 비즈니스 계정 ID(페이스북 페이지에 연결된 것). */
  igUserId?: string;
  graphVersion?: string;
  fetchImpl?: typeof fetch;
  /** 한 번에 받을 게시물 수. 중앙값 계산에 30건이 필요해 기본 50으로 넉넉히 둔다. */
  mediaLimit?: number;
};

/**
 * 조회 실패를 사람이 읽을 수 있는 원인으로 바꾼다. Business Discovery의 실패는 대부분
 * "대상이 개인 계정"이거나 "권한/토큰 문제"인데, Graph API 메시지만으로는 구분이 어렵다.
 */
function explain(code: number | undefined, message: string): string | undefined {
  if (code === 110) return "대상이 비즈니스/크리에이터 계정이 아니거나 사용자명이 바뀌었습니다.";
  if (code === 190) return "액세스 토큰이 만료됐거나 무효합니다(시스템 사용자 토큰 권장).";
  if (code === 10 || code === 200) return "앱 권한이 부족합니다(instagram_basic·pages_read_engagement 확인).";
  if (code === 4 || code === 17 || code === 32) return "호출 한도에 걸렸습니다. 잠시 뒤 재시도하세요.";
  if (/does not exist|Unsupported get request/i.test(message)) return "사용자명을 찾을 수 없습니다(철자·변경 확인).";
  return undefined;
}

const MEDIA_FIELDS = [
  "id",
  "caption",
  "like_count",
  "comments_count",
  "timestamp",
  "permalink",
  "media_type",
  "media_product_type",
].join(",");

export class BusinessDiscoveryClient {
  private readonly accessToken: string;
  private readonly igUserId: string;
  private readonly graphVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly mediaLimit: number;

  constructor(options: BusinessDiscoveryOptions = {}) {
    this.accessToken = options.accessToken ?? process.env.IG_ACCESS_TOKEN ?? "";
    this.igUserId = options.igUserId ?? process.env.IG_USER_ID ?? "";
    this.graphVersion = options.graphVersion ?? process.env.IG_GRAPH_VERSION ?? DEFAULT_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mediaLimit = options.mediaLimit ?? 50;
  }

  /** 설정 누락을 호출 전에 걸러 "토큰 없음"이 API 에러로 둔갑하지 않게 한다. */
  missingConfig(): string | null {
    if (!this.accessToken) return "IG_ACCESS_TOKEN이 없습니다(.env에 넣어주세요).";
    if (!this.igUserId) return "IG_USER_ID가 없습니다(내 인스타그램 비즈니스 계정 ID).";
    return null;
  }

  async fetchAccount(username: string): Promise<BusinessDiscoveryResult> {
    const configError = this.missingConfig();
    if (configError) return { ok: false, username, error: configError };

    const discovery =
      `business_discovery.username(${username})` +
      `{followers_count,media_count,media.limit(${this.mediaLimit}){${MEDIA_FIELDS}}}`;

    const url = new URL(`https://graph.facebook.com/${this.graphVersion}/${this.igUserId}`);
    url.searchParams.set("fields", discovery);
    url.searchParams.set("access_token", this.accessToken);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString());
    } catch (error) {
      return { ok: false, username, error: `네트워크 오류: ${error instanceof Error ? error.message : String(error)}` };
    }

    const json = (await res.json().catch(() => ({}))) as {
      business_discovery?: {
        followers_count?: number;
        media_count?: number;
        media?: { data?: InstagramMedia[] };
      };
      error?: { message?: string; code?: number };
    };

    if (!res.ok || json.error) {
      const code = json.error?.code;
      const message = json.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, username, error: message, code, hint: explain(code, message) };
    }

    const discovered = json.business_discovery;
    if (!discovered) {
      return { ok: false, username, error: "business_discovery 필드가 비어 있습니다(개인 계정일 가능성).", hint: explain(110, "") };
    }

    const media = discovered.media?.data ?? [];
    const observedFields = [...new Set(media.flatMap((item) => Object.keys(item)))].sort();

    return {
      ok: true,
      username,
      followersCount: discovered.followers_count ?? 0,
      mediaCount: discovered.media_count ?? 0,
      media,
      observedFields,
    };
  }
}
