// `페이지 캡처` 자리 테스트. 실제 브라우저를 띄우지 않는다(capture를 주입한다).
//
// 지켜야 할 것: URL은 마커 둘째 줄에서 오고, 지어낸 값(URL이 아닌 것)은 찍지 않으며,
// 찍은 화면도 검증을 거쳐 맞지 않으면 비운다.

import { capturePagesForJob } from "./capturePagesForJob.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "카카오 선물하기에서 스타벅스 상품권을 보내면 1+1 쿠폰을 받습니다.",
  "[IMAGE: 카카오 선물하기 스타벅스 1+1 이벤트 안내 — 페이지 캡처]",
  "다음 문단입니다.",
  "[IMAGE: 매장에서 음료를 받는 손님 — AI 생성]",
].join("\n\n");
const PROMPTS = ["https://gift.kakao.com/page/37395", "A photorealistic photo, no text. 16:9."];

const shot = async () => ({ ok: true as const, buffer: Buffer.from("x"), mimeType: "image/jpeg", width: 2560, height: 1920 });
const upload = async ({ index }: { index: number }) => ({ ok: true as const, url: `https://s/${index}.jpg` });

// --- 1. 캡처 자리만 찍고, URL은 둘째 줄에서 가져온다 -------------------------------------------
{
  const urls: string[] = [];
  const result = await capturePagesForJob(
    { jobId: "job-1", body: BODY, imagePrompts: PROMPTS },
    { capture: async (url) => { urls.push(url); return shot(); }, chooseImage: false, upload }
  );
  assert(urls.length === 1 && urls[0] === "https://gift.kakao.com/page/37395", `캡처 자리만 URL로 연다 (${JSON.stringify(urls)})`);
  assert(result.images.length === 1 && result.images[0].index === 1, "자리 번호가 보존돼야 한다");
  assert(result.images[0].sourcePage === urls[0], "출처 URL이 기록돼야 한다");
  assert(result.images[0].license?.includes("gift.kakao.com"), "캡션 출처 표기가 있어야 한다");
  assert(result.images[0].provider === "capture", "provider가 capture여야 한다");
  console.log("✅ 페이지 캡처 - 캡처 자리만, URL은 마커 둘째 줄에서");
}

// --- 2. URL이 아니면 찍지 않는다(지어낸 설명이 들어온 경우) ------------------------------------
{
  let called = 0;
  const result = await capturePagesForJob(
    { jobId: "job-1", body: BODY, imagePrompts: ["카카오 선물하기 이벤트 페이지를 캡처", "p"] },
    { capture: async () => { called += 1; return shot(); }, chooseImage: false, upload }
  );
  assert(called === 0, "URL이 아니면 브라우저를 열지 않는다");
  assert(result.images.length === 0 && result.failures[0].includes("캡처할 URL이 없습니다"), "사유를 남겨야 한다");
  console.log("✅ URL이 아니면 캡처하지 않고 사유를 남긴다");
}

// --- 3. 찍은 화면이 맞지 않으면 비운다(로그인 벽·개편 대비) ------------------------------------
{
  const result = await capturePagesForJob(
    { jobId: "job-1", body: BODY, imagePrompts: PROMPTS },
    {
      capture: shot,
      chooseImage: async () => ({ picked: null, reason: "로그인 화면이 찍혔다" }),
      upload,
    }
  );
  assert(result.images.length === 0, "검증 불합격이면 채택하지 않는다");
  assert(result.failures.some((f) => f.includes("로그인 화면")), "사유가 전달돼야 한다");
  console.log("✅ 찍은 화면이 맞지 않으면 비우고 사유를 남긴다");
}

// --- 4. 이미 채워진 자리는 건너뛴다 ------------------------------------------------------------
{
  let called = 0;
  const result = await capturePagesForJob(
    { jobId: "job-1", body: BODY, imagePrompts: PROMPTS, filledIndexes: [1] },
    { capture: async () => { called += 1; return shot(); }, chooseImage: false, upload }
  );
  assert(called === 0 && result.images.length === 0, "이미 채워진 자리는 다시 찍지 않는다");
  console.log("✅ 이미 채워진 자리는 건너뛴다");
}

console.log("\n🎉 페이지 캡처 테스트 통과");
