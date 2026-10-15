// 러너 쪽 대기(B-1 ③): person 자료조사가 시작될 때 맥이 소스팩을 채울 때까지 최대 8분 기다린다.
// 타임아웃이면 지금처럼 재료 없이 진행한다(맥이 꺼져 있어도 더 나빠지지 않는다). 발화 체인은 바꾸지 않는다.
import { readPersonSourcePack } from "./personSourcePack.js";
import type { PersonSourcePack } from "./personSourcePack.js";

export const SOURCE_PACK_WAIT_MS = 8 * 60 * 1000;
export const SOURCE_PACK_POLL_INTERVAL_MS = 30 * 1000;

export type WaitForSourcePackOptions = {
  /** job의 현재 metadata를 읽는다(주입 가능). */
  readMetadata: () => Promise<Record<string, unknown> | null>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 현재 시각(ms). 테스트에서 가짜 시계로 바꾼다. */
  now?: () => number;
  log?: (message: string) => void;
};

export type WaitForSourcePackResult = { pack: PersonSourcePack | null; waitedMs: number; timedOut: boolean };

export async function waitForPersonSourcePack(options: WaitForSourcePackOptions): Promise<WaitForSourcePackResult> {
  const timeoutMs = options.timeoutMs ?? SOURCE_PACK_WAIT_MS;
  const intervalMs = options.intervalMs ?? SOURCE_PACK_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const startedAt = now();

  for (;;) {
    let pack: PersonSourcePack | null = null;
    try {
      pack = readPersonSourcePack(await options.readMetadata());
    } catch (error) {
      // 읽기 실패는 대기를 멈출 이유가 아니다 - 다음 주기에 다시 본다.
      log(`⚠️ [research] 소스팩 확인 실패(계속 대기): ${error instanceof Error ? error.message : error}`);
    }
    const waitedMs = now() - startedAt;
    if (pack) return { pack, waitedMs, timedOut: false };
    if (waitedMs + intervalMs > timeoutMs) {
      log(`⚠️ [research] 소스팩 대기 ${Math.round(waitedMs / 1000)}초 만료 - 인물DB·나무위키 재료 없이 진행합니다`);
      return { pack: null, waitedMs, timedOut: true };
    }
    if (waitedMs === 0) log("ℹ️ [research] 맥 소스팩(인물DB·나무위키) 대기 중 - 최대 8분");
    await sleep(intervalMs);
  }
}

/**
 * runResearchStage가 쓰는 결정: person이면 이미 있는 팩을 쓰고, 없으면 기다린다. 다른 카테고리는 아무것도 하지 않는다
 * (DB 조회도 대기도 없다).
 */
export async function resolvePersonSourcePack(input: {
  category: string | null | undefined;
  metadata: Record<string, unknown> | null;
  jobId: string;
  wait: (jobId: string) => Promise<PersonSourcePack | null>;
}): Promise<PersonSourcePack | null> {
  if (input.category !== "person") return null;
  return readPersonSourcePack(input.metadata) ?? (await input.wait(input.jobId));
}
