// robots.txt 판정. communityRecon.ts와 테스트가 함께 쓴다.
//
// 별도 파일인 이유: communityRecon.ts는 최상단에서 `await main()`을 실행하므로 import하면
// 실제 네트워크 조사가 돌아버린다. 판정 로직만 따로 두어야 외부 호출 없이 테스트할 수 있다.

/**
 * robots.txt 패턴 -> 정규식. `*`(임의 문자열)와 끝의 `$`(경로 끝 고정)를 지원한다.
 * 그 외 문자는 이스케이프해 문자 그대로 매칭한다.
 */
function robotsPatternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/**
 * User-agent: * 블록에서 targetPath에 적용되는 규칙을 찾아 금지 여부를 답한다.
 *
 * **Allow를 반드시 함께 본다.** 2026-09-30 실측에서 이 함수가 Disallow만 보다가 에펨코리아를
 * 잘못 제외했다: 그 사이트는 `Disallow: /`와 `Allow: /best`를 함께 두어 베스트 목록만 열어뒀는데,
 * `Disallow: /`에 걸려 금지로 판정됐다. robots.txt 표준은 **가장 구체적인(긴) 패턴이 이기고,
 * 같은 길이면 Allow가 이긴다** - 그래서 `/best`(6자)가 `/`(1자)를 덮는다.
 *
 * 허용된 사이트를 잘못 빼는 것도 오판이지만, 반대 방향(금지된 곳을 긁는 것)이 훨씬 위험하므로
 * 규칙이 하나도 안 맞으면 "허용"으로 두되(robots 표준 그대로) 원문을 사람이 보게 출력한다.
 */
export function isPathDisallowed(robotsTxt: string, targetPath: string): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((line) => line.trim());
  let inWildcardBlock = false;
  // 가장 구체적인 규칙 하나만 남긴다. 동점이면 Allow가 이긴다.
  let best: { length: number; allow: boolean } | null = null;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      inWildcardBlock = value === "*";
      continue;
    }
    if (!inWildcardBlock) continue;
    if (key !== "allow" && key !== "disallow") continue;
    // 빈 Disallow는 "금지 없음"이라는 뜻이라 규칙으로 세지 않는다.
    if (!value) continue;

    if (!robotsPatternToRegex(value).test(targetPath)) continue;

    const allow = key === "allow";
    if (!best || value.length > best.length || (value.length === best.length && allow)) {
      best = { length: value.length, allow };
    }
  }

  return best ? !best.allow : false;
}
