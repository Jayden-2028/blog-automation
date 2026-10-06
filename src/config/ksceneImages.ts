// 사용설명서(The Korea Manual) 발행 이미지 호스팅 설정(개편3 §4.3-4, 2026-10-06 사용자 확정).
//
// Blogger API에는 이미지 업로드가 없어 Blogspot 글은 지금까지 Supabase Storage URL을 핫링크했다(영구 보관을 강제하고
// egress를 쓴다). 사용설명서 트랙은 발행 시점에 이미지를 **전용 공개 Cloudflare Pages 프로젝트**로 복사하고 본문 URL을 치환한다.
// 비용 0, CDN이라 페이지 속도에도 유리하다. 이 프로젝트는 원고 뷰어 프로젝트(Access 게이트가 걸린)와 **다르다** - 공개여야 한다.
//
// 설정이 비어 있으면(프로젝트를 아직 안 만들었으면) 복사를 건너뛰고 Supabase URL로 발행한다 - 발행이 막히지 않는다.
// 이때 job은 `imagesRehostedAt`이 없으므로 storage-cleanup이 그 이미지를 지우지 않는다(핫링크 보호).
//
// 프로젝트 이름은 **연 단위로 갈 수 있다**(`kscene-images-2026` -> `kscene-images-2027`). Pages 배포당 파일 한도가 2만 개라
// 글 ~3,300건 분량이 차면 환경변수만 바꿔 새 프로젝트로 넘어간다. 기존 글의 URL은 프로젝트별 도메인이라 영향이 없다.

export type KsceneImagesConfig = {
  enabled: boolean;
  projectName: string | undefined;
  accountId: string | undefined;
  apiToken: string | undefined;
  /** 이미지가 서비스되는 기준 URL(끝 슬래시 없음). 기본 https://<project>.pages.dev. 커스텀 도메인을 붙이면 덮어쓴다. */
  baseUrl: string | undefined;
};

export function loadKsceneImagesConfig(env: Record<string, string | undefined> = process.env): KsceneImagesConfig {
  const projectName = env.KSCENE_IMAGES_PAGES_PROJECT?.trim() || undefined;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || undefined;
  const apiToken = env.CLOUDFLARE_API_TOKEN || undefined;
  const baseUrl = (env.KSCENE_IMAGES_BASE_URL?.trim() || (projectName ? `https://${projectName}.pages.dev` : "")).replace(/\/+$/, "") || undefined;
  return { enabled: Boolean(projectName && accountId && apiToken && baseUrl), projectName, accountId, apiToken, baseUrl };
}

/** Pages 배포당 파일 한도는 20,000개다. 여유를 두고 이 수를 넘기면 새 프로젝트로 넘어가라고 알린다. */
export const KSCENE_IMAGES_FILE_LIMIT_WARN = 19_000;
