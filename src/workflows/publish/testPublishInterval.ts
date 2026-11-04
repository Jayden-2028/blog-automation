// 최소 발행 간격 가드 테스트(2026-11-01). 네트워크·DB 없음.
//
// 배경: 10/31 23:47에 티스토리로 두 건을 연달아 올린 직후 7번째에서 카카오 캡차가 떴다. 더 큰 이유는
// 네이버 - 자동 발행으로 저품질 판정을 받은 이력이 있다(사용자). 그래서 채널별 최소 간격을 둔다.

import {
  checkDailyLimit,
  checkInterval,
  dailyPublishLimit,
  DEFAULT_DAILY_PUBLISH_LIMIT,
  DEFAULT_MIN_INTERVAL_MINUTES,
  kstDayStartIso,
  laterOf,
  minIntervalMinutes,
} from "./publishInterval.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NOW = new Date("2026-11-01T10:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

// ── 1. 기본값은 5분이고 채널별로 덮어쓴다 ────────────────────────
{
  assert(DEFAULT_MIN_INTERVAL_MINUTES === 5, "기본 5분");
  assert(minIntervalMinutes("tistory", {}) === 5, "미설정이면 기본값");
  assert(minIntervalMinutes("tistory", { TISTORY_PUBLISH_MIN_INTERVAL_MIN: "12" }) === 12, "채널 변수로 덮어쓴다");
  assert(minIntervalMinutes("naver", { NAVER_PUBLISH_MIN_INTERVAL_MIN: "0" }) === 0, "0은 끄기로 허용한다");
  assert(minIntervalMinutes("naver", { NAVER_PUBLISH_MIN_INTERVAL_MIN: "-3" }) === 5, "음수는 기본값");
  assert(minIntervalMinutes("naver", { NAVER_PUBLISH_MIN_INTERVAL_MIN: "곧바로" }) === 5, "숫자가 아니면 기본값");
  // 채널이 서로 간섭하지 않는다.
  assert(minIntervalMinutes("naver", { TISTORY_PUBLISH_MIN_INTERVAL_MIN: "30" }) === 5, "다른 채널 변수는 안 본다");
}

// ── 2. 간격 안이면 막고, 지났으면 통과 ───────────────────────────
{
  const blocked = checkInterval(ago(2), "tistory", NOW, {});
  assert(!blocked.allowed, "2분 전 발행이면 막는다");
  assert(!blocked.allowed && Math.round(blocked.waitMs / 60_000) === 3, `남은 시간 3분 (실제: ${!blocked.allowed ? blocked.waitMs : 0}ms)`);

  assert(checkInterval(ago(5), "tistory", NOW, {}).allowed, "정확히 5분이면 통과");
  assert(checkInterval(ago(9), "tistory", NOW, {}).allowed, "9분이면 통과");

  // 10/31 실제 사고 재현: 23:47 발행 → 23:49 두 번째 시도(2분 뒤)
  const incident = checkInterval("2026-10-31T14:47:00.000Z", "tistory", new Date("2026-10-31T14:49:00.000Z"), {});
  assert(!incident.allowed, "10/31 캡차 사고 간격(2분)은 이제 막힌다");
}

// ── 3. 모르면 통과시킨다(가드가 관문이 되면 안 된다) ─────────────
{
  assert(checkInterval(null, "naver", NOW, {}).allowed, "발행 이력이 없으면 통과");
  assert(checkInterval("어제쯤", "naver", NOW, {}).allowed, "시각을 못 읽으면 통과");
  assert(checkInterval(ago(-30), "naver", NOW, {}).allowed, "미래 시각(시계 어긋남)도 통과");
  assert(checkInterval(ago(1), "naver", NOW, { NAVER_PUBLISH_MIN_INTERVAL_MIN: "0" }).allowed, "0분이면 끈 것이다");
}

// ── 4. 채널마다 따로 센다 ────────────────────────────────────────
{
  const env = { TISTORY_PUBLISH_MIN_INTERVAL_MIN: "30", NAVER_PUBLISH_MIN_INTERVAL_MIN: "5" };
  assert(!checkInterval(ago(10), "tistory", NOW, env).allowed, "티스토리는 30분 기준이라 10분은 막힘");
  assert(checkInterval(ago(10), "naver", NOW, env).allowed, "네이버는 5분 기준이라 10분은 통과");
}

// ── 5. 실패한 시도도 센다(2026-11-01 구멍) ──────────────────────
// 11/01 12:47·12:48에 두 건이 1분 간격으로 시도돼 둘 다 캡차에 막혔다. 첫 건이 실패해 성공 기록이
// 남지 않았고, 성공만 보던 가드가 다음 건을 통과시켰다. 이제 마지막 "시도"를 기준으로 본다.
{
  const published = ago(60);   // 한 시간 전 성공
  const attempted = ago(1);    // 1분 전 실패
  assert(laterOf(published, attempted) === attempted, "더 최근 쪽(실패 시도)을 고른다");
  assert(laterOf(published, null) === published, "한쪽만 있으면 그것");
  assert(laterOf(null, null) === null, "둘 다 없으면 null");
  assert(laterOf("깨진값", attempted) === attempted, "못 읽는 값은 반대쪽");

  // 성공만 봤다면 통과했을 상황이 이제 막힌다.
  assert(checkInterval(published, "tistory", NOW, {}).allowed, "성공만 보면 1시간 전이라 통과했다");
  assert(!checkInterval(laterOf(published, attempted), "tistory", NOW, {}).allowed, "시도를 세면 막힌다");
  console.log("✅ 실패 시도 포함 - 캡차 직후 재시도를 막는다");
}

console.log("✅ 최소 발행 간격: 기본 5분·채널별 설정·사고 재현·모르면 통과");

// ── 5. 일일 발행 상한(2026-11-01 도입 -> 2026-11-05 폐지) ─────────
{
  // 폐지는 "장치를 지운다"가 아니라 "기본값이 0(상한 없음)"이다 - 되살리려면 환경변수 한 줄이다.
  assert(DEFAULT_DAILY_PUBLISH_LIMIT === 0, "기본 상한 없음(2026-11-05 폐지)");
  assert(dailyPublishLimit("tistory", {}) === 0, "미설정이면 상한 없음");
  assert(dailyPublishLimit("tistory", { TISTORY_PUBLISH_DAILY_LIMIT: "3" }) === 3, "변수로 되살린다");
  assert(dailyPublishLimit("tistory", { TISTORY_PUBLISH_DAILY_LIMIT: "0" }) === 0, "0은 끄기로 허용");
  assert(dailyPublishLimit("tistory", { TISTORY_PUBLISH_DAILY_LIMIT: "-2" }) === 0, "음수는 기본값");
  assert(dailyPublishLimit("tistory", { TISTORY_PUBLISH_DAILY_LIMIT: "많이" }) === 0, "숫자가 아니면 기본값");
  assert(dailyPublishLimit("naver", { TISTORY_PUBLISH_DAILY_LIMIT: "9" }) === 0, "다른 채널 변수는 안 본다");

  assert(checkDailyLimit(0, 1).allowed, "오늘 0건이면 통과");
  const blocked = checkDailyLimit(1, 1);
  assert(!blocked.allowed, "오늘 1건이면 막는다");
  assert(!blocked.allowed && blocked.publishedToday === 1 && blocked.limit === 1, "사유에 건수·상한을 담는다");
  assert(checkDailyLimit(5, 0).allowed, "상한 0(끄기)이면 몇 건이든 통과");
  assert(checkDailyLimit(2, 3).allowed, "상한 미만이면 통과");

  // KST 자정 경계 - 서버 UTC 자정으로 끊으면 오전 9시에 초기화된다(BLOGGER_DAILY_LIMIT과 같은 함정).
  assert(kstDayStartIso(new Date("2026-11-01T11:30:00.000Z")) === "2026-10-31T15:00:00.000Z", "KST 11/1 20:30 -> 11/1 00:00 KST");
  assert(kstDayStartIso(new Date("2026-11-01T14:59:00.000Z")) === "2026-10-31T15:00:00.000Z", "KST 11/1 23:59는 아직 같은 날");
  assert(kstDayStartIso(new Date("2026-11-01T15:00:00.000Z")) === "2026-11-01T15:00:00.000Z", "KST 11/2 00:00부터 새 날");
  console.log("✅ 일일 발행 상한 - 기본 상한 없음(폐지), 환경변수로 되살림, KST 자정 기준");
}
