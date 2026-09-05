// 채널별 원고 페이지(manuscripts/index.html) 자동 배포 설정. publishTargets.ts와 같은 패턴 -
// 숫자·문자열을 로직 코드에 흩뿌리지 않고 이 파일만 참조한다.
//
// 셋(projectName/accountId/apiToken) 다 있어야 enabled다 - 하나라도 비면 로컬 파일 생성만
// 계속되고 배포는 조용히 skip된다(Cloudflare 계정 설정 전에도 회귀 없음).

export type CloudflarePagesConfig = {
  enabled: boolean;
  projectName: string | undefined;
  accountId: string | undefined;
  apiToken: string | undefined;
};

export const CLOUDFLARE_PAGES_CONFIG: CloudflarePagesConfig = (() => {
  const projectName = process.env.CLOUDFLARE_PAGES_PROJECT_NAME || undefined;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || undefined;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || undefined;
  return { enabled: Boolean(projectName && accountId && apiToken), projectName, accountId, apiToken };
})();

/** 배포된 Pages 프로젝트의 고정 URL. 설정 전이면 null. */
export function cloudflarePagesUrl(): string | null {
  return CLOUDFLARE_PAGES_CONFIG.projectName ? `https://${CLOUDFLARE_PAGES_CONFIG.projectName}.pages.dev` : null;
}
