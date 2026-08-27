// TelegramBot callback 핸들러 테스트.
//
// 실제 Telegram API와 Supabase를 호출하지 않는다. TelegramBot이 제공하는 주입 지점
// (loadRanking/createJob/saveTitles/generateTitles)으로 DB·LLM 접근을 대체해 분기만 검증한다.
//
// 여기서 지켜야 할 성질은 셋이다:
// 1. 우리 버튼이 아닌 update를 조용히 무시한다(봇이 들어 있는 대화에는 별게 다 온다)
// 2. 다른 chat에서 온 callback을 거부한다
// 3. 중복 클릭이 job을 두 개 만들지 않고, 비싼 제목 생성도 다시 하지 않는다

import { TelegramBot } from "./TelegramBot.js";
import type { ArticleJobRow, KeywordRankingRow } from "../types/database.js";
import type { TelegramCallbackQuery } from "./TelegramBot.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const CHAT_ID = "123456";
const RUN_ID = 18;
const RANK = 3;

function makeRanking(): KeywordRankingRow {
  return {
    id: 1,
    run_id: RUN_ID,
    keyword_id: null,
    keyword: "양준모 재혼 상대 양지원",
    headline: "양준모 재혼 상대 양지원 임신 발표",
    seed_query: "양준모 재혼",
    category: "entertainment",
    rank: RANK,
    total_score: 61,
    trend_score: 30,
    news_score: 9,
    content_score: 9,
    freshness_score: 7,
    cross_source_score: 6,
    click_score: 0,
    trend_direction: "rising",
    related_count: 3,
    sources: ["naver_news", "naver_blog"],
    score_breakdown: null,
    reason: "검색 관심 상승",
    latest_published_at: null,
    created_at: "2026-08-27T00:00:00.000Z",
  };
}

function makeJob(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
  return {
    id: "job-uuid-1",
    source_run_id: RUN_ID,
    source_rank: RANK,
    keyword: "양준모 재혼 상대 양지원",
    headline: "양준모 재혼 상대 양지원 임신 발표",
    seed_query: "양준모 재혼",
    category: "entertainment",
    total_score: 61,
    score_breakdown: null,
    status: "selected",
    selected_at: "2026-08-27T00:00:00.000Z",
    selected_via: "telegram",
    metadata: {},
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeQuery(data: string | undefined, chatId: string | number = CHAT_ID): TelegramCallbackQuery {
  return {
    id: "cbq-1",
    data,
    message: { message_id: 55, chat: { id: chatId } },
  };
}

// ---------- 주입 헬퍼 ----------
// ESM 네임스페이스는 재정의할 수 없으므로 모듈을 패칭하지 않는다. TelegramBot이 제공하는
// 주입 지점(loadRanking/createJob/saveTitles)으로 DB 접근을 대체한다 -
// buildDailyQueryPool의 loadActiveSeeds, runCreatorAdvisorCollection의 fetchCandidates와 같은 방식.

type Calls = { create: number; saveTitles: number; titles: number; loadRanking: number };

function makeBot(opts: {
  ranking: KeywordRankingRow | null;
  created?: boolean;
  calls: Calls;
  failTitles?: boolean;
}): TelegramBot {
  return new TelegramBot({
    botToken: "test-token",
    chatId: CHAT_ID,
    loadRanking: async () => {
      opts.calls.loadRanking++;
      return opts.ranking;
    },
    createJob: async () => {
      opts.calls.create++;
      return { job: makeJob(), created: opts.created ?? true };
    },
    saveTitles: async () => {
      opts.calls.saveTitles++;
    },
    generateTitles: async () => {
      opts.calls.titles++;
      if (opts.failTitles) throw new Error("헤드리스 실행 실패");
      return ["제목 A", "제목 B", "제목 C"];
    },
  });
}

function newCalls(): Calls {
  return { create: 0, saveTitles: 0, titles: 0, loadRanking: 0 };
}

async function main(): Promise<void> {
  console.log("▶ TelegramBot callback 핸들러 테스트 시작\n");

  // 1) 우리 버튼이 아닌 update는 조용히 무시하고 DB를 건드리지 않는다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    for (const data of [undefined, "", "other:1:2", "sel:abc:1"]) {
      const result = await bot.handleCallbackQuery(makeQuery(data));
      assert(
        result.outcome.status === "ignored" && result.outcome.reason === "not_a_selection",
        `선택 버튼이 아닌 값을 무시해야 한다: ${JSON.stringify(data)} -> ${JSON.stringify(result.outcome)}`
      );
    }
    assert(calls.loadRanking === 0 && calls.create === 0, "무시된 update에서 DB를 조회/기록하면 안 된다");
    console.log("✅ 선택 버튼이 아닌 update -> 무시, DB 접근 없음");
  }

  // 2) 다른 chat에서 온 callback은 거부한다. 봇이 초대된 다른 대화에서 눌릴 수 있다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const result = await bot.handleCallbackQuery(makeQuery(`sel:${RUN_ID}:${RANK}`, "999999"));
    assert(
      result.outcome.status === "ignored" && result.outcome.reason === "wrong_chat",
      `다른 chat은 거부해야 한다 (실제: ${JSON.stringify(result.outcome)})`
    );
    assert(calls.loadRanking === 0 && calls.create === 0, "거부된 chat에서 DB를 건드리면 안 된다");
    console.log("✅ 다른 chat에서 온 callback -> 거부, DB 접근 없음");
  }

  // 3) 조회되지 않는 (run_id, rank)는 만료로 처리한다. 이 판정이 곧 callback_data 검증이다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: null, calls });
    const result = await bot.handleCallbackQuery(makeQuery(`sel:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "expired", `조회 실패는 expired여야 한다 (실제: ${result.outcome.status})`);
    assert(result.message.includes("만료"), "사용자에게 만료 안내를 해야 한다");
    assert(calls.create === 0, "존재하지 않는 ranking으로 job을 만들면 안 된다");
    console.log("✅ 조회 실패(만료/위조) -> expired, job 생성 없음");
  }

  // 4) 정상 선택: job 생성 + 제목 생성 + metadata 저장 + 확인 메시지.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const result = await bot.handleCallbackQuery(makeQuery(`sel:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "created", `정상 선택은 created여야 한다 (실제: ${result.outcome.status})`);
    assert(calls.create === 1, `job 생성은 1회여야 한다 (실제: ${calls.create})`);
    assert(calls.titles === 1, `제목 생성은 1회여야 한다 (실제: ${calls.titles})`);
    assert(calls.saveTitles === 1, "생성된 제목을 metadata에 저장해야 한다");
    assert(result.message.includes("제목 A"), "확인 메시지에 추천 제목이 들어가야 한다");
    assert(result.message.includes("양준모"), "확인 메시지에 선택한 키워드가 들어가야 한다");
    console.log("✅ 정상 선택 -> job 생성 + 제목 3개 + 확인 메시지");
  }

  // 5) 중복 클릭: job을 다시 만들지 않고, 비싼 제목 생성도 하지 않는다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), created: false, calls });
    const result = await bot.handleCallbackQuery(makeQuery(`sel:${RUN_ID}:${RANK}`));
    assert(
      result.outcome.status === "already_selected",
      `중복 클릭은 already_selected여야 한다 (실제: ${result.outcome.status})`
    );
    assert(calls.titles === 0, "중복 클릭에서 제목을 다시 생성하면 안 된다(토큰 낭비)");
    assert(calls.saveTitles === 0, "중복 클릭에서 metadata를 다시 쓰면 안 된다");
    console.log("✅ 중복 클릭 -> 기존 job 반환, 제목 재생성 없음");
  }

  // 6) 제목 생성이 실패해도 선택 자체는 성공해야 한다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls, failTitles: true });
    const result = await bot.handleCallbackQuery(makeQuery(`sel:${RUN_ID}:${RANK}`));
    assert(
      result.outcome.status === "created",
      `제목 생성 실패가 선택을 무효로 만들면 안 된다 (실제: ${result.outcome.status})`
    );
    assert(result.message.includes("선택 완료"), "제목 없이도 확인 메시지를 보내야 한다");
    console.log("✅ 제목 생성 실패 -> 선택은 정상 완료");
  }

  console.log("\n✅ TelegramBot callback 핸들러 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
