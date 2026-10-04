import { KEYWORD_CRON, resolveScheduled } from "./schedule.js";
import { readFileSync } from "node:fs";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`❌ ${m}`); }
const at = (h: number, m = 0) => Date.UTC(2026, 9, 6, h, m);
const wf = (cron: string, h: number) => resolveScheduled(cron, at(h))?.map((t) => `${t.workflow}${t.inputs?.round ? ":" + t.inputs.round : ""}`);

assert(JSON.stringify(wf(KEYWORD_CRON, 0)) === '["entertainment-keyword.yml:morning"]', "00 UTC 엔터 오전");
assert(JSON.stringify(wf(KEYWORD_CRON, 4)) === '["entertainment-keyword.yml:noon"]', "04 UTC 엔터 오후");
assert(JSON.stringify(wf(KEYWORD_CRON, 9)) === '["entertainment-keyword.yml:evening"]', "09 UTC 엔터 저녁");
assert(JSON.stringify(wf(KEYWORD_CRON, 11)) === '["social-issue-keyword.yml"]', "11 UTC 사회");
assert(resolveScheduled(KEYWORD_CRON, at(12))?.length === 0, "12 UTC 할 일 없음(오류 아님)");
assert(resolveScheduled(KEYWORD_CRON, at(5)) === null, "등록 안 된 시각은 null");
assert(JSON.stringify(wf("30 0 * * *", 0)) === '["analytics-search.yml"]', "analytics-search");
assert(JSON.stringify(wf("0 1 * * 1", 1)) === '["analytics-index-health.yml"]', "index-health");
assert(resolveScheduled("0 9 * * *", at(9)) === null, "옛 cron 문자열은 알 수 없음");

// wrangler.toml과 어긋나지 않는지(문자열 불일치가 가장 흔한 사고다)
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const crons = /crons\s*=\s*\[(.*?)\]/s.exec(toml)?.[1].match(/"([^"]+)"/g)?.map((x) => x.slice(1, -1)) ?? [];
assert(crons.length <= 5, `cron은 5개 이하(현재 ${crons.length})`);
assert(crons.includes(KEYWORD_CRON), "wrangler.toml에 KEYWORD_CRON 있음");
for (const c of crons) assert(resolveScheduled(c, c === KEYWORD_CRON ? at(0) : c === "0 1 * * 1" ? at(1) : at(0)) !== null, `toml cron이 코드에 매핑됨: ${c}`);
console.log(`✅ testSchedule 통과 (cron ${crons.length}개)`);
