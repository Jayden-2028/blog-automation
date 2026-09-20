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

export interface Env {
  TELEGRAM_WEBHOOK_SECRET: string;
  GH_DISPATCH_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  /** 버튼 클릭 즉시 "접수됨" 토스트용(answerCallbackQuery). 없으면 토스트만 생략하고 나머지는 그대로 동작한다. */
  TELEGRAM_BOT_TOKEN?: string;
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

async function telegramApi(env: Env, method: string, body: unknown): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
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
async function lockButtons(env: Env, update: unknown): Promise<void> {
  const message = (update as { callback_query?: { message?: { chat?: { id?: unknown }; message_id?: unknown } } })
    .callback_query?.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") return;

  await telegramApi(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [[PROCESSING_BUTTON]] },
  });
}

async function answerCallbackQuery(env: Env, callbackQueryId: string, text = CALLBACK_ACK_TEXT): Promise<void> {
  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

/**
 * cron 표현식(UTC) -> 깨울 워크플로우 파일명. KST 08:00/12:00/18:00에 맞춘 것이다
 * (2026-09-18 사용자 결정 - 하루에 고르게 펴서 시간대별로 다른 성격의 키워드를 본다).
 * 순서 의존: 연예 잡은 social-issue가 채운 trend_candidates를 읽지만, "오늘 날짜"가 아니라
 * latestAvailableTrendDate를 쓰므로 UTC 날짜가 갈려도(08:00 KST = 전날 23:00 UTC) 문제없다.
 *
 * 2026-09-16 간격 확대(사용자 요청): 원래 09:00/09:10/13:00로 10분만 띄웠는데, 그 좁은 간격이
 * heavy-pipeline 전체 부하를 짧은 시간에 몰아 사용자가 같은 목록에서 Go를 연달아 누르는 상황과
 * 겹치기 쉬웠다. 카테고리 간 간격을 넓혀 시스템 전체 부하를 분산한다 - 다만 이것만으로는 **같은
 * 카테고리 안에서** 클릭이 몰리는 문제(오늘 실제 사고의 주 원인)는 못 잡는다는 점은 알고 진행한다.
 * 그건 dispatchWorkflow.ts의 DB 큐(2026-09-16, 아래 참고)가 담당한다.
 */
const SCHEDULED_WORKFLOWS: Record<string, string> = {
  "0 23 * * *": "social-issue-keyword.yml", // 08:00 KST (UTC로는 전날 23:00)
  "0 3 * * *": "entertainment-keyword.yml", // 12:00 KST - social-issue가 채운 trend_candidates를 읽는다
  "0 9 * * *": "community-keyword.yml", // 18:00 KST
  "30 0 * * *": "analytics-search.yml", // 09:30 KST - Search Console 일일 성과(데이터는 3일 전 것)
};

async function dispatchWorkflow(env: Env, workflowFile: string): Promise<void> {
  const res = await fetch(
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
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`workflow_dispatch 실패(${workflowFile}):`, res.status, text.slice(0, 300));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
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

    if (!isCallbackQuery && !isReplyMessage) {
      return new Response("OK", { status: 200 });
    }

    const callbackQuery = isCallbackQuery
      ? (update as { callback_query?: { id?: unknown; data?: unknown } }).callback_query
      : undefined;
    const callbackQueryId = callbackQuery?.id;

    // 잠금 버튼(위 PROCESSING_BUTTON)을 누른 것 - 처리 중이라는 뜻이니 GitHub Actions를 깨우지 않는다.
    if (callbackQuery?.data === "noop") {
      if (typeof callbackQueryId === "string" && callbackQueryId) {
        ctx.waitUntil(answerCallbackQuery(env, callbackQueryId, "⏳ 앞서 누른 요청을 처리하고 있습니다."));
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
        body: JSON.stringify({ event_type: "telegram_update", client_payload: update }),
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
      ctx.waitUntil(answerCallbackQuery(env, callbackQueryId));
      ctx.waitUntil(lockButtons(env, update));
    }

    return new Response("OK", { status: 200 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const workflowFile = SCHEDULED_WORKFLOWS[event.cron];
    if (!workflowFile) {
      console.error(`알 수 없는 cron 표현식: ${event.cron}`);
      return;
    }
    ctx.waitUntil(dispatchWorkflow(env, workflowFile));
  },
};
