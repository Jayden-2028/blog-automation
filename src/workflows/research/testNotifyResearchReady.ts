// buildResearchPreviewMessages 테스트. 실제 Telegram 발송은 하지 않는다.

import { buildResearchPreviewMessages } from "./notifyResearchReady.js";
import { TELEGRAM_MESSAGE_CHAR_LIMIT } from "../../notifications/TelegramNotifier.js";
import type { ArticleJobRow, SourceRow } from "../../types/database.js";

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
    job_id: "48472dba-9763-4c26-9c31-86b233a04161",
    title: "예매권 추첨 응모 안내",
    url: "https://www.kh.or.kr/x",
    source_name: "naver_web",
    authority: "official",
    published_at: null,
    content: "예매권 추첨 응모 : 2026. 8. 14.(금) 14:00 ~ 8. 20.(목) 14:00, 당첨자 발표 8. 24.(월) 17:00",
    created_at: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function main(): void {
  console.log("▶ buildResearchPreviewMessages 테스트 시작\n");

  // 1) 등급별 건수 요약이 정확해야 한다.
  const sources = [
    makeSource({ id: 1, authority: "official" }),
    makeSource({ id: 2, authority: "official" }),
    makeSource({ id: 3, authority: "community" }),
  ];
  const messages = buildResearchPreviewMessages(makeJob(), sources);
  const combined = messages.map((m) => m.text).join("\n");
  assert(combined.includes("공공 2"), "공공 2건이 요약에 있어야 한다");
  assert(combined.includes("커뮤니티 1"), "커뮤니티 1건이 요약에 있어야 한다");
  console.log("✅ 등급별 건수 요약 정확");

  // 2) 진행/중단 명령어 안내에 jobId가 정확히 포함돼야 한다 - 사람이 복붙해서 쓸 값이다.
  assert(combined.includes(`job:write -- ${makeJob().id}`), "진행 명령어에 jobId가 있어야 한다");
  assert(combined.includes(`job:reject -- ${makeJob().id}`), "중단 명령어에 jobId가 있어야 한다");
  console.log("✅ 진행/중단 명령어에 jobId 포함");

  // 3) 핵심 회귀: 마감/응모 관련 발췌가 미리보기에 나타나야 한다(경복궁 사례 재현).
  assert(combined.includes("예매권 추첨 응모"), "출처 발췌가 미리보기에 포함돼야 한다");
  assert(combined.includes("당첨자 발표"), "마감 관련 문구가 잘리지 않고 보여야 한다");
  console.log("✅ 마감/응모 정보가 미리보기에 노출됨(경복궁 사례 회귀)");

  // 4) 발췌는 EXCERPT_LENGTH를 넘는 원문을 자르고 말줄임표를 붙인다(전체를 다 보내면 판단이 아니라 정독이 된다).
  const longContent = "가".repeat(500);
  const longMessages = buildResearchPreviewMessages(
    makeJob(),
    [makeSource({ content: longContent })]
  );
  const longCombined = longMessages.map((m) => m.text).join("\n");
  assert(longCombined.includes("…"), "긴 발췌는 말줄임표로 잘려야 한다");
  assert(!longCombined.includes("가".repeat(200)), "발췌가 원문 전체를 담으면 안 된다");
  console.log("✅ 긴 본문은 짧게 발췌 + 말줄임표");

  // 5) url/content가 없어도 죽지 않는다.
  const sparse = buildResearchPreviewMessages(makeJob(), [makeSource({ url: null, content: null, title: null })]);
  assert(sparse.length > 0, "필드가 비어 있어도 메시지는 만들어져야 한다");
  console.log("✅ 필드 누락에도 안전 처리");

  // 6) 출처가 많아 4000자를 넘으면 여러 메시지로 나뉜다.
  const manySources = Array.from({ length: 40 }, (_, i) =>
    makeSource({ id: i, title: `출처 제목 ${i}`, content: "내용 ".repeat(30) })
  );
  const manyMessages = buildResearchPreviewMessages(makeJob(), manySources);
  assert(manyMessages.length >= 2, `출처가 많으면 여러 메시지로 나뉘어야 한다 (실제: ${manyMessages.length}건)`);
  assert(
    manyMessages.every((m) => m.text.length <= TELEGRAM_MESSAGE_CHAR_LIMIT),
    "각 메시지는 글자 수 제한을 넘으면 안 된다"
  );
  console.log(`✅ 출처 40건 -> ${manyMessages.length}개 메시지로 분할, 각각 제한 이내`);

  console.log("\n✅ buildResearchPreviewMessages 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
