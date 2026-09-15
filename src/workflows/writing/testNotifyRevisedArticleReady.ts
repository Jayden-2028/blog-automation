// notifyRevisedArticleReady의 메시지 조립(buildRevisedHeaderMessage)만 검증한다. 실제 발송 없음.

import { buildRevisedHeaderMessage } from "./notifyRevisedArticleReady.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "48472dba-9763-4c26-9c31-86b233a04161";

function makeJob(): ArticleJobRow {
  return {
    id: JOB_ID,
    source_run_id: 1,
    source_rank: 1,
    keyword: "테스트 키워드",
    headline: null,
    seed_query: null,
    category: "living",
    total_score: 50,
    score_breakdown: null,
    status: "review",
    selected_at: "x",
    selected_via: "telegram",
    metadata: {},
    created_at: "x",
    updated_at: "x",
  };
}

function makeArticle(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 1,
    keyword_id: null,
    job_id: JOB_ID,
    title: "수정된 제목",
    content: "본문",
    status: "review",
    ai_model: "claude-headless",
    platform: null,
    created_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

function main(): void {
  console.log("▶ notifyRevisedArticleReady 테스트 시작\n");

  // 1) telegraphUrl 있음 -> 원고 보기 + 결정 버튼(승인/수정/반려) 2행, 피드백 문구 포함.
  {
    const msg = buildRevisedHeaderMessage(makeJob(), makeArticle(), "제목을 더 짧게", "https://telegra.ph/x");
    assert(msg.text.includes("수정된 초안 준비됨"), "헤더 문구가 있어야 한다");
    assert(msg.text.includes("제목을 더 짧게"), "반영한 피드백이 표시돼야 한다");
    assert(msg.replyMarkup?.inline_keyboard.length === 2, "원고 보기 + 결정 버튼 2행이어야 한다");
    assert(
      msg.replyMarkup?.inline_keyboard[1]?.some((b) => "callback_data" in b && b.callback_data?.startsWith("review:confirm:")),
      "결정 버튼에 승인이 있어야 한다"
    );
    console.log("✅ telegraphUrl 있음 -> 원고 보기 + 결정 버튼");
  }

  // 2) telegraphUrl 없음 -> 버튼 없이 폴백 안내만(중복 결정 버튼 방지 - notifyArticleReady.ts와 동일 원칙).
  {
    const msg = buildRevisedHeaderMessage(makeJob(), makeArticle(), "제목을 더 짧게", null);
    assert(msg.replyMarkup === undefined, "telegraphUrl 없으면 헤더에 버튼이 없어야 한다");
    assert(msg.text.includes("Telegraph 발행 실패"), "폴백 안내가 있어야 한다");
    console.log("✅ telegraphUrl 없음 -> 헤더에는 버튼 없음(폴백 경로에서 별도 발송)");
  }

  console.log("\n✅ notifyRevisedArticleReady 테스트 전체 통과");
}

main();
