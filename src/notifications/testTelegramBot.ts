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

import { jobFromFreshSelection, TelegramBot } from "./TelegramBot.js";
import { isTransientNetworkError } from "./isTransientNetworkError.js";
import type { ArticleJobRow, ArticleRow, KeywordRankingRow } from "../types/database.js";
import type { TelegramCallbackQuery, TelegramUpdate } from "./TelegramBot.js";

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
  //    자동 흐름(2026-08-31): 추천 제목은 확인 메시지가 아니라 조사 완료 알림에서 보여준다.
  //    확인 메시지는 "자료조사 시작"만 알린다(자료조사 자체는 pollOnce가 이어서 돌린다).
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "created", `정상 선택은 created여야 한다 (실제: ${result.outcome.status})`);
    assert(calls.create === 1, `job 생성은 1회여야 한다 (실제: ${calls.create})`);
    assert(calls.titles === 1, `제목 생성은 1회여야 한다 (실제: ${calls.titles})`);
    assert(calls.saveTitles === 1, "생성된 제목을 metadata에 저장해야 한다");
    assert(result.message.includes("자료조사"), "확인 메시지에 자료조사 시작 안내가 들어가야 한다");
    assert(result.message.includes("양준모"), "확인 메시지에 선택한 키워드가 들어가야 한다");
    console.log("✅ 정상 선택 -> job 생성 + 제목 3개 + 자료조사 시작 안내");
  }

  // 4-1) jobFromFreshSelection: 자료조사 자동 시작 대상 판정.
  {
    const job = makeJob({ status: "selected" });
    assert(jobFromFreshSelection({ status: "created", job }) === job, "created는 자료조사 대상이다");
    assert(
      jobFromFreshSelection({ status: "changed", job, from: "rejected" }) === job,
      "rejected -> selected 복구는 자료조사 대상이다"
    );
    assert(
      jobFromFreshSelection({ status: "changed", job: makeJob({ status: "rejected" }), from: "selected" }) === null,
      "Go -> Pass 전환은 자료조사 대상이 아니다"
    );
    assert(jobFromFreshSelection({ status: "passed", job }) === null, "Pass는 자료조사 대상이 아니다");
    assert(jobFromFreshSelection({ status: "unchanged", job }) === null, "중복 클릭은 자료조사 대상이 아니다");
    assert(jobFromFreshSelection({ status: "locked", job }) === null, "locked는 자료조사 대상이 아니다");
    console.log("✅ jobFromFreshSelection -> created/복구만 자료조사 시작");
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
    assert(result.message.length > 0, "Pass로 되돌리려는 시도는 '되돌릴 수 없다'고 알려야 한다");
    console.log("✅ 진행 중(writing) job + Pass -> locked + 안내 메시지");
  }

  // 5-4) 선택 직후 Go 중복 탭(researching)은 조용히 넘긴다 - "변경할 수 없습니다"가 노이즈다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), created: false, existingStatus: "researching", calls });
    const result = await bot.handleCallbackQuery(makeQuery(`go:${RUN_ID}:${RANK}`));
    assert(result.outcome.status === "locked", `진행 중 job은 locked여야 한다 (실제: ${result.outcome.status})`);
    assert(result.message === "", `Go 중복 탭은 메시지를 보내지 않아야 한다 (실제: "${result.message}")`);
    assert(calls.updateStatus === 0, "상태를 바꾸면 안 된다");
    console.log("✅ 진행 중(researching) job + Go 중복 탭 -> locked + 무음");
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

  type ReviewCalls = {
    loadJobById: number;
    updateStatus: number;
    mergeJobMetadata: number;
    findLatestArticle: number;
    updateArticleStatus: number;
  };
  function newReviewCalls(): ReviewCalls {
    return {
      loadJobById: 0,
      updateStatus: 0,
      mergeJobMetadata: 0,
      findLatestArticle: 0,
      updateArticleStatus: 0,
    };
  }

  function makeReviewJob(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
    return makeJob({ id: REVIEW_JOB_ID, category: "parenting", metadata: { requiresMedicalReview: true }, ...overrides });
  }

  const REVIEW_ARTICLE_ID = 42;

  function makeReviewBot(opts: { job: ArticleJobRow | null; calls: ReviewCalls; article?: ArticleRow | null }): TelegramBot {
    const article: ArticleRow | null =
      opts.article !== undefined
        ? opts.article
        : {
            id: REVIEW_ARTICLE_ID,
            keyword_id: null,
            job_id: REVIEW_JOB_ID,
            title: "제목",
            content: "본문",
            status: "review",
            ai_model: "claude-headless",
            platform: null,
            created_at: "2026-08-28T00:00:00.000Z",
            updated_at: "2026-08-28T00:00:00.000Z",
          };

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
      findLatestArticleByJobId: async () => {
        opts.calls.findLatestArticle++;
        return article;
      },
      updateArticleStatus: async (_id, status) => {
        opts.calls.updateArticleStatus++;
        return article ? { ...article, status } : null;
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

  // 7-4) confirm: 이제 모든 원고 공통 승인이다(SPRINT_3_DESIGN.md 8절, 2026-08-28) - job.status와
  // 최신 article.status를 approved로 바꾸고, 의학 주제였으면 requiresMedicalReview도 함께 내린다.
  // ⚠️ 통합 전에는 confirm이 metadata만 갱신하고 status는 건드리지 않았다 - 의미가 바뀐 지점이다.
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:confirm:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "reviewed" && result.outcome.action === "confirm", "confirm은 reviewed/confirm이어야 한다");
    assert(calls.mergeJobMetadata === 1, "confirm은 metadata를 갱신해야 한다(requiresMedicalReview 등)");
    assert(calls.updateStatus === 1, "confirm은 job.status를 approved로 바꿔야 한다(이제 이게 발행 승인이다)");
    assert(calls.findLatestArticle === 1, "confirm은 최신 article을 찾아야 한다");
    assert(calls.updateArticleStatus === 1, "confirm은 article.status도 approved로 바꿔야 한다");
    assert(result.message.includes("승인됨"), "승인 메시지가 있어야 한다");
    assert(result.message.includes("교차확인도 함께 완료"), "의학 주제면 교차확인 완료 안내도 함께 있어야 한다");
    console.log("✅ confirm(의학) -> job/article 모두 approved + 교차확인 완료 안내");
  }

  // 7-4b) confirm: 비의학 원고도 동일하게 승인된다(공통 승인 흐름의 핵심) - 의학 전용 안내 문구는 없다.
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob({ metadata: { requiresMedicalReview: false } }), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:confirm:${REVIEW_JOB_ID}`));
    assert(calls.updateStatus === 1, "비의학 원고도 confirm 시 job.status가 approved로 바뀌어야 한다");
    assert(calls.updateArticleStatus === 1, "비의학 원고도 article.status가 approved로 바뀌어야 한다");
    assert(!result.message.includes("교차확인"), "비의학 원고 승인 메시지에는 교차확인 문구가 없어야 한다");
    console.log("✅ confirm(비의학) -> 동일하게 approved, 의학 전용 문구 없음");
  }

  // 7-5) discard: status를 rejected로 바꾼다. article 상태는 건드리지 않는다(반려된 원고는 애초에
  // 발행 대상이 아니므로 article.status를 approved 경로와 대칭으로 바꿀 필요가 없다).
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
    assert(calls.updateArticleStatus === 0, "discard는 article.status를 바꾸지 않는다");
    assert(result.message.includes("반려됨"), "반려 문구여야 한다(구 '폐기됨'에서 변경)");
    console.log("✅ discard -> status='rejected', article은 불변, '반려됨' 문구");
  }

  // 7-6) edit: metadata만 남기고 requiresMedicalReview는 여전히 true로 남아야 한다(재확인 전까지
  // 게이트 유지). job.status도 approved로 넘어가지 않는다(승인 아님).
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:edit:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "reviewed" && result.outcome.action === "edit", "edit은 reviewed/edit이어야 한다");
    assert(calls.updateStatus === 0, "edit은 job.status를 바꾸면 안 된다");
    assert(calls.updateArticleStatus === 0, "edit은 article.status를 바꾸면 안 된다");
    assert(result.message.includes("수정 필요"), "수정 필요 안내가 있어야 한다");
    console.log("✅ edit -> metadata만 갱신(게이트는 계속 걸려 있음), status 불변");
  }

  // 7-6b) confirm인데 원고가 아예 없으면(예외적 상황) article 갱신 없이 job만 approved로 바뀐다 -
  // 죽지 않고 넘어가야 한다(findLatestArticleByJobId가 null을 돌려주는 경우).
  {
    const calls = newReviewCalls();
    const bot = makeReviewBot({ job: makeReviewJob(), calls, article: null });
    const result = await bot.handleArticleReviewCallback(reviewQuery(`review:confirm:${REVIEW_JOB_ID}`));
    assert(result.outcome.status === "reviewed", "article이 없어도 confirm 자체는 성공해야 한다");
    assert(calls.updateStatus === 1, "article이 없어도 job.status는 approved로 바뀌어야 한다");
    assert(calls.updateArticleStatus === 0, "article이 없으면 article.status 갱신을 시도하면 안 된다");
    console.log("✅ confirm(article 없음) -> job만 approved, 예외 없이 안전 처리");
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

  // ---------- 8) 자료조사 체크포인트(handleResearchDecisionCallback) ----------
  // SPRINT_2_DESIGN.md 13-3절 ①, 2026-08-28 추가. write는 review의 confirm/edit/discard와 달리
  // 실제로 무거운 작업(triggerWriting)을 호출하므로, 그 호출이 몇 번 일어났는지가 핵심 검증 대상이다.

  const RESEARCH_JOB_ID = "0d35cd81-94e6-49b9-b6d2-4917b548f971";

  type ResearchCalls = { loadJobById: number; triggerWriting: number; rejectJob: number; onWriteStart: number };
  function newResearchCalls(): ResearchCalls {
    return { loadJobById: 0, triggerWriting: 0, rejectJob: 0, onWriteStart: 0 };
  }

  function makeResearchJob(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
    return makeJob({ id: RESEARCH_JOB_ID, status: "researching", ...overrides });
  }

  function makeResearchBot(opts: { job: ArticleJobRow | null; calls: ResearchCalls }): TelegramBot {
    return new TelegramBot({
      botToken: "test-token",
      chatId: CHAT_ID,
      loadJobById: async () => {
        opts.calls.loadJobById++;
        return opts.job;
      },
      updateJobStatus: async (_id, status) => ({ ...(opts.job ?? makeResearchJob()), status }),
      triggerWriting: () => {
        opts.calls.triggerWriting++;
      },
      onWriteStart: async () => {
        opts.calls.onWriteStart++;
      },
      rejectJob: async (_jobId, _reason) => {
        opts.calls.rejectJob++;
        return { status: "rejected", job: { ...(opts.job ?? makeResearchJob()), status: "rejected" } };
      },
    });
  }

  function researchQuery(data: string, chatId: string | number = CHAT_ID): TelegramCallbackQuery {
    return { id: "cbq-research-1", data, message: { message_id: 88, chat: { id: chatId } } };
  }

  // 8-1) "research:" 형식이 아니면 조용히 무시한다(DB 접근 없음).
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: makeResearchJob(), calls });
    for (const data of ["go:18:1", "review:confirm:x", "not-a-research"]) {
      const result = await bot.handleResearchDecisionCallback(researchQuery(data));
      assert(
        result.outcome.status === "ignored" && result.outcome.reason === "not_a_research_decision",
        `research: 형식이 아니면 무시해야 한다: ${data} -> ${JSON.stringify(result.outcome)}`
      );
    }
    assert(calls.loadJobById === 0, "무시된 데이터에서 job을 조회하면 안 된다");
    console.log("✅ research: 형식이 아닌 콜백 -> 무시, DB 접근 없음");
  }

  // 8-2) 다른 chat에서 온 콜백은 거부한다.
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: makeResearchJob(), calls });
    const result = await bot.handleResearchDecisionCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`, "999999"));
    assert(
      result.outcome.status === "ignored" && result.outcome.reason === "wrong_chat",
      `다른 chat은 거부해야 한다 (실제: ${JSON.stringify(result.outcome)})`
    );
    assert(calls.loadJobById === 0, "거부된 chat에서 job을 조회하면 안 된다");
    console.log("✅ 다른 chat에서 온 research 콜백 -> 거부");
  }

  // 8-3) job을 찾을 수 없으면 job_not_found.
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: null, calls });
    const result = await bot.handleResearchDecisionCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(result.outcome.status === "job_not_found", `job 없으면 job_not_found여야 한다 (실제: ${result.outcome.status})`);
    console.log("✅ 존재하지 않는 job -> job_not_found");
  }

  // 8-4) 이미 조사 체크포인트를 벗어난 job(예: 이미 review까지 간 경우)은 write/reject 둘 다
  //      다시 실행하지 않는다 - 중복 클릭이나 CLI로 이미 처리된 뒤 눌린 버튼을 안전하게 막는다.
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: makeResearchJob({ status: "review" }), calls });
    const writeResult = await bot.handleResearchDecisionCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(writeResult.outcome.status === "already_final", `이미 review면 already_final이어야 한다 (실제: ${writeResult.outcome.status})`);
    assert(calls.triggerWriting === 0, "체크포인트를 벗어난 job에서 triggerWriting을 호출하면 안 된다");

    const rejectResult = await bot.handleResearchDecisionCallback(researchQuery(`research:reject:${RESEARCH_JOB_ID}`));
    assert(rejectResult.outcome.status === "already_final", `이미 review면 already_final이어야 한다 (실제: ${rejectResult.outcome.status})`);
    assert(calls.rejectJob === 0, "체크포인트를 벗어난 job에서 rejectJob을 호출하면 안 된다");
    console.log("✅ 체크포인트를 벗어난 job -> write/reject 모두 already_final, 재실행 없음");
  }

  // 8-5) reject: rejectJob을 호출하고 중단 메시지를 보낸다.
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: makeResearchJob(), calls });
    const result = await bot.handleResearchDecisionCallback(researchQuery(`research:reject:${RESEARCH_JOB_ID}`));
    assert(result.outcome.status === "rejected", `reject는 rejected여야 한다 (실제: ${result.outcome.status})`);
    assert(calls.rejectJob === 1, "reject는 rejectJob을 1회 호출해야 한다");
    assert(calls.triggerWriting === 0, "reject에서 원고 작성을 호출하면 안 된다");
    assert(result.message.includes("중단"), "중단 메시지가 있어야 한다");
    console.log("✅ reject -> rejectJob 호출, 중단 메시지");
  }

  // 8-6) write: 즉시 확인(onWriteStart) + 집필을 detached로 띄운다(triggerWriting). 완료·실패
  //      알림은 detached CLI가 직접 보내므로 핸들러는 빈 메시지를 돌린다.
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: makeResearchJob(), calls });
    const result = await bot.handleResearchDecisionCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(result.outcome.status === "write_started", `write는 write_started여야 한다 (실제: ${result.outcome.status})`);
    assert(calls.onWriteStart === 1, "write는 집필 띄우기 전 onWriteStart(즉시 확인)를 1회 호출해야 한다");
    assert(calls.triggerWriting === 1, "write는 triggerWriting(detached 띄우기)을 1회 호출해야 한다");
    assert(result.message === "", "핸들러는 빈 메시지 - 완료/실패 알림은 detached CLI가 보낸다");
    console.log("✅ write -> onWriteStart(즉시 확인) + triggerWriting(detached), 핸들러 메시지 없음");
  }

  // 8-6a) reject·중복 write: reject는 onWriteStart를 부르지 않고, 이미 writing인 job의 write 재클릭은
  //       집필을 다시 띄우지 않고 "이미 작성 중"만 안내한다(아직 정상 범위 - updated_at을 방금으로
  //       둬서 재시도 버튼(8-7 참고)이 안 붙는 경로를 확인한다).
  {
    const calls = newResearchCalls();
    const bot = makeResearchBot({ job: makeResearchJob(), calls });
    await bot.handleResearchDecisionCallback(researchQuery(`research:reject:${RESEARCH_JOB_ID}`));
    assert(calls.onWriteStart === 0 && calls.triggerWriting === 0, "reject는 집필 관련 호출을 하지 않아야 한다");
    const bot2 = makeResearchBot({
      job: makeResearchJob({ status: "writing", updated_at: new Date().toISOString() }),
      calls,
    });
    const dup = await bot2.handleResearchDecisionCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(dup.outcome.status === "already_final", "이미 writing인 job의 write 재클릭은 already_final");
    assert(calls.onWriteStart === 0 && calls.triggerWriting === 0, "중복 write 클릭은 집필을 다시 띄우지 않아야 한다");
    assert(dup.message.includes("이미 원고를 작성 중"), "중복 클릭에는 '이미 작성 중' 안내가 나가야 한다");
    assert(dup.replyMarkup === undefined, "아직 멈춘 게 아니면 재시도 버튼을 붙이지 않아야 한다");
    console.log("✅ reject·중복 write -> 집필 미호출, 중복 클릭에 '작성 중' 안내(재시도 버튼 없음)");
  }

  // 8-7) writing에 오래(임계값 이상) 멈춘 job은 write 재클릭에 재시도 버튼을 함께 준다 - 실패해도
  //      status가 writing에서 안 풀리는 설계(runArticleJob.ts) 때문에 버튼 없이는 텔레그램에서
  //      영원히 복구할 방법이 없었다(2026-09-01 실사고 대응).
  {
    const calls = newResearchCalls();
    const staleUpdatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40분 전
    const bot = makeResearchBot({ job: makeResearchJob({ status: "writing", updated_at: staleUpdatedAt }), calls });
    const stuck = await bot.handleResearchDecisionCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(stuck.outcome.status === "already_final", "멈춘 job의 write 재클릭도 already_final(집필을 또 띄우지 않는다)");
    assert(calls.triggerWriting === 0, "재클릭만으로는 집필을 다시 띄우지 않는다 - retry 버튼을 눌러야 한다");
    assert(stuck.message.includes("응답이 없습니다"), "멈춘 job에는 별도 안내 문구가 나가야 한다");
    assert(stuck.replyMarkup?.[0]?.[0]?.callback_data === `research:retry:${RESEARCH_JOB_ID}`, "재시도 버튼이 붙어야 한다");
    console.log("✅ 오래 멈춘 writing job -> '응답 없음' 안내 + 재시도 버튼");
  }

  // 8-8) research:retry - 멈춘 job만 재시도를 허용하고, 아직 정상 범위거나 이미 다른 상태로
  //      넘어간 job은 거부한다(경합/오클릭 방어).
  {
    const calls = newResearchCalls();
    const staleUpdatedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const bot = makeResearchBot({ job: makeResearchJob({ status: "writing", updated_at: staleUpdatedAt }), calls });
    const retried = await bot.handleResearchDecisionCallback(researchQuery(`research:retry:${RESEARCH_JOB_ID}`));
    assert(retried.outcome.status === "retry_started", `멈춘 job의 retry는 retry_started여야 한다 (실제: ${retried.outcome.status})`);
    assert(calls.triggerWriting === 1, "retry는 triggerWriting(detached 재실행)을 1회 호출해야 한다");
    assert(retried.message.includes("다시 시작"), "재시작 확인 메시지가 나가야 한다");
    console.log("✅ research:retry -> 멈춘 job만 triggerWriting 재실행");

    const calls2 = newResearchCalls();
    const freshBot = makeResearchBot({
      job: makeResearchJob({ status: "writing", updated_at: new Date().toISOString() }),
      calls: calls2,
    });
    const rejected = await freshBot.handleResearchDecisionCallback(researchQuery(`research:retry:${RESEARCH_JOB_ID}`));
    assert(rejected.outcome.status === "retry_rejected", "아직 임계값 전인 job의 retry는 거부해야 한다");
    assert(calls2.triggerWriting === 0, "거부된 retry는 집필을 띄우면 안 된다");
    console.log("✅ research:retry -> 아직 진행 중일 수 있는 job은 거부");

    const calls3 = newResearchCalls();
    const doneBot = makeResearchBot({ job: makeResearchJob({ status: "review" }), calls: calls3 });
    const alreadyMoved = await doneBot.handleResearchDecisionCallback(researchQuery(`research:retry:${RESEARCH_JOB_ID}`));
    assert(alreadyMoved.outcome.status === "retry_rejected", "writing이 아닌 job의 retry는 거부해야 한다");
    assert(calls3.triggerWriting === 0, "이미 다른 상태로 넘어간 job은 재실행하지 않아야 한다");
    console.log("✅ research:retry -> writing이 아닌 job(이미 진행됨)은 거부");
  }

  // 8-9) research: 콜백이 키워드 선택/원고 검수 핸들러를 침범하지 않는다.
  {
    const calls = newCalls();
    const bot = makeBot({ ranking: makeRanking(), calls });
    const selectionResult = await bot.handleCallbackQuery(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(
      selectionResult.outcome.status === "ignored" && selectionResult.outcome.reason === "not_a_selection",
      `research: 데이터는 키워드 선택 핸들러에서 무시돼야 한다 (실제: ${JSON.stringify(selectionResult.outcome)})`
    );

    const reviewCalls = newReviewCalls();
    const reviewBot = makeReviewBot({ job: makeReviewJob(), calls: reviewCalls });
    const reviewResult = await reviewBot.handleArticleReviewCallback(researchQuery(`research:write:${RESEARCH_JOB_ID}`));
    assert(
      reviewResult.outcome.status === "ignored" && reviewResult.outcome.reason === "not_a_review",
      `research: 데이터는 원고 검수 핸들러에서 무시돼야 한다 (실제: ${JSON.stringify(reviewResult.outcome)})`
    );
    console.log("✅ research: 콜백이 키워드 선택/원고 검수 핸들러를 침범하지 않음");
  }

  // ---------- 9) isTransientNetworkError: 인프라 장애 판정 ----------
  {
    const supabaseNetworkError = Object.assign(new Error("TypeError: fetch failed"), {
      details:
        "TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND exbhtdearvxjorwqlqno.supabase.co (ENOTFOUND)",
    });
    assert(isTransientNetworkError(supabaseNetworkError), "Supabase 스타일 DNS 실패는 인프라 장애로 판정해야 한다");
    assert(isTransientNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:5432")), "ECONNREFUSED는 인프라 장애다");
    assert(!isTransientNetworkError(new Error("null value violates not-null constraint")), "일반 DB 제약 위반은 인프라 장애가 아니다");
    assert(!isTransientNetworkError(new Error("job not found")), "일반 로직 에러는 인프라 장애가 아니다");
    console.log("✅ isTransientNetworkError -> 네트워크/DNS만 인프라 장애로 판정");
  }

  // ---------- 10) pollOnce: offset 전진 안전성(인프라 장애 시 유실 방지) ----------
  // 2026-09-02 실측 버그: Supabase DNS 장애 중 GO 클릭 3건이 "실패해도 offset은 전진시킨다"는
  // 설계 때문에 영구 유실됐다. 인프라 장애는 offset을 전진시키지 않아 다음 폴링에서 텔레그램이
  // 그대로 다시 배달하게 해야 하고, 코드/데이터 문제는 재시도해도 똑같이 실패하니 건너뛰어야 한다.
  {
    function makeUpdate(updateId: number, rank: number): TelegramUpdate {
      return { update_id: updateId, callback_query: makeQuery(`go:${RUN_ID}:${rank}`) };
    }

    function makePollOnceBot(opts: {
      updates: TelegramUpdate[];
      storedOffset: number | null;
      failRank: number;
      failError: unknown;
    }): { bot: TelegramBot; advancedTo: number[] } {
      const advancedTo: number[] = [];
      const bot = new TelegramBot({
        botToken: "test-token",
        chatId: CHAT_ID,
        fetchUpdates: async () => opts.updates,
        getStoredOffset: async () => opts.storedOffset,
        advanceStoredOffset: async (updateId) => {
          advancedTo.push(updateId);
          return null;
        },
        loadRanking: async (_runId, rank) => ({ ...makeRanking(), rank }),
        createJob: async (ranking, status) => {
          if (ranking.rank === opts.failRank) throw opts.failError;
          return { job: makeJob({ status }), created: true };
        },
        saveTitles: async () => {},
        generateTitles: async () => [],
        triggerResearch: () => {},
        sendTelegramRequest: async () => null,
      });
      return { bot, advancedTo };
    }

    // 10-1) 인프라 장애(DNS 등)로 실패한 update는 offset을 전진시키지 않는다 - 재시도 대상으로 남는다.
    {
      const updates = [makeUpdate(101, 1), makeUpdate(102, 2), makeUpdate(103, 3)];
      const networkError = Object.assign(new Error("TypeError: fetch failed"), {
        details: "Caused by: Error: getaddrinfo ENOTFOUND exbhtdearvxjorwqlqno.supabase.co (ENOTFOUND)",
      });
      const { bot, advancedTo } = makePollOnceBot({ updates, storedOffset: 100, failRank: 2, failError: networkError });
      const result = await bot.pollOnce();
      assert(result.errors.length === 1, `실패 1건이 기록돼야 한다 (실제: ${result.errors.length})`);
      assert(result.results.length === 1, `102 이후는 처리를 멈춰야 한다 (실제 처리: ${result.results.length}건)`);
      assert(
        advancedTo.length === 1 && advancedTo[0] === 101,
        `offset은 마지막 성공(101)까지만 전진해야 한다 (실제: ${JSON.stringify(advancedTo)})`
      );
      console.log("✅ 인프라 장애 update -> offset 미전진(재시도 대상으로 남음), 이후 update 중단");
    }

    // 10-2) 코드/데이터 문제로 실패한 update는 건너뛰고 offset을 전진시킨다 - 영원히 막히면 안 된다.
    {
      const updates = [makeUpdate(201, 1), makeUpdate(202, 2), makeUpdate(203, 3)];
      const { bot, advancedTo } = makePollOnceBot({
        updates,
        storedOffset: 200,
        failRank: 2,
        failError: new Error("제약 조건 위반"),
      });
      const result = await bot.pollOnce();
      assert(result.errors.length === 1, `실패 1건이 기록돼야 한다 (실제: ${result.errors.length})`);
      assert(result.results.length === 2, `202를 건너뛰고 203까지 처리해야 한다 (실제: ${result.results.length}건)`);
      assert(
        advancedTo.length === 1 && advancedTo[0] === 203,
        `offset은 마지막(203)까지 전진해야 한다 (실제: ${JSON.stringify(advancedTo)})`
      );
      console.log("✅ 코드/데이터 문제 update -> 건너뛰고 offset 전진, 이후 update 계속 처리");
    }
  }

  console.log("\n✅ TelegramBot callback 핸들러 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
