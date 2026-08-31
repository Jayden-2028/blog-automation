// Blogger API v3 발행에 쓸 refresh token을 최초 1회 발급받는다(SPRINT_5_DESIGN.md §8, §10-1).
//
// 흐름(OAuth 2.0 loopback — Desktop app client 표준):
//   1) 127.0.0.1의 빈 포트로 임시 HTTP 서버를 연다(리다이렉트 수신용)
//   2) 구글 동의 URL을 콘솔에 출력 → 사용자가 브라우저에서 "허용"
//   3) 구글이 ?code=... 로 로컬 서버에 리다이렉트 → code를 토큰으로 교환
//   4) refresh_token을 출력. 사용자가 .env의 BLOGGER_REFRESH_TOKEN=에 붙여넣는다
//
// 이 스크립트는 아무 파일도 자동 수정하지 않는다(.env에 직접 쓰지 않음) - 비밀값을 코드가
// 다루는 범위를 최소화한다. Playwright/DB/Telegram 접근 없음.
//
// 실행: npm run setup:blogger
import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { BLOGGER_CONFIG } from "../../../config/publishTargets.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

async function main(): Promise<void> {
  const { clientId, clientSecret, scope, blogId } = BLOGGER_CONFIG;
  if (!clientId || !clientSecret) {
    console.error(
      "❌ .env에 BLOGGER_CLIENT_ID / BLOGGER_CLIENT_SECRET가 없습니다.\n" +
        "   GCP 콘솔 > 사용자 인증 정보 > OAuth 클라이언트 ID(데스크톱 앱)에서 발급한 값을 넣으세요."
    );
    process.exit(1);
  }

  const state = randomBytes(16).toString("hex");

  // 빈 포트에 서버를 먼저 열어 실제 포트를 확정한 뒤 redirect_uri를 만든다.
  let boundPort = 0;
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(`<h3>동의 취소/실패: ${error}</h3><p>터미널로 돌아가 다시 시도하세요.</p>`);
        server.close();
        reject(new Error(`OAuth 동의 실패: ${error}`));
        return;
      }
      if (returnedState !== state || !returnedCode) {
        res.end("<h3>잘못된 응답(state 불일치)</h3>");
        server.close();
        reject(new Error("state 불일치 - CSRF 방어에 걸렸습니다. 다시 시도하세요."));
        return;
      }
      res.end("<h3>인증 완료 ✅</h3><p>이 창을 닫고 터미널로 돌아가세요.</p>");
      server.close();
      resolve(returnedCode);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      boundPort = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${boundPort}`;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope,
        access_type: "offline",
        prompt: "consent", // refresh_token을 반드시 받기 위해 매번 동의를 강제
        state,
      }).toString();

      console.log("\n▶ 아래 URL을 브라우저에서 열고 로그인 + '허용'을 누르세요:\n");
      console.log(authUrl.toString());
      console.log(
        '\n("확인되지 않은 앱" 경고가 뜨면 "고급" → "blog-automation(안전하지 않음)으로 이동" 클릭)\n'
      );
    });
  });

  const redirectUri = `http://127.0.0.1:${boundPort}`;
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const tokenJson = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenJson.refresh_token) {
    console.error(
      `❌ 토큰 교환 실패 (${tokenRes.status}): ${tokenJson.error ?? ""} ${tokenJson.error_description ?? ""}`
    );
    if (!tokenJson.refresh_token && tokenJson.access_token) {
      console.error(
        "   access_token은 왔지만 refresh_token이 없습니다 - 이전에 이미 동의한 계정입니다.\n" +
          "   https://myaccount.google.com/permissions 에서 이 앱 접근을 삭제한 뒤 다시 실행하세요."
      );
    }
    process.exit(1);
  }

  // 발급된 토큰으로 blog 접근을 즉시 검증한다(잘못된 blogId를 setup 단계에서 잡는다).
  let blogCheck = "";
  if (blogId) {
    const check = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/${blogId}?fields=name,url`,
      { headers: { Authorization: `Bearer ${tokenJson.access_token}` } }
    );
    if (check.ok) {
      const b = (await check.json()) as { name?: string; url?: string };
      blogCheck = `\n✅ 블로그 확인: "${b.name}" (${b.url})`;
    } else {
      blogCheck = `\n⚠️ BLOGGER_BLOG_ID(${blogId}) 접근 실패 (${check.status}) - blog ID를 확인하세요.`;
    }
  }

  console.log(
    "\n────────────────────────────────────────\n" +
      "✅ refresh token 발급 완료. 아래 값을 .env의 BLOGGER_REFRESH_TOKEN= 에 붙여넣으세요:\n\n" +
      tokenJson.refresh_token +
      "\n\n그리고 .env에 BLOGGER_ENABLED=true 를 추가하면 발행이 활성화됩니다." +
      blogCheck +
      "\n────────────────────────────────────────\n"
  );
}

main().catch((error) => {
  console.error("❌ setup:blogger 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
