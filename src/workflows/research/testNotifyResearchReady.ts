// buildResearchPreviewMessages 테스트. 실제 Telegram 발송/파일 읽기는 하지 않는다.
//
// 2026-09-01: summary는 이제 research/[키워드].md를 파싱한 ResearchSummary(또는 파일 읽기 실패 시
// null)다. summary가 있으면 그 텍스트가 본문, null이면 sources 발췌로 폴백한다.
// verdict === "blocked"면 [✍️ 원고 작성] 버튼을 빼고 [🗑 중단]만 남긴다.

import { buildResearchPreviewMessages } from "./notifyResearchReady.js";
import { TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { ResearchSummary } from "./summarizeResearchForReview.js";
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

const summary = (text: string, verdict: ResearchSummary["verdict"] = "ok"): ResearchSummary => ({ verdict, text });

function main(): void {
  console.log("▶ buildResearchPreviewMessages 테스트 시작\n");

  const sources = [
    makeSource({ id: 1, authority: "official" }),
    makeSource({ id: 2, authority: "official" }),
    makeSource({ id: 3, authority: "community" }),
  ];

  // 1) 헤더의 등급별 건수 요약은 항상 나온다.
  const messages = buildResearchPreviewMessages(makeJob(), sources, summary("예매는 2026.08.20 마감됐습니다."));
  const combined = messages.map((m) => m.text).join("\n");
  assert(combined.includes("공공 2"), "공공 2건이 헤더에 있어야 한다");
  assert(combined.includes("커뮤니티 1"), "커뮤니티 1건이 헤더에 있어야 한다");
  console.log("✅ 등급별 건수 요약 정확");

  // 2) 진행/중단 명령어 안내 텍스트는 없다(버튼으로 대체).
  assert(!combined.includes("job:write --"), "진행 명령어 안내 없음");
  assert(!combined.includes("job:reject --"), "중단 명령어 안내 없음");
  console.log("✅ 명령어 안내 제거됨(버튼으로 대체)");

  // 3) summary가 있으면 그 텍스트가 그대로 본문에 노출된다(출처 나열 아님).
  const summaryText = "⚠️ 예매권 추첨 응모(8/14~8/20)와 당첨자 발표(8/24)가 모두 지났습니다.\n- 도슭수라상 가격은 1인 6만 원입니다.";
  const summaryCombined = buildResearchPreviewMessages(makeJob(), sources, summary(summaryText))
    .map((m) => m.text)
    .join("\n");
  assert(summaryCombined.includes("당첨자 발표"), "요약 내용이 미리보기에 그대로 포함돼야 한다");
  assert(summaryCombined.includes("⚠️"), "마감 경고 표시가 유지돼야 한다");
  assert(!summaryCombined.includes("[공공]"), "요약이 있으면 출처 나열 폴백 형식이 섞이면 안 된다");
  console.log("✅ summary 있음 -> 요약 본문 그대로 노출");

  // 4) summary === null이면 출처 나열로 폴백한다.
  const fallbackCombined = buildResearchPreviewMessages(makeJob(), sources, null)
    .map((m) => m.text)
    .join("\n");
  assert(fallbackCombined.includes("요약 파일을 읽지 못"), "폴백 안내 문구가 있어야 한다");
  assert(fallbackCombined.includes("[공공]"), "null이면 출처 나열로 폴백해야 한다");
  assert(fallbackCombined.includes("예매권 추첨 응모"), "폴백 발췌에도 핵심 정보가 잘리지 않아야 한다");
  console.log("✅ summary null -> 출처 나열 폴백");

  // 5) 폴백 발췌는 원문이 길면 자르고 말줄임표를 붙인다.
  const longFallback = buildResearchPreviewMessages(makeJob(), [makeSource({ content: "가".repeat(500) })], null)
    .map((m) => m.text)
    .join("\n");
  assert(longFallback.includes("…"), "긴 발췌는 말줄임표로 잘려야 한다");
  assert(!longFallback.includes("가".repeat(200)), "발췌가 원문 전체를 담으면 안 된다");
  console.log("✅ 폴백 발췌는 짧게 자름 + 말줄임표");

  // 6) 필드가 비어도 폴백 경로가 죽지 않는다.
  const sparse = buildResearchPreviewMessages(makeJob(), [makeSource({ url: null, content: null, title: null })], null);
  assert(sparse.length > 0, "필드가 비어 있어도 메시지는 만들어져야 한다");
  console.log("✅ 필드 누락에도 안전 처리(폴백 경로)");

  // 7) 폴백 출처가 많으면 여러 메시지로 나뉜다.
  const manySources = Array.from({ length: 40 }, (_, i) =>
    makeSource({ id: i, title: `출처 제목 ${i}`, content: "내용 ".repeat(30) })
  );
  const manyMessages = buildResearchPreviewMessages(makeJob(), manySources, null);
  assert(manyMessages.length >= 2, `출처가 많으면 여러 메시지로 나뉘어야 한다 (실제: ${manyMessages.length}건)`);
  assert(
    manyMessages.every((m) => m.text.length <= TELEGRAM_MESSAGE_CHAR_LIMIT),
    "각 메시지는 글자 수 제한을 넘으면 안 된다"
  );
  console.log(`✅ 출처 40건(폴백) -> ${manyMessages.length}개 메시지로 분할, 각각 제한 이내`);

  // 8) 마지막 메시지에 [✍️ 원고 작성][🗑 중단] 버튼(callback_data 정확).
  const buttonMessages = buildResearchPreviewMessages(makeJob(), sources, summary("요약"));
  const lastRows = buttonMessages[buttonMessages.length - 1].replyMarkup?.inline_keyboard ?? [];
  assert(lastRows.length === 1 && lastRows[0].length === 2, `버튼은 한 행에 2개여야 한다 (실제: ${JSON.stringify(lastRows)})`);
  assert(
    lastRows[0].some((b) => "callback_data" in b && b.callback_data === `research:write:${makeJob().id}`),
    "원고 작성 버튼 callback_data"
  );
  assert(
    lastRows[0].some((b) => "callback_data" in b && b.callback_data === `research:reject:${makeJob().id}`),
    "중단 버튼 callback_data"
  );
  console.log("✅ 마지막 메시지에 원고 작성/중단 버튼 부착");

  // 9) 마지막이 아닌 메시지에는 버튼이 없다.
  assert(
    buttonMessages.slice(0, -1).every((m) => !m.replyMarkup),
    "마지막이 아닌 메시지에는 버튼이 없어야 한다"
  );
  console.log("✅ 마지막 메시지에만 버튼 부착");

  // 10) verdict === "blocked"면 원고 작성 버튼을 빼고 중단만 남긴다.
  const blockedRows =
    buildResearchPreviewMessages(makeJob(), sources, summary("근거 부족", "blocked"))
      .slice(-1)[0].replyMarkup?.inline_keyboard ?? [];
  assert(blockedRows.length === 1 && blockedRows[0].length === 1, `blocked면 버튼 1개(중단)만 (실제: ${JSON.stringify(blockedRows)})`);
  assert(
    blockedRows[0][0] && "callback_data" in blockedRows[0][0] && blockedRows[0][0].callback_data === `research:reject:${makeJob().id}`,
    "blocked면 남는 버튼은 중단"
  );
  console.log("✅ verdict blocked -> 중단 버튼만");

  // 11) 추천 제목(job.metadata.titleSuggestions)이 있으면 노출, 없으면 생략.
  const withTitles = buildResearchPreviewMessages(
    makeJob({ metadata: { titleSuggestions: ["제목 하나", "제목 둘"] } }),
    sources,
    summary("요약")
  )
    .map((m) => m.text)
    .join("\n");
  assert(withTitles.includes("추천 제목") && withTitles.includes("제목 하나"), "저장된 제목이 노출돼야 한다");
  const noTitles = buildResearchPreviewMessages(makeJob({ metadata: {} }), sources, summary("요약"))
    .map((m) => m.text)
    .join("\n");
  assert(!noTitles.includes("추천 제목"), "제목이 없으면 블록도 없어야 한다");
  console.log("✅ 추천 제목: metadata에 있으면 노출, 없으면 생략");

  console.log("\n✅ buildResearchPreviewMessages 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
