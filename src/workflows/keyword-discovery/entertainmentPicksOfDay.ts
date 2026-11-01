// 그날 엔터 트랙이 이미 집어 간 키워드·인물 목록. 사회 리포트(20시)에서 같은 것을 또 올리지
// 않으려고 쓴다.
//
// **왜 어휘 목록으로는 안 되는가**(2026-11-01 사용자 지적). `socialReportSections.ts`의
// `isEntertainmentLeak`는 "영화·드라마·가수" 같은 **어휘**로 판정한다. 그런데 실제로 새어 들어온
// 것은 강유미·한은서·김용건·이찬혁·전원일기 맏딸처럼 **사람 이름뿐인 키워드**였다. 제목에도
// 엔터 어휘가 없으니 목록을 아무리 늘려도 같은 구멍이 남는다 - 이름을 다 적을 수는 없다.
//
// 그래서 어휘가 아니라 **출처로** 판정한다. 18시 엔터 run(`keyword_rankings`)과 19시 핫이슈 스타
// run(`metadata.people[]`)에 이미 올라간 것이면, 그건 엔터가 가져간 소재다. 이름을 몰라도 걸린다.
//
// 이 판정은 **어휘 판정을 대체하지 않고 더한다** - 엔터 run에 안 뜬 연예 키워드는 여전히 어휘가 잡는다.

import { ENTERTAINMENT_RUN_KINDS } from "../../config/discoveryRunKinds.js";
import { listRecentDiscoveryRuns } from "../../services/supabase/repositories/discoveryRunRepository.js";
import { listKeywordRankingsByRunId } from "../../services/supabase/repositories/keywordRankingRepository.js";

export type EntertainmentPicksOfDay = {
  /** 18시 엔터 run이 Top N으로 올린 키워드. */
  keywords: string[];
  /** 19시 핫이슈 스타 run이 고른 인물 이름. */
  people: string[];
};

/** 한국시간 기준 날짜(YYYY-MM-DD). run 비교는 UTC가 아니라 KST 하루로 묶는다. */
export function kstDateKey(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function peopleNamesOf(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const people = (metadata as { people?: unknown }).people;
  if (!Array.isArray(people)) return [];
  return people
    .map((person) => (person && typeof person === "object" ? (person as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
}

/**
 * 오늘(KST) 엔터 트랙이 집은 키워드·인물. 조회가 실패하면 **빈 목록**을 돌려준다 -
 * 이 단계는 알림 품질을 높이는 보조 장치이고, 여기서 실패해 사회 리포트 자체가 멈추면 안 된다.
 */
export async function loadEntertainmentPicksOfDay(
  now: Date = new Date(),
  deps: {
    listRuns?: typeof listRecentDiscoveryRuns;
    listRankings?: typeof listKeywordRankingsByRunId;
  } = {}
): Promise<EntertainmentPicksOfDay> {
  const listRuns = deps.listRuns ?? listRecentDiscoveryRuns;
  const listRankings = deps.listRankings ?? listKeywordRankingsByRunId;
  const today = kstDateKey(now);

  try {
    const runs = await listRuns(40);
    const todaysEntertainmentRuns = runs.filter((run) => {
      const kind = (run.metadata as { kind?: unknown } | null)?.kind;
      if (typeof kind !== "string" || !ENTERTAINMENT_RUN_KINDS.includes(kind)) return false;
      const at = run.started_at ?? run.created_at;
      return typeof at === "string" && kstDateKey(new Date(at)) === today;
    });

    const keywords: string[] = [];
    const people: string[] = [];
    for (const run of todaysEntertainmentRuns) {
      people.push(...peopleNamesOf(run.metadata));
      const rankings = await listRankings(run.id);
      for (const row of rankings) {
        if (typeof row.keyword === "string" && row.keyword.trim()) keywords.push(row.keyword.trim());
      }
    }
    return { keywords: [...new Set(keywords)], people: [...new Set(people)] };
  } catch (error) {
    console.log(`⚠️ 엔터 선점 목록 조회 실패(비치명적) - ${(error as Error).message}`);
    return { keywords: [], people: [] };
  }
}

/** 비교용 정규화: 공백·가운뎃점·따옴표를 지우고 소문자로. "악뮤 이찬혁" vs "이찬혁"을 잇기 위함. */
export function normalizeForOverlap(text: string): string {
  return text.replace(/[\s·・,."'`’”“\-–—]/g, "").toLowerCase();
}

/**
 * 이 사회 키워드가 오늘 엔터가 집어 간 것과 겹치는가.
 *
 * - 인물: 이름이 키워드·제목 **어디에든** 들어 있으면 겹침으로 본다("악뮤 이찬혁 신곡" ← "이찬혁").
 *   두 글자 이름은 일반 낱말과 부딪히므로(예: "한은") **세 글자 이상**만 본다.
 * - 키워드: 한쪽이 다른 쪽을 통째로 품을 때만 겹침이다. 짧은 조각이 우연히 들어맞는 것을 막으려고
 *   **정규화 후 6자 이상**인 것만 본다.
 */
export function overlapsEntertainmentPicks(
  item: { keyword: string; headline?: string | null },
  picks: EntertainmentPicksOfDay
): boolean {
  const haystack = normalizeForOverlap(`${item.keyword} ${item.headline ?? ""}`);
  if (!haystack) return false;

  for (const name of picks.people) {
    const normalized = normalizeForOverlap(name);
    if (normalized.length >= 3 && haystack.includes(normalized)) return true;
  }
  for (const keyword of picks.keywords) {
    const normalized = normalizeForOverlap(keyword);
    if (normalized.length < 6) continue;
    if (haystack.includes(normalized) || normalized.includes(haystack)) return true;
  }
  return false;
}
