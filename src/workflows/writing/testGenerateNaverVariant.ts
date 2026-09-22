// 네이버 배리에이션 테스트. LLM은 주입해 파싱·검증만 본다(외부 호출 없음).
//
// 가장 중요한 불변식: **이미지 마커가 원본과 완전히 같아야 한다.** 두 글이 같은 이미지를 쓰는데
// 마커 등장 순서로 짝짓기 때문에, 하나라도 어긋나면 엉뚱한 문단에 이미지가 붙는다.

import {
  buildNaverVariantPrompt,
  generateNaverVariant,
  imageMarkersOf,
  parseNaverVariantOutput,
} from "./generateNaverVariant.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SOURCE_BODY = [
  "블로그스팟 도입 문단입니다. 지원금은 30만 원입니다.",
  "[IMAGE: 주민센터 창구 — AI 생성]",
  "**신청 방법**\n정부24에서 신청합니다.",
  "[IMAGE: 전통시장 결제 — 웹 검색]",
  "마무리 문단입니다.",
].join("\n\n");

const body = (markers: string[]) =>
  [
    "네이버판 도입 문단입니다. 지원금은 30만 원입니다. " + "가".repeat(300),
    `[IMAGE: ${markers[0]}]`,
    "**어떻게 신청하나요**\n정부24를 이용합니다.",
    `[IMAGE: ${markers[1]}]`,
    "맺음 문단입니다.",
  ].join("\n\n");

const reply = (title: string, tags: string, b: string) => async () => ({
  ok: true as const,
  output: `### TITLE\n${title}\n### TAGS\n${tags}\n### BODY\n${b}`,
  durationMs: 1,
});

const input = { category: "living", blogspotTitle: "블로그스팟 제목", blogspotBody: SOURCE_BODY };

async function main(): Promise<void> {
  console.log("▶ generateNaverVariant 테스트 시작\n");

  // 1) 프롬프트: 마커 불변·사실 보존·구조 유지가 모두 실려야 한다.
  const prompt = buildNaverVariantPrompt(input);
  assert(prompt.includes("개수·순서·설명 문구를 원본 그대로"), "마커 불변 규칙이 실려야 한다");
  assert(prompt.includes("같은 게시물로 보지 않을"), "배리에이션 목적(중복 회피)이 실려야 한다");
  assert(prompt.includes("소제목의 순서와 다루는 내용"), "구조는 유지한다는 지시가 있어야 한다");
  assert(prompt.includes("voice.md"), "어투 규격을 읽으라는 지시가 있어야 한다");
  // 참고 자료 링크아웃 제거(2026-09-22 사용자 결정). 블로그 원고와 갈리는 유일한 구조 차이라
  // 규칙이 프롬프트에서 빠지면 조용히 예전처럼 링크가 따라붙는다.
  assert(prompt.includes("'참고 자료' 블록은 통째로 뺀다"), "참고 자료 제거 규칙이 실려야 한다");
  assert(prompt.includes("`**요약**` 블록은 그대로 둔다"), "요약은 남긴다는 지시가 있어야 한다");
  assert(!prompt.includes("'참고 자료' 목록도 그대로 옮긴다"), "옛 규칙(그대로 옮긴다)이 남아 있으면 안 된다");
  assert(prompt.includes(SOURCE_BODY), "원본 본문이 실려야 한다");
  console.log("✅ 프롬프트 - 마커 불변 + 중복 회피 목적 + 구조 유지 + 어투 규격");

  // 2) 마커 추출.
  assert(
    JSON.stringify(imageMarkersOf(SOURCE_BODY)) ===
      JSON.stringify(["주민센터 창구 — AI 생성", "전통시장 결제 — 웹 검색"]),
    "마커를 등장 순서대로 뽑아야 한다"
  );

  // 3) 정상 경로: 마커가 같으면 성공.
  const ok = await generateNaverVariant({
    ...input,
    generate: reply("네이버 제목", "태그1, 태그2", body(["주민센터 창구 — AI 생성", "전통시장 결제 — 웹 검색"])),
  });
  assert(ok.status === "success", `마커가 같으면 성공해야 한다 (${ok.status === "failed" ? ok.error : ""})`);
  assert(ok.status === "success" && ok.variant.title === "네이버 제목", "제목이 바뀌어야 한다");
  assert(ok.status === "success" && ok.variant.tags.length === 2, "태그를 파싱해야 한다");
  console.log("✅ 정상 경로 - 제목·태그·본문 파싱");

  // 4) **핵심**: 마커 설명이 바뀌면 버린다(잘못 붙은 이미지보다 네이버 원고가 없는 게 낫다).
  const changed = await generateNaverVariant({
    ...input,
    generate: reply("t", "a, b", body(["주민센터 창구 사진 — AI 생성", "전통시장 결제 — 웹 검색"])),
  });
  assert(changed.status === "failed", "마커 설명이 바뀌면 버려야 한다");
  assert(changed.status === "failed" && changed.error.includes("이미지 마커"), `사유가 분명해야 한다 (${changed.status === "failed" ? changed.error : ""})`);

  // 마커가 하나 빠져도 마찬가지.
  const dropped = await generateNaverVariant({
    ...input,
    generate: reply("t", "a", "도입 문단입니다. " + "가".repeat(400) + "\n\n[IMAGE: 주민센터 창구 — AI 생성]\n\n끝."),
  });
  assert(dropped.status === "failed", "마커가 빠지면 버려야 한다");
  console.log("✅ 마커 불일치(설명 변경/누락) -> 배리에이션 폐기");

  // 5) 마커 형식이 없는 대화체 응답, LLM 실패는 예외 없이 failed.
  const chatty = await generateNaverVariant({
    ...input,
    generate: async () => ({ ok: true as const, output: "네, 다시 써 드릴게요!", durationMs: 1 }),
  });
  assert(chatty.status === "failed", "마커 없는 응답을 성공으로 오인하면 안 된다");

  const down = await generateNaverVariant({
    ...input,
    generate: async () => ({ ok: false as const, error: "claude 없음", durationMs: 1 }),
  });
  assert(down.status === "failed" && down.error === "claude 없음", "실행 실패가 그대로 전파돼야 한다");
  console.log("✅ 대화체 응답·실행 실패 안전 처리");

  // 6) 파서: TITLE이 없으면 원본 제목으로 폴백한다.
  const parsed = parseNaverVariantOutput("### BODY\n본문만 있습니다.", "폴백 제목");
  assert(parsed.title === "폴백 제목", "제목이 없으면 폴백해야 한다");
  assert(parsed.body === "본문만 있습니다.", "본문은 그대로 읽어야 한다");
  console.log("✅ 파서 폴백");

  console.log("\n✅ generateNaverVariant 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
