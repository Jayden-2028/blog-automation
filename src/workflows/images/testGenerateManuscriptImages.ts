// generateManuscriptImages 테스트. 이미지 API(OpenAI/Gemini)와 Supabase Storage, 비용 원장을
// 전부 주입해 짝짓기·A/B·실패 격리·상한·비용 기록만 검증한다. 외부 호출·유료 호출 없음.
//
// record를 반드시 주입하는 이유(2026-09-16): 기본 구현이 Supabase에 insert하므로, 주입하지 않으면
// 이 테스트가 조용히 네트워크를 타게 된다("외부 호출 없음"이라는 이 파일의 전제가 깨진다).

import { generateManuscriptImages } from "./generateManuscriptImages.js";
import type { ManuscriptImageConfig } from "../../config/manuscriptImages.js";
import type { RecordApiUsageInput } from "../../services/usage/recordApiUsage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const cfg = (over: Partial<ManuscriptImageConfig> = {}): ManuscriptImageConfig => ({
  enabled: true,
  abCompare: false,
  maxPerArticle: 6,
  ...over,
});

const BODY = [
  "도입 문단입니다.",
  "[IMAGE: 광안리 밤바다 드론쇼]",
  "**첫 소제목**\n소제목 문단입니다.",
  "[IMAGE: 관람객으로 붐비는 해변]",
  "마무리 문단입니다.",
].join("\n\n");

const PROMPTS = ["Night drone light show over a city beach", "Crowd watching a light show at a beach"];

const okGenerate = async (_input: { prompt: string }, provider?: string) => {
  const resolved = (provider ?? "openai") as "openai" | "gemini";
  return {
    ok: true as const,
    imageBuffer: Buffer.from("fake"),
    mimeType: "image/png",
    provider: resolved,
    model: resolved === "gemini" ? "gemini-3.1-flash-lite-image" : "gpt-image-2",
    // 실제 응답과 같은 자리수(1536x864 quality=low 실측 = 출력 120토큰).
    usage: { inputTokens: 30, imageInputTokens: 0, outputTokens: 120, totalTokens: 150 },
  };
};

/** 비용 원장 기록을 가로챈다. 기본 구현은 Supabase insert라 테스트에서 타면 안 된다. */
const recorded: RecordApiUsageInput[] = [];
const recordStub = async (event: RecordApiUsageInput): Promise<void> => {
  recorded.push(event);
};

const okUpload = async (input: { jobId: string; index: number; variant?: string }) => ({
  ok: true as const,
  url: `https://storage/${input.jobId}/${input.index}${input.variant ? "-" + input.variant : ""}.png`,
  path: "x",
});

const input = { jobId: "job-1", keyword: "광안리 드론쇼", date: "2026-09-15", body: BODY, imagePrompts: PROMPTS };

async function main(): Promise<void> {
  console.log("▶ generateManuscriptImages 테스트 시작\n");

  // 1) 꺼져 있으면 아무것도 하지 않는다(기본값 - 유료 호출 가드).
  let calls = 0;
  const off = await generateManuscriptImages(input, {
    config: cfg({ enabled: false }),
    generate: async () => {
      calls += 1;
      return okGenerate({ prompt: "" });
    },
    upload: okUpload,
    record: recordStub,
  });
  assert(off.images.length === 0 && calls === 0, "비활성 상태에서는 이미지 API를 호출하면 안 된다");
  console.log("✅ MANUSCRIPT_IMAGE_GENERATION=false -> 호출 없음");

  // 2) 단일 provider: 마커 수만큼 만들고 프롬프트가 순서대로 짝지어진다.
  const prompts: string[] = [];
  const single = await generateManuscriptImages(input, {
    config: cfg(),
    generate: async (i) => {
      prompts.push(i.prompt);
      return okGenerate(i);
    },
    upload: okUpload,
    record: recordStub,
  });
  assert(single.images.length === 2, `마커 2개 -> 이미지 2장 (${single.images.length})`);
  assert(prompts[0] === PROMPTS[0] && prompts[1] === PROMPTS[1], `프롬프트 순서가 어긋났다 (${JSON.stringify(prompts)})`);
  assert(single.images[0].index === 1 && single.images[1].index === 2, "index는 본문 마커 순서(1부터)여야 한다");
  assert(single.images[0].description === "광안리 밤바다 드론쇼", "설명이 캡션으로 넘어와야 한다");
  assert(single.images[0].url?.endsWith("/1.png"), `단일 provider면 파일명에 꼬리표가 없어야 한다 (${single.images[0].url})`);
  assert(single.failures.length === 0, "정상 경로에 실패가 없어야 한다");
  console.log("✅ 단일 provider - 마커 수만큼 생성, 프롬프트 순서 유지");

  // 3) A/B 비교: 같은 index로 provider만 다른 2장.
  const ab = await generateManuscriptImages(input, {
    config: cfg({ abCompare: true }),
    generate: okGenerate,
    upload: okUpload,
    record: recordStub,
    providers: ["openai", "gemini"],
  });
  assert(ab.images.length === 4, `마커 2개 x provider 2개 = 4장 (${ab.images.length})`);
  const first = ab.images.filter((i) => i.index === 1);
  assert(first.length === 2, "같은 index에 2장이 있어야 한다");
  assert(
    first.map((i) => i.provider).sort().join(",") === "gemini,openai",
    `provider가 둘 다 있어야 한다 (${JSON.stringify(first.map((i) => i.provider))})`
  );
  assert(
    first.every((i) => i.url?.includes("-" + i.provider)),
    `A/B면 파일명에 provider 꼬리표가 붙어야 한다 (${JSON.stringify(first.map((i) => i.url))})`
  );
  console.log("✅ A/B 비교 - 같은 index에 provider별 2장, 파일명 분리");

  // 4) 한 장이 실패해도 나머지는 계속 만든다(best-effort). 실패한 자리는 url=null + 사유.
  let n = 0;
  const partial = await generateManuscriptImages(input, {
    config: cfg(),
    generate: async (i) => {
      n += 1;
      return n === 1
        ? { ok: false as const, error: "rate limit", provider: "openai" as const, model: "gpt-image-2" }
        : okGenerate(i);
    },
    upload: okUpload,
    record: recordStub,
  });
  assert(partial.images.length === 2, "실패한 자리도 항목은 남아야 한다(뷰어가 사유를 보여준다)");
  assert(partial.images[0].url === null && partial.images[0].error === "rate limit", "실패 사유가 기록돼야 한다");
  assert(partial.images[1].url !== null, "앞 장이 실패해도 뒷 장은 만들어야 한다");
  assert(partial.failures.length === 1 && partial.failures[0].includes("rate limit"), "실패 목록에 남아야 한다");
  console.log("✅ 부분 실패 - 나머지 계속 생성 + 실패 사유 기록");

  // 5) 업로드 실패도 같은 방식으로 격리된다.
  const upFail = await generateManuscriptImages(input, {
    config: cfg(),
    generate: okGenerate,
    upload: async () => ({ ok: false as const, error: "bucket not found" }),
    record: recordStub,
  });
  assert(upFail.images.every((i) => i.url === null), "업로드 실패면 url이 없어야 한다");
  assert(upFail.failures.length === 2, "업로드 실패도 사유로 남아야 한다");
  console.log("✅ 업로드 실패 격리");

  // 6) 프롬프트 수가 마커 수와 안 맞으면 그 문서 전체가 "프롬프트 미상"이라 생성하지 않는다
  //    (parseManuscriptBlocks의 안전 규칙 - 엉뚱한 이미지에 엉뚱한 프롬프트를 붙이느니 안 만든다).
  let mismatchCalls = 0;
  const mismatch = await generateManuscriptImages(
    { ...input, imagePrompts: ["프롬프트 하나뿐"] },
    {
      config: cfg(),
      generate: async (i) => {
        mismatchCalls += 1;
        return okGenerate(i);
      },
      upload: okUpload,
      record: recordStub,
    }
  );
  assert(mismatchCalls === 0, "프롬프트 짝이 안 맞으면 생성하면 안 된다");
  assert(mismatch.images.every((i) => i.url === null), "그 자리는 미생성으로 남아야 한다");
  assert(mismatch.failures.length === 2, "건너뛴 사유가 남아야 한다");
  console.log("✅ 마커/프롬프트 개수 불일치 -> 생성 안 함(안전)");

  // 7) 상한: maxPerArticle을 넘으면 앞에서부터 자른다.
  const capped = await generateManuscriptImages(input, {
    config: cfg({ maxPerArticle: 1 }),
    generate: okGenerate,
    upload: okUpload,
    record: recordStub,
  });
  assert(capped.images.length === 1, `상한 1이면 1장만 (${capped.images.length})`);
  assert(capped.failures.some((f) => f.includes("상한")), "상한으로 잘렸다는 사실을 남겨야 한다");
  console.log("✅ maxPerArticle 상한 적용");

  // 8) 비용 기록(2026-09-16). 이 계측이 빠지면 대시보드의 금액이 영영 0으로 남는다.
  recorded.length = 0;
  const metered = await generateManuscriptImages(input, {
    config: cfg({ abCompare: true }),
    generate: okGenerate,
    upload: okUpload,
    record: recordStub,
    providers: ["openai", "gemini"],
  });
  assert(metered.images.length === 4, "A/B 4장 전제");
  assert(recorded.length === 4, `성공한 호출 수만큼 기록돼야 한다 (실제: ${recorded.length})`);
  assert(
    recorded.every((r) => r.operation === "image.generate" && r.jobId === "job-1"),
    "어느 원고 때문에 나간 비용인지(job_id)가 붙어야 원고당 단가를 낼 수 있다"
  );
  assert(
    recorded.some((r) => r.model === "gpt-image-2") && recorded.some((r) => r.model === "gemini-3.1-flash-lite-image"),
    "실제로 호출한 모델 ID가 그대로 넘어가야 단가표와 맞는다"
  );
  assert(recorded[0].usage?.outputTokens === 120, "응답의 usage가 그대로 실려야 한다");
  console.log("✅ 성공한 호출만 비용 원장에 기록 + job_id/모델/usage 전달");

  // 실패한 호출은 과금되지 않으므로 원장에 남기지 않는다($0 행만 쌓여 호출 수가 부풀 뿐이다).
  recorded.length = 0;
  await generateManuscriptImages(input, {
    config: cfg(),
    generate: async () => ({ ok: false as const, error: "rate limit", provider: "openai" as const, model: "gpt-image-2" }),
    upload: okUpload,
    record: recordStub,
  });
  assert(recorded.length === 0, `실패 호출은 기록하지 않는다 (실제: ${recorded.length})`);
  console.log("✅ 실패 호출은 원장에 남기지 않음");

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
