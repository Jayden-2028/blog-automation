// buildArticlePrompt / parseArticleOutput 테스트.
// 외부 호출(LLM/DB) 없이 순수 함수만 검증한다.

import { ARTICLE_OUTPUT_MARKERS, buildArticlePrompt, buildMedicalDisclaimer, parseArticleOutput } from "./buildArticlePrompt.js";
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
  assert(normalPrompt.includes(ARTICLE_OUTPUT_MARKERS.hashtags), "해시태그 마커 지시가 프롬프트에 있어야 한다");
  assert(normalPrompt.includes("정확히 15개"), "해시태그 개수(15개) 지시가 프롬프트에 있어야 한다");
  console.log("✅ 일반 프롬프트: 스킬 지시 + 팩트 카드 + 해시태그 지시 포함, 의학 규칙 없음");

  // 2) 의학 주제는 의학 전용 규칙이 추가돼야 한다.
  const medicalPrompt = buildArticlePrompt({
    job: makeJob({ keyword: "아기 셔더링어택 증상", category: "parenting" }),
    sources: [makeSource({ authority: "community", url: "https://in.naver.com/x", title: "커뮤니티 글" })],
    isMedical: true,
  });
  assert(medicalPrompt.includes("전문의와 상담"), "의학 원고에는 전문의 상담 안내 규칙이 있어야 한다");
  assert(medicalPrompt.includes("진단이나 처방으로 읽힐"), "의학 원고에는 단정적 표현 금지 규칙이 있어야 한다");
  console.log("✅ 의학 프롬프트: 의학 전용 규칙 추가됨");

  // 2-1) 회귀(2026-08-28 사용자 제공 블로그 샘플 분석): 카테고리별로 다른 톤 규칙이 들어가야 한다.
  // living은 편집자 톤(1인칭 금지, "~습니다"체 통일), 나머지(entertainment/ott/parenting)는
  // 개인 블로그 톤(1인칭, 개인 소감 문단)을 쓴다.
  const livingPrompt = buildArticlePrompt({ job: makeJob({ category: "living" }), sources: [makeSource()], isMedical: false });
  assert(livingPrompt.includes("1인칭을 쓰지 않는다"), "living은 편집자 톤 규칙(1인칭 금지)이 있어야 한다");
  assert(livingPrompt.includes("결론 문단을 둔다"), "living은 명확한 입장을 담은 결론 규칙이 있어야 한다");
  assert(!livingPrompt.includes("개인적인 소감"), "living에는 개인 블로그 톤 규칙이 섞이면 안 된다");

  for (const category of ["entertainment", "ott", "parenting"] as const) {
    const personalPrompt = buildArticlePrompt({ job: makeJob({ category }), sources: [makeSource()], isMedical: false });
    assert(
      personalPrompt.includes("1인칭 화자로 쓴다"),
      `${category}는 개인 블로그 톤 규칙(1인칭)이 있어야 한다`
    );
    assert(
      personalPrompt.includes("개인적인 소감"),
      `${category}는 개인 소감 문단 규칙이 있어야 한다`
    );
    assert(
      !personalPrompt.includes("1인칭을 쓰지 않는다"),
      `${category}에는 편집자 톤 규칙(1인칭 금지)이 섞이면 안 된다`
    );
  }
  console.log("✅ 카테고리별 톤 규칙 분기(living=편집자 톤 / entertainment·ott·parenting=개인 블로그 톤)");

  // 2-2) category가 없으면(null) 더 넓은 표본을 관찰한 개인 블로그 톤을 기본으로 쓴다.
  const noCategoryPrompt = buildArticlePrompt({ job: makeJob({ category: null }), sources: [makeSource()], isMedical: false });
  assert(noCategoryPrompt.includes("1인칭 화자로 쓴다"), "category 없음은 개인 블로그 톤을 기본으로 써야 한다");
  console.log("✅ category 없음 -> 개인 블로그 톤 기본값");

  // 3) 근거가 없으면 "지어내지 말라"는 안내가 팩트 카드 자리에 들어가야 한다.
  const emptyPrompt = buildArticlePrompt({ job: makeJob(), sources: [], isMedical: false });
  assert(emptyPrompt.includes("절대 단정하지"), "근거 없음 경고가 포함돼야 한다");
  console.log("✅ 근거 없음 -> 단정 금지 경고 포함");

  // 4) 정상 출력 파싱(해시태그 포함).
  const wellFormed = [
    ARTICLE_OUTPUT_MARKERS.title,
    "2026 근로장려금 지급일, 놓치면 안 되는 이유",
    "",
    ARTICLE_OUTPUT_MARKERS.body,
    "## 개요\n근로장려금은...\n\n## 신청 방법\n...",
    "",
    ARTICLE_OUTPUT_MARKERS.seoDescription,
    "2026 근로장려금 지급일과 신청 방법을 정리했습니다.",
    "",
    ARTICLE_OUTPUT_MARKERS.hashtags,
    "#근로장려금 #지급일 #신청방법",
  ].join("\n");

  const parsed = parseArticleOutput(wellFormed, "폴백 제목");
  assert(parsed.title === "2026 근로장려금 지급일, 놓치면 안 되는 이유", `제목 파싱 실패: ${parsed.title}`);
  assert(parsed.body.includes("## 개요") && parsed.body.includes("## 신청 방법"), "본문 파싱이 마커 사이 전체를 담아야 한다");
  assert(!parsed.body.includes("HASHTAGS") && !parsed.body.includes("#근로장려금"), "body에는 SEO/해시태그 마커 이후 내용이 섞이면 안 된다");
  assert(parsed.seoDescription === "2026 근로장려금 지급일과 신청 방법을 정리했습니다.", `SEO 설명 파싱 실패: ${parsed.seoDescription}`);
  assert(
    JSON.stringify(parsed.hashtags) === JSON.stringify(["#근로장려금", "#지급일", "#신청방법"]),
    `해시태그 파싱 실패: ${JSON.stringify(parsed.hashtags)}`
  );
  console.log("✅ 정상 출력 파싱 성공 (title/body/seoDescription/hashtags)");

  // 4-1) 해시태그에 "#" 없는 토큰이나 중복이 섞여도 안전하게 정리한다.
  const messyHashtags = [
    ARTICLE_OUTPUT_MARKERS.title,
    "제목",
    "",
    ARTICLE_OUTPUT_MARKERS.body,
    "본문",
    "",
    ARTICLE_OUTPUT_MARKERS.hashtags,
    "#태그1 태그없음 #태그1 #태그2",
  ].join("\n");
  const parsedMessy = parseArticleOutput(messyHashtags, "폴백");
  assert(
    JSON.stringify(parsedMessy.hashtags) === JSON.stringify(["#태그1", "#태그2"]),
    `"#" 없는 토큰 제거 + 중복 제거 실패: ${JSON.stringify(parsedMessy.hashtags)}`
  );
  console.log("✅ 해시태그: '#' 없는 토큰 제거 + 중복 제거");

  // 5) 마커가 없는 출력(모델이 형식을 안 지킨 경우)은 전체를 body로, title은 폴백을 쓴다.
  const noMarkers = "그냥 자유 형식으로 쓴 글입니다. 마커가 없습니다.";
  const fallback = parseArticleOutput(noMarkers, "키워드 폴백 제목");
  assert(fallback.title === "키워드 폴백 제목", "마커 없으면 폴백 제목을 써야 한다");
  assert(fallback.body === noMarkers, "마커 없으면 전체를 body로 보존해야 한다(원고를 버리지 않는다)");
  assert(fallback.seoDescription === null, "마커 없으면 seoDescription은 null이어야 한다");
  assert(fallback.hashtags.length === 0, "마커 없으면 hashtags는 빈 배열이어야 한다");
  console.log("✅ 마커 없는 출력 -> 폴백 title + 전체 보존 (원고 유실 없음)");

  // 6) SEO_DESCRIPTION/HASHTAGS 마커가 없어도(title/body만 있어도) 파싱은 성공해야 한다.
  const noSeo = [ARTICLE_OUTPUT_MARKERS.title, "제목만", "", ARTICLE_OUTPUT_MARKERS.body, "본문 내용"].join("\n");
  const parsedNoSeo = parseArticleOutput(noSeo, "폴백");
  assert(parsedNoSeo.title === "제목만" && parsedNoSeo.body === "본문 내용", "SEO 마커 없이도 title/body는 정상 파싱돼야 한다");
  assert(parsedNoSeo.seoDescription === null, "SEO 마커가 없으면 null이어야 한다");
  assert(parsedNoSeo.hashtags.length === 0, "HASHTAGS 마커가 없으면 빈 배열이어야 한다");
  console.log("✅ SEO_DESCRIPTION/HASHTAGS 없어도 title/body 정상 파싱");

  // 7) buildMedicalDisclaimer: 의학 주제가 아니면 null(고지를 붙이지 않는다).
  assert(buildMedicalDisclaimer(false, [makeSource()]) === null, "비의학 주제는 고지가 없어야 한다");
  console.log("✅ 비의학 주제 -> 고지 없음(null)");

  // 8) buildMedicalDisclaimer: 공공/의료 출처가 하나도 없으면(커뮤니티뿐) 강한 문구를 쓴다.
  // 2026-08-28 사용자 요청 회귀: "아기 셔더링어택" 원고가 커뮤니티 출처뿐이었는데 "의학적으로
  // 사실 확인을 거친 정보가 아니"라는 고지가 없었다는 피드백을 고정한다.
  const communityOnlyDisclaimer = buildMedicalDisclaimer(true, [
    makeSource({ authority: "community" }),
    makeSource({ authority: "community" }),
  ]);
  assert(communityOnlyDisclaimer !== null, "커뮤니티뿐이면 고지가 있어야 한다");
  assert(communityOnlyDisclaimer!.includes("사실 확인을 거친 정보가 아닙니다"), "저신뢰 출처 고지 문구가 정확해야 한다");
  assert(communityOnlyDisclaimer!.startsWith("*") && communityOnlyDisclaimer!.endsWith("*"), "이탤릭 마크다운(*...*)으로 감싸야 한다(Telegraph에 작은 글씨가 없어 이탤릭으로 근사)");
  console.log("✅ 커뮤니티뿐인 의학 원고 -> 저신뢰 출처 고지(이탤릭)");

  // 9) buildMedicalDisclaimer: 공공/의료 출처가 하나라도 있으면 더 완화된 문구를 쓴다.
  const officialBackedDisclaimer = buildMedicalDisclaimer(true, [
    makeSource({ authority: "official" }),
    makeSource({ authority: "community" }),
  ]);
  assert(officialBackedDisclaimer !== null, "의학 주제면 출처와 무관하게 고지는 항상 있어야 한다");
  assert(!officialBackedDisclaimer!.includes("사실 확인을 거친 정보가 아닙니다"), "공식 출처가 있으면 저신뢰 문구를 쓰면 안 된다");
  assert(officialBackedDisclaimer!.includes("전문의와 상담"), "공식 출처가 있어도 상담 권유는 유지해야 한다");
  console.log("✅ 공식/의료 출처 있는 의학 원고 -> 완화된 고지");

  console.log("\n✅ buildArticlePrompt / parseArticleOutput 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
