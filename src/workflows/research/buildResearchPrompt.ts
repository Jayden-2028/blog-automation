// 헤드리스 researcher 에이전트에게 넘길 프롬프트.
//
// Node는 조율만 한다(CLAUDE.md 원고 파이프라인 운영 규칙): 규격은 prompts/research/researcher.md,
// 이 함수는 그 규격을 "읽고 따르라"고 지시하고 job 컨텍스트 + baseline 자료 + 정확한 출력 경로만
// 박아 넣는다. 조사 방법·품질 기준·파일 템플릿은 전부 researcher.md에 있다.

import type { PersonSourcePack } from "./personSourcePack.js";
import type { ArticleJobRow, SourceInsert } from "../../types/database.js";
import { formatBriefForPrompt } from "../brief/buildKeywordBrief.js";
import type { KeywordBrief } from "../brief/buildKeywordBrief.js";

export type BuildResearchPromptInput = {
  job: Pick<ArticleJobRow, "keyword" | "headline" | "category">;
  /**
   * 기획 브리프(2026-09-17). 있으면 researcher는 여기 적힌 독자 질문에 답할 자료를 1순위로 찾고,
   * 키워드 유형에 맞는 소스 프로파일(researcher.md §4-1)을 쓴다. 브리프 생성이 실패하면 null이고
   * 그때는 예전처럼 researcher.md 기본 절차로 돈다 - 브리프가 원고 생성을 막지 않는다.
   */
  brief?: KeywordBrief | null;
  /** Node가 NAVER API로 먼저 모은 기준 자료. 에이전트는 이 위에 빈칸만 보강한다(하이브리드). */
  baselineSources: SourceInsert[];
  /** 에이전트가 정확히 여기에 Write해야 한다(절대 경로). */
  outputPath: string;
  today: string;
  /**
   * 인스타그램 수동 큐레이션 job의 원본 자료(2026-09-21). 캡션 + 이미지에 번인된 텍스트.
   * 있으면 이게 이 job의 1차 근거다 - researcher.md의 일반 절차보다 우선해서 이 내용의 사실관계를
   * 검증·보강하는 데 조사를 집중시킨다. keyword는 NAVER baseline 검색용 짧은 문자열일 뿐이라
   * 이 원문이 없으면 무엇을 다루는 글인지 절반만 아는 셈이다.
   */
  sourceContext?: string | null;
  /**
   * 종합 키워드 입력 툴(2026-10-19)에서 사용자가 직접 전달한 소스 텍스트(카페글 붙여넣기 · 블로그 본문 추출 · 유튜브 요점).
   * `job.metadata.sourceText`. 1차 근거이되 출처 불명이라 사실은 공식·뉴스 소스로 재확인한다. 없으면 null.
   */
  userSourceText?: string | null;
  /** 소스 텍스트의 출처 URL(링크 자동 추출 경로, B부). 라벨에 함께 적는다. 없으면 null. */
  userSourceUrl?: string | null;
  /**
   * 변환기(텔레그램 링크·주제·긴 글 입력) 출처 job인가(`metadata.source`가 instagram_manual/keyword_input - instagramTrack.ts
   * isConverterJobSource). 2026-10-29 🌏 국제 트랙: category=kscene인데 keyword·소스가 **한글**일 수 있어 kscene 분기의
   * "keyword는 영문 질의" 가정을 풀고, 사용자가 보낸 소재를 에버그린 제한 때문에 버리지 않게 한다. kscene이 아니면 무시한다.
   */
  converterSource?: boolean;
  /**
   * 재조사 안내(2026-10-02). 직전 조사가 자료 부족(verdict blocked)으로 글쓰기를 막았을 때, 사람이
   * [자료조사 다시 하기]를 눌러 다시 돌리는 경우다. 무엇이 모자랐는지 알려 줘야 같은 조사를 반복하지
   * 않는다. 없으면 일반 조사.
   */
  retryHint?: string | null;
  /**
   * 인물 백과 트랙(category=person): 핫스타 알림의 화제 배경 한 줄(`job.metadata.personBackground`).
   * person-researcher.md §6-0이 출력 §1(지금 화제인 이유)의 출발점으로 쓴다. person이 아니면 무시한다.
   */
  personBackground?: string | null;
  /**
   * 인물 백과: Node가 모은 인물명 단독 자동완성 원본(`collectSourcesForJob` person 모드). 에이전트가 §4-1 주제
   * 묶음·동명이인 가드의 재료로 쓴다. null이면 수집 안 됨(싣지 않는다).
   */
  personAutocomplete?: { query: string; suggestions: string[]; failed: boolean } | null;
  /**
   * 인물 백과: 맥이 수집한 네이버 인물DB·나무위키 원문(2026-10-15, B-1 - 클라우드 IP는 두 곳이 403이다).
   * null이면 수집 안 됨(맥 꺼짐·대기 만료)이라 싣지 않고 지금처럼 §2-1 직접 열람을 시도한다.
   */
  personSourcePack?: PersonSourcePack | null;
};

function formatBaseline(baselineSources: SourceInsert[]): string[] {
  if (baselineSources.length === 0) {
    return ["(없음 - NAVER 검색이 비었거나 실패했다. 전부 직접 조사해야 한다.)"];
  }
  return baselineSources.map((s, i) => {
    const auth = s.authority ?? "미분류";
    const url = s.url ?? "(URL 없음)";
    // 지식iN·카페·백과는 등급만으로는 구분이 안 된다(전부 community). 독자의 질문 원문이라 표시한다.
    const label =
      s.source_name === "naver_kin"
        ? " (지식iN 질문)"
        : s.source_name === "naver_cafe"
          ? " (카페 글)"
          : s.source_name === "naver_encyc"
            ? " (백과사전)"
            : "";
    return `${i + 1}. [${auth}]${label} ${s.title ?? "(제목 없음)"} — ${url}`;
  });
}

/** 사용자 제공 소스 텍스트 절(A-3). 인스타 `sourceContext`와 별개로 라벨을 붙여 싣는다. 없으면 빈 배열. */
export function buildUserSourceTextSection(text: string | null | undefined, url?: string | null): string[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  return [
    "## 사용자 제공 소스 텍스트 (1차 근거·출처 불명)",
    "사용자가 직접 전달한 글이다. 주제 파악과 조사 방향의 1차 근거로 쓰되, 사실은 공식·뉴스",
    "소스로 재확인한다. 문장·표현을 그대로 가져오지 않는다(표절·유사문서 리스크).",
    ...(url ? [`출처 URL: ${url}`] : []),
    "",
    body,
    "",
  ];
}

export function buildResearchPrompt(input: BuildResearchPromptInput): string {
  const { job, baselineSources, outputPath, today } = input;

  const baselineLines = formatBaseline(baselineSources);

  // 인물 백과(2026-10-13): 규격이 researcher.md를 **대체**한다(self-contained). brief.type(celebrity) 판정에
  // 맡기면 기존 프로파일이 골라지므로 kscene처럼 category로 분기한다. 브리프 §4-1 프로파일 오버라이드도 싣지 않는다.
  if (job.category === "person") return buildPersonResearchPrompt(input, baselineLines);

  return [
    "너는 블로그 원고용 자료조사 에이전트다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격을 못 읽으면 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/research/researcher.md  (자료조사 계약서 - 절대 규칙, 등급, 수집 절차, 검증, 출력 템플릿)",
    "- prompts/writing/rules/topic-allocation.md  (주제 배분 - 조사 분량도 이 비율을 따른다)",
    "- prompts/writing/rules/article-structure.md (카테고리별 문단 흐름 - 이 단계들을 채울 자료를 찾는다)",
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}   (이 문자열을 다듬거나 바꾸지 않는다)`,
    job.category ? `- topic: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- notes: 원문 제목 "${job.headline}" 맥락 참고` : null,
    `- 오늘 날짜: ${today}`,
    "",
    ...(input.sourceContext
      ? [
          "이 job의 원본 자료(사용자가 인스타그램에서 직접 골라 보낸 게시물 - 1차 근거, 조사로 걷어내지 않는다):",
          input.sourceContext,
          "",
          "위 원본 자료를 §2(확인된 사실)의 뼈대로 삼고, WebSearch/WebFetch는 이 내용의 사실관계 검증·",
          "배경 보강(왜 이 일이 생겼는지, 관련 인물·수치·이전 사례)에 집중한다. 원본에 없는 내용을",
          "지어내지 않는다 - 확인 안 되면 §7 확인 실패에 남긴다.",
          "",
        ]
      : []),
    ...buildUserSourceTextSection(input.userSourceText, input.userSourceUrl),
    ...(input.retryHint
      ? [
          "이번은 재조사다. 직전 조사가 자료 부족으로 글쓰기를 막았다:",
          `- ${input.retryHint}`,
          "같은 검색을 되풀이하지 말고 이 부족분을 먼저 채울 출처(공식 사이트·원문 문서·언론 기사)를 새로 찾는다.",
          "그래도 못 찾으면 억지로 채우지 말고 verdict를 사실대로 적는다.",
          "",
        ]
      : []),
    "이미 수집된 기준 자료(baseline - NAVER 뉴스/웹/블로그 검색 결과):",
    ...baselineLines,
    "",
    ...(input.brief
      ? [
          "기획 브리프(이 키워드를 검색한 독자가 알고 싶은 것 - researcher.md §4-1·§6-1이 이걸 소비한다):",
          formatBriefForPrompt(input.brief),
          "",
        ]
      : []),
    "파이프라인 오버라이드(researcher.md와 충돌하면 이 지시가 우선):",
    ...(input.brief
      ? [
          `- 수집 순서는 researcher.md §4 기본 표 대신 §4-1의 \`${input.brief.type}\` 프로파일을 따른다.`,
          "- §6-1대로 브리프의 질문 Q1~Q5 각각에 답할 자료를 먼저 찾고, 답을 못 찾은 질문은 §7 확인 실패에",
          "  \"Q{n} 미해결: <무엇을 찾아봤는지>\"로 남긴다. 질문을 건너뛰거나 다른 질문으로 바꾸지 않는다.",
        ]
      : []),
    // 사용설명서 트랙(개편3): keyword가 영문 검색 질의이고, 독자는 해외 방문자·거주자다. NAVER baseline은 한국어 질의가
    // 아니라 빈약할 수 있어 공식·1차 영문/한글 자료를 직접 찾도록 못박는다.
    job.category === "kscene"
      ? "- **이 job은 category=kscene(해외 독자용 한국 사용설명서)다.** keyword는 영문 검색 질의다 - 그 질의의 의도(해외" +
        " 방문자·거주자가 알고 싶은 것)에 답할 자료를 찾는다. 공식·1차 자료(한국관광공사 visitkorea.or.kr, 정부·지자체·" +
        "운영 기관 공식 사이트, 철도·지하철 공식 안내)를 우선하고 영문 페이지와 한글 페이지를 **둘 다** 본다. 요금·운영시간·" +
        "정책처럼 바뀌는 값은 출처의 **기준 시점**을 반드시 적는다. 조사 파일은 기존 규격대로 **한국어**로 쓴다." +
        " 시의성 기사(최근 사건·논란)는 근거로 쓰지 않는다 - 에버그린 안내만 다룬다. 단 운영 변경" +
        " 공지(요금 인상·휴무·코스 변경·운영 중단)는 예외다(researcher.md §4-2)."
      : null,
    // 현지 관행(2026-10-30 로컬 정체성 개정): 집필의 고정 레이어 3개(현지인은 이렇게 합니다 / 외국인이 자주 오해하는 점 /
    // 이 글자를 보게 됩니다)는 §12에 줄이 있을 때만 쓴다 - 조사가 §12를 안 채우면 그 레이어가 영구히 비어 있다.
    // 등급·수치 규칙은 그대로다: 커뮤니티 자료는 관행 서술 전용이고 요금·시간의 근거가 되지 못한다.
    job.category === "kscene"
      ? "- **현지 관행 조사(researcher.md §4-2 5·6번, §12)**: 공식 자료로 규정·요금·절차를 확정한 뒤, 별도로" +
        " **한국 사람들이 실제로 어떻게 하는지**를 한국어로 찾는다 - (d) 각도: 네이버 카페·커뮤니티(맘카페·입주민 카페·" +
        "직장인 커뮤니티)의 실제 글, 공식 기관의 한글 FAQ·민원 답변, 국내 뉴스의 제도 변경·관행 기사. **한글 질의로**" +
        " 검색한다(\"아파트 음식물 쓰레기 실제로\", \"식당 호출벨 없을 때\", \"주민센터 vs 구청 어디\")." +
        " (e) **영문 외국인 커뮤니티 1회** - 같은 주제의 레딧·외국인 커뮤니티 질문을 한 번 검색해 \"외국인이 무엇을" +
        " 헷갈려 하는지\"를 질문 원문 URL과 함께 적는다. 이 자료는 `community`/`news` 등급 그대로이며 **수치·요금·" +
        "시간의 근거로는 쓰지 않는다** - 관행 서술과 외국인 오해 전용이다. (d)·(e)를 더해 **검색 하한은 8회**이고" +
        " 공식 페이지 4건 하한은 그대로다." +
        " 결과는 **`## 12. 현지 관행 (Local practice)`** 절에 §12 표 형식(구분 관행/규정 vs 관행/오해/표기 · 내용 ·" +
        " 범위 · 근거 URL · 등급 · 확인일)으로 남기고, **§2(확인된 사실)·§6(수치·기준)에는 섞지 않는다**." +
        " 없으면 행 대신 `관행 미확보 - <무엇을 검색했나>`를 적는다. frontmatter에 `local_practice_rows: N`(§12 표의" +
        " 행 수, 미확보면 0)을 추가한다 - 0이어도 조사 실패가 아니고 verdict에 영향을 주지 않는다."
      : null,
    // 🌏 국제(변환기 → kscene, 2026-10-29): 사용자가 텔레그램으로 보낸 한글 주제·링크·긴 글이 keyword·소스다. 위 "영문 질의"
    // 가정과 에버그린 제한을 그대로 두면 한글 keyword로 영문 자료를 못 찾거나 사용자가 고른 소재를 버린다.
    job.category === "kscene" && input.converterSource
      ? "- **이 job은 변환기(텔레그램 입력) 출처다 - keyword·소스 텍스트가 한글일 수 있다.** 위 '영문 검색 질의' 가정은 이 job에" +
        " 맞지 않는다: keyword를 해외 독자(한국 방문자·거주자)가 알고 싶어 할 관점의 **영문 질의로도 바꿔** 검색하고(예: 한글 주제 →" +
        " \"how to … in korea\" 꼴), 한글 1차 자료와 영문 자료를 **둘 다** 본다. **사용자가 보낸 소재가 곧 주제다** - 시의성 소재여도" +
        " 에버그린 제한 때문에 소재를 버리거나 다른 주제로 바꾸지 않는다. 대신 그 소재를 해외 독자가 1년 뒤에도 쓸 수 있는 안내(배경·" +
        "방법·주의점)로 풀 자료를 찾고, 사실 확인은 규격대로 한다(위 사용자 제공 소스·원본 게시물은 출처 불명 1차 근거라 공식 자료로 재확인)."
      : null,
    `- 출력 파일은 researcher.md §7의 이름 규칙·충돌 규칙을 무시하고 정확히 이 절대 경로에 Write한다: ${outputPath}`,
    "- 위 baseline 자료는 이미 확보된 것이다. 그 URL들을 다시 열어 확인하되, 조사는 baseline이 못",
    "  채운 빈칸(정의·핵심 수치·시행 이력·예외·자주 묻는 질문·오해)을 WebSearch/WebFetch로 보강하는 데 집중한다.",
    "- researcher.md §4의 8개 카테고리(나무위키 포함)를 baseline 위에서 빠짐없이 시도한다. 각도를 바꿔 최소 3회 검색한다.",
    "- baseline의 **(지식iN 질문)·(카페 글)** 항목은 §5 '사람들이 실제로 묻는 질문'의 원문이다. 그 제목을",
    "  그대로 §5에 옮긴다(URL 포함) - 이 항목이 있는데 §5를 '찾지 못함'으로 두지 않는다.",
    "- **§11 캡처할 페이지**를 반드시 채운다(없으면 \"없음\"). 이벤트·프로모션 안내, 공식 신청 페이지,",
    "  작품·상품 공식 소개, 순위·차트처럼 **그 화면을 보여주는 것이 답인** 페이지의 URL이다.",
    "  파이프라인이 이 주소를 그대로 열어 찍으므로 **직접 열어본 것만** 적는다 - 로그인해야 보이거나",
    "  앱에서만 열리는 화면은 적지 않는다(찍으면 로그인 벽이 찍힌다).",
    "- frontmatter의 keyword는 위 입력 keyword와 한 글자도 다르지 않아야 한다.",
    "- §10 전체 출처 목록 표에는 baseline + 네가 새로 연 URL을 전부 등급과 함께 넣는다(감사기록).",
    "",
    "완료하면 파일을 저장한 뒤 마지막 줄에 `SAVED: <경로>`만 답하라. 다른 설명은 필요 없다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** 자동완성 원본은 걸러내지 않고 그대로 싣는다. 실패·빈 결과는 그 사실을 적어 에이전트가 스스로 보강하게 한다. */
function formatPersonAutocomplete(auto: { query: string; suggestions: string[]; failed: boolean } | null): string[] {
  if (!auto) return [];
  if (auto.failed) {
    return [
      `네이버 자동완성 원본(질의 "${auto.query}" - Node 수집): 자동완성 조회 실패(또는 결과 없음).`,
      "순위 측정 재료가 없다. §4-1 2단계는 직접 검색(자동완성 화면·연관 검색)으로 보강하되, 확인하지 못했으면",
      "§6 작품 외 활동에 \"자동완성 원본 확보 실패\"를 그대로 적는다.",
      "",
    ];
  }
  return [
    `네이버 자동완성 원본(질의 "${auto.query}" - Node 수집, 걸러내지 않은 원본 순서). §4-1 주제 묶음·§4-1-1 동명이인 가드의 재료다:`,
    ...auto.suggestions.map((s, i) => `${i + 1}. ${s}`),
    "",
  ];
}

/**
 * 맥이 수집한 인물DB·나무위키 원문 절(2026-10-15, B-1). 규격 파일은 건드리지 않고 파이프라인 오버라이드로 얹는다 -
 * 등급(인물DB official / 나무위키 community)·교차확인·인용 규칙은 person-researcher.md 그대로다.
 */
function formatPersonSourcePack(pack: PersonSourcePack | null): string[] {
  if (!pack) return [];
  const block = (label: string, text: string, failure: string | undefined): string[] =>
    text
      ? [`### ${label} 원문 (맥 수집, ${pack.fetchedAt})`, "```text", text, "```", ""]
      : [`### ${label}: 맥 수집 실패 - ${failure ?? "내용 없음"}. 이 출처는 §2-1대로 직접 열어 보고, 못 열면 대조 미완으로 기록한다.`, ""];
  const failureOf = (prefix: string) => pack.errors.find((e) => e.startsWith(prefix))?.slice(prefix.length).trim();
  return [
    "아래는 **맥이 수집한 네이버 인물DB 카드와 나무위키 원문**이다(클라우드에서는 두 사이트가 차단돼 열리지 않는다).",
    "person-researcher.md §2-1의 이 두 고정 출처 열람은 아래 원문으로 갈음할 수 있다 - 같은 곳을 다시 열려고 시도하지 않는다.",
    "등급·교차확인·인용 규칙은 규격과 동일하다(인물DB = official, 나무위키 = community, 인물DB와 충돌하면 인물DB가 이긴다).",
    "§6 출처 표(§10)에는 두 출처를 URL(`https://search.naver.com/search.naver?query=<이름>`, `https://namu.wiki/w/<이름>`)로 올린다.",
    "",
    ...block("네이버 인물DB", pack.personDb, failureOf("personDb:")),
    ...block("나무위키", pack.namuwiki, failureOf("namuwiki:")),
    ...formatAiAnswer("네이버 AI", pack.naverAiAnswer, pack.fetchedAt),
    ...formatAiAnswer("구글 AI", pack.googleAiAnswer, pack.fetchedAt),
    ...formatReferenceBlogPosts(pack.referenceBlogPosts),
  ];
}

/**
 * AI 답변 절(2026-10-17, PERSON-RESEARCH-SOURCES §A-2). 구조·커버리지 참고 전용이다 - 실측으로 사실 오류가 확인됐다
 * (데뷔를 1998년 '사랑과 성공'으로 답변 - 인물DB·나무위키는 1996년 '스타트'). 비어 있으면 절을 싣지 않는다.
 */
function formatAiAnswer(source: string, text: string | undefined, fetchedAt: string): string[] {
  if (!text) return [];
  return [
    `## ${source} 답변 (구조 참고 전용)`,
    `아래는 ${source === "네이버 AI" ? "네이버 검색 AI" : "구글 AI"}의 생성 답변이다. **어떤 축(드라마/영화/예능/광고)을 다루고 각 축의`,
    "대표를 무엇으로 뽑았는지 - 조사 커버리지 체크리스트로만 쓴다.** 개별 사실(연도·작품명·",
    "수상)은 오류가 실측된 바 있으므로 인용하지 않는다. 사실은 인물DB > 나무위키 > news",
    "우선순위로 별도 확인한 것만 쓴다. 위 출처와 충돌하면 이 답변을 버린다.",
    `(수집 ${fetchedAt})`,
    "```text",
    text,
    "```",
    "",
  ];
}

/** 테마 블로그 풀 글 절(§B-4). 구성·커버리지 참고 전용 - 사실 근거 금지, 문장·표현 차용 금지. */
function formatReferenceBlogPosts(posts: PersonSourcePack["referenceBlogPosts"]): string[] {
  if (!posts || posts.length === 0) return [];
  return [
    "## 레퍼런스 블로그 포스팅 (구성 참고 전용)",
    "같은 인물을 다룬 상위 테마 블로그 글이다. **어떤 꼭지를 다뤘는지(커버리지)와 문단 구성만",
    "참고한다.** 사실 근거로 쓰지 않는다(개인 블로그 - 검증 안 됨). 문장·표현을 가져오지",
    "않는다(표절·유사문서 판정 리스크). 이 글들이 다룬 꼭지 중 우리 조사에 없는 것이 있으면",
    "그 꼭지를 공식·뉴스 소스로 다시 조사한다.",
    "",
    ...posts.flatMap((post, i) => [
      `### 레퍼런스 ${i + 1}: ${post.title} (${post.blogId}${post.postedAt ? `, ${post.postedAt}` : ""})`,
      post.url,
      "```text",
      post.excerpt,
      "```",
      "",
    ]),
  ];
}

/** category=person 전용. 읽을 규격은 person-researcher.md 하나(+ 주제 배분·문단 흐름)다. */
function buildPersonResearchPrompt(input: BuildResearchPromptInput, baselineLines: string[]): string {
  const { job, outputPath, today } = input;
  return [
    "너는 블로그 원고용 자료조사 에이전트다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격을 못 읽으면 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/research/person-researcher.md  (인물 백과 자료조사 계약서 - self-contained. researcher.md는 읽지 않는다)",
    "- prompts/writing/rules/topic-allocation.md  (주제 배분 - 조사 분량도 이 비율을 따른다)",
    "- prompts/writing/rules/article-structure.md (카테고리별 문단 흐름 - 이 단계들을 채울 자료를 찾는다)",
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}   (인물명. 이 문자열을 다듬거나 바꾸지 않는다)`,
    "- topic: person",
    job.headline && job.headline !== job.keyword ? `- headline: ${job.headline}   (현재 화제작)` : null,
    input.personBackground ? `- background: ${input.personBackground}` : null,
    `- 오늘 날짜: ${today}`,
    "",
    ...(input.retryHint
      ? [
          "이번은 재조사다. 직전 조사가 자료 부족으로 글쓰기를 막았다:",
          `- ${input.retryHint}`,
          "같은 검색을 되풀이하지 말고 이 부족분을 먼저 채울 출처를 새로 찾는다.",
          "그래도 못 찾으면 억지로 채우지 말고 verdict를 사실대로 적는다.",
          "",
        ]
      : []),
    "이미 수집된 기준 자료(baseline - NAVER 뉴스/웹문서 검색 결과. 카페·지식iN은 수집하지 않았다):",
    ...baselineLines,
    "",
    ...formatPersonAutocomplete(input.personAutocomplete ?? null),
    ...formatPersonSourcePack(input.personSourcePack ?? null),
    // 종합 키워드 입력 툴(2026-10-19): 인물 트랙으로 링크·긴 글을 보낸 경우의 소스 본문. §1 사실 우선순위 밖 1차 근거.
    ...buildUserSourceTextSection(input.userSourceText, input.userSourceUrl),
    "파이프라인 오버라이드(person-researcher.md와 충돌하면 이 지시가 우선):",
    `- 출력 파일은 person-researcher.md §6의 이름 규칙을 무시하고 정확히 이 절대 경로에 Write한다: ${outputPath}`,
    "- 위 baseline 자료는 이미 확보된 것이다. 그 URL들을 다시 열어 확인하되, 조사는 baseline이 못 채운 빈칸을",
    "  person-researcher.md §2 절차(고정 출처 → 뉴스 → 웹검색 → LLM 보강)로 보강하는 데 집중한다.",
    "- frontmatter의 keyword는 위 입력 keyword와 한 글자도 다르지 않아야 한다.",
    "",
    "완료하면 파일을 저장한 뒤 마지막 줄에 `SAVED: <경로>`만 답하라. 다른 설명은 필요 없다.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
