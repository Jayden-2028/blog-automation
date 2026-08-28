// summarizeResearchForReview 테스트. generateSummary를 주입해 실제 LLM을 호출하지 않는다.

import { summarizeResearchForReview } from "./summarizeResearchForReview.js";
import type { SourceRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
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
    content: "예매권 추첨 응모 : 2026. 8. 14.(금) ~ 8. 20.(목), 당첨자 발표 8. 24.(월)",
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("▶ summarizeResearchForReview 테스트 시작\n");

  const job = { keyword: "2026 경복궁 별빛야행", headline: "2026 경복궁 별빛야행 야간개장", category: "living" };

  // 1) 정상 응답을 그대로 요약으로 돌려준다.
  const ok = await summarizeResearchForReview(
    { job, sources: [makeSource()], today: "2026-08-27" },
    { generateSummary: async () => ({ ok: true, output: "- ⚠️ 예매가 이미 마감됐습니다." }) }
  );
  assert(ok.ok, "정상 응답이면 ok:true여야 한다");
  if (ok.ok) assert(ok.summary.includes("마감"), "요약 텍스트가 그대로 반환돼야 한다");
  console.log("✅ 정상 응답 -> 요약 그대로 반환");

  // 2) 프롬프트에 오늘 날짜와 키워드, 근거 내용이 실제로 포함돼야 한다(모델이 판단할 재료).
  let capturedPrompt = "";
  await summarizeResearchForReview(
    { job, sources: [makeSource()], today: "2026-08-27" },
    {
      generateSummary: async (prompt) => {
        capturedPrompt = prompt;
        return { ok: true, output: "- 요약" };
      },
    }
  );
  assert(capturedPrompt.includes("2026-08-27"), "프롬프트에 오늘 날짜가 포함돼야 한다");
  assert(capturedPrompt.includes("2026 경복궁 별빛야행"), "프롬프트에 키워드가 포함돼야 한다");
  assert(capturedPrompt.includes("예매권 추첨 응모"), "프롬프트에 근거 내용이 포함돼야 한다(buildFactCard 재사용 확인)");
  console.log("✅ 프롬프트에 오늘 날짜/키워드/근거가 포함됨");

  // 3) LLM 호출이 실패하면 예외를 던지지 않고 ok:false를 반환한다.
  const failed = await summarizeResearchForReview(
    { job, sources: [makeSource()] },
    { generateSummary: async () => ({ ok: false, error: "claude가 종료 코드 1로 끝났습니다" }) }
  );
  assert(!failed.ok, "LLM 실패면 ok:false여야 한다");
  if (!failed.ok) assert(failed.error.includes("종료 코드"), "실패 사유가 그대로 전달돼야 한다");
  console.log("✅ LLM 호출 실패 -> 예외 없이 ok:false");

  // 4) 빈 출력도 실패로 취급한다(호출은 됐지만 쓸모없는 결과).
  const empty = await summarizeResearchForReview(
    { job, sources: [makeSource()] },
    { generateSummary: async () => ({ ok: true, output: "   " }) }
  );
  assert(!empty.ok, "빈 출력은 ok:false로 취급해야 한다");
  console.log("✅ 빈 출력 -> ok:false");

  // 5) 근거가 아예 없으면 LLM을 부르지 않고 고정 안내를 즉시 반환한다(비용 0).
  let called = false;
  const noSources = await summarizeResearchForReview(
    { job, sources: [] },
    { generateSummary: async () => { called = true; return { ok: true, output: "-" }; } }
  );
  assert(!called, "근거가 없으면 LLM을 호출하지 않아야 한다");
  assert(noSources.ok, "근거 없음도 ok:true(고정 안내)여야 한다");
  console.log("✅ 근거 없음 -> LLM 호출 없이 고정 안내 반환");

  console.log("\n✅ summarizeResearchForReview 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
