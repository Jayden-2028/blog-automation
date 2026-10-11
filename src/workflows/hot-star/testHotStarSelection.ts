// 핫이슈 스타 선별·포매팅·분기 테스트(KEYWORD-REFRESH-2026-10.md §B·§E).
// 외부 호출 없음 - LLM·DB·Telegram은 전부 주입으로 대체한다.
import "dotenv/config";

import {
  buildHotStarMaterials,
  buildHotStarPrompt,
  formatHotStarMessage,
  HOT_STAR_BACKGROUND_MAX_CHARS,
  HOT_STAR_TOP_N,
  markEveningOverlap,
  parseHotStarOutput,
  type HotStarMaterial,
} from "./hotStarSelection.js";
import { pickEveningRun, runHotStarCollection, startOfSeoulDay } from "./runHotStarCollection.js";
import { HOT_STAR_RUN_KIND, isKeywordSelectionRunKind } from "../../config/discoveryRunKinds.js";
import type { DiscoveryRunRow, KeywordRankingRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const material = (text: string, origin: HotStarMaterial["origin"], headline?: string): HotStarMaterial => ({
  text,
  headline: headline ?? null,
  origin,
  source: origin === "ranking" ? "entertainment" : "google_trends",
});

function makeRun(id: number, startedAt: string, kind: string | null, status = "completed"): DiscoveryRunRow {
  return {
    id,
    started_at: startedAt,
    completed_at: startedAt,
    status,
    candidates_count: 100,
    clusters_count: 10,
    inserted_count: 10,
    error_count: 0,
    source: "naver",
    seed_queries: null,
    metadata: kind ? { kind } : null,
    created_at: startedAt,
  } as DiscoveryRunRow;
}

function makeRanking(rank: number, keyword: string, headline: string | null): KeywordRankingRow {
  return {
    id: rank,
    run_id: 501,
    keyword_id: null,
    keyword,
    headline,
    seed_query: null,
    category: "entertainment",
    rank,
    total_score: 80,
    trend_score: null,
    news_score: null,
    content_score: null,
    freshness_score: null,
    cross_source_score: null,
    click_score: null,
    trend_direction: "up",
    related_count: 3,
    sources: ["naver"],
    score_breakdown: null,
    reason: null,
    latest_published_at: null,
    created_at: "2026-10-11T09:10:00Z",
  } as KeywordRankingRow;
}

async function main(): Promise<void> {
  console.log("▶ 핫이슈 스타 테스트 시작\n");

  // ---------- 1) 재료 조립 ----------
  const materials = buildHotStarMaterials([
    material("트렌드 키워드", "trend"),
    material("엔터 키워드", "ranking", "엔터 키워드 관련 뉴스 제목"),
    material("엔터 키워드", "ranking", "엔터 키워드 관련 뉴스 제목"), // 완전 중복
    material("  ", "trend"), // 빈 문구
  ]);
  assert(materials.length === 2, `중복·빈 문구는 버린다 (실제 ${materials.length}건)`);
  assert(materials[0].origin === "ranking", "랭킹 재료가 트렌드보다 앞이어야 한다(상한에 걸릴 때 뒤가 먼저 잘린다)");
  console.log("  ✅ 재료 중복 제거 + 랭킹 우선 정렬");

  const capped = buildHotStarMaterials(
    Array.from({ length: 30 }, (_, index) => material(`트렌드 ${index}`, "trend")),
    5
  );
  assert(capped.length === 5, `재료 상한이 적용돼야 한다 (실제 ${capped.length}건)`);
  console.log("  ✅ 재료 상한");

  // ---------- 2) 프롬프트 ----------
  const prompt = buildHotStarPrompt(materials);
  assert(prompt.includes("1. 엔터 키워드 — 엔터 키워드 관련 뉴스 제목"), "헤드라인이 있으면 함께 넘긴다");
  assert(prompt.includes("번호|인물명|화제가 된 배경"), "출력 형식을 고정해야 한다");
  assert(prompt.includes("억지로 채우지 않는다"), "5명을 못 채우면 줄이라는 지시가 있어야 한다");
  assert(prompt.includes("작품명·프로그램명·그룹명·회사명은 인물이 아니다"), "인물만 고르라는 지시가 있어야 한다");
  assert(prompt.includes("목록 전체를 본다"), "앞쪽 몇 줄에만 의존하지 말라는 지시가 있어야 한다");
  console.log("  ✅ 프롬프트 형식·지시");

  // ---------- 3) 파싱 ----------
  const parsed = parseHotStarOutput(
    [
      "1|아이유|드라마 최종회가 자체 최고 시청률을 기록했다.",
      "2. | 박보검 | 신작 영화 개봉 소식이 종일 화제였다.",
      "3|아이유|같은 인물 중복 줄",
      "쓸모없는 줄",
      "4|이것은 이름이 아니라 아주 긴 문장입니다 그리고 더 깁니다|배경",
      "5|차은우|",
      "6|정해인|예능 출연이 화제가 됐다.",
    ].join("\n")
  );
  assert(parsed.length === 3, `유효한 줄만 남아야 한다 (실제 ${parsed.length}건: ${parsed.map((p) => p.name).join(",")})`);
  assert(parsed[0].name === "아이유" && parsed[1].name === "박보검" && parsed[2].name === "정해인", "순서가 유지돼야 한다");
  console.log("  ✅ 형식 위반·중복 인물·빈 배경 줄 제거");

  // 본문 안의 인용부호는 지키고, 전체를 감싼 것만 벗긴다(2026-10-11 실측 회귀 - 작품명 따옴표가 깨졌다).
  const q = String.fromCharCode(39);
  const quoted = parseHotStarOutput(`1|${q}정보석${q}|${q}살림남${q}에서 반전 일상을 공개했다.`);
  assert(quoted[0].name === "정보석", `감싼 따옴표는 벗긴다: ${quoted[0].name}`);
  assert(
    quoted[0].background === `${q}살림남${q}에서 반전 일상을 공개했다.`,
    `본문 안 따옴표는 지켜야 한다: ${quoted[0].background}`
  );
  console.log("  ✅ 인용부호 처리(감싼 것만 벗기고 본문은 보존)");

  const longBackground = parseHotStarOutput(`1|아이유|${"가".repeat(400)}`);
  assert(
    longBackground[0].background.length <= HOT_STAR_BACKGROUND_MAX_CHARS,
    `배경이 상한으로 잘려야 한다 (실제 ${longBackground[0].background.length}자)`
  );
  console.log("  ✅ 긴 배경은 잘라서 쓴다");

  const overflow = parseHotStarOutput(
    Array.from({ length: 9 }, (_, index) => `${index + 1}|인물${index}|배경 ${index}`).join("\n")
  );
  assert(overflow.length === HOT_STAR_TOP_N, `Top ${HOT_STAR_TOP_N}을 넘지 않아야 한다 (실제 ${overflow.length}건)`);
  console.log(`  ✅ Top ${HOT_STAR_TOP_N} 상한`);

  // ---------- 4) 18시 알림 중복 표기 ----------
  const marked = markEveningOverlap(
    [
      { name: "아이유", background: "배경1" },
      { name: "박보검", background: "배경2" },
    ],
    ["아이유 드라마 최종회", "폭싹 속았수다 시청률"]
  );
  assert(marked[0].alsoInEveningNotification && !marked[1].alsoInEveningNotification, "겹치는 인물만 표기돼야 한다");
  assert(marked.length === 2, "중복을 제거하지 않고 둘 다 남아야 한다(§B)");
  console.log("  ✅ 18시 알림 중복은 '제거'가 아니라 '표기'");

  // ---------- 5) 메시지 포매팅 ----------
  const now = new Date("2026-10-11T10:00:00Z"); // KST 19:00
  const full = formatHotStarMessage(
    markEveningOverlap(
      Array.from({ length: HOT_STAR_TOP_N }, (_, index) => ({ name: `인물${index}`, background: `배경 ${index}` })),
      ["인물0 소식"]
    ),
    { now, materialSummary: "엔터 run #501 키워드 10건 · 당일 트렌드 후보 40건" }
  );
  assert(full.includes("🌟 <b>오늘의 핫이슈 스타</b>"), "제목이 있어야 한다");
  assert(full.includes(`Top ${HOT_STAR_TOP_N}`) && !full.includes("오늘은"), "5명을 채운 날엔 'Top 5'만 적는다");
  assert(full.includes("↳ 18시 알림에도 선정"), "중복 표기 줄이 보여야 한다");
  assert(full.includes("2026년 10월 11일"), "KST 날짜가 보여야 한다");
  assert(full.includes("재료: 엔터 run #501"), "재료 내역 꼬리말");
  assert(full.includes("읽기용 알림입니다"), "알림 전용임을 본문에 밝혀야 한다(버튼이 없는 이유)");
  console.log("  ✅ 5명 채운 날 본문");

  const partial = formatHotStarMessage(markEveningOverlap([{ name: "아이유", background: "배경" }], []), { now });
  assert(partial.includes("오늘은 1명"), "5명을 못 채운 날은 몇 명인지 적어야 한다(§B)");
  console.log("  ✅ 5명 미만이면 '오늘은 N명'");

  const escaped = formatHotStarMessage(markEveningOverlap([{ name: "A<b>&", background: "배경 <script>" }], []), { now });
  assert(escaped.includes("A&lt;b&gt;&amp;") && escaped.includes("&lt;script&gt;"), "외부 문자열은 HTML escape돼야 한다");
  console.log("  ✅ HTML escape");

  // ---------- 6) 당일 엔터 run 선택 ----------
  const runNow = new Date("2026-10-11T10:00:00Z"); // KST 10-11 19:00
  assert(
    startOfSeoulDay(runNow).toISOString() === "2026-10-10T15:00:00.000Z",
    `KST 당일 시작이 어긋난다: ${startOfSeoulDay(runNow).toISOString()}`
  );
  const todayEvening = makeRun(501, "2026-10-11T09:05:00Z", "entertainment"); // KST 18:05
  const yesterdayEvening = makeRun(401, "2026-10-10T09:05:00Z", "entertainment");
  const todayFailed = makeRun(502, "2026-10-11T09:40:00Z", "entertainment", "failed");
  const todaySocial = makeRun(503, "2026-10-11T11:05:00Z", "social_issue");
  assert(pickEveningRun([todaySocial, todayFailed, todayEvening, yesterdayEvening], runNow)?.id === 501, "당일 완료된 엔터 run을 골라야 한다");
  assert(pickEveningRun([yesterdayEvening, todaySocial], runNow) === null, "전날 run은 당일 재료가 아니다");
  console.log("  ✅ 당일 엔터 run 선택(실패·다른 트랙·전날 제외)");

  // ---------- 7) 오케스트레이션 ----------
  const rankings = [
    makeRanking(1, "아이유 드라마", "아이유 드라마 최종회 시청률 자체 최고"),
    makeRanking(2, "박보검 신작", "박보검 신작 영화 개봉"),
    makeRanking(12, "순위 밖 키워드", "차은우 관련 기사"), // rank>10 - 18시 알림에 안 올라갔다
  ];
  const baseOptions = {
    now: runNow,
    fetchRecentRuns: async () => [todayEvening],
    fetchRankings: async () => rankings,
    fetchTrendCandidates: async () => [{ keyword: "트렌드 인물", topic: "연예", source: "google_trends" }],
    save: async () => ({ runId: 900, persisted: true }),
  };

  const sent: string[] = [];
  const ok = await runHotStarCollection({
    ...baseOptions,
    runLlm: async () => ({
      ok: true,
      output: "1|아이유|드라마 최종회가 자체 최고 시청률을 찍었다.\n2|차은우|신작 캐스팅 소식이 돌았다.",
    }),
    send: async (text) => {
      sent.push(text);
    },
  });
  assert(ok.status === "notified" && ok.runId === 900, `정상 발송이어야 한다: ${ok.status} ${ok.error ?? ""}`);
  assert(sent.length === 1, "메시지 한 번만 보낸다");
  assert(ok.people[0].alsoInEveningNotification, "18시 알림(rank<=10)에 있던 아이유는 중복 표기");
  assert(!ok.people[1].alsoInEveningNotification, "rank 12 키워드의 차은우는 18시 알림에 없었다 - 표기하지 않는다");
  assert(ok.rankingMaterialCount === 3 && ok.trendMaterialCount === 1, `재료 집계 오류: ${JSON.stringify(ok)}`);
  console.log("  ✅ 정상 흐름(발송 1회 + 중복 표기 판정은 18시에 실제로 올라간 범위만)");

  // LLM 실패 -> 발송하지 않는다
  const llmFailSends: string[] = [];
  const llmFail = await runHotStarCollection({
    ...baseOptions,
    runLlm: async () => ({ ok: false, error: "timeout" }),
    send: async (text) => {
      llmFailSends.push(text);
    },
  });
  assert(llmFail.status === "llm_failed" && llmFailSends.length === 0, "LLM 실패면 근거 없는 알림을 보내지 않는다");
  console.log("  ✅ LLM 실패 → 무발송");

  // 인물을 못 뽑으면 발송하지 않는다
  const noPeople = await runHotStarCollection({
    ...baseOptions,
    runLlm: async () => ({ ok: true, output: "형식을 어긴 출력" }),
    send: async () => {
      throw new Error("보내면 안 된다");
    },
  });
  assert(noPeople.status === "no_people", "인물 0명이면 no_people");
  console.log("  ✅ 인물 0명 → 무발송");

  // 재료가 없으면 LLM도 호출하지 않는다
  let llmCalls = 0;
  const noMaterials = await runHotStarCollection({
    now: runNow,
    fetchRecentRuns: async () => [],
    fetchRankings: async () => [],
    fetchTrendCandidates: async () => [],
    runLlm: async () => {
      llmCalls += 1;
      return { ok: true, output: "" };
    },
    send: async () => {
      throw new Error("보내면 안 된다");
    },
  });
  assert(noMaterials.status === "no_materials" && llmCalls === 0, "재료가 없으면 LLM을 호출하지 않는다(토큰 낭비 방지)");
  console.log("  ✅ 재료 0건 → LLM 호출 없음");

  // 엔터 run이 없어도 트렌드 후보만으로 진행한다
  const trendOnly = await runHotStarCollection({
    now: runNow,
    fetchRecentRuns: async () => [yesterdayEvening],
    fetchRankings: async () => {
      throw new Error("불러선 안 된다");
    },
    fetchTrendCandidates: async () => [{ keyword: "트렌드 인물", topic: "연예", source: "daum_realtime" }],
    runLlm: async () => ({ ok: true, output: "1|아이유|트렌드에 올랐다." }),
    save: async () => ({ runId: 901, persisted: true }),
    send: async () => {},
    log: () => {},
  });
  assert(trendOnly.status === "notified" && trendOnly.eveningRunId === null, "엔터 run이 없어도 트렌드만으로 보낸다");
  assert(trendOnly.message?.includes("엔터 run 없음"), "재료 꼬리말에 엔터 run 없음이 보여야 한다");
  console.log("  ✅ 엔터 run 누락 → 트렌드 후보만으로 진행");

  // 트렌드 조회 실패는 랭킹만으로 진행한다
  const trendFail = await runHotStarCollection({
    ...baseOptions,
    fetchTrendCandidates: async () => {
      throw new Error("egress quota");
    },
    runLlm: async () => ({ ok: true, output: "1|아이유|배경." }),
    send: async () => {},
    log: () => {},
  });
  assert(trendFail.status === "notified" && trendFail.trendMaterialCount === 0, "트렌드 조회 실패는 비치명적이어야 한다");
  console.log("  ✅ 트렌드 조회 실패 → 랭킹만으로 진행");

  // run 기록이 실패해도 알림은 나간다
  const saveFailSends: string[] = [];
  const saveFail = await runHotStarCollection({
    ...baseOptions,
    save: async () => ({ runId: null, persisted: false, error: "insert 실패" }),
    runLlm: async () => ({ ok: true, output: "1|아이유|배경." }),
    send: async (text) => {
      saveFailSends.push(text);
    },
    log: () => {},
  });
  assert(saveFail.status === "notified" && saveFail.saveError === "insert 실패" && saveFailSends.length === 1, "기록 실패가 알림을 막으면 안 된다");
  console.log("  ✅ run 기록 실패 → 알림은 계속");

  // dry-run은 저장·발송을 하지 않는다
  const dry = await runHotStarCollection({
    ...baseOptions,
    dryRun: true,
    save: async () => {
      throw new Error("저장하면 안 된다");
    },
    runLlm: async () => ({ ok: true, output: "1|아이유|배경." }),
    send: async () => {
      throw new Error("보내면 안 된다");
    },
  });
  assert(dry.status === "dry_run" && dry.runId === null && dry.message, "dry-run은 본문만 만든다");
  console.log("  ✅ dry-run");

  // ---------- 8) 키워드 알림과 섞이지 않는 kind ----------
  assert(HOT_STAR_RUN_KIND === "entertainment-hot-star", "run kind는 entertainment-hot-star");
  assert(!isKeywordSelectionRunKind(HOT_STAR_RUN_KIND), "핫스타 run은 키워드 선택 알림 재료가 될 수 없다");
  assert(isKeywordSelectionRunKind("entertainment") && isKeywordSelectionRunKind(undefined), "엔터 run과 kind 없는 옛 run은 그대로 쓰인다");
  console.log("  ✅ run kind 구분(watchdog·수동 재발송이 키워드 run과 섞어 보지 않는다)");

  console.log("\n✅ 핫이슈 스타 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
