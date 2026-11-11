// 다음 연예 "많이 본 뉴스" 랭킹 파서(순수 함수. 네트워크 접근 없음).
//
// 왜 필요한가(2026-11-11, KEYWORD-ENT-REDESIGN-2026-11.md R1): Google 뉴스 RSS는 이슈를 묶어 주지만
// **순위를 주지 않는다.** `<ol>`이 5건에서 잘려 매체 수가 70 item 중 63건에서 똑같이 5가 되므로
// (parseGoogleNewsRss.ts 상단), 그 값으로는 "오늘 가장 큰 사안"을 가릴 수 없다. 다음의 「많이 본
// 뉴스」는 **한국 독자가 실제로 읽은 순서**라, 지금 파이프라인에 가장 없는 신호다.
//
// **이 파서의 결과는 후보(시드)가 되지 않는다.** Google 클러스터의 순위를 올리는 데만 쓴다
// (mapNewsFeedCandidates.ts). 매칭에 실패한 다음 기사를 따로 시드로 넣으면 같은 이슈가 두 시드로
// 갈라져, 2026-11-10의 중복 집중을 다시 만든다 - 그래서 일부러 넣지 않고 「못 맞춘 목록」만 남긴다.
//
// 구조(2026-11-11 실측): `box_news_ranking` 블록 안의 `<ul class="list_newsbasic">`에
// `<a class="item_newsbasic" data-tiara-ordnum="N" …><strong class="tit_txt">제목</strong>` 10건.
// 색상·래퍼 클래스까지 고정으로 요구하지 않는다 - 제목과 순위만 읽으면 되고, 못 읽으면 조용히
// 빈 배열을 돌려준다(보조 신호가 daily job을 죽이면 안 된다).

export type DaumEntRankingItem = {
  /** 「많이 본 뉴스」 순위(1부터). */
  rank: number;
  title: string;
};

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

function cleanTitle(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * 「많이 본 뉴스」 블록만 잘라낸다. 같은 페이지에 `data-tiara-ordnum`을 쓰는 다른 섹션이 여럿 있어
 * (2026-11-11 실측 70개) 전체를 훑으면 순위가 섞인다.
 */
function extractRankingBlock(html: string): string | null {
  const start = html.indexOf("box_news_ranking");
  if (start < 0) return null;
  const end = html.indexOf("</ul>", start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

export function parseDaumEntRanking(html: string): DaumEntRankingItem[] {
  const block = extractRankingBlock(html);
  if (!block) return [];

  const items: DaumEntRankingItem[] = [];
  const seenRanks = new Set<number>();

  for (const match of block.matchAll(
    /<a\b[^>]*\bclass="item_newsbasic"[^>]*\bdata-tiara-ordnum="(\d+)"[^>]*>([\s\S]*?)<\/a>/g
  )) {
    const rank = Number.parseInt(match[1], 10);
    if (!Number.isInteger(rank) || rank < 1 || seenRanks.has(rank)) continue;

    const titleMatch = /<strong\b[^>]*\bclass="tit_txt"[^>]*>([\s\S]*?)<\/strong>/.exec(match[2]);
    if (!titleMatch) continue;

    const title = cleanTitle(titleMatch[1]);
    if (!title) continue;

    seenRanks.add(rank);
    items.push({ rank, title });
  }

  return items.sort((a, b) => a.rank - b.rank);
}
