// 최소 robots.txt 판정(발주서 B-5: robots 위반 fetch를 추가하지 않는다). `User-agent: *` 그룹의 Allow/Disallow만 본다 -
// 가장 긴 매칭이 이긴다. 4xx(robots 없음)는 허용, 네트워크 오류·5xx는 **불허**(확인 못 했으면 가져오지 않는다).
import type { FetchLike } from "../research/personSourcePack.js";

export function isPathAllowed(robotsTxt: string, path: string): boolean {
  const rules: Array<{ allow: boolean; pattern: string }> = [];
  let inStarGroup = false;
  let groupStarted = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (groupStarted) {
        inStarGroup = false;
        groupStarted = false;
      }
      if (value === "*") inStarGroup = true;
    } else if (field === "allow" || field === "disallow") {
      groupStarted = true;
      if (inStarGroup && value) rules.push({ allow: field === "allow", pattern: value });
    }
  }
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    const re = new RegExp(`^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    if (re.test(path) && (!best || rule.pattern.length > best.length || (rule.pattern.length === best.length && rule.allow))) {
      best = { allow: rule.allow, length: rule.pattern.length };
    }
  }
  return best ? best.allow : true;
}

export async function isUrlAllowedByRobots(url: string, fetchImpl: FetchLike, timeoutMs = 5000): Promise<boolean> {
  const u = new URL(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${u.protocol}//${u.host}/robots.txt`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal });
    if (res.status >= 500) return false;
    if (!res.ok) return true; // 4xx = robots.txt 없음
    return isPathAllowed(await res.text(), `${u.pathname}${u.search}`);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
