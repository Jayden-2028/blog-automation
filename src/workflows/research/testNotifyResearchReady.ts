// buildResearchPreviewMessages 테스트. 실제 Telegram 발송/LLM 호출은 하지 않는다.
//
// 2026-08-27 두 번째 실측 피드백을 회귀로 고정한다: 첫 버전은 출처 발췌를 그대로 나열해 링크를
// 일일이 열어봐야 했다("웹페이지 긁어온 형태") - 이제는 summarizeResearchForReview()가 만든 요약이
// 본문이 되고, 요약 실패 시에만 출처 나열로 폴백한다.

import { buildResearchPreviewMessages } from "./notifyResearchReady.js";
import { TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { SummarizeResearchResult } from "./summarizeResearchForReview.js";
import type { ArticleJobRow, SourceRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeJob(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
  return {
    id: "48472dba-9763-4c26-9c31-86b233a04161",
    source_run_id: 18,
    source_rank: 2,
    keyword: "2026 경복궁 별빛야행",
    headline: "2026 경복궁 별빛야행 야간개장",
    seed_query: "경복궁",
    category: "living",
    total_score: 61,
    score_breakdown: null,
    status: "researching",
    selected_at: "2026-08-27T00:00:00.000Z",
    selected_via: "telegram",
    metadata: {},
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1,
    keyword_id: null,
    job_id: "48472dba-9763-4c26-9c31-86b233a04161",
    title: "예매권 추첨 응모 안내",
    url: "https://www.kh.or.kr/x",
    source_name: "naver_web",
    authority: "official",
    published_at: null,
    content: "예매권 추첨 응모 : 2026. 8. 14.(금) 14:00 ~ 8. 20.(목) 14:00, 당첨자 발표 8. 24.(월) 17:00",
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

const okSummary = (summary: string): SummarizeResearchResult => ({ ok: true, summary, durationMs: 5000 });
const failedSummary = (error: string): SummarizeResearchResult => ({ ok: false, error, durationMs: 1000 });

function main(): void {
  console.log("▶ buildResearchPreviewMessages 테스트 시작\n");

  const sources = [
    makeSource({ id: 1, authority: "official" }),
    makeSource({ id: 2, authority: "official" }),
    makeSource({ id: 3, authority: "community" }),
  ];

  // 1) 등급별 건수 요약이 정확해야 한다(헤더는 요약 성공 여부와 무관하게 항상 나온다).
  const messages = buildResearchPreviewMessages(
    makeJob(),
    sources,
    okSummary("- 예매는 2026.08.20 마감됐습니다.")
  );
  const combined = messages.map((m) => m.text).join("\n");
  assert(combined.includes("공공 2"), "공공 2건이 요약에 있어야 한다");
  assert(combined.includes("커뮤니티 1"), "커뮤니티 1건이 요약에 있어야 한다");
  console.log("✅ 등급별 건수 요약 정확");

  // 2) 회귀(2026-08-28 사용자 피드백): 진행/중단 명령어 안내 두 줄을 뺐다. 버튼이 붙기 전에는
  // 유일한 진행 수단이라 필요했지만, 이제 같은 메시지에 버튼이 있어 긴 jobId 줄이 노출될 이유가 없다.
  assert(!combined.includes("job:write --"), "진행 명령어 안내는 더 이상 없어야 한다(버튼으로 대체)");
  assert(!combined.includes("job:reject --"), "중단 명령어 안내는 더 이상 없어야 한다(버튼으로 대체)");
  console.log("✅ 명령어 안내 제거됨(버튼으로 대체)");

  // 3) 핵심 회귀: 요약이 성공하면 AI 요약 본문이 그대로 노출돼야 한다(출처 나열이 아니라).
  const summaryText = "- ⚠️ 예매권 추첨 응모(8/14~8/20)와 당첨자 발표(8/24)가 모두 지났습니다.\n- 도슭수라상 가격은 1인 6만 원입니다.";
  const summaryMessages = buildResearchPreviewMessages(makeJob(), sources, okSummary(summaryText));
  const summaryCombined = summaryMessages.map((m) => m.text).join("\n");
  assert(summaryCombined.includes("당첨자 발표"), "요약 내용이 미리보기에 그대로 포함돼야 한다");
  assert(summaryCombined.includes("⚠️"), "마감 경고 표시가 유지돼야 한다");
  assert(!summaryCombined.includes("[공공]"), "요약이 성공하면 출처 나열 폴백 형식이 섞이면 안 된다");
  console.log("✅ 요약 성공 -> AI 요약 본문이 그대로 노출됨(원문 나열 아님)");

  // 4) 요약 실패 시에만 출처 나열로 폴백해야 한다("웹페이지 긁어온 형태" 문제 재현 방지 확인).
  const fallbackMessages = buildResearchPreviewMessages(
    makeJob(),
    sources,
    failedSummary("claude가 종료 코드 1로 끝났습니다")
  );
  const fallbackCombined = fallbackMessages.map((m) => m.text).join("\n");
  assert(fallbackCombined.includes("요약 생성 실패"), "실패 사유 안내가 있어야 한다");
  assert(fallbackCombined.includes("[공공]"), "요약 실패 시에는 출처 나열로 폴백해야 한다");
  assert(fallbackCombined.includes("예매권 추첨 응모"), "폴백 발췌에도 핵심 정보가 잘리지 않아야 한다");
  console.log("✅ 요약 실패 -> 출처 나열 폴백, 실패 사유 명시");

  // 5) 폴백 발췌는 FALLBACK_EXCERPT_LENGTH를 넘는 원문을 자르고 말줄임표를 붙인다.
  const longContent = "가".repeat(500);
  const longFallback = buildResearchPreviewMessages(
    makeJob(),
    [makeSource({ content: longContent })],
    failedSummary("실패")
  );
  const longCombined = longFallback.map((m) => m.text).join("\n");
  assert(longCombined.includes("…"), "긴 발췌는 말줄임표로 잘려야 한다");
  assert(!longCombined.includes("가".repeat(200)), "발췌가 원문 전체를 담으면 안 된다");
  console.log("✅ 폴백 발췌는 짧게 자름 + 말줄임표");

  // 6) url/content가 없어도(요약 실패 경로) 죽지 않는다.
  const sparse = buildResearchPreviewMessages(
    makeJob(),
    [makeSource({ url: null, content: null, title: null })],
    failedSummary("실패")
  );
  assert(sparse.length > 0, "필드가 비어 있어도 메시지는 만들어져야 한다");
  console.log("✅ 필드 누락에도 안전 처리(폴백 경로)");

  // 7) 요약이 매우 길거나 출처가 많아 4000자를 넘으면 여러 메시지로 나뉜다.
  const manySources = Array.from({ length: 40 }, (_, i) =>
    makeSource({ id: i, title: `출처 제목 ${i}`, content: "내용 ".repeat(30) })
  );
  const manyMessages = buildResearchPreviewMessages(makeJob(), manySources, failedSummary("실패"));
  assert(manyMessages.length >= 2, `출처가 많으면 여러 메시지로 나뉘어야 한다 (실제: ${manyMessages.length}건)`);
  assert(
    manyMessages.every((m) => m.text.length <= TELEGRAM_MESSAGE_CHAR_LIMIT),
    "각 메시지는 글자 수 제한을 넘으면 안 된다"
  );
  console.log(`✅ 출처 40건(요약 실패) -> ${manyMessages.length}개 메시지로 분할, 각각 제한 이내`);

  // 8) 회귀(2026-08-28 사용자 피드백): "진행하려면 npm run job:write --"가 텍스트로만 안내돼
  // 폰에서 터미널로 명령어를 옮겨 쳐야 했다 - 마지막 메시지에 원고 작성/중단 버튼이 붙어야 한다.
  const buttonMessages = buildResearchPreviewMessages(makeJob(), sources, okSummary("- 요약"));
  const lastMessage = buttonMessages[buttonMessages.length - 1];
  const buttonRows = lastMessage.replyMarkup?.inline_keyboard ?? [];
  assert(buttonRows.length === 1 && buttonRows[0].length === 2, `버튼은 한 행에 2개(작성/중단)여야 한다 (실제: ${JSON.stringify(buttonRows)})`);
  assert(
    buttonRows[0].some((b) => "callback_data" in b && b.callback_data === `research:write:${makeJob().id}`),
    "원고 작성 버튼의 callback_data가 정확해야 한다"
  );
  assert(
    buttonRows[0].some((b) => "callback_data" in b && b.callback_data === `research:reject:${makeJob().id}`),
    "중단 버튼의 callback_data가 정확해야 한다"
  );
  console.log("✅ 마지막 메시지에 원고 작성/중단 버튼 부착(callback_data 정확)");

  // 9) 다른 메시지들(마지막이 아닌)에는 버튼이 없어야 한다 - Telegram은 메시지당 버튼 세트가 하나다.
  const earlierMessages = buttonMessages.slice(0, -1);
  assert(
    earlierMessages.every((m) => !m.replyMarkup),
    "마지막이 아닌 메시지에는 버튼이 없어야 한다"
  );
  console.log("✅ 마지막 메시지에만 버튼 부착");

  console.log("\n✅ buildResearchPreviewMessages 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
