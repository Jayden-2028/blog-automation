// 통합 알림 버튼(✏️ 수정 요청 / 🗑 반려) 콜백 테스트(PIPELINE-MERGE-2026-10.md §1-b, §7). 실행: npm run test:pipeline-merge-callbacks
// 실제 Telegram·Supabase를 부르지 않는다 - TelegramBot 주입 지점으로 대체한다.
import { TelegramBot } from "./TelegramBot.js";
import type { TelegramCallbackQuery, TelegramUpdate } from "./TelegramBot.js";
import type { ArticleJobRow } from "../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const CHAT_ID = "123456";
const JOB_ID = "054bfe0b-5cf7-4386-941f-810146c25e12";

function makeJob(overrides: Partial<ArticleJobRow> = {}, metadata: Record<string, unknown> = {}): ArticleJobRow {
  return {
    id: JOB_ID, source_run_id: 1, source_rank: 1, keyword: "통합 알림 키워드", headline: null, seed_query: null,
    category: "entertainment", total_score: 50, score_breakdown: null, status: "approved",
    selected_at: "x", selected_via: "telegram", created_at: "x", updated_at: "x",
    metadata: { autoApprovedAt: "2026-10-08T00:00:00Z", channelManuscriptsReadyAt: "2026-10-08T00:10:00Z", ...metadata },
    ...overrides,
  } as ArticleJobRow;
}

type State = {
  job: ArticleJobRow;
  statusUpdates: string[];
  patches: Record<string, unknown>[];
  manifestRemoved: string[];
  refreshTriggers: number;
  telegram: { method: string; body: Record<string, unknown> }[];
  revisions: { jobId: string; feedback: string }[];
};

function makeBot(job: ArticleJobRow, opts: { publishHistory?: boolean; manifestFails?: boolean } = {}): { bot: TelegramBot; state: State } {
  const state: State = { job, statusUpdates: [], patches: [], manifestRemoved: [], refreshTriggers: 0, telegram: [], revisions: [] };
  const bot = new TelegramBot({
    botToken: "test-token",
    chatId: CHAT_ID,
    loadJobById: async () => state.job,
    updateJobStatus: async (_id, status) => {
      state.statusUpdates.push(status);
      state.job = { ...state.job, status };
      return state.job;
    },
    mergeJobMetadata: async (_id, patch) => {
      state.patches.push(patch);
      state.job = { ...state.job, metadata: { ...state.job.metadata, ...patch } };
      return state.job;
    },
    hasPublishHistory: async () => opts.publishHistory === true,
    removeManifestTopic: async (id) => {
      if (opts.manifestFails) throw new Error("db down");
      state.manifestRemoved.push(id);
    },
    triggerManuscriptsRefresh: () => void (state.refreshTriggers += 1),
    triggerRevision: (jobId, feedback) => void state.revisions.push({ jobId, feedback }),
    findJobByEditRequestMessageId: async (messageId) => (messageId === 9001 ? state.job : null),
    sendTelegramRequest: async (method, body) => {
      state.telegram.push({ method, body: body as Record<string, unknown> });
      return method === "sendMessage" ? ({ message_id: 9001 } as never) : null;
    },
  });
  return { bot, state };
}

// 릴레이(Cloudflare Worker)가 누른 순간 키보드를 "⏳ 처리 중…" 하나로 덮어쓴 상태를 재현한다.
const LOCKED = { inline_keyboard: [[{ text: "⏳ 처리 중…", callback_data: "noop" }]] };
function reviewUpdate(action: "edit" | "discard"): TelegramUpdate {
  const query: TelegramCallbackQuery = {
    id: "cbq-1",
    data: `review:${action}:${JOB_ID}`,
    message: { message_id: 77, chat: { id: CHAT_ID }, reply_markup: LOCKED },
  } as never;
  return { update_id: 1, callback_query: query } as TelegramUpdate;
}
const lastKeyboard = (state: State) => {
  const edits = state.telegram.filter((c) => c.method === "editMessageReplyMarkup");
  return (edits[edits.length - 1]?.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard;
};

// 1) 🗑 반려: rejected + 반려 시각 기록 + 뷰어 manifest 제외 + 페이지 재배포 발화 + 키보드는 "반려됨" 한 개로 닫는다.
{
  const { bot, state } = makeBot(makeJob());
  const out = await bot.processUpdate(reviewUpdate("discard"));
  assert(out.reviewResult?.outcome.status === "reviewed", "반려 처리됨");
  assert(state.statusUpdates.join() === "rejected", "job.status = rejected");
  const patch = state.patches.find((p) => "rejectedAt" in p);
  assert(patch && typeof patch.rejectedAt === "string" && patch.rejectedVia === "telegram-review" && patch.rejectedAtStatus === "approved", "storage-cleanup이 셀 반려 시각과 경로를 남긴다");
  assert(state.manifestRemoved.join() === JOB_ID, "뷰어 manifest에서 제외");
  assert(state.refreshTriggers === 1, "뷰어 페이지 재배포 발화");
  const kb = lastKeyboard(state);
  assert(kb?.length === 1 && kb[0].length === 1 && kb[0][0].text.includes("반려됨") && kb[0][0].callback_data === "noop", "키보드는 '반려됨' 한 버튼으로 닫힌다(발행 버튼이 남지 않는다)");
  console.log("✅ 🗑 반려 - rejected + rejectedAt + manifest 제외 + 재배포 발화 + 키보드 닫기");
}

// 2) 준비 전(channelManuscriptsReadyAt 없음) 반려: 제외는 하되 페이지 재배포는 불필요.
{
  const { bot, state } = makeBot(makeJob({}, { channelManuscriptsReadyAt: null }));
  await bot.processUpdate(reviewUpdate("discard"));
  assert(state.statusUpdates.join() === "rejected" && state.manifestRemoved.length === 1 && state.refreshTriggers === 0, "준비 전 반려는 재배포를 발화하지 않는다");
  console.log("✅ 준비 전 반려 - 재배포 없음");
}

// 3) 이미 발행됐거나 발행 중이면 반려를 받지 않는다 + 눌려서 잠긴 키보드는 원래대로 되살린다.
{
  const { bot, state } = makeBot(makeJob(), { publishHistory: true });
  const out = await bot.processUpdate(reviewUpdate("discard"));
  assert(out.reviewResult?.outcome.status === "blocked", "발행 이력이 있으면 blocked");
  assert(state.statusUpdates.length === 0 && state.manifestRemoved.length === 0, "상태·manifest를 건드리지 않는다");
  const all = (lastKeyboard(state) ?? []).flat();
  assert(all.some((b) => b.callback_data === `publish:naver:${JOB_ID}`) && all.some((b) => b.callback_data === `review:discard:${JOB_ID}`), "잠긴 키보드를 발행·수정·반려 버튼으로 복원");
  console.log("✅ 발행 이력 있는 원고 반려 거부 + 키보드 복원");
}

// 4) manifest 삭제가 실패해도 반려는 유효하고, 사람에게 알린다.
{
  const { bot, state } = makeBot(makeJob(), { manifestFails: true });
  const out = await bot.processUpdate(reviewUpdate("discard"));
  assert(out.reviewResult?.outcome.status === "reviewed" && state.statusUpdates.join() === "rejected", "반려는 유효");
  assert(out.reviewResult?.message.includes("원고 페이지에서 바로 빠지지 않았을 수"), "페이지 제외 실패를 알린다");
  console.log("✅ manifest 삭제 실패 - 반려 유효 + 경고");
}

// 5) ✏️ 수정 요청: 답장 요청 메시지를 보내고 id를 저장, 키보드는 발행 버튼을 포함해 전체 복원 + 수정 요청 표시.
{
  const { bot, state } = makeBot(makeJob());
  const out = await bot.processUpdate(reviewUpdate("edit"));
  assert(out.reviewResult?.outcome.status === "reviewed", "수정 요청 처리됨");
  assert(state.statusUpdates.length === 0, "수정 요청은 상태를 바꾸지 않는다(approved 유지)");
  const patch = state.patches.find((p) => "editRequestMessageId" in p);
  assert(patch?.editRequestMessageId === 9001 && patch.reviewDecision === "needs_edit", "답장 매칭용 메시지 id 저장");
  const all = (lastKeyboard(state) ?? []).flat();
  assert(all.some((b) => b.callback_data === `publish:naver:${JOB_ID}`), "잠금 뒤에도 발행 버튼이 살아 있어야 한다(이게 없으면 수정 요청 뒤 발행 불가)");
  assert(all.some((b) => b.text.includes("수정 요청됨")), "수정 요청 표시");
  console.log("✅ ✏️ 수정 요청 - 답장 대기 + 발행 버튼 포함 키보드 복원");

  // 그 메시지에 답장 -> job-revise 트리거(트랙 구분 매칭: 봇이 자기 트랙 job만 찾는다).
  const reply = await bot.handleEditFeedbackMessage({
    message_id: 90, chat: { id: Number(CHAT_ID) }, reply_to_message: { message_id: 9001 }, text: "첫 문단을 줄여줘",
  } as never);
  assert(reply.outcome.status === "accepted" && state.revisions.length === 1 && state.revisions[0].feedback === "첫 문단을 줄여줘", "답장이 job:revise로 이어진다");
  const none = await bot.handleEditFeedbackMessage({
    message_id: 91, chat: { id: Number(CHAT_ID) }, reply_to_message: { message_id: 1234 }, text: "무관",
  } as never);
  assert(none.outcome.status === "ignored", "관계없는 답장은 무시");
  console.log("✅ ✏️ 답장 -> 수정 반영 트리거, 무관한 답장 무시");
}

// 6) 반려된 원고의 오래된 ✏️ 버튼과 발행 버튼은 받지 않는다.
{
  const { bot } = makeBot(makeJob({ status: "rejected" }));
  const edit = await bot.handleArticleReviewCallback({ id: "c", data: `review:edit:${JOB_ID}`, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert(edit.outcome.status === "blocked" && edit.message.includes("반려된 원고"), "반려된 원고에 수정 요청을 받지 않는다");
  const pub = await bot.handlePublishDecisionCallback({ id: "c", data: `publish:naver:${JOB_ID}`, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert(pub.outcome.status === "job_rejected", "반려된 원고는 발행 콜백도 거부");
  const images = await bot.handlePublishDecisionCallback({ id: "c", data: `publish:images:${JOB_ID}`, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert(images.outcome.status !== "job_rejected", "이미지 수정/내려받기는 발행이 아니므로 이 가드의 대상이 아니다");
  console.log("✅ 반려된 원고 - 수정 요청·발행 콜백 거부");
}

// 7) 옛 초안 흐름은 그대로: review 상태 job의 ✅ 승인은 approved로 가고 prepare를 발화한다(공존).
{
  let prepared = 0;
  const legacyJob = makeJob({ status: "review" }, { autoApprovedAt: null, channelManuscriptsReadyAt: null });
  const state = { job: legacyJob };
  const bot = new TelegramBot({
    botToken: "t", chatId: CHAT_ID,
    loadJobById: async () => state.job,
    updateJobStatus: async (_id, status) => ((state.job = { ...state.job, status }), state.job),
    mergeJobMetadata: async (_id, patch) => ((state.job = { ...state.job, metadata: { ...state.job.metadata, ...patch } }), state.job),
    findLatestArticleByJobId: async () => null,
    triggerPublishPrepare: () => void (prepared += 1),
    sendTelegramRequest: async () => null,
  });
  const out = await bot.handleArticleReviewCallback({ id: "c", data: `review:confirm:${JOB_ID}`, message: { message_id: 1, chat: { id: CHAT_ID } } } as never);
  assert(out.outcome.status === "reviewed" && state.job.status === "approved" && prepared === 1, "게이트 false 시절 흐름(✅ -> approved -> prepare)이 그대로 동작");
  console.log("✅ 공존 - 옛 초안 ✅ 승인 흐름 불변");
}
console.log("\n✅ testPipelineMergeCallbacks 전체 통과");
