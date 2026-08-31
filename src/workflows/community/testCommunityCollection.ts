// 커뮤니티 LLM 추출 + candidate 매핑 + 수집 배선 테스트.
// 외부 호출/DB 접근 없이 fixture와 주입된 함수만 사용한다(testGoogleTrends.ts와 같은 원칙).
//
// 실제 사이트 provider(더쿠/네이트판/다음·네이버 카페)는 아직 없다(CommunitySource.ts 참고) -
// 이 테스트는 "provider가 0개여도 안전하게 0건을 반환하는가"와 "provider가 붙었을 때 나머지
// 파이프라인(추출 -> 매핑 -> upsert)이 옳게 동작하는가"를 fake provider로 검증한다. 실제 사이트가
// 붙어도 이 테스트 구조는 그대로 유효하다.

import {
  buildExtractionPrompt,
  parseExtractionOutput,
  extractCommunityKeywords,
  type CommunityPostInput,
} from "./extractCommunityKeywords.js";
import { mapCommunityItemsToInserts, resolveCommunityCategory, computeCommunityCandidateScore } from "./mapCommunityCandidates.js";
import { runCommunityCollection } from "./runCommunityCollection.js";
import type { CommunitySourceProvider } from "../../services/community/CommunitySource.js";
import type { RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

const SAMPLE_POSTS: CommunityPostInput[] = [
  { site: "natepann", title: "ㅋㅋㅋㅋ 이거 실화냐 개레전드", siteRank: 1 },
  { site: "natepann", title: "배우 이서준 열애설 상대 공개", siteRank: 2 },
  { site: "theqoo", title: "오늘 점심 뭐 먹음?", siteRank: 1 },
  { site: "theqoo", title: "근로장려금 반기신청 오늘 마감이라는데 다들 신청함?", siteRank: 2 },
  { site: "theqoo", title: "이 짤 레전드 아니냐 ㅋㅋ", siteRank: 3 },
];

function testExtractionPromptAndParsing(): void {
  console.log("▶ 추출 프롬프트/파싱 테스트");

  const prompt = buildExtractionPrompt(SAMPLE_POSTS);
  assert(prompt.includes("0. [natepann] ㅋㅋㅋㅋ 이거 실화냐 개레전드"), "입력 목록이 번호 포함으로 프롬프트에 들어가야 한다");
  assert(prompt.includes("entertainment"), "허용 category 목록이 프롬프트에 명시돼야 한다");
  ok("프롬프트에 번호 매긴 입력 목록과 category 목록이 포함됨");

  // 정상 출력
  {
    const output = ["1|이서준 열애설|entertainment", "3|근로장려금 반기신청|living"].join("\n");
    const items = parseExtractionOutput(output, SAMPLE_POSTS.length);
    assert(items.length === 2, "정상 출력 2줄이 2건으로 파싱돼야 한다");
    assert(items[0].index === 1 && items[0].keyword === "이서준 열애설" && items[0].category === "entertainment", "첫 항목 파싱 정확해야 한다");
    assert(items[1].index === 3 && items[1].category === "living", "둘째 항목 파싱 정확해야 한다");
    ok("정상 출력 파싱");
  }

  // category 비워둔 경우 -> null (호출자가 폴백)
  {
    const items = parseExtractionOutput("2|오늘 점심 이슈|", SAMPLE_POSTS.length);
    assert(items.length === 1 && items[0].category === null, "category를 비워두면 null이어야 한다");
    ok("category 생략 -> null (폴백 위임)");
  }

  // 깨진/방어적 케이스들: 예외 없이 무시되거나 걸러져야 한다
  {
    assert(parseExtractionOutput("", SAMPLE_POSTS.length).length === 0, "빈 출력은 0건이어야 한다");
    assert(parseExtractionOutput("이건 그냥 설명 문장입니다", SAMPLE_POSTS.length).length === 0, "구분자 없는 줄은 버려야 한다");
    assert(parseExtractionOutput("99|범위 밖 인덱스|living", SAMPLE_POSTS.length).length === 0, "범위 밖 index는 버려야 한다");
    assert(parseExtractionOutput("abc|숫자 아닌 인덱스|living", SAMPLE_POSTS.length).length === 0, "숫자가 아닌 index는 버려야 한다");
    assert(parseExtractionOutput("0||living", SAMPLE_POSTS.length).length === 0, "빈 키워드는 버려야 한다");
    assert(
      parseExtractionOutput("1|이서준 열애설|없는카테고리", SAMPLE_POSTS.length)[0].category === null,
      "유효하지 않은 category는 null로 떨어져야 한다(폴백 위임), 파싱 자체가 죽으면 안 된다"
    );
    ok("깨진 출력에도 예외 없이 방어적으로 처리됨");
  }

  // 같은 index가 두 번 나오면 첫 번째만
  {
    const items = parseExtractionOutput("1|A|entertainment\n1|B|living", SAMPLE_POSTS.length);
    assert(items.length === 1 && items[0].keyword === "A", "중복 index는 첫 번째만 남아야 한다");
    ok("중복 index 방지");
  }

  // 따옴표/공백 정리
  {
    const items = parseExtractionOutput('0| "이서준 열애설"  |entertainment', SAMPLE_POSTS.length);
    assert(items[0].keyword === "이서준 열애설", "따옴표/여백이 정리돼야 한다");
    ok("키워드 앞뒤 따옴표/공백 정리");
  }

  console.log("✅ 추출 프롬프트/파싱 테스트 통과\n");
}

async function testExtractCommunityKeywordsNeverThrows(): Promise<void> {
  console.log("▶ extractCommunityKeywords 계약 테스트");

  // posts가 비어 있으면 LLM을 아예 호출하지 않는다.
  {
    let called = false;
    const result = await extractCommunityKeywords([], {
      runHeadless: async () => {
        called = true;
        return { ok: true, output: "", durationMs: 0 };
      },
    });
    assert(!called, "posts가 0건이면 LLM을 호출하면 안 된다");
    assert(result.items.length === 0, "빈 posts -> 빈 결과");
    ok("posts 0건 -> LLM 미호출, 즉시 빈 결과");
  }

  // LLM 호출 자체가 실패해도 던지지 않는다.
  {
    const result = await extractCommunityKeywords(SAMPLE_POSTS, {
      runHeadless: async (): Promise<RunHeadlessClaudeResult> => ({
        ok: false,
        error: "claude가 종료 코드 1로 끝났습니다",
        durationMs: 10,
      }),
    });
    assert(result.items.length === 0, "실패 시 items는 빈 배열이어야 한다");
    assert(result.error === "claude가 종료 코드 1로 끝났습니다", "실패 원인이 보존돼야 한다");
    ok("LLM 호출 실패해도 throw하지 않고 error 필드로 알림");
  }

  // 정상 호출 경로: 주입된 결과가 그대로 파싱된다.
  {
    const result = await extractCommunityKeywords(SAMPLE_POSTS, {
      runHeadless: async (prompt) => {
        assert(prompt.includes("natepann"), "프롬프트에 입력 posts가 반영돼야 한다");
        return { ok: true, output: "1|이서준 열애설|entertainment\n3|근로장려금 반기신청|living", durationMs: 500 };
      },
    });
    assert(result.items.length === 2 && !result.error, "정상 경로에서는 파싱된 items + error 없음");
    ok("정상 경로: 주입된 LLM 출력이 파싱까지 이어짐");
  }

  console.log("✅ extractCommunityKeywords 계약 테스트 통과\n");
}

function testMapping(): void {
  console.log("▶ 매핑 테스트");

  // category 우선순위: LLM -> 어휘 규칙 -> community 폴백
  {
    assert(resolveCommunityCategory("entertainment", "아무 키워드") === "entertainment", "LLM category를 우선해야 한다");
    assert(resolveCommunityCategory(null, "근로장려금 반기신청") === "living", "LLM이 비었으면 어휘 규칙으로 폴백해야 한다");
    assert(resolveCommunityCategory(null, "아무도 모르는 낯선 단어") === "community", "어휘 규칙도 못 잡으면 community로 폴백해야 한다(구글 트렌드의 living과 다름)");
    ok("category 폴백 순서: LLM > 어휘 규칙 > community");
  }

  // rank 점수: siteRank가 낮을수록(=순위가 높을수록) 점수가 높다
  {
    const top = computeCommunityCandidateScore(1);
    const mid = computeCommunityCandidateScore(10);
    assert(top > mid, "1위가 10위보다 점수가 높아야 한다");
    assert(computeCommunityCandidateScore(1000) === 0, "순위가 너무 낮으면 0 아래로 내려가지 않아야 한다");
    ok("candidate_score가 siteRank에 따라 단조 감소하고 0 아래로 내려가지 않음");
  }

  const collectedAt = "2026-08-30T09:00:00.000Z";

  // 정상 매핑 + 메타데이터 보존
  {
    const extracted = [
      { index: 1, keyword: "이서준 열애설", category: "entertainment" as const },
      { index: 3, keyword: "근로장려금 반기신청", category: null },
    ];
    const { rows, droppedCount } = mapCommunityItemsToInserts(SAMPLE_POSTS, extracted, { collectedAt });
    assert(rows.length === 2 && droppedCount === 0, "2건 추출 -> 2행, 0 drop");
    assert(rows[0].source === "community" && rows[0].topic === "community", "source/topic 고정값 확인");
    assert(rows[0].topic_normalized === "entertainment", "첫 행 category 확인");
    assert(rows[1].topic_normalized === "living", "둘째 행 어휘 폴백 category 확인");
    assert(rows[0].rank === 1 && rows[1].rank === 2, "rank는 extracted 순서대로 1부터 매겨야 한다");
    assert(rows[0].movement_type === "flat" && rows[0].rank_change === null, "커뮤니티는 변화 정보가 없어 flat/null이어야 한다");
    assert(rows[0].trend_date === "2026-08-30", "trend_date는 collectedAt 날짜여야 한다");
    const meta = rows[0].metadata as { site: string; siteRank: number; sourceTitle: string };
    assert(meta.site === "natepann" && meta.siteRank === 2, "metadata에 원본 site/siteRank가 보존돼야 한다");
    assert(meta.sourceTitle === "배우 이서준 열애설 상대 공개", "metadata에 원본 제목이 보존돼야 한다(사후 확인용)");
    ok("정상 매핑: source/topic/category/rank/metadata 전부 확인");
  }

  // 너무 짧은 키워드는 버려진다
  {
    const extracted = [{ index: 0, keyword: "션", category: null }];
    const { rows, droppedCount, droppedKeywords } = mapCommunityItemsToInserts(SAMPLE_POSTS, extracted, { collectedAt });
    assert(rows.length === 0 && droppedCount === 1 && droppedKeywords[0] === "션", "1글자 키워드는 버려야 한다(다른 소스와 같은 게이트)");
    ok("1글자 키워드 제외");
  }

  // 배치 내 conflict key 중복 제거(21000 예방)
  {
    const extracted = [
      { index: 0, keyword: "이서준 열애설", category: "entertainment" as const },
      { index: 1, keyword: "이서준 열애설", category: "entertainment" as const },
    ];
    const { rows, droppedCount } = mapCommunityItemsToInserts(SAMPLE_POSTS, extracted, { collectedAt });
    assert(rows.length === 1 && droppedCount === 1, "같은 (keyword, category) 중복은 1건만 남아야 한다");
    ok("배치 내 conflict key 중복 제거");
  }

  // expires_at은 ttlHours 기준으로 계산된다
  {
    const extracted = [{ index: 0, keyword: "이서준 열애설", category: "entertainment" as const }];
    const { rows } = mapCommunityItemsToInserts(SAMPLE_POSTS, extracted, { collectedAt, ttlHours: 18 });
    const expected = new Date(Date.parse(collectedAt) + 18 * 60 * 60 * 1000).toISOString();
    assert(rows[0].expires_at === expected, "expires_at = collectedAt + ttlHours");
    ok("expires_at 계산 확인");
  }

  console.log("✅ 매핑 테스트 통과\n");
}

async function testCollectionNeverThrows(): Promise<void> {
  console.log("▶ runCommunityCollection 계약 테스트");

  // disabled -> skipped, 조회 없음
  {
    const result = await runCommunityCollection({ enabled: false });
    assert(result.status === "skipped" && result.reason === "disabled", "disabled면 skipped여야 한다");
    ok("disabled -> skipped (조회 없음)");
  }

  // provider가 0개(현재 실제 상태) -> LLM 호출 없이 success + 0건
  {
    let extractCalled = false;
    const result = await runCommunityCollection({
      enabled: true,
      sources: [],
      extractKeywords: async (posts) => {
        extractCalled = true;
        return { items: [] };
      },
    });
    assert(result.status === "success" && result.fetchedCount === 0 && result.upsertedCount === 0, "provider 0개 -> success + 0건");
    assert(!extractCalled, "글이 0건이면 LLM 추출을 호출하면 안 된다");
    ok("provider 0개(실측 전 현재 상태) -> 안전하게 0건 성공, LLM 미호출");
  }

  // 사이트 하나가 실패해도 나머지로 진행한다(실패 격리)
  {
    const okProvider: CommunitySourceProvider = {
      site: "site_ok",
      label: "정상 사이트",
      fetchPosts: async () => [{ title: "정상 사이트 인기글 - 이서준 열애설", siteRank: 1 }],
    };
    const failingProvider: CommunitySourceProvider = {
      site: "site_down",
      label: "실패 사이트",
      fetchPosts: async () => {
        throw new Error("차단됨(403)");
      },
    };
    const result = await runCommunityCollection({
      enabled: true,
      dryRun: true,
      sources: [okProvider, failingProvider],
      extractKeywords: async (posts) => {
        assert(posts.length === 1 && posts[0].site === "site_ok", "실패한 사이트의 글은 posts에 섞이면 안 된다");
        return { items: [{ index: 0, keyword: "이서준 열애설", category: "entertainment" }] };
      },
    });
    assert(result.status === "success", "사이트 하나 실패해도 전체 status는 success여야 한다");
    assert(result.fetchedCount === 1, "정상 사이트의 글만 fetchedCount에 반영돼야 한다");
    assert(result.sourceErrors?.site_down === "차단됨(403)", "실패한 사이트의 원인이 sourceErrors에 남아야 한다");
    ok("사이트 하나 실패 격리: 나머지로 진행 + 실패 원인 보존");
  }

  // dry-run: 조회/추출/매핑만, DB 쓰기 없음
  {
    const provider: CommunitySourceProvider = {
      site: "site_ok",
      label: "정상 사이트",
      fetchPosts: async () => [{ title: "근로장려금 반기신청 마감", siteRank: 1 }],
    };
    const result = await runCommunityCollection({
      enabled: true,
      dryRun: true,
      sources: [provider],
      extractKeywords: async () => ({ items: [{ index: 0, keyword: "근로장려금 반기신청", category: null }] }),
    });
    assert(result.status === "success" && result.upsertedCount === 0 && result.expiredCount === 0, "dry-run은 write count가 0이어야 한다");
    assert(result.fetchedCount === 1, "dry-run이어도 fetchedCount는 실제 조회 결과를 반영해야 한다");
    ok("dry-run: 조회/추출/매핑만 수행, DB 쓰기 없음");
  }

  // LLM 추출 실패해도 전체 status는 success (비치명적) - upsertedCount만 0
  {
    const provider: CommunitySourceProvider = {
      site: "site_ok",
      label: "정상 사이트",
      fetchPosts: async () => [{ title: "아무 제목", siteRank: 1 }],
    };
    const result = await runCommunityCollection({
      enabled: true,
      dryRun: true,
      sources: [provider],
      extractKeywords: async () => ({ items: [], error: "claude가 종료 코드 1로 끝났습니다" }),
    });
    assert(result.status === "success", "LLM 추출 실패는 전체 job을 failed로 만들면 안 된다(비치명적)");
    assert(result.upsertedCount === 0 && result.droppedCount === 0, "추출 결과가 없으면 upsert도 0건이어야 한다");
    assert(result.extractionError === "claude가 종료 코드 1로 끝났습니다", "추출 실패 원인이 extractionError에 보존돼야 한다");
    ok("LLM 추출 실패해도 status는 success 유지, extractionError로 원인만 보존");
  }

  // 가장 중요한 계약: 예상 못한 예외(Error)도 throw하지 않고 failed로 변환
  {
    // fetchPosts 실패는 sourceErrors로 격리되므로(위 블록에서 검증), 여기서는 그 격리 경로를
    // 벗어난 지점에서 예외가 나는 상황을 시뮬레이션한다. extractKeywords가 던지는(=결과 객체의
    // error 필드가 아니라 실제 throw) 케이스가 그 지점이다. dryRun:true로 두어 실제 Supabase는
    // 절대 건드리지 않는다(testGoogleTrends.ts의 forced-failure 주입과 같은 원칙).
    const result = await runCommunityCollection({
      enabled: true,
      dryRun: true,
      sources: [
        {
          site: "site_ok",
          label: "정상 사이트",
          fetchPosts: async () => [{ title: "이서준 열애설", siteRank: 1 }],
        },
      ],
      extractKeywords: async () => {
        throw { message: "unexpected", code: "500", details: "boom" }; // 비-Error 객체로 describeError 경로도 검증
      },
    });
    assert(result.status === "failed", "예기치 못한 예외는 status:'failed'로 변환돼야 한다");
    assert(typeof result.error === "string" && result.error.length > 0, "실패 원인이 문자열로 보존돼야 한다([object Object] 금지)");
    assert(result.error !== "[object Object]", "PostgrestError 등 비-Error 객체도 [object Object]가 되면 안 된다");
    ok("수집 실패해도 throw하지 않고 status='failed' + 문자열 원인 반환");
  }

  console.log("✅ runCommunityCollection 계약 테스트 통과\n");
}

async function main(): Promise<void> {
  console.log("▶ 커뮤니티 수집기 테스트 시작\n");

  testExtractionPromptAndParsing();
  await testExtractCommunityKeywordsNeverThrows();
  testMapping();
  await testCollectionNeverThrows();

  console.log("✅ 전체 통과");
}

await main();
