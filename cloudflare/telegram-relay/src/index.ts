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

export interface Env {
  TELEGRAM_WEBHOOK_SECRET: string;
  GH_DISPATCH_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    return new Response("OK", { status: 200 });
  },
};
