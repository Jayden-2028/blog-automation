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

// --- 액션 버튼(2026-09-22 네이버 재개로 1개 -> 3개, 2026-09-29 내려받기로 4개) ------------------
{
  const JOB = "054bfe0b-1234-4abc-8def-0123456789ab";
  const withUuid = buildManuscriptReadyMessage(successResult(job(JOB)), "https://pages.example.dev");
  const rows = withUuid.replyMarkup?.inline_keyboard ?? [];

  // 버튼이 4개가 되면서 두 줄로 나눴다 - 한 줄에 몰면 텔레그램에서 글자가 잘려 구분이 안 된다.
  if (rows.length !== 3) throw new Error(`❌ 페이지 열기 줄 + 액션 두 줄, 세 줄이어야 한다 (${JSON.stringify(rows)})`);
  if (!rows[0][0].url?.includes(`#${JOB}`)) throw new Error("❌ 첫 줄은 원고 페이지 딥링크여야 한다");

  const actions = [...rows[1], ...rows[2]];
  if (rows[1].length !== 2 || rows[2].length !== 1) {
    throw new Error(`❌ 액션 버튼은 2개 + 1개(네이버만)여야 한다 (${JSON.stringify(rows.slice(1))})`);
  }
  const expected = [
    { needle: "이미지", data: `publish:images:${JOB}` },
    { needle: "내려받기", data: `publish:export:${JOB}` },
    { needle: "네이버", data: `publish:naver:${JOB}` },
  ];
  expected.forEach((want, i) => {
    if (!actions[i].text.includes(want.needle)) throw new Error(`❌ ${i + 1}번 버튼 문구에 "${want.needle}"이 있어야 한다 (${actions[i].text})`);
    if (actions[i].callback_data !== want.data) throw new Error(`❌ ${i + 1}번 콜백이 틀렸다 (${actions[i].callback_data})`);
  });

  if (actions.some((a) => a.callback_data?.startsWith("publish:blogspot:"))) {
    throw new Error("❌ 엔터 트랙에는 블로그(Blogspot) 발행 버튼이 없어야 한다");
  }

  // jobId가 UUID가 아니면 버튼만 빠지고 알림 자체는 살아야 한다(예외로 알림을 죽이지 않는다).
  const legacy = buildManuscriptReadyMessage(successResult(job("a")), "https://pages.example.dev");
  const legacyRows = legacy.replyMarkup?.inline_keyboard ?? [];
  if (legacyRows.length !== 1 || legacyRows[0].length !== 1) throw new Error("❌ UUID가 아니면 액션 버튼만 빠져야 한다");
  if (!legacy.text.includes("원고 준비 완료")) throw new Error("❌ 알림 본문은 그대로여야 한다");
  console.log("✅ 액션 버튼 - 이미지 수정/맥으로 내려받기/네이버 발행(블로그 발행 없음), UUID 아니면 생략");
}

// --- 사회 트랙(2026-10-05, §3.3): 자동 발행 없음 -> 발행 버튼 없이 수동 발행 안내 -------------------
{
  const JOB = "154bfe0b-1234-4abc-8def-0123456789ab";
  const socialJob = { ...job(JOB), metadata: { track: "social" } } as ArticleJobRow;
  const msg = buildManuscriptReadyMessage(successResult(socialJob), "https://pages.example.dev");
  const rows = msg.replyMarkup?.inline_keyboard ?? [];
  const all = rows.flat();

  if (all.some((b) => b.callback_data?.startsWith("publish:naver:") || b.callback_data?.startsWith("publish:blogspot:"))) {
    throw new Error("❌ 사회 트랙에는 네이버·블로그 발행 버튼이 없어야 한다");
  }
  if (!all.some((b) => b.callback_data === `publish:images:${JOB}`)) throw new Error("❌ 이미지 수정 버튼은 있어야 한다");
  if (!all.some((b) => b.callback_data === `publish:export:${JOB}`)) throw new Error("❌ 맥으로 내려받기 버튼은 있어야 한다");
  if (rows[0]?.[0]?.url !== `https://pages.example.dev/social.html#${JOB}`) {
    throw new Error(`❌ 원고 페이지 링크는 social.html 딥링크여야 한다 (${rows[0]?.[0]?.url})`);
  }
  if (!msg.text.includes("티스토리")) throw new Error("❌ 티스토리 수동 발행 안내가 있어야 한다");
  if (msg.text.includes("🟢 네이버")) throw new Error("❌ 사회 알림에 네이버 표기가 있으면 안 된다");

  // 엔터 job은 그대로다(트랙 값이 없으면 엔터).
  const ent = buildManuscriptReadyMessage(successResult(job(JOB)), "https://pages.example.dev");
  if (!(ent.replyMarkup?.inline_keyboard ?? []).flat().some((b) => b.callback_data === `publish:naver:${JOB}`)) {
    throw new Error("❌ 엔터 알림에는 네이버 발행 버튼이 그대로 있어야 한다");
  }
  if (ent.replyMarkup?.inline_keyboard[0][0].url !== `https://pages.example.dev/#${JOB}`) {
    throw new Error("❌ 엔터 딥링크는 기존 루트 그대로여야 한다");
  }
  console.log("✅ 사회 트랙 - 발행 버튼 없음, social.html 딥링크, 티스토리 수동 발행 안내 (엔터는 불변)");
}
