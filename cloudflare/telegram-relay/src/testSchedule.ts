import { KEYWORD_CRON, resolveScheduled } from "./schedule.js";
import { readFileSync } from "node:fs";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`❌ ${m}`); }
const at = (h: number, m = 0) => Date.UTC(2026, 9, 6, h, m);
const wf = (cron: string, h: number) => resolveScheduled(cron, at(h))?.map((t) => `${t.workflow}${t.inputs?.round ? ":" + t.inputs.round : ""}`);

// 2026-10-11 키워드 개편: 엔터는 09 UTC(18시 KST) 한 회차만, 10 UTC(19시 KST)는 핫이슈 스타 신설.
assert(resolveScheduled(KEYWORD_CRON, at(0)) === null, "00 UTC(엔터 오전)는 폐지 - 아무것도 안 깨운다");
assert(resolveScheduled(KEYWORD_CRON, at(4)) === null, "04 UTC(엔터 오후)는 폐지 - 아무것도 안 깨운다");
assert(JSON.stringify(wf(KEYWORD_CRON, 9)) === '["entertainment-keyword.yml:evening"]', "09 UTC 엔터 저녁(유일 회차)");
assert(JSON.stringify(wf(KEYWORD_CRON, 10)) === '["entertainment-hot-star.yml"]', "10 UTC 핫이슈 스타 Top 5(알림 전용)");
assert(JSON.stringify(wf(KEYWORD_CRON, 11)) === '["social-issue-keyword.yml"]', "11 UTC 사회");
assert(JSON.stringify(wf(KEYWORD_CRON, 12)) === '["kscene-topic.yml","watchdog.yml"]', "12 UTC 사용설명서 수집 + watchdog 동시 발화(개편3)");
assert(resolveScheduled(KEYWORD_CRON, at(5)) === null, "등록 안 된 시각은 null");
assert(JSON.stringify(wf("30 0 * * *", 0)) === '["analytics-search.yml"]', "analytics-search");
assert(JSON.stringify(wf("0 1 * * 1", 1)) === '["analytics-index-health.yml"]', "index-health");
assert(JSON.stringify(wf("0 18 * * 6", 18)) === '["storage-cleanup.yml"]', "storage-cleanup(주 1회, 개편2.5 D)");
assert(resolveScheduled("0 9 * * *", at(9)) === null, "옛 cron 문자열은 알 수 없음");

// wrangler.toml과 어긋나지 않는지(문자열 불일치가 가장 흔한 사고다)
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const crons = /crons\s*=\s*\[(.*?)\]/s.exec(toml)?.[1].match(/"([^"]+)"/g)?.map((x) => x.slice(1, -1)) ?? [];
assert(crons.length <= 5, `cron은 5개 이하(현재 ${crons.length})`);
assert(crons.includes(KEYWORD_CRON), "wrangler.toml에 KEYWORD_CRON 있음");
assert(crons.includes("0 18 * * 6"), "wrangler.toml에 storage-cleanup cron 있음");
// 워크플로 파일이 실제로 있어야 dispatch가 404가 아니다.
for (const file of ["storage-cleanup.yml", "kscene-topic.yml", "watchdog.yml", "entertainment-hot-star.yml"]) readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), "utf8");
for (const c of crons) assert(resolveScheduled(c, c === KEYWORD_CRON ? at(9) : c === "0 1 * * 1" ? at(1) : c === "0 18 * * 6" ? at(18) : at(0)) !== null, `toml cron이 코드에 매핑됨: ${c}`);

// cron 표현식의 시각 목록과 코드의 분기 시각이 어긋나면 그 시각은 조용히 아무 일도 하지 않는다.
const keywordHours = KEYWORD_CRON.split(" ")[1].split(",").map(Number);
for (const h of keywordHours) assert(resolveScheduled(KEYWORD_CRON, at(h)) !== null, `KEYWORD_CRON ${h} UTC에 분기가 있음`);
assert(keywordHours.length === 4, `KEYWORD_CRON 시각은 4개(18·19·20·21시 KST), 현재 ${keywordHours.length}개`);
console.log(`✅ testSchedule 통과 (cron ${crons.length}개)`);
