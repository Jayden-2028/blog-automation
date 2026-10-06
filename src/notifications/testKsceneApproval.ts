// 사용설명서 트랙 2단계 승인 테스트(개편3) - DB·Telegram·GitHub 없음(전부 주입).
//   한글 ✅ -> 영어본 생성 트리거(승인 아님) / 영어본 ✅ -> 최종 승인 / 영어본 수정 요청 -> 재번역 / 다른 트랙은 그대로.
import { TelegramBot } from "./TelegramBot.js";
import type { TelegramCallbackQuery, TelegramMessage } from "./TelegramBot.js";
import type { ArticleJobRow } from "../types/database.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

const CHAT_ID = "4242";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

const makeJob = (metadata: Record<string, unknown>, status: ArticleJobRow["status"] = "review"): ArticleJobRow =>
  ({ id: JOB_ID, keyword: "how to use t money card in korea", status, category: "kscene", metadata }) as ArticleJobRow;

function setup(job: ArticleJobRow) {
  const calls = {
    translation: [] as Array<{ jobId: string; feedback?: string }>,
    revision: [] as string[],
    prepare: 0,
    status: [] as string[],
    merges: [] as Record<string, unknown>[],
    articleStatus: [] as string[],
    sent: [] as string[],
  };
  const bot = new TelegramBot({
    botToken: "t",
    chatId: CHAT_ID,
    loadJobById: async () => job,
    updateJobStatus: async (_id, status) => {
      calls.status.push(status);
      return { ...job, status };
    },
    mergeJobMetadata: async (_id, patch) => {
      calls.merges.push(patch);
      return null;
    },
    findLatestArticleByJobId: async () => ({ id: 9, status: "review" }) as never,
    updateArticleStatus: async (_id, status) => {
      calls.articleStatus.push(status);
      return null;
    },
    triggerPublishPrepare: () => {
      calls.prepare += 1;
    },
    triggerTranslation: (jobId, feedback) => {
      calls.translation.push({ jobId, feedback });
    },
    triggerRevision: (jobId) => {
      calls.revision.push(jobId);
    },
    findJobByEditRequestMessageId: async () => job,
    sendTelegramRequest: async (method, body) => {
      if (method === "sendMessage") {
        calls.sent.push(String(body.text));
        return { message_id: 7001 } as never;
      }
      return null;
    },
  });
  return { bot, calls };
}

const query = (action: "confirm" | "edit" | "discard"): TelegramCallbackQuery => ({
  id: "cbq",
  data: `review:${action}:${JOB_ID}`,
  message: { message_id: 55, chat: { id: Number(CHAT_ID) } },
});

const reply = (text: string): TelegramMessage => ({ chat: { id: Number(CHAT_ID) }, message_id: 60, reply_to_message: { message_id: 7001 }, text }) as TelegramMessage;

async function main(): Promise<void> {
  // 1) 한글 ✅ -> 번역 트리거, 승인 아님
  {
    const { bot, calls } = setup(makeJob({ track: "kscene" }));
    const result = await bot.handleArticleReviewCallback(query("confirm"));
    assert(result.outcome.status === "reviewed" && result.outcome.action === "confirm", "한글 ✅는 reviewed");
    assert(calls.translation.length === 1 && calls.translation[0].jobId === JOB_ID && calls.translation[0].feedback === undefined, "영어본 생성 트리거 1회");
    assert(calls.status.length === 0 && calls.articleStatus.length === 0 && calls.prepare === 0, "한글 승인으로 job·article을 approved로 만들거나 이미지 준비를 띄우면 안 된다");
    const merge = calls.merges[0];
    assert(merge.ksceneStage === "translating" && typeof merge.koreanApprovedAt === "string" && typeof merge.translateStartedAt === "string", "translating·한글 승인 시각 기록");
    assert(result.message.includes("한글 원고 승인됨") && result.message.includes("영어본"), "안내 문구");
    console.log("✅ 한글 ✅ -> 영어본 생성 트리거(승인·이미지 준비 없음)");
  }

  // 2) 번역 중 재클릭 -> 막는다 / 오래된 translating -> 다시 시작 / 실패 후 재시도 -> 시작
  {
    const fresh = setup(makeJob({ track: "kscene", ksceneStage: "translating", translateStartedAt: new Date().toISOString() }));
    const r1 = await fresh.bot.handleArticleReviewCallback(query("confirm"));
    assert(r1.outcome.status === "already_reviewed" && fresh.calls.translation.length === 0 && fresh.calls.merges.length === 0, "번역 중 재클릭은 중복 실행하지 않는다");

    const stale = setup(makeJob({ track: "kscene", ksceneStage: "translating", translateStartedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString() }));
    await stale.bot.handleArticleReviewCallback(query("confirm"));
    assert(stale.calls.translation.length === 1, "25분 넘게 번역 중이면 죽은 것으로 보고 다시 시작");

    const failed = setup(makeJob({ track: "kscene", ksceneStage: "translation_failed", koreanApprovedAt: "2026-10-07T00:00:00Z" }));
    await failed.bot.handleArticleReviewCallback(query("confirm"));
    assert(failed.calls.translation.length === 1 && failed.calls.merges[0].koreanApprovedAt === "2026-10-07T00:00:00Z", "실패 후 '다시 만들기'는 재시작하고 최초 한글 승인 시각을 보존");
    console.log("✅ 번역 중 재클릭 방지 / 정체 복구 / 실패 후 재시도");
  }

  // 3) 영어본 ✅ -> 최종 승인
  {
    const { bot, calls } = setup(makeJob({ track: "kscene", ksceneStage: "english_review" }));
    const result = await bot.handleArticleReviewCallback(query("confirm"));
    assert(result.outcome.status === "reviewed" && calls.status.join() === "approved" && calls.articleStatus.join() === "approved" && calls.prepare === 1, "영어본 ✅는 job·최신 article(영어본)을 approved로 하고 이미지 준비를 띄운다");
    assert(calls.translation.length === 0, "다시 번역하지 않는다");
    assert(typeof calls.merges[0].englishApprovedAt === "string", "영어본 승인 시각 기록");
    assert(result.message.includes("영어본 승인됨") && result.message.includes("Blogger"), "영어본 승인 안내");
    console.log("✅ 영어본 ✅ -> 최종 승인 + 이미지·발행 준비");
  }

  // 4) 수정 요청 답장: 영어본 단계는 재번역, 한글 단계는 기존 재작성
  {
    const english = setup(makeJob({ track: "kscene", ksceneStage: "english_review", editRequestMessageId: 7001 }));
    const out = await english.bot.handleEditFeedbackMessage(reply("Make the intro shorter"));
    assert(out.outcome.status === "accepted" && english.calls.translation[0]?.feedback === "Make the intro shorter" && english.calls.revision.length === 0, "영어본 수정 요청은 한글을 다시 쓰지 않고 영어본만 재번역");
    assert(out.message.includes("영어본 수정 반영 중"), "안내 문구");

    const korean = setup(makeJob({ track: "kscene", editRequestMessageId: 7001 }));
    await korean.bot.handleEditFeedbackMessage(reply("제목을 바꿔주세요"));
    assert(korean.calls.revision.length === 1 && korean.calls.translation.length === 0, "한글 검수 단계 수정 요청은 기존 재작성");
    console.log("✅ 수정 요청 - 영어본은 재번역 / 한글은 재작성");
  }

  // 5) 다른 트랙은 그대로(엔터·사회는 한 번에 승인)
  {
    for (const metadata of [{}, { track: "social" }]) {
      const { bot, calls } = setup(makeJob(metadata));
      const result = await bot.handleArticleReviewCallback(query("confirm"));
      assert(result.outcome.status === "reviewed" && calls.status.join() === "approved" && calls.translation.length === 0 && calls.prepare === 1, `${JSON.stringify(metadata)}: 한 번에 승인`);
      assert(result.message.includes("승인됨") && !result.message.includes("영어본"), "기존 문구");
    }
    console.log("✅ 엔터·사회 트랙 승인 흐름 불변");
  }

  // 6) 반려는 어느 단계든 그대로
  {
    const { bot, calls } = setup(makeJob({ track: "kscene", ksceneStage: "english_review" }));
    const result = await bot.handleArticleReviewCallback(query("discard"));
    assert(result.outcome.status === "reviewed" && calls.status.join() === "rejected" && calls.translation.length === 0, "영어본 단계 반려");
    console.log("✅ 반려는 영어본 단계에서도 동작");
  }

  console.log("\n✅ testKsceneApproval 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
