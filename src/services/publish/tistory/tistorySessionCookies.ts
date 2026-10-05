// 티스토리 로그인 쿠키를 프로필 폴더 옆 JSON에 따로 보관한다(2026-10-06 맥미니 실측).
//
// 왜 필요한가: 티스토리/카카오의 로그인 쿠키 일부는 **세션 쿠키**(만료 없음)다. Chromium은 정상 종료해도 세션 쿠키를
// 다음 실행으로 넘기지 않는 경우가 있어, setup:tistory로 로그인한 직후에도 폴러가 띄운 브라우저는 로그인 화면으로
// 갔다(쿠키 9개뿐, 전부 로그인 전 것). 그래서 로그인 직후 쿠키 전부를 파일로 받아 두고, 브라우저를 띄울 때마다
// 다시 넣는다. 로그인 상태로 페이지를 연 뒤에는 최신 쿠키로 갱신한다(서버가 쿠키를 돌리는 경우 대비).
//
// 파일은 프로필 폴더 안(.local/, gitignore)에 둔다. 값은 로그에 절대 찍지 않는다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Cookie } from "playwright";

const FILE_NAME = "session-cookies.json";
const DOMAIN_RE = /tistory|kakao|daum/;

export function cookieFilePath(profileDir: string): string {
  return join(profileDir, FILE_NAME);
}

/** 로그인 관련 도메인의 쿠키를 저장한다. 돌려주는 값은 저장한 개수. */
export async function saveSessionCookies(context: BrowserContext, profileDir: string): Promise<number> {
  const cookies = (await context.cookies()).filter((c) => DOMAIN_RE.test(c.domain));
  writeFileSync(cookieFilePath(profileDir), JSON.stringify(cookies), { encoding: "utf8", mode: 0o600 });
  return cookies.length;
}

/** 저장해 둔 쿠키를 새 컨텍스트에 넣는다. 파일이 없거나 깨졌으면 0. */
export async function restoreSessionCookies(context: BrowserContext, profileDir: string): Promise<number> {
  const path = cookieFilePath(profileDir);
  if (!existsSync(path)) return 0;
  try {
    const cookies = JSON.parse(readFileSync(path, "utf8")) as Cookie[];
    if (!Array.isArray(cookies) || cookies.length === 0) return 0;
    await context.addCookies(cookies);
    return cookies.length;
  } catch {
    return 0;
  }
}
