// 텔레그램 webhook 릴레이 - 비즈니스 로직은 하나도 안 가진다. 진짜 텔레그램에서 온 요청인지만
// 확인하고(secret_token 헤더), callback_query가 있는 update와 답장(reply) 형태의 일반 메시지만
// GitHub Actions(telegram-update.yml, repository_dispatch)로 그대로 넘긴다.
//
// 왜 여기서 파싱/검증을 안 하는가: TelegramBot.ts의 콜백 파서·상태전이·idempotency 가드를
// Worker(V8 isolate, Node 아님)에 다시 구현하면 두 벌 유지보수가 되고 드리프트가 생긴다.
// 이미 검증된 Node 코드(GH Actions 러너 위)를 그대로 재사용하는 게 목적이다
// (docs/ai-handoff/CLOUD_MIGRATION.md Phase 3 설계 결정).
//
// 2026-09-15: "수정 필요" 답장 피드백 기능을 위해 message 타입도 조건부로 허용한다.
// reply_to_message가 있는지만 본다(어느 job에 대한 답장인지 등 실제 매칭은 TelegramBot.
// handleEditFeedbackMessage가 한다 - 여기는 "이 모양이면 넘길 가치가 있다"는 최소 필터일 뿐,
// 그 이상의 판단은 하지 않는다). 답장이 아닌 일반 메시지(잡담 등)는 여기서 걸러 GitHub Actions를
// 깨우지 않는다 - setWebhook의 allowed_updates에도 message가 추가돼 있어야 애초에 여기까지 온다.
//
// 2026-09-16: 키워드 수집 3종의 GitHub Actions `schedule:` 트리거를 걷어내고 이 Worker의 Cron
// Triggers로 대체한다(scheduled() 핸들러). 이유(실측) - GH Actions의 네이티브 schedule 이벤트는
// "베스트 에포트"일 뿐 시각을 보장하지 않는다(공식 문서: 부하가 높으면 지연되거나 아예 드롭될 수
// 있음). 실제로 사회이슈/연예OTT/커뮤니티 세 워크플로우가 매일 4~5시간씩 늦었고 하루는 아예
// 발동하지 않았다(정시 근처를 피해 7분/17분 밀어도 고쳐지지 않음 - 09-15 커밋 e11e511). 반면
// `workflow_dispatch`(REST API로 명시 호출)는 이 저장소 실측에서 항상 호출 즉시 정확히 돌았다 -
// 그래서 "언제 돌지"는 Cloudflare Cron Triggers(별도 인프라, 분 단위 정밀도)가 결정하고, 실제
// 실행은 GitHub API를 통해 workflow_dispatch로만 깨운다. `GH_DISPATCH_TOKEN`은 `workflow`
// 스코프가 있는 새 PAT로 교체했다 - 기존 값은 `repository_dispatch`용으로만 발급돼 있어
// workflow_dispatch 호출이 403(Resource not accessible)으로 실패했다(실측 확인). 1분 주기
// 임시 cron으로 실제 dispatch 성공까지 확인한 뒤 이 파일의 실 스케줄로 되돌렸다.

import { resolveScheduled, type ScheduledDispatch } from "./schedule.js";
import { forwardsPlainMessages, trackFromPath, type RelayTrack } from "./track.js";

export interface Env {
  TELEGRAM_WEBHOOK_SECRET: string;
  GH_DISPATCH_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  /** 버튼 클릭 즉시 "접수됨" 토스트용(answerCallbackQuery). 없으면 토스트만 생략하고 나머지는 그대로 동작한다. */
  TELEGRAM_BOT_TOKEN?: string;
  /** 사회 트랙 봇(2026-10). 경로 /webhook/social 로 들어온 update의 토스트·버튼 잠금에 쓴다. */
  SOCIAL_TELEGRAM_BOT_TOKEN?: string;
  /** 사용설명서 트랙 봇(개편3). 경로 /webhook/kscene. */
  KSCENE_TELEGRAM_BOT_TOKEN?: string;
  /** 인스타 변환기 봇(2026-10-06 웹훅 전환). 경로 /webhook/instagram. */
  INSTAGRAM_BOT_TOKEN?: string;
}

/**
 * 트랙의 봇 토큰. **다른 트랙의 토큰으로 대신하지 않는다** - 사회 봇에서 온 콜백에 메인봇 토큰으로
 * answerCallbackQuery를 부르면 텔레그램이 거부(콜백 쿼리는 그 봇 것)하고, 잠금 버튼도 엉뚱한 봇의
 * 메시지를 고치려다 실패한다. 없으면 undefined -> 토스트만 생략(릴레이 자체는 계속 동작).
 */
function botTokenFor(env: Env, track: RelayTrack): string | undefined {
  switch (track) {
    case "social":
      return env.SOCIAL_TELEGRAM_BOT_TOKEN;
    case "kscene":
      return env.KSCENE_TELEGRAM_BOT_TOKEN;
    case "instagram":
      return env.INSTAGRAM_BOT_TOKEN;
    default:
      return env.TELEGRAM_BOT_TOKEN;
  }
}

/**
 * 2026-09-16: 버튼을 누른 순간 텔레그램에 "접수됨" 토스트를 띄운다. 실제 처리(GH Actions 러너
 * 부팅 + npm ci + claude CLI 설치 + 제목 생성)는 60초 안팎이라, 그동안 버튼이 계속 로딩 상태로
 * 남아 사용자가 "안 눌렸나?" 하고 다시 누르는 원인이 됐다(더블탭 → 취소·중복 사고의 출발점).
 * TelegramBot.ts의 answerCallbackQuery는 러너에서 뒤늦게 호출돼 이미 만료돼 있어 어차피 한 번도
 * 보인 적이 없다(그 코드는 실패를 무시하도록 돼 있어 여기서 먼저 답해도 충돌하지 않는다). 실제
 * 결과("키워드 선택 완료", "승인됨" 등)는 지금처럼 러너가 sendMessage로 보낸다.
 */
const CALLBACK_ACK_TEXT = "⏳ 접수됐습니다. 처리 결과는 곧 메시지로 알려드립니다.";

/**
 * 눌린 직후 버튼을 이것 하나로 바꿔 **두 번째 탭 자체를 불가능하게** 만든다(2026-09-18).
 *
 * 왜 토스트만으로는 부족했나(실측): 승인 버튼이 1초 간격으로 두 번 눌렸다(update_id 223675272 /
 * 223675273 - 서로 다른 콜백이라 웹훅 재전송이 아니다). 눌러도 버튼 모양이 그대로라 "안 눌렸나?"
 * 싶어 다시 누른 것이다. 러너가 버튼을 바꾸는 건 60초 뒤라 그 사이가 통째로 무방비였다.
 *
 * `noop`은 아래 fetch 핸들러가 걸러내므로 눌러도 GitHub Actions를 깨우지 않는다. 러너가 나중에
 * markReviewButtonsDecided로 최종 라벨("✅ 승인됨" 등)을 다시 씌운다 - 그때는 이미 결정이 기록돼
 * 있어 다시 눌러도 idempotency 가드가 받는다.
 */
const PROCESSING_BUTTON = { text: "⏳ 처리 중…", callback_data: "noop" };

async function telegramApi(env: Env, track: RelayTrack, method: string, body: unknown): Promise<void> {
  const token = botTokenFor(env, track);
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`${method} 실패:`, res.status, text.slice(0, 200));
  }
}

/** 버튼을 "처리 중" 하나로 잠근다. 메시지 정보가 없으면(오래된 콜백 등) 조용히 건너뛴다. */
async function lockButtons(env: Env, track: RelayTrack, update: unknown): Promise<void> {
  const message = (update as { callback_query?: { message?: { chat?: { id?: unknown }; message_id?: unknown } } })
    .callback_query?.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") return;

  await telegramApi(env, track, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [[PROCESSING_BUTTON]] },
  });
}

async function answerCallbackQuery(
  env: Env,
  track: RelayTrack,
  callbackQueryId: string,
  text = CALLBACK_ACK_TEXT
): Promise<void> {
  await telegramApi(env, track, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

/**
 * cron이 깨울 워크플로우를 GitHub API로 dispatch한다.
 *
 * **실패하면 던진다**(2026-10-02). 전에는 console.error만 하고 조용히 끝났다. 그러면 Cloudflare
 * 쪽에서도 "성공한 호출"로 기록돼, 엔터·커뮤니티가 이틀 동안 안 돌았는데도 어디에도 실패 흔적이
 * 남지 않았다. 던지면 이 호출이 대시보드 Metrics의 오류로 잡히고 로그에 사유가 남는다.
 * 성공도 한 줄 남긴다 - "호출은 됐다"는 사실이 있어야 "호출이 안 됐다"와 구분된다.
 */
async function dispatchWorkflow(env: Env, target: ScheduledDispatch): Promise<void> {
  const workflowFile = target.workflow;
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "blog-automation-telegram-relay",
        },
        body: JSON.stringify(target.inputs ? { ref: "main", inputs: target.inputs } : { ref: "main" }),
      }
    );
  } catch (error) {
    console.error(`workflow_dispatch 네트워크 오류(${workflowFile}):`, error);
    throw error;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`workflow_dispatch 실패(${workflowFile}):`, res.status, text.slice(0, 300));
    throw new Error(`workflow_dispatch 실패(${workflowFile}): HTTP ${res.status}`);
  }

  console.log(`workflow_dispatch 성공(${workflowFile}): HTTP ${res.status}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 인증을 먼저 한다 - 경로가 맞는지는 시크릿을 아는 호출자에게만 알려 준다(404와 403으로 구조를 캐내지 못하게).
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    // 어느 봇에서 온 update인지는 **경로**로 안다(봇마다 setWebhook 경로가 다르다). update 본문에는 봇 식별자가
    // 없다. 모르는 경로는 조용히 엔터로 보내지 않고 404 - 잘못 등록된 webhook이 엉뚱한 트랙을 움직이면 안 된다.
    const track = trackFromPath(new URL(request.url).pathname);
    if (!track) {
      return new Response("Not Found", { status: 404 });
    }

    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // callback_query도 없고, 답장(reply) 형태의 message도 아닌 update는 GitHub Actions를 깨우지
    // 않고 바로 200(잡담·일반 메시지 등).
    const isCallbackQuery = Boolean(update) && typeof update === "object" && "callback_query" in update;
    const message = Boolean(update) && typeof update === "object" ? (update as Record<string, unknown>).message : undefined;
    const isReplyMessage = Boolean(message) && typeof message === "object" && "reply_to_message" in (message as object);

    // 인스타 봇은 링크가 일반 메시지로 오므로 글자가 있는 메시지는 전부 넘긴다(2026-10-06). 다른 봇은 그대로다.
    const isTextMessage =
      Boolean(message) && typeof message === "object" && typeof (message as { text?: unknown }).text === "string";
    if (!isCallbackQuery && !isReplyMessage && !(forwardsPlainMessages(track) && isTextMessage)) {
      return new Response("OK", { status: 200 });
    }

    const callbackQuery = isCallbackQuery
      ? (update as { callback_query?: { id?: unknown; data?: unknown } }).callback_query
      : undefined;
    const callbackQueryId = callbackQuery?.id;

    // 잠금 버튼(위 PROCESSING_BUTTON)을 누른 것 - 처리 중이라는 뜻이니 GitHub Actions를 깨우지 않는다.
    if (callbackQuery?.data === "noop") {
      if (typeof callbackQueryId === "string" && callbackQueryId) {
        ctx.waitUntil(answerCallbackQuery(env, track, callbackQueryId, "⏳ 앞서 누른 요청을 처리하고 있습니다."));
      }
      return new Response("OK", { status: 200 });
    }

    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "blog-automation-telegram-relay",
        },
        // track은 update 뒤에 놓는다 - 본문에 같은 이름의 필드가 있어도 경로로 정한 값이 이긴다.
        body: JSON.stringify({ event_type: "telegram_update", client_payload: { ...(update as object), track } }),
      }
    );

    if (!dispatchResponse.ok) {
      const text = await dispatchResponse.text().catch(() => "");
      console.error("GitHub dispatch 실패:", dispatchResponse.status, text.slice(0, 300));
      // 5xx를 돌려주면 텔레그램이 webhook 재시도 정책에 따라 나중에 다시 보낸다.
      return new Response("Upstream dispatch failed", { status: 502 });
    }

    // 디스패치가 실제로 성공한 뒤에만 알린다(실패면 위에서 502 → 텔레그램 재전송).
    // 버튼 잠금이 핵심이고 토스트는 보조다 - 잠가야 두 번째 탭이 물리적으로 막힌다.
    if (typeof callbackQueryId === "string" && callbackQueryId) {
      ctx.waitUntil(answerCallbackQuery(env, track, callbackQueryId));
      ctx.waitUntil(lockButtons(env, track, update));
    }

    return new Response("OK", { status: 200 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const targets = resolveScheduled(event.cron, event.scheduledTime);
    // 깨어났다는 사실부터 남긴다. 이게 없으면 "cron이 안 울렸다"와 "울렸는데 아무것도 못 했다"를
    // 로그로 구분할 수 없다(2026-10-02 엔터·커뮤니티 미실행 때 실제로 구분이 안 됐다).
    const names = targets === null ? "매핑 없음" : targets.length === 0 ? "(할 일 없음)" : targets.map(describeTarget).join(", ");
    console.log(`[cron] ${event.cron} (예정 ${new Date(event.scheduledTime).toISOString()}) -> ${names}`);
    if (targets === null) {
      console.error(`알 수 없는 cron 표현식/시각: ${event.cron} @ ${new Date(event.scheduledTime).toISOString()}`);
      throw new Error(`알 수 없는 cron 표현식/시각: ${event.cron}`);
    }
    for (const target of targets) ctx.waitUntil(dispatchWorkflow(env, target));
  },
};

function describeTarget(target: ScheduledDispatch): string {
  return target.inputs ? `${target.workflow} ${JSON.stringify(target.inputs)}` : target.workflow;
}
