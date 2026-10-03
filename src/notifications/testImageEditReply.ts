// 텔레그램 "🖼 이미지 수정" 답장 처리 테스트(2026-10-03). 실행: npm run test:image-edit-reply
//
// testTelegramBot.ts에도 같은 영역이 있지만 그 파일은 앞쪽의 DB 의존 테스트에서 멈춰 여기까지
// 오지 못한다(로컬·클라우드 세션). 실측 사고를 고정하는 테스트라 따로 돌게 둔다.
import { TelegramBot } from "./TelegramBot.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const CHAT_ID = "123456";
const JOB = "6517c3ce-abde-45dd-9218-1f8cd1b1d865";
// 대구 북구 원고와 같은 모양: 6자리 중 1·2·4만 찼다.
const IMAGES = [1, 2, 4].map((index) => ({
  index,
  description: `자리 ${index}`,
  prompt: null,
  url: `https://img/${index}.png`,
  provider: "web",
  fileName: `0${index}.png`,
}));
const BODY = Array.from(
  { length: 6 },
  (_, i) => `문단 ${i + 1}.\n\n[IMAGE: 자리 ${i + 1} — 웹 검색]\n[IMAGE PROMPT: 검색어 ${i + 1}]`
).join("\n\n");

function makeBot(over: Record<string, unknown> = {}) {
  const state: { patches: Record<string, unknown>[]; prepared: number; rewritten: string[] } = {
    patches: [],
    prepared: 0,
    rewritten: [],
  };
  const bot = new TelegramBot({
    botToken: "test-token",
    chatId: CHAT_ID,
    findJobByImageEditRequestMessageId: async () =>
      ({ id: JOB, keyword: "대구 북구 수해 복구 현장 구청 직원 업혀 이동 논란", status: "approved", metadata: { images: IMAGES } }) as never,
    loadArticlesByJobId: async () => [{ id: 1, platform: null, content: BODY }] as never,
    updateArticleContent: async (_id: number, content: string) => {
      state.rewritten.push(content);
    },
    mergeJobMetadata: (async (_id: string, patch: Record<string, unknown>) => {
      state.patches.push(patch);
      return null;
    }) as never,
    sendTelegramRequest: (async () => null) as never,
    triggerPublishPrepare: () => {
      state.prepared += 1;
    },
    ...over,
  } as never);
  return { bot, state };
}

const reply = (text: string) =>
  ({ chat: { id: Number(CHAT_ID) }, message_id: 70, reply_to_message: { message_id: 55 }, text }) as never;

async function main(): Promise<void> {
  console.log("▶ 이미지 수정 답장 처리 테스트 시작\n");

  // 1) 빈 자리 번호도 받는다. 전에는 상한이 "채워진 이미지 수(3)"라 5번이 조용히 버려졌다.
  for (const text of ["3번 AI생성해주세요.\n5번 AI생성해주세요", "3번 주민 항의 장면 AI로 생성하세요, 5번 업혀가는 공무원 AI로 생성하세요"]) {
    const { bot, state } = makeBot();
    const out = await bot.handleImageEditReply(reply(text));
    assert(out.outcome.status === "accepted", "처리돼야 한다");
    const patch = state.patches.find((p) => "imageRequirements" in p) as { imageRequirements: Record<string, string> } | undefined;
    const req = patch?.imageRequirements ?? {};
    assert(req["3"] && req["5"], `3번과 5번을 둘 다 받아야 한다 (${JSON.stringify(req)} ← "${text}")`);
    assert(out.message.includes("3번") && out.message.includes("5번"), "되읽기에 둘 다 있어야 한다");
    // 마커도 둘 다 AI 생성으로 바뀐다.
    const body = state.rewritten.at(-1) ?? "";
    assert(/자리 3 — AI 생성/.test(body) && /자리 5 — AI 생성/.test(body), "두 자리 마커를 AI 생성으로 바꿔야 한다");
  }
  console.log("✅ 6자리 중 3자리만 찬 원고 - 빈 자리 5번 요청도 받는다(두 가지 문장 형태)");

  // 2) 원고를 못 읽어도 막히지 않는다(넉넉한 상한으로 받는다).
  {
    const { bot, state } = makeBot({
      loadArticlesByJobId: async () => {
        throw new Error("DB 끊김");
      },
    });
    await bot.handleImageEditReply(reply("6번 다시 찾아주세요"));
    const patch = state.patches.find((p) => "images" in p);
    assert(patch, "원고를 못 읽어도 요청은 처리해야 한다");
    console.log("✅ 원고를 못 읽어도 요청 처리");
  }

  console.log("\n✅ 이미지 수정 답장 처리 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
