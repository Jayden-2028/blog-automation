// naverPasteCheck 테스트. 브라우저 없이 판정 규칙만 고정한다.
//
// 가장 중요한 케이스는 **2026-10-03 사고 재현**이다: 글자는 다 들어갔는데 굵게·큰 글씨가 0이면
// 서식이 날아간 것이고, 그때 "성공"으로 통과시키면 안 된다. 예전 코드는 글자 수만 봤다.

import { convertArticleToNaverHtml } from "./convertArticleToNaverHtml.js";
import {
  describePasteGap,
  expectBodyFormat,
  isBodyFilled,
  isPasteFormatted,
  LARGE_FONT_MIN_PX,
  MIN_BODY_CHARS,
  nonWhitespaceLength,
} from "./naverPasteCheck.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

/** 실제 발행 경로와 같은 변환기를 거친 HTML을 쓴다 - 규칙이 갈라지면 이 테스트가 깨진다. */
const MARKDOWN = [
  "티빙 오리지널 <러브 바이러스>는 9년 차 연인이 결혼을 앞두고 각자 새로운 사람을 만나보는 로맨스 드라마입니다.",
  "**정해인 신세경, 첫 로맨스 호흡**\n정해인과 신세경은 이 작품에서 처음으로 로맨스 호흡을 맞춥니다. 두 사람이 연기하는 하도운과 강채린은 9년을 만난 연인입니다.",
  "![하도운과 강채린의 첫 만남 장면](https://example.supabase.co/storage/v1/object/public/article-images/1.png)",
  "- 하도운(정해인): 유복한 집안의 외동아들이자 능력 있는 변호사입니다.\n- 강채린(신세경): 하도운의 첫사랑이자 오랜 여자친구인 치과 페이닥터입니다.",
  "#러브바이러스 #티빙오리지널 #정해인 #신세경",
].join("\n\n");

async function main(): Promise<void> {
  console.log("▶ naverPasteCheck 테스트 시작\n");

  const html = convertArticleToNaverHtml(MARKDOWN);
  const expected = expectBodyFormat(html);

  // 1) 변환 결과에서 이미지·굵게·큰 글씨를 실제로 센다
  assert(expected.images === 1, `이미지 1장을 세야 한다(실제: ${expected.images})`);
  assert(expected.bold === 1, `소제목 굵게 1개를 세야 한다(실제: ${expected.bold})`);
  assert(expected.large === 1, `소제목 큰 글씨 1개를 세야 한다(실제: ${expected.large})`);
  assert(expected.chars > 100, `기대 글자 수가 계산돼야 한다(실제: ${expected.chars})`);
  console.log("✅ expectBodyFormat - 변환 결과에서 이미지/굵게/큰 글씨/글자 수를 센다");

  // 2) **2026-10-03 사고 재현**: 평문 타이핑으로 글자만 들어간 상태
  const plainOnly = { chars: expected.chars, images: 0, bold: 0, large: 0 };
  assert(isBodyFilled(expected, plainOnly), "글자는 다 들어간 상태여야 한다");
  assert(!isPasteFormatted(expected, plainOnly), "글자만 있고 서식이 없으면 성공으로 보면 안 된다");
  const gaps = describePasteGap(expected, plainOnly);
  assert(gaps.length === 3, `경고 3건(이미지/굵게/큰 글씨)이 나와야 한다(실제: ${gaps.length}건 - ${gaps.join(" / ")})`);
  console.log("✅ 사고 재현 - 글자만 들어가고 서식이 없으면 실패 판정 + 경고 3건");

  // 3) 정상 붙여넣기 - 기대대로 들어가면 통과하고 경고가 없다
  const good = { chars: expected.chars, images: 1, bold: 1, large: 1 };
  assert(isPasteFormatted(expected, good), "기대대로 들어가면 통과해야 한다");
  assert(describePasteGap(expected, good).length === 0, "기대대로 들어가면 경고가 없어야 한다");
  console.log("✅ 정상 붙여넣기 - 통과 + 경고 없음");

  // 4) 붙여넣기가 통째로 실패한 경우(빈 본문)
  const empty = { chars: 0, images: 0, bold: 0, large: 0 };
  assert(!isBodyFilled(expected, empty), "빈 본문은 실패여야 한다");
  assert(!isPasteFormatted(expected, empty), "빈 본문은 실패여야 한다");
  console.log("✅ 빈 본문 - 실패 판정");

  // 5) 중간에 잘린 경우 - 기대 글자의 절반만 들어왔다
  const truncated = { chars: Math.floor(expected.chars * 0.5), images: 1, bold: 1, large: 1 };
  assert(!isBodyFilled(expected, truncated), "절반만 들어오면 실패여야 한다");
  console.log("✅ 잘린 본문 - 60% 미만이면 실패 판정");

  // 6) 이미지만 빠진 경우 - 발행은 막지 않고 경고만 남긴다(SmartEditor 외부 이미지 처리 미검증)
  const noImage = { chars: expected.chars, images: 0, bold: 1, large: 1 };
  assert(isPasteFormatted(expected, noImage), "이미지 누락만으로 발행을 막지 않는다");
  const imageWarnings = describePasteGap(expected, noImage);
  assert(imageWarnings.length === 1 && imageWarnings[0].includes("이미지"), `이미지 경고 1건이어야 한다(실제: ${imageWarnings.join(" / ")})`);
  console.log("✅ 이미지 누락 - 통과시키되 경고로 남긴다");

  // 7) 기대값이 0인 항목은 묻지 않는다(소제목·이미지 없는 짧은 원고)
  const plainMarkdown = "짧은 글입니다. ".repeat(10);
  const plainExpected = expectBodyFormat(convertArticleToNaverHtml(plainMarkdown));
  assert(plainExpected.bold === 0 && plainExpected.large === 0 && plainExpected.images === 0, "기대값이 0이어야 한다");
  assert(
    isPasteFormatted(plainExpected, { chars: plainExpected.chars, images: 0, bold: 0, large: 0 }),
    "기대값이 0인 항목은 없어도 통과해야 한다"
  );
  console.log("✅ 소제목·이미지 없는 원고 - 없는 서식은 묻지 않는다");

  // 8) 상수 - 본문(15px)과 소제목(19px) 사이에 경계가 있어야 둘을 구분한다
  assert(LARGE_FONT_MIN_PX === 17, `큰 글씨 경계는 17px여야 한다(실제: ${LARGE_FONT_MIN_PX})`);
  assert(MIN_BODY_CHARS === 50, `최소 글자 수는 50이어야 한다(실제: ${MIN_BODY_CHARS})`);
  assert(nonWhitespaceLength(" 가 나\n다 ") === 3, "공백을 뺀 글자 수를 세야 한다");
  console.log("✅ 경계 상수 - 본문 15px < 17px < 소제목 19px");

  console.log("\n✅ 전체 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
