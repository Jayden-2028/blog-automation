// Serper 호출 1건을 비용 원장(api_usage)에 남긴다(2026-10-06 재가동, SERPER-REVIVAL B).
//
// **fire-and-forget이다.** 호출부(searchSerperImages 등)는 Promise.all로 병렬이고 429 재시도 루프 안에
// 있다 - 기록을 await하면 검색이 DB 왕복만큼 느려지고, 기록이 실패하면 검색 결과를 잃는다.
// 그래서 기다리지 않고, 동기 예외·비동기 거부 모두 삼킨다(경고만 찍는다).
//
// 성공/실패를 operation 이름으로 가른다 - `image.search`는 크레딧을 쓴 호출, `image.search.failed`는 안 쓴 호출
// (400 크레딧 소진·429 한도). byModel 집계에서 두 줄로 따로 보이고, 잔여 크레딧 추정은 성공 행만 센다.

import { SERPER_IMAGES_MODEL, SERPER_SEARCH_MODEL } from "../../config/apiPricing.js";
import { recordApiUsage } from "./recordApiUsage.js";

export type SerperEndpoint = "images" | "search";

export type RecordSerperUsageInput = {
  endpoint: SerperEndpoint;
  /** 응답이 2xx였는가. 네트워크 실패면 false + status 0. */
  ok: boolean;
  status: number;
  /** 어느 원고 때문에 나간 호출인가. 원고당 단가(perManuscript)에 잡히려면 필요하다. */
  jobId?: string | null;
  /** 테스트 주입. 기본은 실제 원장 기록. */
  record?: typeof recordApiUsage;
};

export function recordSerperUsage(input: RecordSerperUsageInput): void {
  try {
    const record = input.record ?? recordApiUsage;
    const base = input.endpoint === "images" ? "image.search" : "web.search";
    void Promise.resolve(
      record({
        provider: "serper",
        model: input.endpoint === "images" ? SERPER_IMAGES_MODEL : SERPER_SEARCH_MODEL,
        operation: input.ok ? base : `${base}.failed`,
        quantity: 1,
        billedQueries: input.ok ? 1 : 0,
        jobId: input.jobId ?? null,
        metadata: { endpoint: input.endpoint, ok: input.ok, status: input.status },
      })
    ).catch((error) => {
      console.warn(`⚠️ Serper 사용량 기록 실패(무시하고 계속): ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    console.warn(`⚠️ Serper 사용량 기록 실패(무시하고 계속): ${error instanceof Error ? error.message : String(error)}`);
  }
}
