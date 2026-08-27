// Telegra.ph(telegra.ph) 공개 API 클라이언트. 원고를 서식이 반영된 페이지로 발행한다.
//
// 왜 도입했는가(2026-08-27, 사용자 요청): Telegram 메시지 본문(parse_mode=HTML)은 우리 원고의
// 마크다운(##, **, -)을 그대로 문자로 보여줄 뿐 서식으로 렌더링하지 않는다. 사용자가 "원고보기
// 버튼을 눌러 서식이 반영된 화면으로 보고 싶다"고 요청했고, Telegraph는 Telegram이 자체 제공하는
// 퍼블리싱 서비스라 앱 안에서 바로 열리고 실제 제목/문단/링크로 렌더링된다.
//
// 계정을 세션마다 새로 만드는 이유: Telegraph는 access_token 없이 createPage를 호출할 수 없지만,
// 페이지 자체는 어떤 토큰으로 만들었든 URL만 있으면 누구나 열람할 수 있다(수정 권한만 그 토큰에
// 묶인다). 이번 스프린트는 발행한 페이지를 나중에 다시 수정할 계획이 없으므로, 실행마다 임시
// 계정을 만들어 쓰는 쪽이 access_token을 영구 보관하는 것보다 간단하다 - 새 환경변수나 DB 테이블이
// 필요 없다.
//
// ⚠️ 발행된 페이지는 URL을 아는 누구나 볼 수 있는 공개 페이지다(비공개 아님). 아직 검수 전인
// 원고도 이 URL로 새어나갈 수 있다는 뜻이므로, 민감한 내용을 다루는 job에는 쓰지 않는 편이 안전하다.

import { markdownToTelegraphNodes } from "./markdownToTelegraphNodes.js";

const TELEGRAPH_API_BASE_URL = "https://api.telegra.ph";

/** Telegraph API 호출 타임아웃. 발행 실패가 원고 생성 전체를 막으면 안 되므로 짧게 잡는다. */
const TELEGRAPH_TIMEOUT_MS = 10_000;

export type PublishToTelegraphResult = { ok: true; url: string } | { ok: false; error: string };

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAPH_TIMEOUT_MS);

  try {
    const response = await fetch(`${TELEGRAPH_API_BASE_URL}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await response.json()) as { ok: boolean; result?: T; error?: string };
    if (!json.ok) throw new Error(json.error ?? `Telegraph ${path} 실패`);
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 원고를 Telegraph 페이지로 발행하고 URL을 반환한다. 실패해도 예외를 던지지 않는다 - 발행은
 * "더 잘 읽히게 하는" 부가 기능이지 원고 생성의 필수 단계가 아니므로, 실패하면 호출자가 Telegram
 * 본문 dump로 폴백할 수 있게 error를 돌려준다.
 */
export async function publishArticleToTelegraph(title: string, markdown: string): Promise<PublishToTelegraphResult> {
  try {
    const account = await postJson<{ access_token: string }>(
      "createAccount",
      { short_name: "blog-automation", author_name: "블로그 자동화" }
    );

    const page = await postJson<{ url: string }>("createPage", {
      access_token: account.access_token,
      title,
      content: markdownToTelegraphNodes(markdown),
      return_content: false,
    });

    return { ok: true, url: page.url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
