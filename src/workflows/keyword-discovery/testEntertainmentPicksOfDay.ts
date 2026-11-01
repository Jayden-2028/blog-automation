// 엔터 선점 교차확인 테스트(2026-11-01). 네트워크·DB 없음 - 조회 함수는 주입한다.
//
// 배경: 사회 리포트(20시)에 강유미·한은서·전원일기 맏딸·김용건·악뮤 이찬혁이 섞여 들어왔다.
// `isEntertainmentLeak`는 "영화·드라마·가수" 같은 어휘로 판정하는데 이들은 **사람 이름뿐**이라
// 어휘가 하나도 없다. 그래서 "오늘 엔터 run이 이미 집어 갔는가"를 출처로 본다.

import {
  kstDateKey,
  loadEntertainmentPicksOfDay,
  normalizeForOverlap,
  overlapsEntertainmentPicks,
} from "./entertainmentPicksOfDay.js";
import type { DiscoveryRunRow, KeywordRankingRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NOW = new Date("2026-11-01T11:30:00.000Z"); // KST 11/1 20:30 - 사회 리포트 시각

function run(id: number, kind: string, startedAt: string, metadata: Record<string, unknown> = {}): DiscoveryRunRow {
  return {
    id,
    started_at: startedAt,
    completed_at: startedAt,
    status: "completed",
    candidates_count: 0,
    clusters_count: 0,
    inserted_count: 0,
    error_count: 0,
    source: "naver",
    seed_queries: null,
    metadata: { kind, ...metadata },
    created_at: startedAt,
  };
}

// 테스트가 보는 것은 run_id·keyword 둘뿐이라 나머지 컬럼은 채우지 않는다.
function ranking(runId: number, rank: number, keyword: string): KeywordRankingRow {
  return { id: runId * 100 + rank, run_id: runId, rank, keyword } as unknown as KeywordRankingRow;
}

// ── 1. KST 날짜 경계 ─────────────────────────────────────────────
{
  assert(kstDateKey(new Date("2026-11-01T11:30:00.000Z")) === "2026-11-01", "KST 20:30은 11/1");
  // UTC로는 10/31이지만 KST로는 11/1이다(KST 09:00). 날짜를 UTC로 묶으면 같은 날 run을 놓친다.
  assert(kstDateKey(new Date("2026-10-31T23:00:00.000Z")) === "2026-11-01", "UTC 10/31 23시는 KST 11/1");
  assert(kstDateKey(new Date("2026-11-01T14:59:00.000Z")) === "2026-11-01", "UTC 11/1 14:59는 아직 KST 11/1");
  assert(kstDateKey(new Date("2026-11-01T15:00:00.000Z")) === "2026-11-02", "UTC 11/1 15:00부터 KST 11/2");
}

// ── 2. 오늘 엔터 run만 모은다 ────────────────────────────────────
{
  const runs: DiscoveryRunRow[] = [
    run(10, "entertainment", "2026-11-01T09:00:00.000Z"), // 오늘 18시 엔터
    run(11, "entertainment-hot-star", "2026-11-01T10:00:00.000Z", {
      people: [
        { rank: 1, name: "강유미" },
        { rank: 2, name: "이찬혁" },
        { rank: 3, name: "" }, // 빈 이름은 버린다
      ],
    }),
    run(12, "social_issue", "2026-11-01T11:00:00.000Z"), // 사회 run은 보지 않는다
    run(13, "entertainment", "2026-10-31T09:00:00.000Z"), // 어제 엔터는 보지 않는다
  ];
  const rankingsByRun: Record<number, KeywordRankingRow[]> = {
    10: [ranking(10, 1, "전원일기 맏딸 근황"), ranking(10, 2, "김용건 인터뷰")],
    12: [ranking(12, 1, "국정감사 출장 지적")],
    13: [ranking(13, 1, "어제 엔터 키워드")],
  };

  const picks = await loadEntertainmentPicksOfDay(NOW, {
    listRuns: async () => runs,
    listRankings: async (runId) => rankingsByRun[runId] ?? [],
  });

  assert(picks.people.length === 2, `인물 2명 (실제 ${picks.people.length}: ${picks.people.join(",")})`);
  assert(picks.people.includes("강유미") && picks.people.includes("이찬혁"), "핫이슈 스타 인물을 모은다");
  assert(picks.keywords.length === 2, `키워드 2건 (실제 ${picks.keywords.length}: ${picks.keywords.join(",")})`);
  assert(!picks.keywords.includes("국정감사 출장 지적"), "사회 run의 키워드는 모으지 않는다");
  assert(!picks.keywords.includes("어제 엔터 키워드"), "어제 run은 모으지 않는다");
}

// ── 3. 조회 실패는 비치명적 ─────────────────────────────────────
{
  const picks = await loadEntertainmentPicksOfDay(NOW, {
    listRuns: async () => {
      throw new Error("DB 장애");
    },
  });
  assert(picks.keywords.length === 0 && picks.people.length === 0, "실패하면 빈 목록 - 리포트를 막지 않는다");
}

// ── 4. 겹침 판정 — 실제로 새어 들어온 5건 ────────────────────────
{
  const picks = {
    keywords: ["전원일기 맏딸 근황", "김용건 인터뷰"],
    people: ["강유미", "이찬혁", "한은서"],
  };
  const hit = (keyword: string, headline: string | null = null) => overlapsEntertainmentPicks({ keyword, headline }, picks);

  assert(hit("강유미 유튜브 구독자"), "인물명이 키워드 안에 있으면 겹침");
  assert(hit("악뮤 이찬혁 신곡"), "수식어가 붙어도 인물명이 들어 있으면 겹침");
  assert(hit("한은서", null), "키워드가 인물명 그 자체여도 겹침");
  assert(hit("김용건 인터뷰"), "엔터 키워드와 같으면 겹침");
  assert(hit("전원일기 맏딸 근황 화제"), "엔터 키워드를 품으면 겹침");
  assert(hit("어떤 사건", "제보자는 강유미 씨였다"), "제목에만 있어도 겹침");

  // 겹치지 않아야 하는 것들
  assert(!hit("국정감사 출장 지적"), "관계 없는 사회 키워드는 통과");
  assert(!hit("아동수당 신청 방법"), "생활 정보는 통과");
}

// ── 5. 오탐 방지 — 짧은 조각은 보지 않는다 ───────────────────────
{
  // 두 글자 이름은 일반 낱말과 부딪힌다. "한은"이 이름이면 "한국은행 한은 총재"가 걸려 버린다.
  const shortName = { keywords: [], people: ["한은"] };
  assert(!overlapsEntertainmentPicks({ keyword: "한은 기준금리 동결" }, shortName), "두 글자 이름은 보지 않는다");

  // 정규화 후 6자 미만 키워드는 보지 않는다 - 짧은 조각이 우연히 들어맞는다.
  const shortKeyword = { keywords: ["개봉"], people: [] };
  assert(!overlapsEntertainmentPicks({ keyword: "택배 상자 개봉 사기" }, shortKeyword), "짧은 키워드는 보지 않는다");

  assert(normalizeForOverlap("악뮤 · 이찬혁") === "악뮤이찬혁", "공백·가운뎃점을 지운다");
}

console.log("✅ KST 날짜 경계 - UTC 기준으로 묶으면 같은 날 run을 놓친다");
console.log("✅ 오늘 엔터 run(키워드 + 핫이슈 스타 인물)만 모은다");
console.log("✅ 조회 실패는 빈 목록 - 사회 리포트를 막지 않는다");
console.log("✅ 실제 누수 5건(강유미·이찬혁·한은서·김용건·전원일기 맏딸) 전부 적중");
console.log("✅ 두 글자 이름·짧은 키워드는 오탐 방지로 제외");
console.log("\n✅ 엔터 선점 교차확인 테스트 완료");
