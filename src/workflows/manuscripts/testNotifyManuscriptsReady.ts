// buildManuscriptReadyMessage 테스트. pagesUrl을 주입해 Cloudflare 설정 전/후 두 분기를 검증한다
// (cloudflarePagesUrl()은 환경변수 기반 상수라 직접 흔들지 않고 인자로 override).
import { buildManuscriptReadyMessage } from "./notifyManuscriptsReady.js";
import type { JobManuscriptsResult } from "./prepareApprovedManuscripts.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(id: string): ArticleJobRow {
  return {
    id,
    source_run_id: 1,
    source_rank: 1,
    keyword: `키워드 ${id}`,
    headline: null,
    seed_query: null,
    category: "living",
    total_score: 50,
    score_breakdown: null,
    status: "approved",
    selected_at: "x",
    selected_via: "telegram",
    metadata: {},
    created_at: "x",
    updated_at: "x",
  } as ArticleJobRow;
}

function successResult(j: ArticleJobRow): JobManuscriptsResult {
  return {
    job: j,
    result: {
      status: "success",
      imageFailures: [],
      topic: {
        jobId: j.id,
        keyword: j.keyword,
        category: j.category,
        date: "2026-09-06",
        readyAt: "2026-09-06T00:00:00Z",
        manuscript: {
          title: "제목",
          searchDescription: null,
          slug: null,
          tags: [],
          body: "본문",
          imagePrompts: [],
          images: [],
          filePath: "x",
        },
      },
    },
  };
}

async function main(): Promise<void> {
  console.log("▶ buildManuscriptReadyMessage 테스트 시작\n");

  // 1) Cloudflare 미설정(null) -> 로컬 경로 텍스트로 폴백, 버튼 없음
  const m1 = buildManuscriptReadyMessage(successResult(job("a")), null);
  assert(!m1.replyMarkup, "미설정이면 버튼이 없어야 한다");
  assert(m1.text.includes("manuscripts/index.html") || m1.text.includes("<code>"), "미설정이면 로컬 경로 문구가 있어야 한다");
  console.log("✅ Cloudflare 미설정 -> 로컬 경로 텍스트 폴백");

  // 2) Cloudflare 설정됨 -> 딥링크 버튼(#jobId), 로컬 경로 문구 없음
  const m2 = buildManuscriptReadyMessage(successResult(job("b")), "https://test-project.pages.dev");
  assert(m2.replyMarkup?.inline_keyboard[0][0].url === "https://test-project.pages.dev/#b", `딥링크 URL 실패 (${JSON.stringify(m2.replyMarkup)})`);
  assert(!m2.text.includes("manuscripts/index.html"), "설정됐으면 로컬 경로 문구가 없어야 한다");
  console.log("✅ Cloudflare 설정됨 -> #jobId 딥링크 버튼");

  // 3) 실패 케이스는 URL 설정 여부와 무관하게 항상 같은 형태
  const failed: JobManuscriptsResult = { job: job("c"), result: { status: "failed", reason: "타임아웃" } };
  const m3 = buildManuscriptReadyMessage(failed, "https://test-project.pages.dev");
  assert(!m3.replyMarkup && m3.text.includes("타임아웃"), "실패 메시지는 버튼 없이 사유만 담아야 한다");
  console.log("✅ 실패 케이스 - 버튼 없음, 사유 텍스트만");

  console.log("\n✅ buildManuscriptReadyMessage 테스트 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// --- 액션 버튼(2026-09-22 네이버 재개로 1개 -> 3개) ----------------------------------------------
{
  const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";
  const withUuid = buildManuscriptReadyMessage(successResult(job(JOB)), "https://pages.example.dev");
  const rows = withUuid.replyMarkup?.inline_keyboard ?? [];

  // 버튼이 3개가 되면서 줄을 나눴다 - 한 줄에 몰면 텔레그램에서 글자가 잘려 구분이 안 된다.
  if (rows.length !== 2) throw new Error(`❌ 페이지 열기 줄 + 액션 줄, 두 줄이어야 한다 (${JSON.stringify(rows)})`);
  if (!rows[0][0].url?.includes(`#${JOB}`)) throw new Error("❌ 첫 줄은 원고 페이지 딥링크여야 한다");

  const actions = rows[1];
  if (actions.length !== 3) throw new Error(`❌ 액션 버튼 3개여야 한다 (${JSON.stringify(actions)})`);
  const expected = [
    { needle: "이미지", data: `publish:images:${JOB}` },
    { needle: "블로그", data: `publish:blogspot:${JOB}` },
    { needle: "네이버", data: `publish:naver:${JOB}` },
  ];
  expected.forEach((want, i) => {
    if (!actions[i].text.includes(want.needle)) throw new Error(`❌ ${i + 1}번 버튼 문구에 "${want.needle}"이 있어야 한다 (${actions[i].text})`);
    if (actions[i].callback_data !== want.data) throw new Error(`❌ ${i + 1}번 콜백이 틀렸다 (${actions[i].callback_data})`);
  });

  // jobId가 UUID가 아니면 버튼만 빠지고 알림 자체는 살아야 한다(예외로 알림을 죽이지 않는다).
  const legacy = buildManuscriptReadyMessage(successResult(job("a")), "https://pages.example.dev");
  const legacyRows = legacy.replyMarkup?.inline_keyboard ?? [];
  if (legacyRows.length !== 1 || legacyRows[0].length !== 1) throw new Error("❌ UUID가 아니면 액션 버튼만 빠져야 한다");
  if (!legacy.text.includes("원고 준비 완료")) throw new Error("❌ 알림 본문은 그대로여야 한다");
  console.log("✅ 액션 버튼 - 이미지 수정/블로그 발행/네이버 발행, UUID 아니면 생략");
}
