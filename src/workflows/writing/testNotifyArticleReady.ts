// notifyArticleReady의 메시지 조립 함수 테스트. 실제 Telegram 발송은 하지 않는다 - 순수 조립
// 함수(buildHeaderMessage/buildArticleBodyMessages/buildMedicalDecisionMessage)만 검증한다.
//
// 2026-08-27 실사용에서 발견된 요구사항을 회귀로 고정한다: 처음에는 요약만 보내 "원고를 어떻게
// 확인할 수 있어?"라는 질문을 받았다 - 본문이 실제로 메시지에 포함되는지가 핵심 검증 대상이다.

import {
  buildArticleBodyMessages,
  buildHeaderMessage,
  buildMedicalDecisionMessage,
  buildSourceCountSummary,
} from "./notifyArticleReady.js";
import { TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { RunArticleJobSuccess } from "./notifyArticleReady.js";
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

function makeResult(overrides: Partial<RunArticleJobSuccess> = {}): RunArticleJobSuccess {
  return {
    status: "success",
    job: makeJob(),
    article: makeArticle(),
    sources: [makeSource("official"), makeSource("official"), makeSource("community")],
    isMedical: false,
    requiresMedicalReview: false,
    durationMs: { research: 2000, writing: 185000 },
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

  // 2) 일반(비의학) 원고: 헤더에 의학 경고가 없어야 한다.
  const normalHeader = buildHeaderMessage(makeResult());
  assert(!normalHeader.text.includes("의학 주제"), "일반 원고 헤더에는 의학 경고가 없어야 한다");
  assert(normalHeader.text.includes("원고 초안 준비됨"), "일반 원고 헤더 문구가 있어야 한다");
  assert(!normalHeader.replyMarkup, "일반 원고 헤더에는 버튼이 없어야 한다");
  console.log("✅ 일반 원고 헤더: 의학 경고 없음, 버튼 없음");

  // 3) 의학 원고: 헤더에 경고 + 확인 안내가 있어야 한다.
  const medicalHeader = buildHeaderMessage(makeResult({ requiresMedicalReview: true, isMedical: true }));
  assert(medicalHeader.text.includes("의학 주제"), "의학 원고 헤더에는 경고가 있어야 한다");
  assert(medicalHeader.text.includes("참고 자료"), "출처 확인 안내가 있어야 한다");
  console.log("✅ 의학 원고 헤더: 경고 + 안내 포함");

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

  // 8) 의학 결정 메시지: 버튼 3개(confirm/edit/discard)가 정확한 callback_data로 붙어야 한다.
  const decision = buildMedicalDecisionMessage("48472dba-9763-4c26-9c31-86b233a04161");
  const buttons = decision.replyMarkup?.inline_keyboard[0] ?? [];
  assert(buttons.length === 3, `결정 버튼은 3개여야 한다 (실제: ${buttons.length})`);
  assert(
    buttons.some((b) => b.callback_data === "review:confirm:48472dba-9763-4c26-9c31-86b233a04161"),
    "confirm 버튼의 callback_data가 정확해야 한다"
  );
  assert(
    buttons.some((b) => b.callback_data.startsWith("review:discard:")),
    "discard 버튼이 있어야 한다"
  );
  console.log("✅ 의학 결정 메시지: confirm/edit/discard 버튼 정확히 부착");

  console.log("\n✅ notifyArticleReady 메시지 조립 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
