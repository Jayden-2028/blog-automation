// buildArticlePrompt / parseArticleOutput 테스트.
// 외부 호출(LLM/DB) 없이 순수 함수만 검증한다.

import { ARTICLE_OUTPUT_MARKERS, buildArticlePrompt, parseArticleOutput } from "./buildArticlePrompt.js";
import type { ArticleJobRow, SourceRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeJob(overrides: Partial<ArticleJobRow> = {}): ArticleJobRow {
  return {
    id: "job-1",
    source_run_id: 18,
    source_rank: 1,
    keyword: "2026 근로장려금 지급일",
    headline: "2026 근로장려금 지급일 총정리",
    seed_query: "근로장려금",
    category: "living",
    total_score: 55,
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
    job_id: "job-1",
    title: "국세청 홈택스 - 근로장려금",
    url: "https://hometax.go.kr/x",
    source_name: "naver_web",
    authority: "official",
    published_at: null,
    content: "근로장려금은 9월 1일부터 지급됩니다.",
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function main(): void {
  console.log("▶ buildArticlePrompt / parseArticleOutput 테스트 시작\n");

  // 1) 일반 프롬프트에는 의학 규칙이 없어야 한다.
  const normalPrompt = buildArticlePrompt({ job: makeJob(), sources: [makeSource()], isMedical: false });
  assert(normalPrompt.includes("content-blog"), "content-blog 스킬 사용 지시가 있어야 한다");
  assert(normalPrompt.includes("korean-humanize"), "korean-humanize 스킬 사용 지시가 있어야 한다");
  assert(!normalPrompt.includes("전문의와 상담"), "일반 원고에는 의학 안내 규칙이 없어야 한다");
  assert(normalPrompt.includes("hometax.go.kr"), "팩트 카드의 출처 URL이 포함돼야 한다");
  console.log("✅ 일반 프롬프트: 스킬 지시 + 팩트 카드 포함, 의학 규칙 없음");

  // 2) 의학 주제는 의학 전용 규칙이 추가돼야 한다.
  const medicalPrompt = buildArticlePrompt({
    job: makeJob({ keyword: "아기 셔더링어택 증상", category: "parenting" }),
    sources: [makeSource({ authority: "community", url: "https://in.naver.com/x", title: "커뮤니티 글" })],
    isMedical: true,
  });
  assert(medicalPrompt.includes("전문의와 상담"), "의학 원고에는 전문의 상담 안내 규칙이 있어야 한다");
  assert(medicalPrompt.includes("진단이나 처방으로 읽힐"), "의학 원고에는 단정적 표현 금지 규칙이 있어야 한다");
  console.log("✅ 의학 프롬프트: 의학 전용 규칙 추가됨");

  // 3) 근거가 없으면 "지어내지 말라"는 안내가 팩트 카드 자리에 들어가야 한다.
  const emptyPrompt = buildArticlePrompt({ job: makeJob(), sources: [], isMedical: false });
  assert(emptyPrompt.includes("절대 단정하지"), "근거 없음 경고가 포함돼야 한다");
  console.log("✅ 근거 없음 -> 단정 금지 경고 포함");

  // 4) 정상 출력 파싱.
  const wellFormed = [
    ARTICLE_OUTPUT_MARKERS.title,
    "2026 근로장려금 지급일, 놓치면 안 되는 이유",
    "",
    ARTICLE_OUTPUT_MARKERS.body,
    "## 개요\n근로장려금은...\n\n## 신청 방법\n...",
    "",
    ARTICLE_OUTPUT_MARKERS.seoDescription,
    "2026 근로장려금 지급일과 신청 방법을 정리했습니다.",
  ].join("\n");

  const parsed = parseArticleOutput(wellFormed, "폴백 제목");
  assert(parsed.title === "2026 근로장려금 지급일, 놓치면 안 되는 이유", `제목 파싱 실패: ${parsed.title}`);
  assert(parsed.body.includes("## 개요") && parsed.body.includes("## 신청 방법"), "본문 파싱이 마커 사이 전체를 담아야 한다");
  assert(parsed.seoDescription === "2026 근로장려금 지급일과 신청 방법을 정리했습니다.", `SEO 설명 파싱 실패: ${parsed.seoDescription}`);
  console.log("✅ 정상 출력 파싱 성공 (title/body/seoDescription)");

  // 5) 마커가 없는 출력(모델이 형식을 안 지킨 경우)은 전체를 body로, title은 폴백을 쓴다.
  const noMarkers = "그냥 자유 형식으로 쓴 글입니다. 마커가 없습니다.";
  const fallback = parseArticleOutput(noMarkers, "키워드 폴백 제목");
  assert(fallback.title === "키워드 폴백 제목", "마커 없으면 폴백 제목을 써야 한다");
  assert(fallback.body === noMarkers, "마커 없으면 전체를 body로 보존해야 한다(원고를 버리지 않는다)");
  assert(fallback.seoDescription === null, "마커 없으면 seoDescription은 null이어야 한다");
  console.log("✅ 마커 없는 출력 -> 폴백 title + 전체 보존 (원고 유실 없음)");

  // 6) SEO_DESCRIPTION 마커가 없어도(title/body만 있어도) 파싱은 성공해야 한다.
  const noSeo = [ARTICLE_OUTPUT_MARKERS.title, "제목만", "", ARTICLE_OUTPUT_MARKERS.body, "본문 내용"].join("\n");
  const parsedNoSeo = parseArticleOutput(noSeo, "폴백");
  assert(parsedNoSeo.title === "제목만" && parsedNoSeo.body === "본문 내용", "SEO 마커 없이도 title/body는 정상 파싱돼야 한다");
  assert(parsedNoSeo.seoDescription === null, "SEO 마커가 없으면 null이어야 한다");
  console.log("✅ SEO_DESCRIPTION 없어도 title/body 정상 파싱");

  console.log("\n✅ buildArticlePrompt / parseArticleOutput 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
