// 티스토리에 **실제로 올라간 글**을 하루 1회 읽어 DB에 적립한다(2026-11-05 사용자 지시).
//
// 왜 필요한가: 같은 날 발행이 **임시저장 + 사람이 직접 발행**으로 바뀌었다(TISTORY_PUBLISH_MODE=draft).
// 폴러는 임시저장까지만 하고 `publications` 행을 남기지 않으므로, 사용자가 글 관리에서 발행한 글은
// 시스템에 **기록이 없다**. 기록이 없으면 같이 멈추는 것들이 있다:
//   · 내부 링크 후보(listPublishedPosts) - 새 글이 서로를 링크하지 못한다
//   · 최소 발행 간격·색인 점검·조회수 측정 - 전부 publications를 기준으로 본다
//   · 발행량 판단 - 하루 1건 상한을 폐지한 대신(publishInterval.ts 머리말) "며칠에 몇 건 올렸나"는
//     이 적립 기록으로 본다
//
// 어떻게 읽나: 블로그 **RSS**(`https://<blog>.tistory.com/rss`)다. 로그인이 필요 없어 GitHub Actions에서
// 돌고, 실측 50건이 담겨 하루 1회면 충분히 겹친다(제목·주소·permalink·카테고리·발행시각이 다 있다).
// 글 관리 화면을 긁지 않는 이유 - 거기는 로그인(맥미니)이 필요하고 캡차를 부른다.
//
// 어떻게 맞추나: **제목**이다. 우리가 쓴 제목이 그대로 올라가므로 정규화 후 완전 일치로 찾는다.
// 비슷한 제목을 억지로 붙이지 않는다 - 엉뚱한 주소를 기록하는 쪽이 기록이 없는 쪽보다 나쁘다.
// 못 찾은 글은 "미확인"으로 보고만 한다(사용자가 티스토리에서 직접 쓴 글일 수 있다).
//
// 이 파일은 순수 함수만 둔다(네트워크·DB는 tistoryInventoryCli.ts). RSS 한 번 읽는 것 외에 외부 호출이 없다.

/** RSS item 한 건. */
export type TistoryFeedItem = {
  title: string;
  /** <link>의 공개 주소(/entry/... 형태, 퍼센트 인코딩 그대로). */
  url: string;
  /** <guid>의 숫자 permalink(.../145의 145). 없으면 null. */
  postId: string | null;
  /** <pubDate>를 ISO로. 파싱 실패면 null. */
  publishedAt: string | null;
  /** 첫 <category> = 카테고리 경로("이슈 해설/사건·사고와 재판"). 태그는 담지 않는다. */
  category: string | null;
};

/** 적립 대상 후보. CLI가 articles + publications + article_jobs를 합쳐 만든다. */
export type InventoryArticle = {
  articleId: number;
  jobId: string;
  title: string;
  /** 이 article의 티스토리 publication 주소(있으면). 행이 없으면 undefined. */
  publicationId?: number;
  recordedUrl?: string | null;
};

export type InventoryAction =
  /** publications 행이 아예 없다 - 새로 적립한다. */
  | { kind: "record"; item: TistoryFeedItem; article: InventoryArticle }
  /** 행은 있는데 주소가 비었거나 다르다 - 주소를 맞춘다(임시저장 때 추정 주소가 들어간 경우). */
  | { kind: "fix-url"; item: TistoryFeedItem; article: InventoryArticle; publicationId: number };

export type InventoryPlan = {
  actions: InventoryAction[];
  /** 이미 같은 주소로 적립돼 있어 할 일이 없는 건수. */
  already: number;
  /** 제목으로 우리 원고를 찾지 못한 글. 사용자가 티스토리에서 직접 쓴 글이거나 제목을 고친 글이다. */
  unmatched: TistoryFeedItem[];
};

/** `&amp;middot;`처럼 **두 겹**으로 인코딩돼 오는 티스토리 RSS를 풀어낸다(실측 2026-11-05). */
export function decodeEntities(text: string): string {
  const once = (value: string): string =>
    value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&middot;/g, "·")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  // 두 번 돈다 - `&amp;middot;`는 한 번 풀면 `&middot;`가 되고 그때 비로소 `·`가 된다.
  return once(once(text));
}

/** 제목 비교용 정규화: 엔티티 해제 -> NFC -> 공백 접기 -> 소문자. 기호는 지우지 않는다(지우면 서로 다른 글이 겹친다). */
export function normalizeTitle(title: string): string {
  return decodeEntities(title).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 주소 비교용: 퍼센트 인코딩과 끝 슬래시 차이를 무시한다. */
export function normalizeUrl(url: string): string {
  let value = url.trim();
  try {
    value = decodeURI(value);
  } catch {
    // 인코딩이 깨진 주소는 그대로 비교한다
  }
  return value.replace(/\/+$/, "").normalize("NFC");
}

function firstTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

/** `<guid ...>https://blog.tistory.com/145</guid>`의 145. */
export function postIdFromGuid(guid: string | null): string | null {
  const match = guid?.match(/\/(\d+)(?:[?#].*)?$/);
  return match ? match[1] : null;
}

function toIso(pubDate: string | null): string | null {
  if (!pubDate) return null;
  const parsed = Date.parse(pubDate);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** RSS XML -> item 목록(피드 순서 = 최신순 그대로). 파싱 실패한 item은 조용히 건너뛴다(제목·주소가 없으면 쓸 수 없다). */
export function parseTistoryRss(xml: string): TistoryFeedItem[] {
  const items: TistoryFeedItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1];
    const title = firstTag(block, "title");
    const link = firstTag(block, "link");
    if (!title || !link) continue;
    items.push({
      title: decodeEntities(title),
      url: decodeEntities(link),
      postId: postIdFromGuid(firstTag(block, "guid")),
      publishedAt: toIso(firstTag(block, "pubDate")),
      category: firstTag(block, "category") ? decodeEntities(firstTag(block, "category") as string) : null,
    });
  }
  return items;
}

/**
 * 할 일 목록을 만든다. 쓰기는 하지 않는다 - CLI가 dry-run으로 먼저 보여 주고 `--apply`에서만 쓴다.
 *
 * 제목이 같은 원고가 여럿이면(수정 재작성) **가장 작은 articleId**를 쓴다 - 같은 글을 두 번
 * 적립하지 않으려면 선택이 실행마다 같아야 한다.
 */
export function planInventory(items: readonly TistoryFeedItem[], articles: readonly InventoryArticle[]): InventoryPlan {
  const byTitle = new Map<string, InventoryArticle>();
  for (const article of [...articles].sort((a, b) => a.articleId - b.articleId)) {
    const key = normalizeTitle(article.title);
    if (key && !byTitle.has(key)) byTitle.set(key, article);
  }

  const actions: InventoryAction[] = [];
  const unmatched: TistoryFeedItem[] = [];
  const usedArticles = new Set<number>();
  let already = 0;

  for (const item of items) {
    const article = byTitle.get(normalizeTitle(item.title));
    if (!article || usedArticles.has(article.articleId)) {
      // 같은 원고를 두 글에 붙이지 않는다 - 둘째 글은 미확인으로 남겨 사람이 본다.
      unmatched.push(item);
      continue;
    }
    usedArticles.add(article.articleId);

    if (article.publicationId === undefined) {
      actions.push({ kind: "record", item, article });
      continue;
    }
    if (article.recordedUrl && normalizeUrl(article.recordedUrl) === normalizeUrl(item.url)) {
      already += 1;
      continue;
    }
    actions.push({ kind: "fix-url", item, article, publicationId: article.publicationId });
  }

  return { actions, already, unmatched };
}

/** 적립 결과 한 줄 요약(로그·알림 공용). */
export function inventorySummary(plan: InventoryPlan, total: number): string {
  const recorded = plan.actions.filter((action) => action.kind === "record").length;
  const fixed = plan.actions.length - recorded;
  return `RSS ${total}건 - 새로 적립 ${recorded}, 주소 교정 ${fixed}, 이미 적립 ${plan.already}, 미확인 ${plan.unmatched.length}`;
}
