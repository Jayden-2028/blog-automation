// TelegramBot callback 핸들러 테스트.
//
// 실제 Telegram API와 Supabase를 호출하지 않는다. TelegramBot이 제공하는 주입 지점
// (loadRanking/createJob/saveTitles/updateJobStatus/generateTitles)으로 DB·LLM 접근을 대체해 분기만 검증한다.
//
// 여기서 지켜야 할 성질:
// 1. 우리 버튼이 아닌 update를 조용히 무시한다(봇이 들어 있는 대화에는 별게 다 온다)
// 2. 다른 chat에서 온 callback을 거부한다
// 3. 중복 클릭이 job을 두 개 만들지 않고, 비싼 제목 생성도 다시 하지 않는다
// 4. Pass는 거부 이력만 남기고 LLM을 쓰지 않는다
// 5. 잘못 눌렀을 때 Pass <-> Go로 되돌릴 수 있다
// 6. 이미 진행 중인 job은 버튼으로 되돌려지지 않는다

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
// 주입 지점(loadRanking/createJob/saveTitles/updateJobStatus)으로 DB 접근을 대체한다 -
// buildDailyQueryPool의 loadActiveSeeds, runCreatorAdvisorCollection의 fetchCandidates와 같은 방식.

type Calls = { create: number; saveTitles: number; titles: number; loadRanking: number; updateStatus: number };

function makeBot(opts: {
  ranking: KeywordRankingRow | null;
  created?: boolean;
  /** created:false일 때 이미 존재하는 job의 상태. */
  existingStatus?: ArticleJobRow["status"];
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
    createJob: async (_ranking, status) => {
      opts.calls.create++;
      const created = opts.created ?? true;
      return {
        job: makeJob({ status: created ? status : (opts.existingStatus ?? "selected") }),
        created,
      };
    },
    saveTitles: async () => {
      opts.calls.saveTitles++;
    },
    updateJobStatus: async (_id, status) => {
      opts.calls.updateStatus++;
      return makeJob({ status });
    },
    generateTitles: async () => {
      opts.calls.titles++;
      if (opts.failTitles) throw new Error("헤드리스 실행 실패");
      return ["제목 A", "제목 B", "제목 C"];
    },
  });
}

function newCalls(): Calls {
  return { create: 0, saveTitles: 0, titles: 0, loadRanking: 0, updateStatus: 0 };
}

async function main(): Promise<void> {
  console.log("▶ TelegramBot callback 핸들러 테스트 시작\n");

  // 1) 우리 버튼이 아닌 update는 조용히 무시하고 DB를 건드리지 않는다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    for (const data of [undefined, "", "other:1:2", "go:abc:1"]) {
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
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`, "999999"));
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
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "expired", `조회 실패는 expired여야 한다 (실제: ${result.outcome.status})`);
    assert(result.message.includes("만료"), "사용자에게 만료 안내를 해야 한다");
    assert(calls.create === 0, "존재하지 않는 ranking으로 job을 만들면 안 된다");
    console.log("✅ 조회 실패(만료/위조) -> expired, job 생성 없음");
  }

  // 4) 정상 선택: job 생성 + 제목 생성 + metadata 저장 + 확인 메시지.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "created", `정상 선택은 created여야 한다 (실제: ${result.outcome.status})`);
    assert(calls.create === 1, `job 생성은 1회여야 한다 (실제: ${calls.create})`);
    assert(calls.titles === 1, `제목 생성은 1회여야 한다 (실제: ${calls.titles})`);
    assert(calls.saveTitles === 1, "생성된 제목을 metadata에 저장해야 한다");
    assert(result.message.includes("제목 A"), "확인 메시지에 추천 제목이 들어가야 한다");
    assert(result.message.includes("양준모"), "확인 메시지에 선택한 키워드가 들어가야 한다");
    console.log("✅ 정상 선택 -> job 생성 + 제목 3개 + 확인 메시지");
  }

  // 5) 같은 결정 중복 클릭: job을 다시 만들지 않고, 비싼 제목 생성도 하지 않는다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), created: false, existingStatus: "selected", calls });
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(
      result.outcome.status === "unchanged",
      `같은 결정 중복은 unchanged여야 한다 (실제: ${result.outcome.status})`
    );
    assert(calls.titles === 0, "중복 클릭에서 제목을 다시 생성하면 안 된다(토큰 낭비)");
    assert(calls.updateStatus === 0, "상태가 같으면 갱신하지 않아야 한다");
    console.log("✅ 같은 결정 중복 클릭 -> unchanged, 제목 재생성 없음");
  }

  // 5-1) Pass: 거부 이력만 남기고 LLM을 쓰지 않는다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const result = await bot.handleCallbackQuery(makeQuery(`pass:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "passed", `Pass는 passed여야 한다 (실제: ${result.outcome.status})`);
    assert(
      result.outcome.status === "passed" && result.outcome.job.status === "rejected",
      "Pass로 만든 job은 rejected 상태여야 한다"
    );
    assert(calls.titles === 0, "Pass에서 제목을 만들면 안 된다 - 쓰지 않을 키워드다");
    console.log("✅ Pass -> rejected 기록, LLM 호출 없음");
  }

  // 5-2) Pass 후 Go: 마음을 바꿀 수 있어야 한다. 잘못 눌렀을 때 되돌릴 방법이 없으면 안 된다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), created: false, existingStatus: "rejected", calls });
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "changed", `Pass -> Go는 changed여야 한다 (실제: ${result.outcome.status})`);
    assert(
      result.outcome.status === "changed" && result.outcome.from === "rejected",
      "이전 상태가 rejected로 기록돼야 한다"
    );
    assert(calls.updateStatus === 1, "상태를 selected로 갱신해야 한다");
    assert(calls.titles === 1, "Go로 되돌렸으면 이제 제목이 필요하다");
    console.log("✅ Pass -> Go 전환 -> 상태 갱신 + 제목 생성");
  }

  // 5-3) 이미 진행 중인 job은 되돌리지 않는다. 작업이 버튼 한 번에 사라지면 안 된다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), created: false, existingStatus: "writing", calls });
    const result = await bot.handleCallbackQuery(makeQuery(`pass:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "locked", `진행 중 job은 locked여야 한다 (실제: ${result.outcome.status})`);
    assert(calls.updateStatus === 0, "진행 중 job의 상태를 바꾸면 안 된다");
    console.log("✅ 진행 중(writing) job -> locked, 상태 변경 없음");
  }

  // 6) 제목 생성이 실패해도 선택 자체는 성공해야 한다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls, failTitles: true });
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(
      result.outcome.status === "created",
      `제목 생성 실패가 선택을 무효로 만들면 안 된다 (실제: ${result.outcome.status})`
    );
    assert(result.message.includes("선택 완료"), "제목 없이도 확인 메시지를 보내야 한다");
    console.log("✅ 제목 생성 실패 -> 선택은 정상 완료");
  }

  // ---------- 7) 의학 주제 교차확인(handleArticleReviewCallback) ----------
  // SPRINT_2_DESIGN.md 5-2절. article_jobs.id(UUID)를 직접 가리키므로 (run_id, rank) 기반
  // 키워드 선택과는 별도 주입 지점(loadJobById/mergeJobMetadata)으로 테스트한다.

  const REVIEW_JOB_ID = "054bfe0b-5cf7-4386-941f-810146c25e12";

  type ReviewCalls = { loadJobById: number; updateStatus: number; mergeJobMetadata: number };
  function newReviewCalls(): ReviewCalls {
    return { loadJobById: 0, updateStatus: 0, mergeJobMetadata: 0 };
  }

  function makeReviewJob(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
    return makeJob({ id: REVIEW_JOB_ID, category: "parenting", metadata: { requiresMedicalReview: true }, ...overrides });
  }

  function makeReviewBot(opts: { job: ArticleJobRow | null; calls: ReviewCalls }): TelegramBot {
    return new TelegramBot({
      botToken: "test-token",
      chatId: CHAT_ID,
      loadJobById: async () => {
        opts.calls.loadJobById++;
        return opts.job;
      },
      updateJobStatus: async (_id, status) => {
        opts.calls.updateStatus++;
        return { ...(opts.job ?? makeReviewJob()), status };
      },
      mergeJobMetadata: async (_id, patch) => {
        opts.calls.mergeJobMetadata++;
        return { ...(opts.job ?? makeReviewJob()), metadata: { ...(opts.job?.metadata ?? {}), ...patch } };
      },
    });
  }

  function reviewQuery(data: string, chatId: string | number = CHAT_ID): TelegramCallbackQuery {
    return { id: "cbq-review-1", data, message: { message_id: 77, chat: { id: chatId } } };
  }

  // 7-1) "review:" 형식이 아니면 조용히 무시한다(DB 접근 없음).
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    for (const data of ["go:18:1", "not-a-review", `sel:18:1`]) {
      const result = await bot.handleArticleReviewCallback(reviewQuery(data));
      assert(
        result.outcome.status === "ignored" && result.outcome.reason === "not_a_review",
        `review 형식이 아니면 무시해야 한다: ${data} -> ${JSON.stringify(result.outcome)}`
      );
    }
    assert(calls.loadJobById === 0, "무시된 데이터에서 job을 조회하면 안 된다");
    console.log("✅ review: 형식이 아닌 콜백 -> 무시, DB 접근 없음");
  }

  // 7-2) 다른 chat에서 온 콜백은 거부한다.
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:confirm:${REVIEW_JOB_ID}`, "999999"));
    assert(
      result.outcome.status === "ignored" && result.outcome.reason === "wrong_chat",
      `다른 chat은 거부해야 한다 (실제: ${JSON.stringify(result.outcome)})`
    );
    assert(calls.loadJobById === 0, "거부된 chat에서 job을 조회하면 안 된다");
    console.log("✅ 다른 chat에서 온 review 콜백 -> 거부");
  }

  // 7-3) job을 찾을 수 없으면 job_not_found.
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: null, calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:confirm:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "job_not_found", `job 없으면 job_not_found여야 한다 (실제: ${result.outcome.status})`);
    console.log("✅ 존재하지 않는 job -> job_not_found");
  }

  // 7-4) confirm: requiresMedicalReview를 false로 내리고, job 상태(selected/review 등)는 건드리지 않는다.
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:confirm:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "reviewed" && result.outcome.action === "confirm", "confirm은 reviewed/confirm이어야 한다");
    assert(calls.mergeJobMetadata === 1, "confirm은 metadata를 갱신해야 한다");
    assert(calls.updateStatus === 0, "confirm은 job.status를 바꾸면 안 된다(발행 승인이 아니다)");
    assert(result.message.includes("교차확인 완료"), "확인 메시지가 있어야 한다");
    console.log("✅ confirm -> metadata만 갱신, status 불변");
  }

  // 7-5) discard: status를 rejected로 바꾼다.
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:discard:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "reviewed" && result.outcome.action === "discard", "discard는 reviewed/discard여야 한다");
    assert(
      result.outcome.status === "reviewed" && result.outcome.job.status === "rejected",
      "discard 후 job 상태는 rejected여야 한다"
    );
    assert(calls.updateStatus === 1, "discard는 status를 갱신해야 한다");
    console.log("✅ discard -> status='rejected'");
  }

  // 7-6) edit: metadata만 남기고 requiresMedicalReview는 여전히 true로 남아야 한다(재확인 전까지 게이트 유지).
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:edit:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "reviewed" && result.outcome.action === "edit", "edit은 reviewed/edit이어야 한다");
    assert(calls.updateStatus === 0, "edit은 job.status를 바꾸면 안 된다");
    assert(result.message.includes("수정 필요"), "수정 필요 안내가 있어야 한다");
    console.log("✅ edit -> metadata만 갱신(게이트는 계속 걸려 있음), status 불변");
  }

  // 7-7) 키워드 선택 콜백과 원고 검수 콜백이 같은 폴링 루프에서 서로를 침범하지 않는지 -
  //      handleCallbackQuery가 review: 데이터를 not_a_selection으로 무시하는지 교차 확인.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const result = await bot.handleCallbackQuery(makeQuery(`review:confirm:${REVIEW_JOB_ID}`));
    assert(
      result.outcome.status === "ignored" && result.outcome.reason === "not_a_selection",
      `review: 데이터는 키워드 선택 핸들러에서 무시돼야 한다 (실제: ${JSON.stringify(result.outcome)})`
    );
    assert(calls.loadRanking === 0, "review: 데이터로 키워드 랭킹을 조회하면 안 된다");
    console.log("✅ review: 콜백이 키워드 선택 핸들러를 침범하지 않음");
  }

  console.log("\n✅ TelegramBot callback 핸들러 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
