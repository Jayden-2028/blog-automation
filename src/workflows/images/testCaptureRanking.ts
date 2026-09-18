// 순위표 캡처 판정·연결 테스트. 외부 사이트를 열지 않는다(캡처 함수를 주입한다).
//
// 지켜야 할 것: 등록된 순위만 캡처로 가고, 캡처가 막히면 본문 데이터로 그리는 원래 경로로 돌아온다.

import { matchRankingSource, RANKING_SOURCES } from "./captureRankingImage.js";
import { renderTableImagesForJob } from "./renderTableImagesForJob.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

// --- 1. 출처 판정 ------------------------------------------------------------------------------
{
  assert(matchRankingSource("너 말고 다른 연애 TV 화제성 순위")?.id === "tv-buzz", "화제성 → 펀덱스");
  assert(matchRankingSource("인턴 박스오피스 순위와 누적 관객수")?.id === "box-office", "박스오피스 → CGV");
  assert(matchRankingSource("CGV 무비차트 상위권")?.id === "box-office", "무비차트 → CGV");
  assert(matchRankingSource("신청·심사·계좌개설 일정") === null, "일반 표는 캡처 대상이 아니다");
  assert(matchRankingSource("카페 픽업대 사진") === null, "사진 자리는 캡처 대상이 아니다");
  assert(RANKING_SOURCES.every((s) => /^https:\/\//.test(s.url) && s.attribution), "출처마다 URL과 표기가 있어야 한다");
  console.log("✅ 순위 출처 판정 - 화제성/박스오피스만, 일반 표·사진은 제외");
}

const BODY = [
  "1회 2.6%, 2회 2.8%를 기록했습니다.",
  "[IMAGE: 너 말고 다른 연애 TV 화제성 순위 — 표 생성]",
].join("\n\n");

// --- 2. 등록된 순위는 캡처로 가고 출처가 기록된다 ------------------------------------------------
{
  let capturedId = "";
  const result = await renderTableImagesForJob(
    { jobId: "job-1", body: BODY, imagePrompts: ["화제성"] },
    {
      captureRanking: async (source) => {
        capturedId = source.id;
        return { ok: true as const, buffer: Buffer.from("x"), mimeType: "image/jpeg", width: 1140, height: 2072 };
      },
      upload: async () => ({ ok: true as const, url: "https://s/3.jpg" }),
    }
  );
  assert(capturedId === "tv-buzz", `펀덱스를 캡처해야 한다 (${capturedId})`);
  assert(result.images.length === 1 && result.images[0].url === "https://s/3.jpg", "캡처 결과가 저장돼야 한다");
  assert(result.images[0].sourcePage?.includes("fundex"), "출처 URL이 기록돼야 한다");
  assert(result.images[0].license?.includes("펀덱스"), "캡션 출처 표기가 있어야 한다");
  assert(result.images[0].fileName.endsWith(".jpg"), "jpeg 캡처는 .jpg로 저장한다");
  console.log("✅ 등록 순위 → 사이트 캡처 + 출처·캡션 표기 기록");
}

// --- 3. 캡처가 막히면 본문 데이터로 그리는 경로로 돌아온다 --------------------------------------
{
  const withList = [
    "**화제성 순위**",
    "- 1위: 포핸즈 7.38%",
    "- 4위: 너 말고 다른 연애 4.86%",
    "",
    "[IMAGE: 너 말고 다른 연애 TV 화제성 순위 — 표 생성]",
  ].join("\n");

  let rendered = false;
  const result = await renderTableImagesForJob(
    { jobId: "job-1", body: withList, imagePrompts: ["화제성"] },
    {
      captureRanking: async () => ({ ok: false as const, error: "봇 차단" }),
      render: async () => {
        rendered = true;
        return { ok: true as const, buffer: Buffer.from("x"), mimeType: "image/png" };
      },
      upload: async () => ({ ok: true as const, url: "https://s/1.png" }),
    }
  );
  assert(rendered, "캡처 실패 시 본문 데이터로 그려야 한다");
  assert(result.images.length === 1, "그린 결과가 저장돼야 한다");
  assert(result.images[0].sourcePage == null, "직접 그린 표에는 출처가 없다");
  assert(result.failures.some((f) => f.includes("캡처 실패")), "캡처 실패가 기록돼야 한다");
  console.log("✅ 캡처 실패 → 본문 데이터 렌더로 폴백");
}

// --- 4. captureRanking: false면 캡처를 아예 시도하지 않는다 --------------------------------------
{
  const result = await renderTableImagesForJob(
    { jobId: "job-1", body: BODY, imagePrompts: ["화제성"] },
    { captureRanking: false, render: async () => ({ ok: true as const, buffer: Buffer.from("x"), mimeType: "image/png" }) }
  );
  // 앞 문단에 표·목록이 없으므로 데이터를 못 찾고 끝난다 - 캡처를 타지 않았다는 증거다.
  assert(result.images.length === 0 && result.failures.some((f) => f.includes("찾지 못했습니다")), "캡처를 끄면 본문 데이터 경로만 탄다");
  console.log("✅ captureRanking: false - 외부 사이트를 열지 않는다");
}

console.log("\n🎉 순위표 캡처 테스트 통과");
