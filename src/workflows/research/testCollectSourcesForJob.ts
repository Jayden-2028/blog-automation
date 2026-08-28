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
