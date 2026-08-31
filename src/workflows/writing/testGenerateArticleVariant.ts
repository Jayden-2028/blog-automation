// generateArticleVariant 테스트. 실제 claude -p 호출 없이 generate를 주입한다.
import { generateArticleVariant, parseVariantOutput } from "./generateArticleVariant.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SAMPLE_OUTPUT = `
### TITLE
근로장려금 지급일 완벽 정리: 언제 얼마나 들어올까
### SEARCH_DESCRIPTION
2026년 근로장려금 지급일과 신청 방법을 한눈에 정리했습니다.
### SLUG
Geunro-Jangryeogeum 2026 Payment!! Guide
### TAGS
근로장려금, 지급일, 2026, 신청방법, 국세청
### BODY
## 근로장려금 지급일은 언제인가요?

근로장려금은 **9월 말** 지급됩니다. 국세청이 정기 신청분에 대해 심사를 마치고 순차적으로
계좌에 입금하며, 신청 시점과 계좌 정보 등록 여부에 따라 실제 입금일이 며칠 차이 날 수 있습니다.
지급 대상자에게는 안내문이 먼저 발송되므로, 안내문을 받은 뒤 홈택스에서 심사 결과를 확인하는
것이 가장 정확합니다.

## 얼마를 받을 수 있나요?

가구 유형과 총소득에 따라 지급액이 달라집니다. 단독 가구, 홑벌이 가구, 맞벌이 가구로 나뉘고
각 구간의 소득 상한과 최대 지급액이 다릅니다. 자세한 계산은 홈택스 모의계산을 이용하면 됩니다.

## 자주 묻는 질문

**Q. 지급일에 안 들어왔어요.** 계좌 정보가 등록되지 않았거나 심사가 지연된 경우입니다.
홈택스에서 심사 상태를 확인하세요.

## 요약

핵심은 9월 말 순차 지급, 가구 유형별 지급액 차이, 홈택스에서 심사 결과 확인.
`;

async function main(): Promise<void> {
  console.log("▶ generateArticleVariant 테스트 시작\n");

  // 1) 파서: 마커별 추출 + blogspot 슬러그 정규화(특수문자 제거, kebab)
  const parsed = parseVariantOutput(SAMPLE_OUTPUT, "blogspot", "폴백 제목");
  assert(parsed.title === "근로장려금 지급일 완벽 정리: 언제 얼마나 들어올까", `title 파싱 실패 (${parsed.title})`);
  assert(parsed.searchDescription?.startsWith("2026년 근로장려금"), "searchDescription 파싱 실패");
  assert(parsed.slug === "geunro-jangryeogeum-2026-payment-guide", `슬러그 정규화 실패 (${parsed.slug})`);
  assert(parsed.tags.length === 5 && parsed.tags[0] === "근로장려금", `태그 파싱 실패 (${JSON.stringify(parsed.tags)})`);
  assert(parsed.body.includes("## 자주 묻는 질문") && parsed.body.includes("## 요약"), "body에 FAQ/요약 포함 실패");
  console.log("✅ 파서: 마커 추출 + blogspot 슬러그 kebab 정규화");

  // 2) tistory는 슬러그가 null
  const tistoryParsed = parseVariantOutput(SAMPLE_OUTPUT, "tistory", "폴백");
  assert(tistoryParsed.slug === null, "tistory 슬러그는 null이어야 한다");
  console.log("✅ tistory -> 슬러그 null");

  // 2-1) 본문 뒤에 모델이 붙이는 "**점검 결과**" 메타 텍스트를 잘라낸다(2026-09-01 관측).
  const withMeta =
    SAMPLE_OUTPUT +
    "\n\n### 참고 자료\n- [링크](https://example.com)\n\n---\n\n**점검 결과**: 사실 보존 완료, 연속 3어절 겹침 없음.";
  const cleaned = parseVariantOutput(withMeta, "blogspot", "폴백");
  assert(!cleaned.body.includes("점검 결과"), `본문에서 점검 결과가 제거돼야 한다\n${cleaned.body.slice(-200)}`);
  assert(cleaned.body.includes("참고 자료"), "참고 자료 목록까지는 남아야 한다");
  console.log("✅ 본문 뒤 '점검 결과' 메타 텍스트 제거");

  // 3) generate 성공 -> variant 반환
  const ok = await generateArticleVariant({
    channel: "blogspot",
    category: "living",
    baseTitle: "기준 원고 제목",
    baseBody: "기준 본문",
    generate: async () => ({ ok: true, output: SAMPLE_OUTPUT, durationMs: 10 }),
  });
  assert(ok.status === "success", `성공해야 한다 (${JSON.stringify(ok)})`);
  console.log("✅ generate 성공 -> success + variant");

  // 4) generate 실패 -> failed 그대로 전달
  const fail = await generateArticleVariant({
    channel: "blogspot",
    category: null,
    baseTitle: "t",
    baseBody: "b",
    generate: async () => ({ ok: false, error: "claude 종료 코드 1", durationMs: 5 }),
  });
  assert(fail.status === "failed" && fail.error.includes("종료 코드 1"), "실패 사유 전달 실패");
  console.log("✅ generate 실패 -> failed");

  // 5) 본문이 너무 짧으면 failed (파싱은 됐지만 쓸 수 없는 출력)
  const short = await generateArticleVariant({
    channel: "blogspot",
    category: null,
    baseTitle: "t",
    baseBody: "b",
    generate: async () => ({ ok: true, output: "### TITLE\n짧은 제목\n### BODY\n너무 짧음", durationMs: 5 }),
  });
  assert(short.status === "failed" && short.error.includes("짧"), `짧은 본문은 failed여야 한다 (${JSON.stringify(short)})`);
  console.log("✅ 본문 과소 -> failed");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
