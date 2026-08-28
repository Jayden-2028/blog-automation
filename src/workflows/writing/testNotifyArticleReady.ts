// notifyArticleReady의 메시지 조립 함수 테스트. 실제 Telegram 발송은 하지 않는다 - 순수 조립
// 함수(buildHeaderMessage/buildArticleBodyMessages/buildReviewDecisionMessage)만 검증한다.
//
// 2026-08-27 실사용에서 발견된 요구사항을 회귀로 고정한다: 처음에는 요약만 보내 "원고를 어떻게
// 확인할 수 있어?"라는 질문을 받았다 - 본문이 실제로 메시지에 포함되는지가 핵심 검증 대상이다.
//
// 2026-08-28 승인 버튼이 모든 원고 공통으로 바뀌었다(SPRINT_3_DESIGN.md 8절) - 예전에는
// requiresMedicalReview일 때만 결정 버튼이 붙었는데 이제는 telegraphUrl이 있으면 항상 붙는다.

import {
  buildArticleBodyMessages,
  buildHeaderMessage,
  buildReviewDecisionMessage,
  buildSourceCountSummary,
} from "./notifyArticleReady.js";
import { TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { RunArticleJobSuccess } from "./notifyArticleReady.js";
import type { ArticleReviewResult } from "../review/runArticleReview.js";
import type { ArticleJobRow, ArticleRow, SourceRow } from "../../types/database.js";

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
    status: "review",
    selected_at: "2026-08-27T00:00:00.000Z",
    selected_via: "telegram",
    metadata: {},
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeArticle(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 3,
    keyword_id: null,
    job_id: "48472dba-9763-4c26-9c31-86b233a04161",
    title: "2026 경복궁 별빛야행 정리",
    content: "가을 저녁 경복궁을 걸으며...\n\n## 일정과 가격\n9월 2일부터...",
    status: "review",
    ai_model: "claude-headless",
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeSource(authority: SourceRow["authority"]): SourceRow {
  return {
    id: 1,
    keyword_id: null,
    job_id: "48472dba-9763-4c26-9c31-86b233a04161",
    title: "출처",
    url: "https://example.com",
    source_name: "naver_web",
    authority,
    published_at: null,
    content: "내용",
    created_at: "2026-08-27T00:00:00.000Z",
  };
}

const PASSED_REVIEW: ArticleReviewResult = { checks: [], errorCount: 0, warningCount: 0, passed: true };

function makeFailedReview(message: string): ArticleReviewResult {
  return {
    checks: [{ category: "quality", severity: "warning", message }],
    errorCount: 0,
    warningCount: 1,
    passed: false,
  };
}

function makeResult(overrides: Partial<RunArticleJobSuccess> = {}): RunArticleJobSuccess {
  return {
    status: "success",
    job: makeJob(),
    article: makeArticle(),
    sources: [makeSource("official"), makeSource("official"), makeSource("community")],
    isMedical: false,
    requiresMedicalReview: false,
    durationMs: 185000,
    telegraphUrl: null,
    review: PASSED_REVIEW,
    ...overrides,
  };
}

function main(): void {
  console.log("▶ notifyArticleReady 메시지 조립 테스트 시작\n");

  // 1) 출처 등급 요약 문자열.
  const summary = buildSourceCountSummary(makeResult());
  assert(summary.includes("공공 2건"), `공공 2건이 요약에 있어야 한다 (실제: ${summary})`);
  assert(summary.includes("커뮤니티 1건"), `커뮤니티 1건이 요약에 있어야 한다 (실제: ${summary})`);
  console.log("✅ 출처 등급 요약 정확");

  // 2) 일반(비의학) 원고: 헤더에 의학 경고는 없어야 한다(telegraphUrl 없으면 버튼도 없다).
  const normalHeader = buildHeaderMessage(makeResult());
  assert(!normalHeader.text.includes("의학 주제"), "일반 원고 헤더에는 의학 경고가 없어야 한다");
  assert(normalHeader.text.includes("원고 초안 준비됨"), "일반 원고 헤더 문구가 있어야 한다");
  assert(!normalHeader.replyMarkup, "telegraphUrl이 없으면 버튼이 없어야 한다(중복 방지, 아래 3-3 참고)");
  console.log("✅ 일반 원고 헤더: 의학 경고 없음, telegraphUrl 없으면 버튼 없음");

  // 2-1) 회귀: 검수 결과가 헤더에 표시돼야 한다(SPRINT_3_DESIGN.md 6절 - 차단은 아니지만 참고로 보여준다).
  const withReviewIssue = buildHeaderMessage(
    makeResult({ review: makeFailedReview("분량 3,304자 (목표 1,500~2,500)") })
  );
  assert(withReviewIssue.text.includes("검수"), "검수 결과 요약이 헤더에 있어야 한다");
  assert(withReviewIssue.text.includes("3,304자"), `검수 상세 메시지가 그대로 노출돼야 한다 (실제 텍스트에 없음)`);
  const withoutReviewIssue = buildHeaderMessage(makeResult({ review: PASSED_REVIEW }));
  assert(withoutReviewIssue.text.includes("검수 통과"), "통과 시 '검수 통과' 문구가 있어야 한다");
  console.log("✅ 검수 결과가 헤더에 표시됨(통과/실패 모두)");

  // 3) 의학 원고 + telegraphUrl 있음: 헤더에 경고 + 버튼 안내가 있어야 한다.
  const medicalHeader = buildHeaderMessage(
    makeResult({ requiresMedicalReview: true, isMedical: true, telegraphUrl: "https://telegra.ph/test-08-27" })
  );
  assert(medicalHeader.text.includes("의학 주제"), "의학 원고 헤더에는 경고가 있어야 한다");
  assert(medicalHeader.text.includes("아래 버튼으로"), "결정 안내가 있어야 한다");
  console.log("✅ 의학 원고 헤더: 경고 + 안내 포함");

  // 3-1) 회귀: telegraphUrl이 있으면 일반 원고에도 승인 버튼이 붙어야 한다(2026-08-28, 공통 승인 흐름).
  // 이전에는 requiresMedicalReview일 때만 붙었다 - 비의학 원고는 "원고 보기" 링크만 가고 승인
  // 기록이 안 남는 게 사용자 질문("원고 퀄리티에 대한 품질 관리는?")으로 드러난 구멍이었다.
  const telegraphHeader = buildHeaderMessage(makeResult({ telegraphUrl: "https://telegra.ph/test-08-27" }));
  assert(!telegraphHeader.text.includes("본문 전문을 대신 보냅니다"), "telegraphUrl이 있으면 폴백 안내 문구가 없어야 한다");
  const telegraphRows = telegraphHeader.replyMarkup?.inline_keyboard ?? [];
  assert(
    telegraphRows.length === 2,
    `일반 원고도 telegraphUrl이 있으면 원고 보기 + 승인 버튼, 2행이어야 한다 (실제: ${telegraphRows.length})`
  );
  assert(
    telegraphRows[0]?.some((b) => "url" in b && b.url === "https://telegra.ph/test-08-27"),
    "원고 보기 버튼의 url이 telegraphUrl과 정확히 일치해야 한다"
  );
  assert(
    telegraphRows[1]?.some((b) => "callback_data" in b && b.callback_data === `review:confirm:${makeJob().id}`),
    "둘째 행에 승인 버튼이 있어야 한다(일반 원고도 공통 승인 흐름)"
  );
  console.log("✅ telegraphUrl 있음(일반 원고) -> 원고 보기 + 승인 버튼 2행(공통 승인 흐름 회귀)");

  // 3-2) telegraphUrl + 의학 주제도 동일하게 2행(버튼 자체는 의학 여부와 무관하게 항상 같은 3개).
  const telegraphMedicalHeader = buildHeaderMessage(
    makeResult({ telegraphUrl: "https://telegra.ph/test-08-27", requiresMedicalReview: true, isMedical: true })
  );
  const telegraphMedicalRows = telegraphMedicalHeader.replyMarkup?.inline_keyboard ?? [];
  assert(telegraphMedicalRows.length === 2, `버튼 행은 2개여야 한다 (실제: ${telegraphMedicalRows.length})`);
  assert(
    telegraphMedicalRows[1]?.length === 3,
    `결정 행에는 승인/수정/반려 3개가 있어야 한다 (실제: ${telegraphMedicalRows[1]?.length})`
  );
  console.log("✅ telegraphUrl + 의학 -> 원고 보기 버튼 + 승인/수정/반려 버튼, 2행");

  // 3-3) telegraphUrl이 null이면(발행 실패 폴백) 헤더에는 버튼을 붙이지 않는다 - 결정 버튼은
  // notifyArticleReady()가 본문 dump 뒤에 buildReviewDecisionMessage()로 별도 발송해야 하며,
  // 헤더에도 붙이면 중복 발송이 된다(2026-08-27 발견 후 수정한 버그의 회귀 방지).
  const fallbackHeader = buildHeaderMessage(makeResult({ telegraphUrl: null }));
  assert(fallbackHeader.text.includes("본문 전문을 대신 보냅니다"), "telegraphUrl이 없으면 폴백 안내 문구가 있어야 한다");
  assert(!fallbackHeader.replyMarkup, "telegraphUrl이 없으면 헤더에는 버튼을 붙이면 안 된다(중복 방지)");
  console.log("✅ telegraphUrl 없음 -> 헤더에는 버튼 없음(중복 결정 버튼 방지, 의학 여부 무관)");

  // 4) 핵심 회귀: 본문이 실제로 메시지에 담겨야 한다("원고를 어떻게 확인해?" 질문의 원인).
  const bodyMessages = buildArticleBodyMessages(makeArticle());
  assert(bodyMessages.length >= 1, "본문 메시지가 최소 1건 있어야 한다");
  assert(bodyMessages[0].text.includes("가을 저녁 경복궁"), "본문 실제 내용이 메시지에 포함돼야 한다");
  assert(bodyMessages[0].text.includes("일정과 가격"), "본문 소제목도 포함돼야 한다");
  console.log("✅ 본문이 실제로 메시지에 포함됨(요약만 보내던 문제 해결 확인)");

  // 5) HTML 특수문자는 이스케이프한다 - parse_mode=HTML에서 그대로 보내면 Telegram이 400을 낸다.
  const withHtmlChars = buildArticleBodyMessages(makeArticle({ content: "A<B> & C" }));
  assert(withHtmlChars[0].text.includes("&lt;B&gt;"), `"<"/">"가 이스케이프돼야 한다 (실제: ${withHtmlChars[0].text})`);
  assert(withHtmlChars[0].text.includes("&amp;"), `"&"가 이스케이프돼야 한다 (실제: ${withHtmlChars[0].text})`);
  console.log("✅ HTML 특수문자 이스케이프(Telegram 400 방지)");

  // 6) 긴 본문은 여러 메시지로 나뉜다(TELEGRAM_MESSAGE_CHAR_LIMIT 초과 시).
  const longContent = "가".repeat(TELEGRAM_MESSAGE_CHAR_LIMIT + 500) + "\n\n마지막 문단";
  const longMessages = buildArticleBodyMessages(makeArticle({ content: longContent }));
  assert(longMessages.length >= 2, `긴 본문은 여러 메시지로 나뉘어야 한다 (실제: ${longMessages.length}건)`);
  assert(
    longMessages.every((m) => m.text.length <= TELEGRAM_MESSAGE_CHAR_LIMIT),
    "각 메시지는 글자 수 제한을 넘으면 안 된다"
  );
  console.log(`✅ 긴 본문 -> ${longMessages.length}개 메시지로 분할, 각각 제한 이내`);

  // 7) content가 null이어도 안전하게 처리한다("(본문 없음)").
  const nullContent = buildArticleBodyMessages(makeArticle({ content: null }));
  assert(nullContent[0].text.includes("본문 없음"), "content가 null이어도 안전한 안내를 보내야 한다");
  console.log("✅ content null -> 안전 처리");

  // 8) 결정 메시지: 버튼 3개(승인/수정 필요/반려)가 정확한 callback_data로 붙어야 한다.
  // 이제 모든 원고 공통이라 이름도 buildReviewDecisionMessage로 바뀌었다(구 buildMedicalDecisionMessage).
  const decision = buildReviewDecisionMessage("48472dba-9763-4c26-9c31-86b233a04161");
  const buttons = decision.replyMarkup?.inline_keyboard[0] ?? [];
  assert(buttons.length === 3, `결정 버튼은 3개여야 한다 (실제: ${buttons.length})`);
  assert(
    buttons.some((b) => "callback_data" in b && b.callback_data === "review:confirm:48472dba-9763-4c26-9c31-86b233a04161"),
    "승인 버튼의 callback_data가 정확해야 한다"
  );
  assert(
    buttons.some((b) => "callback_data" in b && b.callback_data?.startsWith("review:discard:")),
    "반려 버튼이 있어야 한다"
  );
  console.log("✅ 결정 메시지: 승인/수정 필요/반려 버튼 정확히 부착");

  console.log("\n✅ notifyArticleReady 메시지 조립 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
