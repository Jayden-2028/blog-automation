// 큐의 대기 항목을 순서대로 읽기 -> job 생성 -> 자료조사 발화까지 이어서 처리한다.
//
// 텔레그램으로 링크를 보낸 뒤 원고 초안이 도착할 때까지 사람 개입이 없어야 한다는 요구
// (INSTAGRAM_CAPTURE_AUTOMATION.md)를 여기서 만족시킨다.
//
// 항목은 서로 독립이다 - 하나가 막혀도 나머지를 계속 처리한다. 실패는 그 항목만 pending으로
// 두고 attempts를 올린다. MAX_ATTEMPTS를 넘으면 skipped로 내리고 알린다(매 분 영원히 재시도하면
// 실패 알림만 쌓이고 Claude 사용량도 샌다).
//
// 2026-09-23 재설계로 갈래가 하나 늘었다: 게시물에서 읽어낸 글자가 0이면(캡션도 번인 텍스트도
// 없음) 실패가 아니라 **사용자에게 주제를 물어본다**(needs_topic). 링크만 받는 설계라 그 게시물에
// 대해 우리가 아는 것이 아무것도 없고, 주제어를 지어내면 게시물과 무관한 원고가 자동으로 나간다.

import { rm } from "node:fs/promises";

// 무거운 의존(브라우저·모델·DB)은 **함수 안에서 동적으로** 부른다. 정적 import면 이 모듈을 읽는
// 것만으로 supabase 클라이언트가 로드되고, 그 모듈은 자격증명이 없으면 throw한다 - 테스트가 전부
// 가짜를 주입하는데도 돌지 않게 된다(실제로 한 번 막혔다).
import { instagramProfilePath } from "./captureInstagramCarousel.js";
import { listPendingEntries, markEntry } from "./instagramQueue.js";
import { parseCaptureFile } from "./parseCaptureFile.js";
import type { LoginState } from "./checkInstagramLogin.js";
import type { runCaptureSession } from "./runCaptureSession.js";
import type { createInstagramJob } from "./createInstagramJob.js";
import type { InstagramCaptureResult, InstagramQueueEntry } from "./types.js";

export const MAX_ATTEMPTS = 3;

export type ProcessResult = {
  attempted: number;
  created: number;
  failed: number;
  givenUp: number;
  /** 사용자에게 주제를 물어본 건수. */
  asked: number;
  /** 사람이 손을 대야 하는 것만 담는다 - 성공은 넣지 않는다(2026-09-23). */
  messages: string[];
};

export type ProcessDeps = {
  listPending?: () => InstagramQueueEntry[];
  runSession?: typeof runCaptureSession;
  createJob?: typeof createInstagramJob;
  triggerResearch?: (jobId: string) => Promise<void>;
  mark?: typeof markEntry;
  /** 주제를 물어보는 텔레그램 메시지를 보내고 message_id를 돌려준다. */
  askTopic?: (entry: InstagramQueueEntry) => Promise<number | null>;
  /** 포기 직전에 로그인 상태를 확인한다. 추측으로 "로그인하세요"를 적지 않기 위해서다. */
  checkLogin?: () => Promise<LoginState>;
  /** 한 번의 폴링에서 처리할 최대 건수. 게시물 열기 + 모델 판정이 건당 수십 초 걸린다. */
  limit?: number;
};

export function captureAutoEnabled(): boolean {
  return process.env.IG_CAPTURE_AUTO === "true";
}

/** 폴러가 이어서 할 수 있는 상태인지. 아니면 이유를 돌려준다. */
export function captureReadiness(): { ready: true } | { ready: false; reason: string } {
  if (!captureAutoEnabled()) {
    return { ready: false, reason: "IG_CAPTURE_AUTO가 true가 아닙니다 - 인스타 변환을 건너뜁니다." };
  }
  if (!instagramProfilePath()) {
    return { ready: false, reason: "IG_BROWSER_PROFILE이 없습니다 - 인스타 로그인 프로필이 필요합니다." };
  }
  return { ready: true };
}

/**
 * 사용자가 답해 준 주제로 캡처 결과를 만든다(재캡처 없음).
 *
 * 같은 게시물을 다시 열어 봐야 또 비어 있다 - 읽을 게 없다는 사실은 이미 확인했다. 사용자가
 * 준 문장이 캡션 자리에 그대로 들어가 조사의 1차 근거가 된다.
 */
export function captureFromUserTopic(entry: InstagramQueueEntry): InstagramCaptureResult {
  const topic = (entry.userTopic ?? "").trim();
  return {
    queueEntryId: entry.id,
    instagramUrl: entry.instagramUrl,
    caption: topic,
    burnedInText: [],
    searchKeyword: topic.split("\n")[0].slice(0, 60).trim(),
    category: null,
  };
}

function giveUpMessage(entry: InstagramQueueEntry, error: string, login: LoginState): string {
  const head = `⛔ ${entry.instagramUrl}\n   ${MAX_ATTEMPTS}회 실패해 포기했습니다: ${error}`;
  if (login === "logged_out") {
    // 추측이 아니라 실제로 확인했을 때만 붙인다.
    return `${head}\n\n   🔑 인스타 로그인이 풀렸습니다.\n   맥에서: npm run ig:login\n   로그인한 뒤 같은 링크를 다시 보내주세요.`;
  }
  if (login === "unknown") {
    return `${head}\n   (로그인 상태를 확인하지 못했습니다 - 브라우저를 못 띄웠을 수 있습니다.)`;
  }
  return `${head}\n   로그인은 살아 있습니다 - 게시물이 비공개이거나 인스타 화면이 바뀌었을 수 있습니다.`;
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
  const checkLogin = deps.checkLogin ?? (async () => (await import("./checkInstagramLogin.js")).checkInstagramLogin());
  const limit = deps.limit ?? 2;

  const result: ProcessResult = { attempted: 0, created: 0, failed: 0, givenUp: 0, asked: 0, messages: [] };
  const pending = listPending().slice(0, limit);

  for (const entry of pending) {
    result.attempted += 1;
    const attempts = (entry.attempts ?? 0) + 1;

    // 사용자가 주제를 답해 준 항목은 다시 열지 않는다.
    let capture: InstagramCaptureResult | null = null;
    if ((entry.userTopic ?? "").trim()) {
      capture = captureFromUserTopic(entry);
    } else {
      const session = await runSession(entry, {
        capture: async (url) => (await import("./captureInstagramCarousel.js")).captureInstagramCarousel(url),
        judge: async (captured, queueEntry) =>
          (await import("./judgeCarouselSlides.js")).judgeCarouselSlides(captured, queueEntry),
        cleanup: (dir) => rm(dir, { recursive: true, force: true }),
      });

      if (session.status === "failed") {
        result.failed += 1;
        if (attempts >= MAX_ATTEMPTS) {
          result.givenUp += 1;
          mark(entry.id, { status: "skipped", attempts, lastError: session.error });
          const login = await checkLogin().catch((): LoginState => "unknown");
          result.messages.push(giveUpMessage(entry, session.error, login));
        } else {
          mark(entry.id, { attempts, lastError: session.error });
          result.messages.push(`⚠️ ${entry.instagramUrl}\n   ${attempts}/${MAX_ATTEMPTS}회 실패: ${session.error}`);
        }
        continue;
      }

      if (session.status === "no_material") {
        // 실패가 아니다 - 게시물은 열렸는데 읽을 글자가 없었다. attempts를 올리지 않는다:
        // 재시도해도 결과가 같고, 사용자의 답을 기다리는 동안 포기로 내려가면 안 된다.
        const askedMessageId = deps.askTopic ? await deps.askTopic(entry).catch(() => null) : null;
        mark(entry.id, { status: "needs_topic", askedMessageId: askedMessageId ?? undefined });
        result.asked += 1;
        continue;
      }

      capture = session.capture;
    }

    // 자동 경로도 수동 CLI(ig:create-job)와 **같은 검증**을 통과시킨다 - 자동이라고 검사를
    // 건너뛰면 잘못된 job이 조용히 생기고, 그때는 되돌리기가 번거롭다.
    const parsed = parseCaptureFile(capture as unknown);
    if (!parsed.ok) {
      result.failed += 1;
      const error = `읽어낸 결과가 규격에 맞지 않습니다: ${parsed.errors.join(" / ")}`;
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

    // 성공은 텔레그램으로 알리지 않는다(2026-09-23 사용자 결정). 사용자는 이미 두 번 알게
    // 된다 - 링크를 보낼 때 봇이 "접수했습니다"로 답하고, 집필이 끝나면 원고 초안이 온다.
  }

  return result;
}
