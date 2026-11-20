// 엔터·국제 봇 주제 직접 입력 테스트(2026-11-21). DB·텔레그램 없이 전부 주입한다.
import { parseKeywordSelectionCallbackData, parsePersonGoCallbackData } from "../../notifications/telegramCallbackData.js";
import { parseArticleReviewCallbackData } from "../../notifications/articleReviewCallbackData.js";
import { parsePublishDecisionCallbackData } from "../../notifications/publishDecisionCallbackData.js";
import { parseResearchDecisionCallbackData } from "../../notifications/researchDecisionCallbackData.js";
import { inputJobFields } from "../instagram-capture/inputJobFields.js";
import { handleTopicMessage, handleTopicPick, parseTopicPickCallbackData, topicJobFields, topicPickCallbackData, PICK_KEYBOARD } from "./topicIntake.js";
import type { TopicBot, TopicIntakeDeps } from "./topicIntake.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const CHAT = "555";

type Harness = {
  deps: TopicIntakeDeps;
  created: ReturnType<typeof topicJobFields>[];
  prompts: Array<{ text: string; replyTo: number | null }>;
  replies: string[];
  edits: string[];
  researched: string[];
};

function harness(bot: TopicBot): Harness {
  const h: Harness = { created: [], prompts: [], replies: [], edits: [], researched: [], deps: undefined as never };
  h.deps = {
    bot,
    allowedChatId: CHAT,
    createJob: async (fields) => {
      h.created.push(fields);
      return { id: `job-${h.created.length}` };
    },
    findByMessageId: async (b, id) => {
      const idx = h.created.findIndex((f) => f.metadata.topicInputBot === b && f.metadata.topicInputMessageId === id);
      return idx >= 0 ? { id: `job-${idx + 1}` } : null;
    },
    triggerResearch: async (jobId) => void h.researched.push(jobId),
    sendPrompt: async (text, replyTo) => void h.prompts.push({ text, replyTo }),
    reply: async (text) => void h.replies.push(text),
    editPromptMessage: async (_c, _m, text) => void h.edits.push(text),
  };
  return h;
}

const plain = { message: { message_id: 42, chat: { id: Number(CHAT) }, text: "한효주 필모그래피 정리" } };
const pick = (kind: "ent" | "person", extra: Record<string, unknown> = {}) => ({
  callback_query: {
    data: topicPickCallbackData(kind),
    message: {
      message_id: 43,
      chat: { id: Number(CHAT) },
      reply_to_message: { message_id: 42, text: "한효주 필모그래피 정리" },
      ...extra,
    },
  },
});

// 1) callback_data: 64바이트 이내, 기존 파서와 겹치지 않는다
for (const kind of ["ent", "person"] as const) {
  const data = topicPickCallbackData(kind);
  assert(Buffer.byteLength(data) <= 64, "callback_data 64바이트 이내");
  assert(parseTopicPickCallbackData(data) === kind, "왕복");
  assert(!parseKeywordSelectionCallbackData(data) && !parsePersonGoCallbackData(data), "키워드·인물 Go 파서와 겹치지 않음");
  assert(!parseArticleReviewCallbackData(data) && !parsePublishDecisionCallbackData(data) && !parseResearchDecisionCallbackData(data), "검수·발행·조사 파서와 겹치지 않음");
}
assert(parseTopicPickCallbackData("go:1:2") === null && parseTopicPickCallbackData("tpick:x") === null && parseTopicPickCallbackData(undefined) === null, "남의 데이터는 null");
assert(PICK_KEYBOARD.inline_keyboard[0].map((b) => b.text).join() === "엔터,인물", "버튼 = 엔터·인물");
console.log("✅ callback_data 형식·충돌 없음");

// 2) job 필드: 변환기와 같은 규칙
const entFields = topicJobFields({ text: "한효주 필모그래피 정리", track: "entertainment", messageId: 42, bot: "entertainment" });
const entConv = inputJobFields({ userTopic: "한효주 필모그래피 정리", track: "entertainment" });
assert(entFields.keyword === entConv.keyword && entFields.category === entConv.category, "엔터: 변환기와 keyword·category 동일");
assert(entFields.metadata.source === "keyword_input" && entFields.metadata.track === undefined && entFields.category === null, "엔터: source=keyword_input, metadata.track 없음(엔터 기본, 변환기와 같다)");
assert(entFields.metadata.topicInputMessageId === 42 && entFields.metadata.topicInputBot === "entertainment", "원 메시지 번호 보관");
const personFields = topicJobFields({ text: "한효주", track: "person", messageId: 42, bot: "entertainment" });
assert(personFields.category === "person" && personFields.metadata.track === undefined, "인물: category=person, metadata.track 없음(변환기와 같다)");
const globalFields = topicJobFields({ text: "Why Koreans eat seaweed soup on birthdays 미역국", track: "global", messageId: 7, bot: "kscene" });
assert(globalFields.category === "kscene" && globalFields.metadata.track === "kscene", "국제: category=kscene, track=kscene");
const longText = `첫 줄 주제\n${"본문 ".repeat(200)}`;
const longFields = topicJobFields({ text: longText, track: "entertainment", messageId: null, bot: "entertainment" });
assert(longFields.keyword === "첫 줄 주제" && typeof longFields.metadata.sourceText === "string" && !("topicInputMessageId" in longFields.metadata), "긴 글: 첫 줄=주제, 전체=소스 본문");
console.log("✅ job 필드 = 변환기 규칙");

// 3) 엔터 봇 글자 메시지 -> 질문만(job 없음)
{
  const h = harness("entertainment");
  const out = await handleTopicMessage(plain, h.deps);
  assert(out.handled && out.status === "asked" && h.created.length === 0 && h.researched.length === 0, "질문만 보내고 job·조사 없음");
  assert(h.prompts[0].text === "📝 주제를 받았습니다: 한효주 필모그래피 정리\n어느 원고로 만들까요?" && h.prompts[0].replyTo === 42, "질문 문구·원 메시지에 답장");
  assert(!(await handleTopicMessage({ message: { ...plain.message, reply_to_message: { message_id: 1 } } }, h.deps)).handled, "답장은 통과");
  assert(!(await handleTopicMessage({ message: { ...plain.message, text: "/start" } }, h.deps)).handled, "명령은 통과");
  assert(!(await handleTopicMessage({ message: { ...plain.message, chat: { id: 1 } } }, h.deps)).handled, "다른 채팅은 통과");
  assert(!(await handleTopicMessage({ callback_query: { data: "x" } } as never, h.deps)).handled, "callback은 통과");
  assert(h.prompts.length === 1, "통과한 것들은 질문을 보내지 않는다");
}
console.log("✅ 엔터 봇: 글자 -> 질문(job 없음), 답장·명령·타 채팅 통과");

// 4) 버튼: 엔터 / 인물 / 더블 탭
for (const kind of ["ent", "person"] as const) {
  const h = harness("entertainment");
  const out = await handleTopicPick(pick(kind), h.deps);
  assert(out.handled && out.status === "created" && h.created.length === 1 && h.researched.join() === "job-1", `${kind}: job 1건 + 조사 1회`);
  assert(h.created[0].category === (kind === "person" ? "person" : null), `${kind}: category`);
  assert(h.edits[0].startsWith(`✅ ${kind === "ent" ? "엔터" : "인물"} 원고로 발주했습니다`), `${kind}: 메시지 편집`);
  const again = await handleTopicPick(pick(kind), h.deps);
  assert(again.handled && again.status === "duplicate" && h.created.length === 1 && h.researched.length === 1, `${kind}: 더블 탭은 job·조사를 또 만들지 않는다`);
  const other = await handleTopicPick(pick(kind === "ent" ? "person" : "ent"), h.deps);
  assert(other.handled && other.status === "duplicate" && h.created.length === 1, "다른 버튼을 또 눌러도 하나");
}
{
  const h = harness("entertainment");
  assert((await handleTopicPick({ callback_query: { data: "go:1:2", message: { message_id: 1, chat: { id: 555 } } } }, h.deps)).handled === false, "남의 버튼은 통과");
  const wrongChat = await handleTopicPick(pick("ent", { chat: { id: 1 } }), h.deps);
  assert(wrongChat.handled && wrongChat.status === "ignored" && h.created.length === 0, "다른 채팅 버튼은 무시");
  const lost = await handleTopicPick({ callback_query: { data: "tpick:ent", message: { message_id: 43, chat: { id: 555 } } } }, h.deps);
  assert(lost.handled && lost.status === "ignored" && h.created.length === 0 && h.edits[0].includes("다시 보내"), "원문을 잃으면 만들지 않고 안내");
  const failing = harness("entertainment");
  failing.deps.triggerResearch = async () => { throw new Error("dispatch down"); };
  const out = await handleTopicPick(pick("ent"), failing.deps);
  assert(out.handled && out.status === "created" && failing.created.length === 1, "조사 발화가 실패해도 job은 남고 예외는 새지 않는다");
}
console.log("✅ 버튼: 엔터·인물 생성, 더블 탭 중복 없음, 타 채팅·원문 유실 처리");

// 5) 국제 봇: 즉시 발주
{
  const h = harness("kscene");
  const out = await handleTopicMessage({ message: { message_id: 9, chat: { id: 555 }, text: "미역국 생일" } }, h.deps);
  assert(out.handled && out.status === "created" && h.created.length === 1 && h.researched.join() === "job-1", "국제: 즉시 job + 조사");
  assert(h.created[0].category === "kscene" && h.created[0].metadata.track === "kscene", "국제 job 모양");
  assert(h.replies[0] === "📝 접수했습니다: 미역국 생일\n국제(Korea Plain) 원고로 발주했습니다.", "국제 접수 답장");
  const dup = await handleTopicMessage({ message: { message_id: 9, chat: { id: 555 }, text: "미역국 생일" } }, h.deps);
  assert(dup.handled && dup.status === "duplicate" && h.created.length === 1 && h.researched.length === 1, "같은 메시지 재배달은 중복 없음");
  assert(!(await handleTopicMessage({ message: { message_id: 10, chat: { id: 555 }, text: "x", reply_to_message: { message_id: 1 } } }, h.deps)).handled, "국제 봇 답장은 통과");
  assert(h.prompts.length === 0, "국제 봇은 버튼을 묻지 않는다");
}
console.log("✅ 국제 봇: 글자 -> 즉시 발주, 중복 없음");

console.log("\n✅ testTopicIntake 전체 통과");
