// 원고 자동 검수 규칙 테스트. 외부 호출 없이 순수 함수만 검증한다.
//
// 이 파일의 절반은 2026-08-28 실측 캘리브레이션에서 나온 오탐 회귀다. 합성 테스트만으로는
// 전부 통과했지만 실제 저장된 원고 3건(아이폰18/재혼황후/셔더링어택)에 돌렸더니 오탐이 쏟아졌고,
// 그 원인 4가지를 각각 고정한다:
//   1. 참고 자료의 링크 제목이 우리 표현으로 오인됨("루머 총정리" -> 추측성 표현)
//   2. "이라는 설명이"의 "설"이 "~라는 설"로 잡힘
//   3. 프롬프트가 요구한 작성 시점 명시 문구가 미검출 날짜로 잡힘
//   4. 평문 URL 출처를 링크 없음으로 오판

import { checkAdDisclosure, checkFacts, checkLegal, checkQuality } from "./articleReviewChecks.js";
import { formatReviewLines, runArticleReview } from "./runArticleReview.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const WRITTEN_AT = "2026-08-28T00:39:15.795Z";

/**
 * 품질 검사를 통과하는 최소 본문. 다른 검사를 볼 때 품질 잡음을 없애려고 쓴다.
 *
 * 문장마다 번호를 넣어 서로 다르게 만드는 이유: 같은 문장을 반복하면 중복 문장 검사에 걸린다
 * (실제로 이 픽스처의 첫 버전이 그렇게 걸렸다 - 검사가 제대로 동작한다는 뜻이기도 하다).
 */
function makeCleanBody(extra = ""): string {
  const filler = Array.from(
    { length: 40 },
    (_, i) => `경복궁 별빛야행 안내 문단 가나다라마바사아자차 ${"가".repeat(i % 7)}${i} 입니다.`
  ).join("\n");
  return `${filler}\n${extra}\n\n## 참고 자료\n\n- [국가유산진흥원](https://www.kh.or.kr/)`;
}

function main(): void {
  console.log("▶ 원고 검수 규칙 테스트 시작\n");

  // ---------- 팩트 ----------

  // 1) 근거에 있는 값은 통과한다(표기가 달라도).
  const factsOk = checkFacts({
    article: { content: "9월 2일부터 진행되며 가격은 6만 원입니다.", created_at: WRITTEN_AT },
    sources: [{ content: "행사 기간 2026. 9. 2.(수) ~ 10. 24.(토), 1매 60,000원" }],
  });
  assert(factsOk.length === 0, `근거에 있는 값은 통과해야 한다 (실제: ${JSON.stringify(factsOk)})`);
  console.log("✅ 팩트: 표기가 달라도 근거에 있으면 통과");

  // 2) 근거에 없는 값은 error로 걸린다.
  const factsBad = checkFacts({
    article: { content: "특별석은 12만 원입니다.", created_at: WRITTEN_AT },
    sources: [{ content: "1매 60,000원" }],
  });
  assert(factsBad.length === 1 && factsBad[0].severity === "error", "근거에 없는 금액은 error여야 한다");
  assert(factsBad[0].message.includes("12만 원"), `걸린 표기를 그대로 보여줘야 한다 (실제: ${factsBad[0].message})`);
  console.log("✅ 팩트: 근거에 없는 값은 error + 원문 표기 표시");

  // 3) 회귀(실측 오탐 3): 프롬프트가 요구한 작성 시점 명시 문구는 걸리면 안 된다.
  // "이 글은 2026년 8월 27~28일에 나온 뉴스와 블로그 글을..." - 작성일 전후는 우리가 만든 값이다.
  const writeDate = checkFacts({
    article: { content: "이 글은 2026년 8월 27일에 나온 뉴스를 정리했습니다.", created_at: WRITTEN_AT },
    sources: [{ content: "근거에는 이 날짜가 없다" }],
  });
  assert(writeDate.length === 0, `작성일 전후 날짜는 걸리면 안 된다 (실제: ${JSON.stringify(writeDate)})`);
  console.log("✅ 팩트: 작성 시점 명시 문구는 오탐 아님(실측 회귀)");

  // 4) 회귀(실측 오탐 1): 참고 자료의 링크 제목에 있는 숫자는 우리 주장이 아니다.
  const refNumbers = checkFacts({
    article: {
      content: "본문에는 수치가 없습니다.\n\n## 참고 자료\n\n- [2026~2027 신제품 999만원 총정리](https://example.com/a)",
      created_at: WRITTEN_AT,
    },
    sources: [{ content: "근거" }],
  });
  assert(refNumbers.length === 0, `참고 자료의 숫자는 걸리면 안 된다 (실제: ${JSON.stringify(refNumbers)})`);
  console.log("✅ 팩트: 참고 자료 섹션 제외(실측 회귀)");

  // 5) 같은 날짜가 두 정규형으로 잡혀도 사람에게는 한 번만 보여준다.
  const dedup = checkFacts({
    article: { content: "2030년 1월 15일에 열립니다.", created_at: WRITTEN_AT },
    sources: [{ content: "근거 없음" }],
  });
  assert(dedup.length === 1, "미검출 날짜가 있어야 한다");
  assert(
    (dedup[0].message.match(/2030년 1월 15/g) ?? []).length === 1,
    `같은 표기를 중복 표시하면 안 된다 (실제: ${dedup[0].message})`
  );
  console.log("✅ 팩트: 같은 표기 중복 표시 안 함");

  // ---------- 법적 ----------

  // 6) 추측성 표현을 잡는다. 연예 분야는 error, 그 외는 warning.
  const legalEnt = checkLegal("결별했다는 의혹이 제기됐다.", "entertainment");
  assert(legalEnt.length === 1 && legalEnt[0].severity === "error", "연예 분야 추측성 표현은 error여야 한다");
  const legalLiving = checkLegal("출시될 가능성이 크다.", "living");
  assert(legalLiving.length === 1 && legalLiving[0].severity === "warning", "비연예 분야는 warning이어야 한다");
  console.log("✅ 법적: 추측성 표현 탐지 + 분야별 심각도 구분");

  // 7) 회귀(실측 오탐 2): "이라는 설명이"의 "설"을 "~라는 설"로 오인하면 안 된다.
  const explanation = checkLegal('"뇌가 미성숙해서 나타나는 증상"이라는 설명이 올라와 있었고', "parenting");
  assert(explanation.length === 0, `"설명"을 추측성 표현으로 잡으면 안 된다 (실제: ${JSON.stringify(explanation)})`);
  // 진짜 "~라는 설"은 여전히 잡혀야 한다.
  const realRumor = checkLegal("결별했다는 설이 돌고 있다.", "entertainment");
  assert(realRumor.length === 1, "진짜 '~라는 설'은 잡혀야 한다");
  console.log("✅ 법적: '설명' 오탐 제거하되 진짜 '~라는 설'은 유지(실측 회귀)");

  // 8) 회귀(실측 오탐 1): 참고 자료의 링크 제목은 우리 표현이 아니다.
  const refTitle = checkLegal(
    "본문은 깨끗합니다.\n\n## 참고 자료\n\n- [아이폰18 폴더블 루머 총정리](https://example.com/a)",
    "living"
  );
  assert(refTitle.length === 0, `참고 자료의 출처 제목은 걸리면 안 된다 (실제: ${JSON.stringify(refTitle)})`);
  console.log("✅ 법적: 참고 자료 섹션 제외(실측 회귀)");

  // ---------- 광고 ----------

  // 9) 대가성 문구 + 표시 없음 -> error.
  const adMissing = checkAdDisclosure("업체로부터 제품을 제공받아 작성했습니다.");
  assert(adMissing.length === 1 && adMissing[0].severity === "error", "표시 없는 대가성 문구는 error여야 한다");
  // 표시가 있으면 통과.
  const adOk = checkAdDisclosure("업체로부터 제품을 제공받아 작성했습니다. #협찬");
  assert(adOk.length === 0, "협찬 표시가 있으면 통과해야 한다");
  // 대가성 문구 자체가 없으면 검사 대상이 아니다.
  assert(checkAdDisclosure("일반 정보 글입니다.").length === 0, "대가성 문구가 없으면 통과해야 한다");
  console.log("✅ 광고: 대가성 문구 대비 표시 누락 탐지");

  // ---------- 품질 ----------

  // 10) 회귀(실측 오탐 4): 평문 URL 출처도 인정해야 한다.
  // 모델이 "- 나무위키: https://..." 형태로 쓰는 경우가 실제로 있었다(재혼황후 원고).
  const plainUrl = checkQuality({
    title: "경복궁 별빛야행 안내",
    body: makeCleanBody().replace("- [국가유산진흥원](https://www.kh.or.kr/)", "- 나무위키: https://namu.wiki/w/x"),
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: false,
  });
  assert(
    !plainUrl.some((c) => c.message.includes("참고 자료")),
    `평문 URL 출처를 링크 없음으로 오판하면 안 된다 (실제: ${JSON.stringify(plainUrl)})`
  );
  console.log("✅ 품질: 평문 URL 출처 인정(실측 회귀)");

  // 11) 참고 자료가 아예 없으면 error.
  const noRefs = checkQuality({
    title: "제목",
    body: "본문만 있고 출처가 없습니다.".repeat(100),
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: false,
  });
  assert(noRefs.some((c) => c.message.includes("참고 자료") && c.severity === "error"), "출처 없음은 error여야 한다");
  console.log("✅ 품질: 참고 자료 없음 -> error");

  // 12) 분량 초과/미달을 경고한다(아이폰18 원고가 3,304자로 실제로 걸린 항목).
  const tooLong = checkQuality({
    title: "제목",
    body: makeCleanBody("가".repeat(3000)),
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: false,
  });
  assert(tooLong.some((c) => c.message.includes("분량")), "분량 초과를 경고해야 한다");
  console.log("✅ 품질: 분량 목표 이탈 경고");

  // 13) 해시태그 개수가 다르면 경고한다(셔더링어택 원고가 0개로 실제로 걸린 항목).
  const noTags = checkQuality({
    title: "제목",
    body: makeCleanBody(),
    hashtags: [],
    isMedical: false,
  });
  assert(noTags.some((c) => c.message.includes("해시태그 0개")), "해시태그 누락을 경고해야 한다");
  console.log("✅ 품질: 해시태그 개수 검사");

  // 14) 의학 주제인데 상담 안내가 없으면 error - 코드가 붙이는 문구가 깨져도 조용히 지나가지 않게.
  const medicalMissing = checkQuality({
    title: "제목",
    body: makeCleanBody(),
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: true,
  });
  assert(
    medicalMissing.some((c) => c.message.includes("전문의") && c.severity === "error"),
    "의학 고지 누락은 error여야 한다"
  );
  const medicalOk = checkQuality({
    title: "제목",
    body: makeCleanBody("정확한 진단은 반드시 전문의와 상담하세요."),
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: true,
  });
  assert(!medicalOk.some((c) => c.message.includes("전문의")), "고지가 있으면 통과해야 한다");
  console.log("✅ 품질: 의학 고지 누락 탐지");

  // 15) 중복 문장 탐지.
  const dupSentence = "이 프로그램은 야간에만 운영되며 사전 예약이 필요합니다.";
  const duplicated = checkQuality({
    title: "제목",
    body: makeCleanBody(`${dupSentence}\n${dupSentence}`),
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: false,
  });
  assert(duplicated.some((c) => c.message.includes("중복 문장")), "중복 문장을 경고해야 한다");
  console.log("✅ 품질: 중복 문장 탐지");

  // ---------- 통합 ----------

  // 16) 전부 통과하면 passed=true, 알림은 한 줄.
  const clean = runArticleReview({
    job: { category: "living" },
    article: {
      title: "경복궁 별빛야행 안내",
      content: makeCleanBody("가격은 6만 원입니다."),
      created_at: WRITTEN_AT,
    },
    sources: [{ content: "1매 60,000원" }],
    hashtags: Array.from({ length: 15 }, (_, i) => `#태그${i}`),
    isMedical: false,
  });
  assert(clean.passed, `깨끗한 원고는 통과해야 한다 (실제: ${JSON.stringify(clean.checks)})`);
  assert(formatReviewLines(clean).length === 1, "통과 시 알림은 한 줄이어야 한다");
  assert(formatReviewLines(clean)[0].includes("검수 통과"), "통과 문구가 있어야 한다");
  console.log("✅ 통합: 깨끗한 원고 -> passed, 알림 한 줄");

  // 17) error가 warning보다 먼저 온다 - 알림이 잘려도 중요한 게 남아야 한다.
  const mixed = runArticleReview({
    job: { category: "entertainment" },
    article: {
      title: "제목",
      content: "결별 의혹이 제기됐다. 특별석은 12만 원이다." + "가".repeat(3000),
      created_at: WRITTEN_AT,
    },
    sources: [{ content: "근거" }],
    hashtags: [],
    isMedical: false,
  });
  assert(mixed.errorCount > 0 && mixed.warningCount > 0, "오류와 경고가 모두 있어야 한다");
  const firstWarningIndex = mixed.checks.findIndex((c) => c.severity === "warning");
  const lastErrorIndex = mixed.checks.map((c) => c.severity).lastIndexOf("error");
  assert(lastErrorIndex < firstWarningIndex, "error가 warning보다 앞에 와야 한다");
  const lines = formatReviewLines(mixed);
  assert(lines[0].includes(`오류 ${mixed.errorCount}`), `요약 줄에 개수가 있어야 한다 (실제: ${lines[0]})`);
  console.log("✅ 통합: error 우선 정렬 + 개수 요약");

  // 18) 본문이 없어도 죽지 않는다.
  const empty = runArticleReview({
    job: { category: null },
    article: { title: null, content: null, created_at: WRITTEN_AT },
    sources: [],
    hashtags: [],
    isMedical: false,
  });
  assert(!empty.passed && empty.checks.length > 0, "본문 없음은 검수에서 걸려야 한다");
  console.log("✅ 통합: 본문 없음 안전 처리");

  console.log("\n✅ 원고 검수 규칙 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
