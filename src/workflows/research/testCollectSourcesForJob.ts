// collectSourcesForJob 테스트. 실제 NAVER API를 호출하지 않는다 - provider 주입 지점으로
// KeywordProvider 결과를 대체해 매핑/등급 판정/중복 제거/부분 실패 로직만 검증한다.

import { collectSourcesForJob } from "./collectSourcesForJob.js";
import type { KeywordProvider } from "../../services/search/providers/KeywordProvider.js";
import type { RawKeyword } from "../../types/keywordDiscovery.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function makeRaw(overrides: Partial<RawKeyword> & { source: string }): RawKeyword {
  return {
    keyword: "기본 제목",
    sourceUrl: "https://example.com/1",
    metadata: { description: "기본 스니펫" },
    ...overrides,
  };
}

function fakeProvider(results: RawKeyword[]): KeywordProvider {
  return { fetchKeywords: async () => results };
}

function failingProvider(message: string): KeywordProvider {
  return {
    fetchKeywords: async () => {
      throw new Error(message);
    },
  };
}

async function main(): Promise<void> {
  console.log("▶ collectSourcesForJob 테스트 시작\n");

  // 1) 세 소스 모두 성공: 등급 판정 + job_id 부여까지 확인.
  {
    const result = await collectSourcesForJob("job-1", "근로장려금", {
      providers: {
        news: fakeProvider([makeRaw({ source: "naver_news", sourceUrl: "https://wikitree.co.kr/a" })]),
        web: fakeProvider([makeRaw({ source: "naver_web", sourceUrl: "https://hometax.go.kr/a" })]),
        blog: fakeProvider([makeRaw({ source: "naver_blog", sourceUrl: "https://blog.naver.com/a" })]),
      },
    });
    assert(Object.keys(result.sourceErrors).length === 0, "전부 성공했으면 에러가 없어야 한다");
    assert(result.sources.length === 3, `3건이어야 한다 (실제: ${result.sources.length})`);
    assert(result.sources.every((s) => s.job_id === "job-1"), "모든 source에 job_id가 붙어야 한다");
    const byAuthority = Object.fromEntries(result.sources.map((s) => [s.source_name, s.authority]));
    assert(byAuthority.naver_web === "official", `official 판정 실패 (실제: ${byAuthority.naver_web})`);
    assert(byAuthority.naver_news === "news", `news 판정 실패 (실제: ${byAuthority.naver_news})`);
    assert(byAuthority.naver_blog === "community", `community 판정 실패 (실제: ${byAuthority.naver_blog})`);
    console.log("✅ 세 소스 성공 -> job_id 부여 + 등급 판정 정확");
  }

  // 2) 일부 실패: 실패한 소스만 sourceErrors에 남고, 성공한 결과로는 계속 진행한다.
  {
    const result = await collectSourcesForJob("job-2", "테스트", {
      providers: {
        news: failingProvider("429 rate limited"),
        web: fakeProvider([makeRaw({ source: "naver_web", sourceUrl: "https://example.com/web-1" })]),
        blog: fakeProvider([makeRaw({ source: "naver_blog", sourceUrl: "https://example.com/blog-1" })]),
      },
    });
    assert(Object.keys(result.sourceErrors).length === 1, "실패한 소스 1건만 기록돼야 한다");
    assert(result.sourceErrors.naver_news?.includes("429"), "실패 사유가 보존돼야 한다");
    assert(result.sources.length === 2, `성공한 2건은 그대로 반환돼야 한다 (실제: ${result.sources.length})`);
    console.log("✅ 일부 실패 -> 실패분만 기록, 성공분으로 계속 진행");
  }

  // 3) 전부 실패: 빈 결과 + 에러 3건 모두 반환(호출자가 재시도 여부를 판단할 근거).
  {
    const result = await collectSourcesForJob("job-3", "테스트", {
      providers: {
        news: failingProvider("timeout"),
        web: failingProvider("timeout"),
        blog: failingProvider("timeout"),
      },
    });
    assert(result.sources.length === 0, "전부 실패면 sources는 비어 있어야 한다");
    assert(Object.keys(result.sourceErrors).length === 3, "전부 실패면 에러 3건이 모두 기록돼야 한다");
    console.log("✅ 전부 실패 -> 빈 결과 + 에러 3건 전달");
  }

  // 4) url 기준 중복 제거. 같은 URL이 여러 소스에 걸쳐 나와도 한 건만 남는다.
  {
    const result = await collectSourcesForJob("job-4", "테스트", {
      providers: {
        news: fakeProvider([makeRaw({ source: "naver_news", sourceUrl: "https://a.com/dup" })]),
        web: fakeProvider([
          makeRaw({ source: "naver_web", sourceUrl: "https://a.com/dup" }),
          makeRaw({ source: "naver_web", sourceUrl: "https://a.com/unique" }),
        ]),
        blog: fakeProvider([]),
      },
    });
    assert(result.sources.length === 2, `중복 제거 후 2건이어야 한다 (실제: ${result.sources.length})`);
    console.log("✅ URL 중복 제거 확인");
  }

  console.log("\n✅ collectSourcesForJob 테스트 완료");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// --- 지식iN·카페·백과(2026-09-18) - 소스 이름 보존, community 등급, 주입 객체에 없는 소스는 건너뜀 ----
{
  const result = await collectSourcesForJob("job-9", "국중박 분장놀이", {
    providers: {
      kin: fakeProvider([makeRaw({ source: "naver_kin", keyword: "국중박 분장놀이 일반인도 볼 수 있나요?", sourceUrl: "https://kin.naver.com/qna/1" })]),
      cafe: fakeProvider([makeRaw({ source: "naver_cafe", keyword: "분장놀이 결선 예매 어떻게 해요", sourceUrl: "https://cafe.naver.com/a/1" })]),
    },
  });
  const names = result.sources.map((s) => s.source_name).sort();
  if (names.join(",") !== "naver_cafe,naver_kin") throw new Error(`❌ 소스 이름이 보존돼야 한다 (${names})`);
  if (!result.sources.every((s) => s.authority === "community")) throw new Error("❌ 지식iN·카페는 community여야 한다");
  if (Object.keys(result.sourceErrors).length !== 0) throw new Error("❌ 주입 객체에 없는 소스(뉴스 등)는 실패로 기록하면 안 된다");
  console.log("✅ 지식iN·카페 소스 - 이름 보존, community, 미주입 소스 건너뜀");
}


// --- 인물 백과 person 모드(2026-10-13, A-7) - 카페·지식iN 제외, 자동완성 원본 주입, 실패해도 진행 ----
{
  const boom = (name: string): KeywordProvider => ({
    fetchKeywords: async () => {
      throw new Error(`❌ person 모드에서 ${name}을 호출하면 안 된다`);
    },
  });
  const providers = {
    news: fakeProvider([makeRaw({ source: "naver_news", sourceUrl: "https://wikitree.co.kr/a" })]),
    web: fakeProvider([makeRaw({ source: "naver_web", sourceUrl: "https://namu.wiki/w/x" })]),
    kin: boom("kin"),
    cafe: boom("cafe"),
  };
  const asked: string[] = [];
  const person = await collectSourcesForJob("job-p", "진선규", {
    category: "person",
    providers,
    fetchAutocomplete: async (q) => {
      asked.push(q);
      return ["진선규 와이프", "진선규 나무위키", "진선규 박보경"];
    },
  });
  if (Object.keys(person.sourceErrors).length !== 0) throw new Error("❌ person 모드는 카페·지식iN을 건드리지 않아 에러가 없어야 한다");
  if (person.sources.some((s) => s.source_name === "naver_kin" || s.source_name === "naver_cafe")) throw new Error("❌ person에 카페·지식iN 소스가 섞였다");
  if (person.sources.length !== 2) throw new Error(`❌ 뉴스+웹 baseline은 유지돼야 한다 (${person.sources.length})`);
  if (asked.join("|") !== "진선규") throw new Error(`❌ 자동완성은 인물명 단독 질의 1회여야 한다 (${asked})`);
  if (person.personAutocomplete?.suggestions.join("|") !== "진선규 와이프|진선규 나무위키|진선규 박보경" || person.personAutocomplete.failed) {
    throw new Error("❌ 자동완성 꼬리말 원본이 걸러지지 않고 그대로 실려야 한다");
  }

  // 조회 실패(예외·빈 결과)는 리서치를 막지 않고 failed로 남긴다.
  const threw = await collectSourcesForJob("job-p", "진선규", {
    category: "person",
    providers,
    fetchAutocomplete: async () => {
      throw new Error("blocked");
    },
  });
  if (threw.sources.length !== 2 || !threw.personAutocomplete?.failed) throw new Error("❌ 자동완성 예외여도 baseline은 수집되고 failed로 표시돼야 한다");

  // 다른 카테고리는 자동완성을 부르지 않고 personAutocomplete가 null이다.
  const other = await collectSourcesForJob("job-o", "x", { providers: { news: providers.news }, fetchAutocomplete: boom("autocomplete").fetchKeywords as never });
  if (other.personAutocomplete !== null) throw new Error("❌ person이 아니면 자동완성을 모으지 않는다");

  // 프롬프트에 원본이 그대로, 실패면 실패 사실이 실린다.
  const { buildResearchPrompt } = await import("./buildResearchPrompt.js");
  const base = { job: { keyword: "진선규", headline: null, category: "person" }, baselineSources: [], outputPath: "/r/진선규.md", today: "2026-10-13" };
  const withAuto = buildResearchPrompt({ ...base, personAutocomplete: person.personAutocomplete });
  if (!withAuto.includes("1. 진선규 와이프") || !withAuto.includes("3. 진선규 박보경")) throw new Error("❌ 프롬프트에 자동완성 원본이 순서대로 실려야 한다");
  const failedPrompt = buildResearchPrompt({ ...base, personAutocomplete: threw.personAutocomplete });
  if (!failedPrompt.includes("자동완성 조회 실패")) throw new Error("❌ 조회 실패 사실이 입력에 남아야 한다");
  console.log("✅ person 모드 - 카페·지식iN 제외, 인물명 단독 자동완성 원본 주입, 실패해도 진행");
}
