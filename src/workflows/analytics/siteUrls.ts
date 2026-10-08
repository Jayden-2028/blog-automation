// GSC 속성 목록 해석. 순수 함수만 둔다(외부 호출 없음).
//
// `GSC_SITE_URLS`(콤마 구분)가 있으면 그 목록을 등록 순서대로 쓰고, 없으면 기존 `GSC_SITE_URL`
// 단일 값으로 폴백한다 - 단일 속성 운영(기존 동작)은 바뀌지 않는다.

/** env에서 속성 목록을 뽑는다. 공백·빈 항목·중복은 걸러내되 순서는 유지한다. */
export function resolveSiteUrls(env: { GSC_SITE_URLS?: string; GSC_SITE_URL?: string }): string[] {
  const raw = env.GSC_SITE_URLS?.trim() ? env.GSC_SITE_URLS : (env.GSC_SITE_URL ?? "");
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** 로그·알림용 짧은 이름(`https://a.blogspot.com/` → `a.blogspot.com`, `sc-domain:x.com` → `x.com`). */
export function siteLabel(siteUrl: string): string {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice("sc-domain:".length);
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

/**
 * 주소가 이 속성에 속하는가. URL 접두어 속성은 접두어 일치, 도메인 속성(`sc-domain:`)은
 * 호스트가 도메인이거나 그 하위 도메인이면 속한다.
 */
export function belongsToSite(url: string, siteUrl: string): boolean {
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length);
    try {
      const host = new URL(url).hostname;
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  }
  return url.startsWith(siteUrl);
}
