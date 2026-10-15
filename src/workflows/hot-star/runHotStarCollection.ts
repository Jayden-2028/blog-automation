// 19:00 KST "오늘의 핫이슈 스타 Top 5" 수집 -> 저장 -> 알림(KEYWORD-REFRESH-2026-10.md §B).
// Worker cron 10 UTC 슬롯이 entertainment-hot-star.yml을 깨운다.
//
// 엔터 메인봇으로 보내고, 인물별 `✍️ 인물글` 버튼(`pgo:<run_id>:<rank>`)을 붙인다(인물 백과 트랙,
// 2026-10-13). 2026-10-11에는 알림 전용이었으나 인물 백과 트랙(PERSON-PROFILE-TRACK-2026-10.md)이 그 연결을
// 대체했다. 누르면 TelegramBot이 run.metadata.people[rank]로 category=person job을 만들어 기존 엔터 트랙
// 흐름(자료조사 → write 자동 → 통합 알림 → 뷰어까지; 발행은 수동 복붙, 자동 발행 없음 2026-10-14)을 탄다. 키워드 Go/Pass 버튼은 여전히 없다.
//
// 재료는 **그날 이미 쌓인 수집 데이터뿐이다**: 18시 엔터 회차의 keyword_rankings + 당일 trend_candidates
// (구글 트렌드·다음 실시간·커뮤니티·Creator Advisor). 보조 수집(NAVER·Serper)은 호출하지 않는다 -
// 18시 회차가 09 UTC에 ~10분 걸려 끝나므로 19시에는 그날 데이터가 이미 가장 신선하다. 추가 호출이
// 필요해지면 그때 호출량을 보고하고 켠다.
//
// 저장: discovery_runs에 kind=entertainment-hot-star로 남긴다(keyword_rankings는 쓰지 않는다 -
// 키워드 Go/Pass가 가리킬 행이 없어야 한다). 인물 버튼의 근거는 metadata.people[]{rank,name,background}다.
// watchdog·통계가 엔터 키워드 run과 섞어 보지 않게 하는 구분이기도 하다.

import { HOT_STAR_RUN_KIND } from "../../config/discoveryRunKinds.js";
import { TelegramNotifier } from "../../notifications/TelegramNotifier.js";
import type { TelegramReplyMarkup } from "../../notifications/TelegramNotifier.js";
import { TrendCandidateRepository } from "../../repositories/TrendCandidateRepository.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { listRecentDiscoveryRuns } from "../../services/supabase/repositories/discoveryRunRepository.js";
import { listKeywordRankingsByRunId } from "../../services/supabase/repositories/keywordRankingRepository.js";
import { saveRankingHistory } from "../keyword-ranking/saveRankingHistory.js";
import {
  buildHotStarKeyboard,
  buildHotStarMaterials,
  buildHotStarPrompt,
  formatHotStarMessage,
  HOT_STAR_TOP_N,
  markEveningOverlap,
  parseHotStarOutput,
  type HotStarMaterial,
  type HotStarPerson,
} from "./hotStarSelection.js";
import type { DiscoveryRunRow, KeywordRankingRow } from "../../types/database.js";

/** 엔터 키워드 run의 kind. 18시 회차 결과를 1차 재료로 읽는다. */
const ENTERTAINMENT_RUN_KIND = "entertainment";

/** 18시 알림에 실제로 올라간 항목 수(sendKeywordNotification 기본 topN). 중복 표기 판정 범위다. */
const EVENING_NOTIFIED_TOP_N = 10;

/** 인물 추출은 짧은 작업이지만 재료가 100줄을 넘을 수 있다. 실패하면 알림을 보내지 않는다. */
const HOT_STAR_TIMEOUT_MS = 180_000;

/** 당일 run을 찾기 위해 읽을 최근 run 수. 하루 4건이라 사흘치다. */
const RECENT_RUNS_LIMIT = 12;

export type RunHotStarCollectionOptions = {
  /** 기준 시각. 테스트 주입. */
  now?: Date;
  dryRun?: boolean;
  /** 최근 discovery_runs 조회. 테스트 주입. */
  fetchRecentRuns?: (limit: number) => Promise<DiscoveryRunRow[]>;
  /** run의 keyword_rankings 조회. 테스트 주입. */
  fetchRankings?: (runId: number) => Promise<KeywordRankingRow[]>;
  /** 당일 trend_candidates 조회. 테스트 주입. 실패해도 랭킹만으로 진행한다. */
  fetchTrendCandidates?: (sinceIso: string) => Promise<{ keyword: string; topic: string; source: string }[]>;
  /** LLM 호출. 테스트 주입. */
  runLlm?: (prompt: string) => Promise<{ ok: true; output: string } | { ok: false; error: string }>;
  /** 저장. 테스트 주입. */
  save?: typeof saveRankingHistory;
  /** 발송. 테스트 주입. replyMarkup은 인물별 `✍️ 인물글` 키보드(run 기록 실패 시 없다). */
  send?: (text: string, replyMarkup?: TelegramReplyMarkup) => Promise<void>;
  log?: (line: string) => void;
};

export type RunHotStarCollectionResult = {
  status: "notified" | "dry_run" | "no_materials" | "no_people" | "llm_failed" | "notify_failed";
  runId: number | null;
  people: HotStarPerson[];
  materialCount: number;
  rankingMaterialCount: number;
  trendMaterialCount: number;
  /** 18시 회차 run id. 못 찾았으면 null(그날 엔터 run이 실패했거나 아직 안 끝난 경우). */
  eveningRunId: number | null;
  message?: string;
  /**
   * 알림에 붙은 `✍️ 인물글` 버튼 라벨. dry-run은 run id가 없어 callback_data를 만들 수 없으므로 라벨만 보인다.
   * run 기록 실패로 버튼 없이 나갔으면 빈 배열.
   */
  buttonLabels?: string[];
  /** 저장 실패는 알림을 막지 않는다 - 사유만 남긴다. */
  saveError?: string;
  error?: string;
};

/** "당일분"의 시작 = KST 오늘 00:00. UTC 날짜로 자르면 KST 00~09시 수집분이 전날로 떨어진다. */
export function startOfSeoulDay(now: Date): Date {
  const seoulDate = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  return new Date(`${seoulDate}T00:00:00+09:00`);
}

function runKind(run: DiscoveryRunRow): string | null {
  const kind = run.metadata?.kind;
  return typeof kind === "string" ? kind : null;
}

/** 당일(KST) 가장 최근에 완료된 엔터 키워드 run. 회차를 가리지 않는다 - 수동 회차도 그날 재료다. */
export function pickEveningRun(runs: readonly DiscoveryRunRow[], now: Date): DiscoveryRunRow | null {
  const since = startOfSeoulDay(now).getTime();
  return (
    runs
      .filter((run) => run.status === "completed" && runKind(run) === ENTERTAINMENT_RUN_KIND)
      .filter((run) => Date.parse(run.started_at) >= since)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] ?? null
  );
}

export async function runHotStarCollection(
  options: RunHotStarCollectionOptions = {}
): Promise<RunHotStarCollectionResult> {
  const now = options.now ?? new Date();
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchRecentRuns = options.fetchRecentRuns ?? listRecentDiscoveryRuns;
  const fetchRankings = options.fetchRankings ?? listKeywordRankingsByRunId;
  const fetchTrendCandidates =
    options.fetchTrendCandidates ?? ((sinceIso: string) => TrendCandidateRepository.listActiveCollectedSince(sinceIso));
  const runLlm =
    options.runLlm ??
    (async (prompt: string) => {
      const result = await runHeadlessClaude({ prompt, timeoutMs: HOT_STAR_TIMEOUT_MS });
      return result.ok ? { ok: true as const, output: result.output } : { ok: false as const, error: result.error };
    });
  const save = options.save ?? saveRankingHistory;
  const send =
    options.send ??
    ((text: string, replyMarkup?: TelegramReplyMarkup) =>
      TelegramNotifier.fromEnv("entertainment").sendMessages([{ text, replyMarkup }]));

  // 1) 1차 재료: 당일 엔터 회차의 keyword_rankings
  const runs = await fetchRecentRuns(RECENT_RUNS_LIMIT);
  const eveningRun = pickEveningRun(runs, now);

  let rankings: KeywordRankingRow[] = [];
  if (eveningRun) {
    try {
      rankings = await fetchRankings(eveningRun.id);
    } catch (error) {
      log(`⚠️ 엔터 run #${eveningRun.id} 랭킹 조회 실패(트렌드 후보만으로 진행): ${describe(error)}`);
    }
  } else {
    log("⚠️ 당일 완료된 엔터 키워드 run을 찾지 못했습니다(트렌드 후보만으로 진행)");
  }

  const rankingMaterials: HotStarMaterial[] = rankings.map((row) => ({
    text: row.keyword,
    headline: row.headline,
    origin: "ranking" as const,
    source: ENTERTAINMENT_RUN_KIND,
  }));

  // 2) 보조 재료: 당일 trend_candidates(이미 수집돼 있는 값 - 추가 API 호출 없음)
  let trendMaterials: HotStarMaterial[] = [];
  try {
    const candidates = await fetchTrendCandidates(startOfSeoulDay(now).toISOString());
    trendMaterials = candidates.map((row) => ({
      text: row.keyword,
      headline: null,
      origin: "trend" as const,
      source: row.source,
    }));
  } catch (error) {
    log(`⚠️ 당일 트렌드 후보 조회 실패(랭킹만으로 진행): ${describe(error)}`);
  }

  const materials = buildHotStarMaterials([...rankingMaterials, ...trendMaterials]);
  const rankingMaterialCount = materials.filter((item) => item.origin === "ranking").length;
  const trendMaterialCount = materials.length - rankingMaterialCount;

  const base = {
    materialCount: materials.length,
    rankingMaterialCount,
    trendMaterialCount,
    eveningRunId: eveningRun?.id ?? null,
  };

  if (materials.length === 0) {
    return { status: "no_materials", runId: null, people: [], ...base, error: "당일 수집 재료가 없습니다" };
  }

  // 3) 인물 5명 + 배경 추출(헤드리스 1콜)
  const llm = await runLlm(buildHotStarPrompt(materials, HOT_STAR_TOP_N));
  if (!llm.ok) {
    // 알림을 보내지 않는다 - 근거 없이 인물 5명을 적어 보내는 것보다 조용한 쪽이 낫다(watchdog과 run 기록으로 남는다).
    return { status: "llm_failed", runId: null, people: [], ...base, error: llm.error };
  }

  const parsed = parseHotStarOutput(llm.output, HOT_STAR_TOP_N);
  if (parsed.length === 0) {
    return { status: "no_people", runId: null, people: [], ...base, error: "인물을 특정하지 못했습니다" };
  }

  // 4) 18시 알림과 겹치는 인물 표기(중복 제거는 하지 않는다)
  const eveningTexts = rankings
    .filter((row) => row.rank <= EVENING_NOTIFIED_TOP_N)
    .flatMap((row) => [row.keyword, row.headline ?? ""]);
  const people = markEveningOverlap(parsed, eveningTexts);

  const materialSummary =
    `${eveningRun ? `엔터 run #${eveningRun.id} 키워드 ${rankingMaterialCount}건` : "엔터 run 없음"}` +
    ` · 당일 트렌드 후보 ${trendMaterialCount}건`;
  const message = formatHotStarMessage(people, { now, materialSummary });

  if (options.dryRun) {
    return { status: "dry_run", runId: null, people, ...base, message, buttonLabels: people.map((p) => `✍️ ${p.rank}. ${p.name} 인물글`) };
  }

  // 5) run 기록(keyword_rankings 행은 만들지 않는다 - ranked는 비운다. 인물글 버튼의 근거는 metadata.people)
  const saved = await save({
    startedAt: now,
    seedQueries: [],
    source: "hot_star",
    metadata: {
      kind: HOT_STAR_RUN_KIND,
      track: "entertainment",
      eveningRunId: eveningRun?.id ?? null,
      people: people.map((person) => ({
        rank: person.rank,
        name: person.name,
        // 인물글 버튼(pgo:)이 job을 만들 때 읽는다 - research의 §1(지금 화제인 이유) 출발점이 된다.
        background: person.background,
        alsoInEveningNotification: person.alsoInEveningNotification,
      })),
    },
    candidatesCount: materials.length,
    clustersCount: people.length,
    errorCount: 0,
    ranked: [],
  });
  const saveError = saved.persisted ? undefined : (saved.error ?? "run 기록 실패");
  if (saveError) log(`⚠️ 핫이슈 스타 run 기록 실패(알림은 계속): ${saveError}`);

  // 6) 엔터 메인봇으로 발송. 인물별 `✍️ 인물글` 키보드를 붙인다. 버튼은 run id를 가리키므로 **run 기록이 성공했을 때만**
  //    붙인다 - 기록이 없으면 눌러도 조회되지 않아 "만료" 답만 오는 죽은 버튼이 된다(알림 자체는 보낸다).
  const replyMarkup = saved.persisted && saved.runId !== null ? (buildHotStarKeyboard(saved.runId, people) ?? undefined) : undefined;
  if (!replyMarkup) log("⚠️ run 기록이 없어 인물글 버튼 없이 알림만 보냅니다");
  try {
    await send(message, replyMarkup);
  } catch (error) {
    return { status: "notify_failed", runId: saved.runId, people, ...base, message, saveError, error: describe(error) };
  }

  return {
    status: "notified",
    runId: saved.runId,
    people,
    ...base,
    message,
    buttonLabels: replyMarkup ? replyMarkup.inline_keyboard.map((row) => row[0].text) : [],
    saveError,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
