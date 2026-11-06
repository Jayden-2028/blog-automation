// 수정 단계 보충 조사 테스트(2026-11-06). 실행: npm run test:revise-research
//
// 실제 LLM·네이버 API·텔레그램을 **호출하지 않는다** - 판정·조사·저장·알림을 전부 주입한다.
// 특히 알림 함수를 주입하지 않으면 이 저장소에서는 운영 텔레그램으로 메시지가 나간다(2026-11-06 실측).

import { appendSupplementalResearch, buildSupplementBlock, countSupplementBlocks } from "../research/appendSupplementalResearch.js";
import {
  collectSupplementalResearch,
  findInPersonPack,
  parseSupplementalOutput,
  researchTextCovers,
  toSupplementSourceInserts,
} from "../research/collectSupplementalResearch.js";
import { MAX_RESEARCH_ITEMS, parseResearchItems, planRevisionResearch, RESEARCH_ITEM_MARKERS } from "./planRevisionResearch.js";
import { describeSupplement, reviseWithSupplementalResearch } from "./reviseWithSupplementalResearch.js";
import type { PersonSourcePack } from "../research/personSourcePack.js";
import type { ReviseArticleInput, ReviseArticleResult } from "./reviseArticleWithFeedback.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const LONG_BODY = "수정된 본문 문단입니다. ".repeat(30);

// ──────────────────────────────────────────────────────────────────────────────
// 1) 조사 항목 추출
// ──────────────────────────────────────────────────────────────────────────────
{
  const items = parseResearchItems(["아무 말", RESEARCH_ITEM_MARKERS.items, "- 마들렌", "2. 달콤한 인생", "• 마왕"].join("\n"));
  assert(items.join("|") === "마들렌|달콤한 인생|마왕", `불릿·번호를 떼고 순서대로 뽑아야 한다 (${items.join("|")})`);

  assert(parseResearchItems(`${RESEARCH_ITEM_MARKERS.items}\n${RESEARCH_ITEM_MARKERS.none}`).length === 0, "(없음)이면 빈 목록");
  assert(parseResearchItems("마커 없는 산문 응답").length === 0, "마커가 없으면 빈 목록");

  const many = parseResearchItems([RESEARCH_ITEM_MARKERS.items, ...Array.from({ length: 20 }, (_, i) => `- 항목${i}`)].join("\n"));
  assert(many.length === MAX_RESEARCH_ITEMS, `개수 상한을 코드가 집행해야 한다 (${many.length})`);

  const noisy = parseResearchItems([RESEARCH_ITEM_MARKERS.items, `- ${"설명이 긴 문장 ".repeat(10)}`, "- 마들렌", "- 마들렌"].join("\n"));
  assert(noisy.join("|") === "마들렌", "긴 설명 줄은 버리고 중복은 제거한다");

  const stopped = parseResearchItems([RESEARCH_ITEM_MARKERS.items, "- 마들렌", "### OTHER", "- 끼어든 것"].join("\n"));
  assert(stopped.join("|") === "마들렌", "다음 ### 블록에서 멈춘다");
  console.log("✅ 조사 항목 추출 - 상한·중복·잡음·마커 경계");
}

{
  const plan = await planRevisionResearch({
    keyword: "신민아",
    category: "person",
    originalTitle: "신민아",
    originalBody: "본문",
    researchText: null,
    feedback: "필모그래피를 늘려주세요. 마들렌·마왕",
    generate: async (prompt) => {
      assert(prompt.includes("마들렌"), "피드백이 프롬프트에 실려야 한다");
      assert(prompt.includes("주제를 바꾸거나 넓히는 항목은 적지 않는다"), "범위 가드 지시가 있어야 한다");
      return { ok: true, output: `${RESEARCH_ITEM_MARKERS.items}\n- 마들렌\n- 마왕`, durationMs: 1 };
    },
  });
  assert(plan.items.join("|") === "마들렌|마왕", "판정 결과를 그대로 돌려준다");

  const failed = await planRevisionResearch({
    keyword: "k",
    category: null,
    originalTitle: "t",
    originalBody: "b",
    researchText: null,
    feedback: "f",
    generate: async () => ({ ok: false, error: "타임아웃", durationMs: 1 }),
  });
  assert(failed.items.length === 0 && failed.error === "타임아웃", "판정 실패는 빈 목록 + 사유(수정을 막지 않는다)");
  console.log("✅ 조사 항목 판정 - 성공/실패 모두 수정을 막지 않는다");
}

// ──────────────────────────────────────────────────────────────────────────────
// 2) 받아 둔 인물 소스팩에서 바로 찾기(네트워크 없음)
// ──────────────────────────────────────────────────────────────────────────────
{
  const pack: PersonSourcePack = {
    personDb: "신민아 배우",
    namuwiki: [
      "## 5. 출연 목록",
      "### 5.1. 드라마",
      "2007년 | MBC | 마왕 | 서해인 | 주연 | 12.3%",
      "2003년 | 마들렌 | 김희진 | 주연",
      "## 6. 수상 경력",
      "2017년 | 제53회 백상예술대상 | TV부문 여자 최우수연기상",
    ].join("\n"),
    workCasts: [{ work: "마왕", role: "서해인", namuwikiTitle: "마왕(드라마)/등장인물", excerpt: "서해인은 네일아티스트다." }],
    fetchedAt: new Date().toISOString(),
    errors: [],
  };

  const magwang = findInPersonPack("마왕", pack);
  assert(magwang, "출연 목록에 있는 작품은 팩에서 바로 나온다");
  assert(magwang!.body.includes("배역 서해인") && magwang!.body.includes("시청률 12.3%"), "배역·시청률을 재료로 담는다");
  assert(magwang!.body.includes("서해인은 네일아티스트다"), "등장인물 발췌도 함께 담는다");

  assert(findInPersonPack("마들렌(2003년 영화)", pack), "괄호 수식이 붙어도 작품명으로 맞춘다");
  assert(findInPersonPack("야수와 미녀", pack) === null, "팩에 없는 작품은 null(에이전트 다리로 넘어간다)");
  assert(findInPersonPack("마왕", null) === null, "팩이 없으면 null");
  assert(findInPersonPack("제53회 백상예술대상", pack) === null, "수상 경력 표는 작품으로 새지 않는다");
  console.log("✅ 인물 소스팩에서 작품 재료 추출(네트워크 없음)");
}

{
  assert(researchTextCovers("## 1. 핵심 사실\n- 마들렌(2003)", "마들렌"), "조사 자료에 있으면 covered");
  assert(!researchTextCovers("## 1. 핵심 사실", "마들렌"), "없으면 not covered");
  assert(!researchTextCovers(null, "마들렌"), "조사 자료가 없으면 not covered");
  console.log("✅ 기존 조사 자료 커버 판정");
}

// ──────────────────────────────────────────────────────────────────────────────
// 3) 보충 조사 출력 파싱 + 범위 가드
// ──────────────────────────────────────────────────────────────────────────────
{
  const raw = [
    "### FOUND",
    "#### 마들렌",
    "- 2003년 영화, 김희진 역 (https://example.com/a)",
    "#### 야수와 미녀",
    "",
    "### SOURCES",
    "| 제목 | URL | 등급 | 발행일 |",
    "| --- | --- | --- | --- |",
    "| 마들렌 소개 | https://example.com/a | news | 2003-05-01 |",
    "| 잘못된 줄 | 없음 | news | - |",
    "| 공공기관 | https://www.mohw.go.kr/x | 이상한등급 | - |",
    "### MISSING",
    "- 야수와 미녀: 개봉 정보를 확인할 출처가 없다",
  ].join("\n");
  const parsed = parseSupplementalOutput(raw);
  assert(parsed.findings.length === 1 && parsed.findings[0].item === "마들렌", "본문이 있는 항목만 findings");
  assert(parsed.sources.length === 2, `URL 없는 줄은 버린다 (${parsed.sources.length})`);
  assert(parsed.sources[0].publishedAt === "2003-05-01", "발행일을 읽는다");
  assert(parsed.sources[1].authority === "official", "이상한 등급은 URL로 재판정한다(.go.kr → official)");
  assert(parsed.missing[0].item === "야수와 미녀" && parsed.missing[0].reason.includes("출처가 없다"), "못 찾음 사유를 읽는다");
  console.log("✅ 보충 조사 출력 파싱 - 출처 검증·못 찾음 사유");
}

{
  // 에이전트가 범위 밖 주제를 덤으로 물어 와도 코드가 버린다(부산 특산품 사고 계열 가드).
  const collected = await collectSupplementalResearch({
    keyword: "신민아",
    category: "person",
    originalTitle: "신민아",
    items: ["마들렌"],
    sourcePack: null,
    researchText: null,
    runAgent: async (prompt) => {
      assert(prompt.includes("목록에 없는 주제·인물·사건은 조사하지도, 적지도 않는다"), "범위 가드 지시가 있어야 한다");
      assert(prompt.includes('주제("신민아")를 함께 넣는다'), "질의에 주제를 붙이라는 지시가 있어야 한다");
      return {
        ok: true,
        output: [
          "### FOUND",
          "#### 마들렌",
          "- 2003년 영화 (https://example.com/a)",
          "#### 부산 특산품",
          "- 범위 밖 재료 (https://example.com/z)",
          "### MISSING",
        ].join("\n"),
        durationMs: 1,
      };
    },
  });
  assert(collected.agentFindings.length === 1 && collected.agentFindings[0].item === "마들렌", "항목 밖 재료는 버린다");
  assert(collected.missing.length === 0, "찾은 항목은 못 찾음에 들어가지 않는다");
  console.log("✅ 범위 가드 - 뽑힌 항목 밖 재료는 원고에 닿지 않는다");
}

{
  // 다섯 중 둘만 찾은 경우. 나머지는 사유와 함께 missing이다(조용히 빠지지 않는다).
  const collected = await collectSupplementalResearch({
    keyword: "신민아",
    category: "person",
    originalTitle: "신민아",
    items: ["마들렌", "달콤한 인생", "야수와 미녀", "이 죽일놈의 사랑", "마왕"],
    sourcePack: null,
    researchText: null,
    runAgent: async () => ({
      ok: true,
      output: [
        "### FOUND",
        "#### 마들렌",
        "- 2003년 영화 (https://example.com/a)",
        "#### 마왕",
        "- 2007년 드라마 (https://example.com/b)",
        "### SOURCES",
        "| 마들렌 | https://example.com/a | news | - |",
        "### MISSING",
        "- 야수와 미녀: 출처 없음",
      ].join("\n"),
      durationMs: 1,
    }),
  });
  assert(collected.agentFindings.length === 2, "찾은 둘만 재료가 된다");
  const missingItems = collected.missing.map((m) => m.item).sort();
  assert(missingItems.join("|") === "달콤한 인생|야수와 미녀|이 죽일놈의 사랑", `못 찾은 셋 전부가 남아야 한다 (${missingItems.join("|")})`);
  assert(collected.missing.find((m) => m.item === "달콤한 인생")!.reason.includes("조사 결과에 나오지 않았다"), "에이전트가 침묵한 항목도 못 찾음이다");
  console.log("✅ 일부만 찾은 경우 - 못 찾은 항목이 사유와 함께 전부 남는다");
}

{
  const collected = await collectSupplementalResearch({
    keyword: "신민아",
    category: "person",
    originalTitle: "신민아",
    items: ["마들렌"],
    sourcePack: null,
    researchText: null,
    runAgent: async () => ({ ok: false, error: "타임아웃", durationMs: 1 }),
  });
  assert(collected.agentError === "타임아웃" && collected.missing[0].reason.includes("타임아웃"), "에이전트 실패는 못 찾음 + 사유로 남는다");

  const packOnly = await collectSupplementalResearch({
    keyword: "신민아",
    category: "person",
    originalTitle: "신민아",
    items: ["마들렌"],
    sourcePack: {
      personDb: "",
      namuwiki: "## 5. 출연 목록\n2003년 | 마들렌 | 김희진 | 주연",
      fetchedAt: new Date().toISOString(),
      errors: [],
    },
    researchText: null,
    runAgent: async () => {
      throw new Error("팩에서 다 찾았으면 에이전트를 부르지 않아야 한다");
    },
  });
  assert(packOnly.packFindings.length === 1 && packOnly.agentFindings.length === 0, "팩이 다 채우면 웹 조사를 돌리지 않는다(비용)");
  console.log("✅ 에이전트 실패 처리 / 팩으로 충족되면 웹 조사 생략");
}

// ──────────────────────────────────────────────────────────────────────────────
// 4) 조사 기록은 덧붙이고 덮어쓰지 않는다
// ──────────────────────────────────────────────────────────────────────────────
{
  const original = "## 1. 핵심 사실\n- 원래 조사 내용\n\n## 10. 출처\n| a | https://x | news | - |";
  const block = buildSupplementBlock({
    feedback: "필모그래피 늘려주세요",
    items: ["마들렌", "야수와 미녀"],
    packFindings: [{ item: "마들렌", body: "- 배역 김희진" }],
    agentFindings: [],
    missing: [{ item: "야수와 미녀", reason: "출처 없음" }],
    sources: [{ title: "마들렌", url: "https://example.com/a", authority: "news", publishedAt: "2003-05-01" }],
    at: "2026-11-06T01:00:00.000Z",
  });
  const once = appendSupplementalResearch(original, block);
  assert(once.startsWith(original), "원 조사가 한 글자도 바뀌지 않아야 한다(감사 기록)");
  assert(once.includes("보충 조사 (수정 요청 반영)") && once.includes("2026-11-06T01:00:00.000Z"), "언제 더 조사했는지 표시된다");
  assert(once.includes('왜: 사용자 수정 요청 "필모그래피 늘려주세요"'), "왜 더 조사했는지 표시된다");
  assert(once.includes("무엇: 마들렌 / 야수와 미녀"), "무엇을 조사했는지 표시된다");
  assert(once.includes("못 찾은 항목 (본문에 쓰지 않는다)"), "못 찾은 항목도 기록에 남는다");
  assert(once.includes("| 마들렌 | https://example.com/a | news | 2003-05-01 |"), "보충 출처 표가 기록에 남는다");

  const twice = appendSupplementalResearch(once, block);
  assert(countSupplementBlocks(twice) === 2, "두 번 수정하면 블록이 둘 쌓인다(덮어쓰기 아님)");
  assert(twice.startsWith(original), "두 번째 보충도 원 조사를 건드리지 않는다");
  assert(appendSupplementalResearch(null, block).includes("보충 조사"), "조사 기록이 없던 job도 블록만 남는다");
  console.log("✅ 조사 기록 - 덧붙이기(원 조사 불변, 여러 번 누적)");
}

{
  const rows = toSupplementSourceInserts("job-1", [
    { title: "a", url: "https://example.com/a", authority: "news", publishedAt: "2003-05-01" },
    { title: "a 중복", url: "https://example.com/a", authority: "news", publishedAt: null },
    { title: "b", url: "https://example.com/b", authority: "community", publishedAt: "발행일 미상" },
  ]);
  assert(rows.length === 2, "URL 중복은 제거한다");
  assert(rows[0].source_name === "revise-researcher", "원 조사 출처와 구분되는 이름을 쓴다");
  assert(rows[0].published_at?.startsWith("2003-05-01"), "파싱 가능한 날짜만 timestamptz로");
  assert(rows[1].published_at === null, "자유 텍스트 날짜는 null(원문은 조사 기록에 남는다)");
  console.log("✅ 보충 출처 -> sources 행(중복 제거·날짜 정규화)");
}

// ──────────────────────────────────────────────────────────────────────────────
// 5) 전체 흐름(주입)
// ──────────────────────────────────────────────────────────────────────────────
const baseJob = {
  jobId: "job-1",
  keyword: "신민아",
  category: "person",
  originalTitle: "신민아",
  originalBody: "기존 본문입니다.\n\n#태그",
  feedback: "필로그래피 문단을 더 늘려주세요. 마들렌·마왕",
};

{
  // 평시 경로: 조사할 것이 없다 -> 보충 조사를 돌지 않고, 조사 기록만 사실 출처로 넘긴다.
  let reviseInput: ReviseArticleInput | null = null;
  const saved: Record<string, unknown>[] = [];
  const { result, supplement } = await reviseWithSupplementalResearch(
    { ...baseJob, metadata: { researchFileContent: "## 1. 핵심 사실\n- 원래 조사" } },
    {
      planItems: async () => ({ items: [] }),
      collect: async () => {
        throw new Error("항목이 없으면 조사를 돌리지 않아야 한다");
      },
      revise: async (input) => {
        reviseInput = input;
        return { status: "success", revised: { title: "제목", body: LONG_BODY }, durationMs: 1 };
      },
      mergeJobMetadata: async (_id, patch) => void saved.push(patch),
      saveSources: async () => undefined,
      log: () => {},
    }
  );
  assert(result.status === "success", "평시 경로는 그대로 성공한다");
  assert(reviseInput!.researchText === "## 1. 핵심 사실\n- 원래 조사", "조사 기록이 재작성에 전달돼야 한다");
  assert(saved.length === 0, "보충 조사가 없으면 metadata를 쓰지 않는다");
  assert(supplement.items.length === 0 && describeSupplement(supplement).length === 0, "평시 알림에 보충 조사 줄이 붙지 않는다");
  console.log("✅ 전체 흐름 - 보충 조사 없는 평시 경로 회귀(조사 기록만 추가 전달)");
}

{
  // 일부만 찾은 경우: 조사 기록에 덧붙이고, 못 찾은 항목을 재작성과 알림 양쪽에 전달한다.
  let reviseInput: ReviseArticleInput | null = null;
  const saved: Record<string, unknown>[] = [];
  let savedSources = 0;
  const { result, supplement } = await reviseWithSupplementalResearch(
    { ...baseJob, metadata: { researchFileContent: "## 1. 핵심 사실\n- 원래 조사" } },
    {
      planItems: async () => ({ items: ["마들렌", "마왕"] }),
      collect: async (input) => {
        assert(input.items.join("|") === "마들렌|마왕", "판정 목록이 조사 범위로 그대로 넘어간다");
        return {
          packFindings: [{ item: "마들렌", body: "- 배역 김희진" }],
          agentFindings: [],
          missing: [{ item: "마왕", reason: "출처 없음" }],
          sources: [{ title: "마들렌", url: "https://example.com/a", authority: "news", publishedAt: null }],
        };
      },
      revise: async (input) => {
        reviseInput = input;
        return { status: "success", revised: { title: "제목", body: LONG_BODY }, durationMs: 1 };
      },
      mergeJobMetadata: async (_id, patch) => void saved.push(patch),
      saveSources: async (rows) => void (savedSources = rows.length),
      now: () => new Date("2026-11-06T01:00:00.000Z"),
      log: () => {},
    }
  );
  assert(result.status === "success", "일부만 찾았어도 그만큼 반영하고 성공한다");
  const nextResearch = saved[0].researchFileContent as string;
  assert(nextResearch.startsWith("## 1. 핵심 사실\n- 원래 조사"), "원 조사가 앞에 그대로 남아야 한다");
  assert(countSupplementBlocks(nextResearch) === 1, "보충 블록이 하나 붙는다");
  assert(reviseInput!.researchText === nextResearch, "재작성은 보충분이 붙은 조사 기록을 사실 출처로 받는다");
  assert(reviseInput!.unavailableItems?.[0].item === "마왕", "못 찾은 항목이 재작성에 전달된다(지어내기 금지)");
  assert(savedSources === 1, "보충 출처가 sources에 들어간다");
  assert((saved[0].lastSupplementalResearch as { at: string }).at === "2026-11-06T01:00:00.000Z", "보충 조사 기록 메타를 남긴다");

  const notes = describeSupplement(supplement);
  assert(notes.some((line) => line.includes("1/2건 반영")), "몇 건 반영했는지 알린다");
  assert(notes.some((line) => line.includes("마왕") && line.includes("출처 없음")), "못 찾은 항목이 사용자에게 보이는 경로로 나간다");
  console.log("✅ 전체 흐름 - 일부만 찾음: 기록 덧붙임 + 못 찾은 항목 알림");
}

{
  // 하나도 못 찾은 경우: 재작성을 돌리지 않고(원고 보존) 사유를 알린다. 기록에는 시도가 남는다.
  const saved: Record<string, unknown>[] = [];
  const { result, supplement } = await reviseWithSupplementalResearch(
    { ...baseJob, metadata: { researchFileContent: "## 1. 핵심 사실" } },
    {
      planItems: async () => ({ items: ["야수와 미녀", "이 죽일놈의 사랑"] }),
      collect: async () => ({
        packFindings: [],
        agentFindings: [],
        missing: [
          { item: "야수와 미녀", reason: "출처 없음" },
          { item: "이 죽일놈의 사랑", reason: "조사 결과에 나오지 않았다" },
        ],
        sources: [],
      }),
      revise: async () => {
        throw new Error("하나도 못 찾았으면 재작성을 돌리지 않아야 한다(원고 보존)");
      },
      mergeJobMetadata: async (_id, patch) => void saved.push(patch),
      saveSources: async () => undefined,
      log: () => {},
    }
  );
  assert(result.status === "blocked", `전부 못 찾으면 blocked여야 한다 (${JSON.stringify(result)})`);
  if (result.status === "blocked") {
    assert(result.reason.includes("야수와 미녀") && result.reason.includes("이 죽일놈의 사랑"), "무엇을 못 찾았는지 사유에 있어야 한다");
    assert(result.reason.includes("원고를 그대로 두었습니다"), "원고를 건드리지 않았다고 알려야 한다");
    assert(!result.reason.includes("마커"), "마커 형식 에러로 나가면 안 된다");
  }
  assert(countSupplementBlocks(saved[0].researchFileContent as string) === 1, "못 찾은 시도도 조사 기록에 남는다");
  assert(describeSupplement(supplement).some((line) => line.includes("0/2건 반영")), "0건 반영이 알림에 보인다");
  console.log("✅ 전체 흐름 - 전부 못 찾음: 원고 보존 + 사유 알림 + 시도 기록");
}

{
  // 조사 기록 저장이 실패해도 수정은 진행되고, 그 사실이 알림에 남는다.
  const { result, supplement } = await reviseWithSupplementalResearch(
    { ...baseJob, metadata: {} },
    {
      planItems: async () => ({ items: ["마들렌"] }),
      collect: async () => ({
        packFindings: [{ item: "마들렌", body: "- 배역 김희진" }],
        agentFindings: [],
        missing: [],
        sources: [],
      }),
      revise: async () => ({ status: "success", revised: { title: "제목", body: LONG_BODY }, durationMs: 1 }),
      mergeJobMetadata: async () => {
        throw new Error("DB 장애");
      },
      saveSources: async () => undefined,
      log: () => {},
    }
  );
  assert(result.status === "success", "기록 저장 실패가 수정을 막지 않는다");
  assert(!supplement.researchAppended, "기록 저장 실패를 표시한다");
  assert(describeSupplement(supplement).some((line) => line.includes("조사 기록 저장에 실패")), "그 사실이 알림에 보인다");
  console.log("✅ 전체 흐름 - 기록 저장 실패는 알리고 진행");
}

{
  // 항목 판정이 실패하면 보충 조사 없이 평시 경로로 간다(보충 조사는 예외 경로다).
  let revised: ReviseArticleResult | null = null;
  const { result, supplement } = await reviseWithSupplementalResearch(
    { ...baseJob, metadata: { researchFileContent: "## 1. 핵심 사실" } },
    {
      planItems: async () => ({ items: [], error: "타임아웃" }),
      collect: async () => {
        throw new Error("판정이 실패하면 조사를 돌리지 않아야 한다");
      },
      revise: async () => {
        revised = { status: "success", revised: { title: "제목", body: LONG_BODY }, durationMs: 1 };
        return revised;
      },
      mergeJobMetadata: async () => undefined,
      saveSources: async () => undefined,
      log: () => {},
    }
  );
  assert(result.status === "success" && revised !== null, "판정 실패에도 평시 재작성이 돈다");
  assert(supplement.planError === "타임아웃", "판정 실패 사유를 기록한다");
  console.log("✅ 전체 흐름 - 판정 실패는 평시 경로로 폴백");
}

console.log("\n✅ testReviseSupplementalResearch 전체 통과");
