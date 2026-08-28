// buildImageBriefMessage 테스트. 실제 Telegram 발송은 하지 않는다 - 순수 조립 함수만 검증한다.

import { buildImageBriefMessage } from "./notifyImageBrief.js";
import type { ParsedImageBrief } from "./buildImageBrief.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "753d9af8-9d2d-4179-bf3f-139fa62ba813";

const BRIEF: ParsedImageBrief = {
  scene: "접힌 스마트폰의 실루엣을 미니멀하게, 파란 계열 그라데이션 배경",
  prompt: "A minimal illustration of a folding smartphone silhouette",
  altText: "폴더블 스마트폰을 형상화한 일러스트",
  prohibited: "실제 애플 제품 사진, 애플 로고, 실존 인물",
};

function main(): void {
  console.log("▶ buildImageBriefMessage 테스트 시작\n");

  const message = buildImageBriefMessage(JOB_ID, "아이폰18 폴더블", BRIEF);

  // 1) 네 필드가 모두 메시지에 실제로 담겨야 한다.
  assert(message.text.includes("파란 계열 그라데이션"), "장면 설명이 메시지에 있어야 한다");
  assert(message.text.includes("A minimal illustration"), "생성 프롬프트가 메시지에 있어야 한다");
  assert(message.text.includes("폴더블 스마트폰을 형상화한 일러스트"), "대체 텍스트가 메시지에 있어야 한다");
  assert(message.text.includes("애플 로고"), "금지 항목이 메시지에 있어야 한다");
  console.log("✅ 장면/프롬프트/대체텍스트/금지항목이 모두 메시지에 포함됨");

  // 2) 회귀: job:image 명령 안내에 실제 jobId가 정확히 들어가야 한다 - 사람이 복붙해서 쓸 값이다.
  assert(message.text.includes(`job:image -- ${JOB_ID}`), "job:image 안내에 jobId가 정확히 있어야 한다");
  console.log("✅ job:image 명령 안내에 jobId 포함");

  // 3) altText/prohibited가 비어 있어도(브리프가 부분 파싱됐을 때) 안내 문구로 대체돼야 한다.
  const partial = buildImageBriefMessage(JOB_ID, "키워드", { ...BRIEF, altText: "", prohibited: "" });
  assert(partial.text.includes("직접 작성 필요"), "빈 대체 텍스트는 안내 문구로 대체돼야 한다");
  assert(partial.text.includes("실존 인물, 브랜드 로고"), "빈 금지 항목은 기본 안내로 대체돼야 한다");
  console.log("✅ 빈 필드는 안내 문구로 안전하게 대체");

  // 4) HTML 특수문자가 섞인 프롬프트도 이스케이프한다(Telegram parse_mode=HTML 400 방지).
  const withHtml = buildImageBriefMessage(JOB_ID, "키워드", { ...BRIEF, prompt: "A <B> & C" });
  assert(withHtml.text.includes("&lt;B&gt;"), "프롬프트의 특수문자가 이스케이프돼야 한다");
  console.log("✅ HTML 특수문자 이스케이프");

  // 5) 회귀(2026-08-28 실측): job:image 안내 문구의 "<이미지 URL>" 플레이스홀더가 이스케이프되지
  // 않아 Telegram이 "<이미지"를 알 수 없는 HTML 태그로 해석해 발송이 400으로 거부됐다. 알려주는
  // 문구가 우리가 직접 쓴 하드코딩 텍스트여도 예외 없이 이스케이프해야 한다는 회귀 고정이다.
  assert(!message.text.includes("<이미지 URL>"), "꺾쇠괄호 플레이스홀더가 이스케이프 없이 남아 있으면 안 된다");
  assert(message.text.includes("&lt;이미지 URL&gt;"), "job:image 안내 문구도 이스케이프돼야 한다");
  console.log("✅ job:image 안내 문구의 꺾쇠괄호 플레이스홀더도 이스케이프됨(실측 회귀 - Telegram 400 방지)");

  console.log("\n✅ buildImageBriefMessage 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
