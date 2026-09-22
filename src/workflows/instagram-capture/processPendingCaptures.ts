// 큐의 대기 항목을 순서대로 캡처 -> job 생성 -> 자료조사 발화까지 이어서 처리한다(2026-09-22).
//
// 이것이 마지막으로 빠져 있던 고리다. 텔레그램 전송 이후 원고 초안이 도착할 때까지 사람 개입이
// 없어야 한다는 요구(INSTAGRAM_CAPTURE_AUTOMATION.md)를 여기서 만족시킨다.
//
// 항목은 서로 독립이다 - 하나가 막혀도 나머지를 계속 처리한다. 실패는 그 항목만 pending으로
// 두고 attempts를 올린다. MAX_ATTEMPTS를 넘으면 skipped로 내리고 알린다(매 분 영원히 재시도하면
// 실패 알림만 쌓이고 Claude 사용량도 샌다).

import { rm } from "node:fs/promises";

// 무거운 의존(브라우저·모델·DB)은 **함수 안에서 동적으로** 부른다. 정적 import면 이 모듈을 읽는
// 것만으로 supabase 클라이언트가 로드되고, 그 모듈은 자격증명이 없으면 throw한다 - 테스트가 전부
// 가짜를 주입하는데도 돌지 않게 된다(실제로 한 번 막혔다). createInstagramJobCli와 같은 이유다.
import { instagramProfilePath } from "./captureInstagramCarousel.js";
import { listPendingEntries, markEntry } from "./instagramQueue.js";
import { parseCaptureFile } from "./parseCaptureFile.js";
import type { runCaptureSession } from "./runCaptureSession.js";
import type { createInstagramJob } from "./createInstagramJob.js";
import type { InstagramQueueEntry } from "./types.js";

export const MAX_ATTEMPTS = 3;

export type ProcessResult = {
  attempted: number;
  created: number;
  failed: number;
  givenUp: number;
  messages: string[];
};

export type ProcessDeps = {
  listPending?: () => InstagramQueueEntry[];
  runSession?: typeof runCaptureSession;
  createJob?: typeof createInstagramJob;
  triggerResearch?: (jobId: string) => Promise<void>;
  mark?: typeof markEntry;
  /** 한 번의 폴링에서 처리할 최대 건수. 캐러셀 캡처 + 모델 판정이 건당 수십 초 걸린다. */
  limit?: number;
};

export function captureAutoEnabled(): boolean {
  return process.env.IG_CAPTURE_AUTO === "true";
}

export async function processPendingCaptures(deps: ProcessDeps = {}): Promise<ProcessResult> {
  const listPending = deps.listPending ?? (() => listPendingEntries());
  const mark = deps.mark ?? markEntry;
  const runSession =
    deps.runSession ?? (async (...args) => (await import("./runCaptureSession.js")).runCaptureSession(...args));
  const createJob =
    deps.createJob ?? (async (capture) => (await import("./createInstagramJob.js")).createInstagramJob(capture));
  const triggerResearch =
    deps.triggerResearch ?? (async (jobId) => (await import("./triggerResearch.js")).triggerResearchForJob(jobId));
  const limit = deps.limit ?? 2;

  const result: ProcessResult = { attempted: 0, created: 0, failed: 0, givenUp: 0, messages: [] };
  const pending = listPending().slice(0, limit);

  for (const entry of pending) {
    result.attempted += 1;
    const attempts = (entry.attempts ?? 0) + 1;

    const session = await runSession(entry, {
      capture: async (url) => (await import("./captureInstagramCarousel.js")).captureInstagramCarousel(url),
      judge: async (captured, queueEntry) =>
        (await import("./judgeCarouselSlides.js")).judgeCarouselSlides(captured, queueEntry),
      findCleanAlternative: async (input) =>
        (await import("./findCleanAlternative.js")).findCleanAlternative(input, {
          tempDir: process.env.TMPDIR ?? "/tmp",
        }),
      cleanup: (dir) => rm(dir, { recursive: true, force: true }),
    });

    if (session.status === "failed") {
      result.failed += 1;
      if (attempts >= MAX_ATTEMPTS) {
        result.givenUp += 1;
        mark(entry.id, { status: "skipped", attempts, lastError: session.error });
        result.messages.push(
          `⛔ ${entry.instagramUrl}\n   ${MAX_ATTEMPTS}회 실패해 포기했습니다: ${session.error}\n   수동 처리: npm run ig:create-job -- <json>`
        );
      } else {
        mark(entry.id, { attempts, lastError: session.error });
        result.messages.push(`⚠️ ${entry.instagramUrl}\n   ${attempts}/${MAX_ATTEMPTS}회 실패: ${session.error}`);
      }
      continue;
    }

    // createInstagramJob에 넘기기 전에 ig:create-job과 **같은 검증**을 통과시킨다 - 자동 경로라고
    // 검사를 건너뛰면 잘못된 job이 조용히 생기고, 그때는 되돌리기가 번거롭다.
    const parsed = parseCaptureFile(session.capture as unknown);
    if (!parsed.ok) {
      result.failed += 1;
      const error = `캡처 결과가 규격에 맞지 않습니다: ${parsed.errors.join(" / ")}`;
      if (attempts >= MAX_ATTEMPTS) {
        result.givenUp += 1;
        mark(entry.id, { status: "skipped", attempts, lastError: error });
      } else {
        mark(entry.id, { attempts, lastError: error });
      }
      result.messages.push(`⚠️ ${entry.instagramUrl}\n   ${error}`);
      continue;
    }

    const created = await createJob(parsed.capture);
    result.created += 1;
    // createInstagramJob이 큐 항목을 done으로 바꾼다. attempts는 기록용으로 남긴다.
    mark(entry.id, { attempts });

    await triggerResearch(created.jobId).catch((error) => {
      // job은 이미 만들어졌다 - 조사 발화만 실패한 것이라 수동으로 이어 돌릴 수 있다.
      result.messages.push(
        `⚠️ job ${created.jobId}는 만들었지만 자료조사 발화에 실패했습니다: ${error instanceof Error ? error.message : error}\n   이어서: npm run job:research -- ${created.jobId}`
      );
    });

    result.messages.push(
      `✅ ${entry.instagramUrl}\n   job ${created.jobId} (이미지 ${session.slidesUsed}장${session.slidesDropped > 0 ? `, 자리 ${session.slidesDropped}개 비움` : ""}) - 조사 시작`
    );
  }

  return result;
}

/** 폴러가 캡처까지 이어서 할 수 있는 상태인지. 아니면 이유를 돌려준다. */
export function captureReadiness(): { ready: true } | { ready: false; reason: string } {
  if (!captureAutoEnabled()) {
    return { ready: false, reason: "IG_CAPTURE_AUTO가 true가 아닙니다 - 캡처 자동화를 건너뜁니다." };
  }
  if (!instagramProfilePath()) {
    return { ready: false, reason: "IG_BROWSER_PROFILE이 없습니다 - 인스타 로그인 프로필이 필요합니다." };
  }
  return { ready: true };
}
