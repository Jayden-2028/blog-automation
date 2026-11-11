// Google 뉴스 한국 ENTERTAINMENT 토픽 RSS 파서(순수 함수. 네트워크 접근 없음).
//
// 왜 이 피드인가(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R1): 기존 동적 소스는 전부
// "사람들이 무엇을 **검색**했나"(Creator Advisor·구글 트렌드·다음 실시간)거나 "커뮤니티에서 무엇을
// 떠들었나"다. 둘 다 아젠다의 후행 지표라, 기사가 뜬 당일 저녁 18시에는 아직 검색량이 붙지 않은
// 사안이 통째로 빠진다 - 2026-11-10에 연예면 주요 기사 14건이 **후보 1334건 안에 아예 없었던**
// 이유다. 이 파서는 "연예 데스크가 오늘 무엇을 냈나"를 직접 읽는다.
//
// **이 피드의 핵심 가치는 Google이 이미 이슈 단위로 묶어 준다는 것이다.** `<item>` 하나가 기사 하나가
// 아니라 **스토리 클러스터**다: `<title>`이 대표 헤드라인이고, `<description>`에 그 이슈를 다룬
// 기사 목록이 `<ol><li><a>제목 - 매체</a><font>매체</font></li>…` 로 들어 있다. 2026-11-11 실측에서
// "인강 강사 이도" 이슈는 한국경제·머니투데이·뉴스1·뉴시스·조선일보 5개 매체가 한 item에 묶여 있었다.
// 우리가 직접 제목 유사도로 묶으면 반드시 틀리는 일을 Google이 대신 해 준다.
//
// **주의: `<ol>`은 5건에서 잘린다.** 2026-11-11 실측 70 item 중 63건이 정확히 5건이었다. 그래서
// outletCount는 "매체가 몇 곳인가"의 **하한**일 뿐이고, 상위권을 가르는 변별 신호로는 쓸 수 없다
// (설계안 R9이 기대한 "보도 매체 수"를 이 값만으로 대체할 수 없다는 뜻이다). 순위 신호는 다음
// 랭킹(parseDaumEntRanking.ts)이 맡는다.
//
// 제목 끝의 " - 매체명"은 Google이 붙인 꼬리다. 검색어로 쓰면 매체명까지 검색하게 되므로 떼어 낸다.
// `<source>` 태그에 같은 매체명이 따로 오므로 정보가 사라지지 않는다.

export type GoogleNewsRelatedArticle = {
  title: string;
  outlet: string | null;
};

export type GoogleNewsStory = {
  /** 대표 헤드라인(" - 매체명" 꼬리를 떼어 낸 것). */
  leadTitle: string;
  /** 대표 기사의 매체(`<source>`). 없으면 null. */
  leadOutlet: string | null;
  /** 피드 등장 순서(1부터). Google의 자체 정렬이고, 우리 쪽 순위 신호로는 약하다. */
  feedPosition: number;
  /** 발행 시각 ISO. 파싱 불가면 null. */
  publishedAt: string | null;
  /** 같은 이슈로 묶인 기사들(대표 포함). `<ol>`이 5건에서 잘리므로 최대 5건이다. */
  related: GoogleNewsRelatedArticle[];
  /** 서로 다른 매체 수. **5에서 포화된다**(파일 상단 주석). */
  outletCount: number;
};

/** Google이 붙이는 " - 매체명" 꼬리. 제목 안의 하이픈과 구분하려고 **마지막** 구분자만 본다. */
export function stripOutletSuffix(title: string, outlet?: string | null): string {
  const trimmed = title.trim();
  if (outlet) {
    const suffix = ` - ${outlet.trim()}`;
    if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length).trim();
  }
  // 매체명을 모를 때(related 항목)는 마지막 " - " 뒤가 짧은 토막일 때만 꼬리로 본다.
  const index = trimmed.lastIndexOf(" - ");
  if (index > 0) {
    const tail = trimmed.slice(index + 3);
    if (tail.length > 0 && tail.length <= 20 && !tail.includes(" - ")) return trimmed.slice(0, index).trim();
  }
  return trimmed;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function firstGroup(source: string, pattern: RegExp): string | null {
  const match = pattern.exec(source);
  return match ? decodeEntities(match[1]).trim() : null;
}

function parsePubDate(raw: string | null): string | null {
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * `<description>` 안의 `<ol>`을 읽어 같은 이슈 기사 목록을 만든다. description은 HTML이 **이스케이프된
 * 채로** 들어오므로 엔티티를 먼저 풀고 파싱한다.
 *
 * 매체는 `<font color="#6f6f6f">매체</font>`로 온다. 색상 값까지 고정으로 요구하지는 않는다 -
 * Google이 스타일을 바꿔도 매체만 못 읽고 제목은 그대로 읽히게 한다(제목이 본질이다).
 */
export function parseRelatedArticles(descriptionRaw: string | null): GoogleNewsRelatedArticle[] {
  if (!descriptionRaw) return [];
  const html = decodeEntities(descriptionRaw);

  const related: GoogleNewsRelatedArticle[] = [];
  for (const [, liBody] of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(liBody);
    if (!anchor) continue;
    const outlet = firstGroup(liBody, /<font[^>]*>([\s\S]*?)<\/font>/);
    const title = stripOutletSuffix(stripTags(anchor[1]), outlet);
    if (!title) continue;
    related.push({ title, outlet: outlet || null });
  }
  return related;
}

/**
 * RSS 본문 -> 스토리 목록. **구조가 바뀌어 아무것도 못 읽어도 예외를 던지지 않고 빈 배열을 돌려준다**
 * (parseDaumRealtimePage.ts와 같은 원칙 - 보조 소스가 daily job을 죽이면 안 된다).
 */
export function parseGoogleNewsRss(xml: string): GoogleNewsStory[] {
  const stories: GoogleNewsStory[] = [];
  let position = 0;

  for (const [, itemBody] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const rawTitle = firstGroup(itemBody, /<title>([\s\S]*?)<\/title>/);
    if (!rawTitle) continue;

    position++;
    const leadOutlet = firstGroup(itemBody, /<source\b[^>]*>([\s\S]*?)<\/source>/);
    const leadTitle = stripOutletSuffix(rawTitle, leadOutlet);
    if (!leadTitle) continue;

    const descriptionRaw = /<description>([\s\S]*?)<\/description>/.exec(itemBody)?.[1] ?? null;
    const related = parseRelatedArticles(descriptionRaw);

    // 대표 기사가 `<ol>`에 없는 경우(실측에서는 항상 첫 항목이지만 보장은 없다)를 대비해 합집합을 쓴다.
    const titles = new Map<string, GoogleNewsRelatedArticle>();
    titles.set(leadTitle, { title: leadTitle, outlet: leadOutlet || null });
    for (const article of related) {
      if (!titles.has(article.title)) titles.set(article.title, article);
    }

    const outlets = new Set(
      [...titles.values()].map((article) => article.outlet).filter((outlet): outlet is string => !!outlet)
    );

    stories.push({
      leadTitle,
      leadOutlet: leadOutlet || null,
      feedPosition: position,
      publishedAt: parsePubDate(firstGroup(itemBody, /<pubDate>([\s\S]*?)<\/pubDate>/)),
      related: [...titles.values()],
      outletCount: Math.max(outlets.size, 1),
    });
  }

  return stories;
}
