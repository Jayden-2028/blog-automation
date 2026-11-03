// 발행 이미지 생존 점검의 판정·문구 테스트 - 네트워크 없음(HEAD 결과를 그대로 넣는다).
import {
  buildImageHealthMessage,
  buildImageHealthReport,
  shouldNotify,
  verdictOf,
} from "./classifyPagesImageHealth.js";
import type { JobImageProbes } from "./classifyPagesImageHealth.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`❌ ${m}`);
}

const PROJECT = "korea-manual-images-2026";
const job = (id: string, keyword: string, statuses: number[], origins: number[] = []): JobImageProbes => ({
  jobId: id,
  keyword,
  pages: statuses.map((status, i) => ({ url: `https://p.dev/${id.slice(0, 8)}/${i}-abc.webp`, status })),
  origins: origins.map((status, i) => ({ url: `https://sb/${id}/${i}.webp`, status })),
});

// 판정 경계. **모르는 상태를 고장으로 치지 않는다**는 쪽이 이 점검의 전제다(매일 도는 알림).
{
  assert(verdictOf(200) === "ok" && verdictOf(206) === "ok", "2xx는 정상");
  assert(verdictOf(404) === "gone" && verdictOf(410) === "gone", "404·410만 사라진 것");
  assert(verdictOf(0) === "unreachable" && verdictOf(500) === "unreachable" && verdictOf(403) === "unreachable", "확인 실패는 고장과 구분한다");
  console.log("  ✅ 404·410만 고장, 타임아웃·5xx·403은 확인 실패");
}

// 조용한 날: 알림을 보내지 않는다.
{
  const report = buildImageHealthReport([job("aaaaaaaa-1", "Trash Day", [200, 200]), job("bbbbbbbb-1", "Bus Fares", [200])]);
  assert(report.jobs === 2 && report.images === 3 && report.goneImages === 0 && report.broken.length === 0, "정상이면 고장 0건");
  assert(!shouldNotify(report), "고장이 없으면 알리지 않는다");
  const message = buildImageHealthMessage(report, PROJECT);
  assert(message.includes("2편 3장 모두 정상"), `정상 문구에 집계가 들어간다 (${message})`);
  console.log("  ✅ 전부 정상 - 알림 없음");
}

// 2026-10-31 재현: 두 글이 통째로 사라졌고 원본은 살아 있다. 문구에 복구 명령이 그대로 들어가야 한다.
{
  const report = buildImageHealthReport([
    job("fda4b29c-0", "Moving Day Foods", [404, 404, 404, 404, 404, 404], [200, 200, 200, 200, 200, 200]),
    job("90623e23-0", "Apartment Prices", [404, 404, 404, 404, 404, 404], [200, 200, 200, 200, 200, 200]),
    job("6b742f14-0", "Korean Breakfast", [200, 200, 200]),
  ]);
  assert(report.goneImages === 12 && report.broken.length === 2, `12장 2편 (${report.goneImages}/${report.broken.length})`);
  assert(report.broken.every((b) => b.recoverable), "원본이 살아 있으면 복구 가능");

  const message = buildImageHealthMessage(report, PROJECT);
  assert(message.includes("12장이 사라졌습니다"), `장수를 제목에 싣는다 (${message})`);
  assert(
    // 장수가 같으면 jobId 순이다 - 순서가 고정이라야 알림을 눈으로 비교할 수 있다.
    message.includes(`npm run images:repair-pages -- 90623e23 fda4b29c --project=${PROJECT} --apply`),
    `복구 명령을 붙여넣을 수 있게 싣는다 (${message})`
  );
  assert(!message.includes("6b742f14"), "멀쩡한 글은 복구 명령에 넣지 않는다");
  assert(shouldNotify(report), "고장이 있으면 알린다");
  console.log("  ✅ 사라진 글 + 붙여넣을 수 있는 복구 명령(2026-10-31 재현)");
}

// 원본까지 사라진 글: 복구 가능하다고 말해선 안 된다. 그쪽이 더 위험한 거짓말이다.
{
  const report = buildImageHealthReport([job("deadbeef-0", "Tipping", [404, 200], [404])]);
  assert(report.broken[0].gone === 1 && report.broken[0].total === 2, "부분 손실도 집는다");
  assert(!report.broken[0].recoverable, "원본이 없으면 복구 불가");
  const message = buildImageHealthMessage(report, PROJECT);
  assert(message.includes("⚠️ 원본도 없음"), `글 줄에 표시한다 (${message})`);
  assert(message.includes("되살릴 수 없습니다"), "되살릴 수 없다고 분명히 적는다");
  assert(!message.includes("images:repair-pages"), "복구 불가뿐이면 복구 명령을 싣지 않는다");
  console.log("  ✅ 원본까지 사라진 글은 복구 가능이라고 말하지 않는다");
}

// 원본을 확인하지 못한 경우(origins 비어 있음)도 복구 가능이라고 하지 않는다.
{
  const report = buildImageHealthReport([job("cafe0000-0", "Subway", [404], [])]);
  assert(!report.broken[0].recoverable, "원본 미확인은 복구 가능으로 보지 않는다");
  console.log("  ✅ 원본 미확인 - 안심시키지 않는다");
}

// 확인 실패만 있는 날: 고장은 아니지만 알린다(계속 실패하면 사람이 봐야 한다).
{
  const report = buildImageHealthReport([job("feed0000-0", "Hospitals", [200, 0, 503])]);
  assert(report.goneImages === 0 && report.unreachable === 2, `확인 실패 2장 (${report.unreachable})`);
  assert(shouldNotify(report), "확인 실패도 알린다");
  const message = buildImageHealthMessage(report, PROJECT);
  assert(message.includes("확인 못 한 2장"), `정상 문구에 덧붙인다 (${message})`);
  console.log("  ✅ 확인 실패는 고장과 따로 보고한다");
}

// 많이 깨진 날: 목록은 8편까지만 펴고 복구 명령에는 전부 넣는다(메시지 잘림 방지).
{
  const many = Array.from({ length: 10 }, (_, i) => job(`${i}0000000-0`, `Topic ${i}`, [404], [200]));
  const message = buildImageHealthMessage(buildImageHealthReport(many), PROJECT);
  assert(message.includes("외 2편"), `나머지는 수만 알린다 (${message})`);
  assert(message.includes("00000000 10000000"), "복구 명령에는 10편 전부 들어간다");
  console.log("  ✅ 목록 8편 제한, 복구 명령은 전부");
}

console.log("\n✅ testPagesImageHealth 통과");
