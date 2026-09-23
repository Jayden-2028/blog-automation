// 헤드리스 writer 에이전트에게 넘길 프롬프트.
//
// Node는 조율만 한다(CLAUDE.md 원고 파이프라인 운영 규칙): 규격은 prompts/writing/writer.md +
// docs/seo-guide.md. 이 함수는 "읽고 따르라"고 지시하고 job 컨텍스트 + 자료조사 파일 경로 +
// 정확한 출력 경로 + 파이프라인 오버라이드만 박아 넣는다.
//
// 파이프라인 오버라이드가 필요한 이유:
// - writer.md §2 스킬 라우팅(/parenting-blog-writer 등)은 anthropic-skills 네임스페이스라 헤드리스
//   `claude -p`에서 로드되지 않는다(실측) - moai-marketer:content-blog + moai-writer:korean-humanize로
//   대체한다(둘 다 헤드리스 가용). 문체는 대신 `prompts/writing/style/*.md`를 Read해서 따른다 -
//   이건 계정 레벨 Skill이 아니라 일반 파일이라 Read 도구로 항상 로드된다(2026-09-03, 원고 퀄리티
//   점검에서 발견: 기존에는 이 스텝이 아예 없어서 세 스킬이 갖고 있던 실제 발행본 기반 문체 디테일이
//   pickStyleRules의 2분류(PERSONAL/EDITORIAL) 요약본으로만 대체되고 있었다).
// - 소제목은 writer.md §6 규격(`**볼드**` 한 줄)을 그대로 따른다 - 2026-09-06부터 Telegraph/
//   네이버/HTML 변환기도 `##`가 아니라 이 볼드 규격을 기준으로 파싱한다. 예전엔 이 줄이 반대로
//   "`##`를 유지하라"고 오버라이드했는데, writer.md 쪽 규칙만 바뀌고 이 파일은 안 바뀌어서
//   실제 발행되는 네이버 기준 원고만 계속 `##`로 나오는 결함이 있었다(실측, 2026-09-06).
// - 사실 출처는 research/[키워드].md 하나뿐 - 웹 검색 없음(감사기록 유지).
//
// 2026-09-15: writer.md(654줄)를 구조 분리했다(원고 퀄리티 점검 - 사실 태도 규칙이 형식 규칙
// 사이에 묻혀 새 모양의 위반을 못 잡은 사례가 나왔다). §4는 rules/facts-and-hedging.md, §6~10은
// rules/output-format.md로 옮겼다. 이 프롬프트도 세 파일을 모두 Read하도록 갱신했다 - 하나라도
// 빠지면 사실 태도나 출력 형식 규칙이 조용히 누락된다.

import type { ArticleJobRow } from "../../types/database.js";
import { formatBriefForPrompt } from "../brief/buildKeywordBrief.js";
import type { KeywordBrief } from "../brief/buildKeywordBrief.js";
import { DEFAULT_WRITING_MODE } from "../../config/writingMode.js";
import type { WritingMode } from "../../config/writingMode.js";

/**
 * 카테고리 → 문체 참고 파일. writer.md §2 라우팅과 1:1 대응.
 * entertainment/ott는 같은 작품·연예 소식 톤을 쓰고, living/community/미분류는 특정 소재를
 * 전제하지 않는 가장 일반적인 개인 블로거 톤(trend)을 기본값으로 쓴다 - parenting은 지아·지우
 * 에피소드를, entertainment는 작품명 노출을 전제하므로 무관한 주제에 강제하면 오히려 어긋난다.
 */
function pickStyleFile(category: string | null): string {
  // incident(사건·사고)는 반드시 맨 앞이다. 다른 카테고리로 폴백되면 사망 사건 기사에
  // "저도 궁금해서 찾아봤어요" 같은 개인 블로거 톤이 적용된다(writer.md §2-1).
  if (category === "incident") return "prompts/writing/style/incident.md";
  if (category === "parenting") return "prompts/writing/style/parenting.md";
  if (category === "entertainment" || category === "ott") return "prompts/writing/style/entertainment.md";
  return "prompts/writing/style/trend.md";
}

export type BuildWritingPromptInput = {
  job: Pick<ArticleJobRow, "keyword" | "headline" | "category">;
  /** researcher가 만든 자료조사 파일(절대 경로). 원고의 모든 사실이 여기서만 나온다. */
  researchFilePath: string;
  /** writer가 정확히 여기에 Write해야 한다(절대 경로). */
  draftFilePath: string;
  isMedical: boolean;
  today: string;
  /**
   * 기획 브리프(2026-09-17). 있으면 소제목 뼈대가 리서치 목차가 아니라 브리프의 독자 질문이 된다
   * (writer.md §3-1). 없으면 예전처럼 쓴다.
   */
  brief?: KeywordBrief | null;
  /**
   * 규격 모드(2026-09-23 검증). `auto`면 writer.md·output-format.md·seo-guide 대신
   * writer-auto.md 하나만 읽히고, 브리프 뼈대·분량·이미지 개수 지시를 뺀다.
   */
  mode?: WritingMode;
};

/**
 * 자율 모드 프롬프트(2026-09-23 검증).
 *
 * spec 모드와 다른 점: 규격 문서 5개(2,549줄) 대신 writer-auto.md 하나만 읽는다. 브리프를
 * 넘기지 않고, 소제목 뼈대·분량·Q&A 개수·이미지 개수·획득 방식 판정 순서를 지시하지 않는다.
 * 남기는 것은 코드가 파싱하는 형식(볼드 소제목·이미지 마커 쌍·frontmatter)과 사실 규칙뿐이다.
 *
 * incident와 voice.md는 자율 대상이 아니다 - 전자는 잘못 쓰는 비용이 크고, 후자는 카테고리와
 * 무관하게 한 목소리를 내야 해서다.
 */
function buildAutoWritingPrompt(input: BuildWritingPromptInput): string {
  const { job, researchFilePath, draftFilePath, isMedical, today } = input;

  return [
    "너는 블로그 원고를 쓰는 편집자다. 아래를 Read로 읽고 그대로 따른다.",
    "규격이나 자료조사 파일을 못 읽으면 draft 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/writing/writer-auto.md   (자율 모드 규격 - 짧다. 전부 읽어라)",
    job.category === "incident"
      ? "- prompts/writing/style/incident.md   (이 job은 사건·사고다. 이 파일이 다른 모든 규칙을 이긴다)"
      : "- prompts/writing/style/voice.md   (공통 어투·어미·인칭. 목소리는 자율 대상이 아니다)",
    `- ${researchFilePath}   (이 원고의 사실 전부. 여기 없는 수치·날짜·기관명·인용은 쓰지 않는다)`,
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}`,
    job.category ? `- category: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- 원문 제목: ${job.headline}` : null,
    `- 오늘 날짜: ${today}`,
    isMedical ? "- 이 주제는 의학 정보를 다룬다. 확인된 출처 밖의 판단·권고를 쓰지 않는다." : null,
    "",
    "파이프라인이 정하는 것(규격과 충돌하면 이쪽이 우선):",
    `- 출력은 정확히 이 절대 경로에 Write한다: ${draftFilePath}`,
    "- 초안은 moai-marketer:content-blog 스킬로 쓰고, moai-writer:korean-humanize로 마무리한다.",
    "- 사실은 위 자료조사 파일에서만 가져온다. WebSearch를 쓰지 않는다.",
    "",
    "**소제목 개수·순서·구성, 분량, 이미지 개수는 지시하지 않는다. 네가 정한다.**",
    "규격 §1대로 자료조사 맨 위의 \"이 키워드를 검색한 사람은 ___을 알고 싶어 한다\"를 먼저 확인하고,",
    "그 한 문장에 원고의 60% 이상을 써라. 그 문장이 자료와 어긋나면 네가 고치고 frontmatter에 남긴다.",
    "",
    `완료하면 파일을 저장한 뒤 마지막 줄에 \`SAVED: ${draftFilePath}\`만 답하라.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildWritingPrompt(input: BuildWritingPromptInput): string {
  const { job, researchFilePath, draftFilePath, isMedical, today } = input;
  if ((input.mode ?? DEFAULT_WRITING_MODE) === "auto") return buildAutoWritingPrompt(input);
  const styleFile = pickStyleFile(job.category);

  return [
    "너는 네이버 블로그 원고를 쓰는 편집자다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격이나 자료조사 파일을 못 읽으면 draft 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/writing/writer.md                       (라우팅·입력 계약·제목·저장 전 체크리스트)",
    "- prompts/writing/rules/facts-and-hedging.md      (사실 태도·헤지 금지 - 항상 최우선, 구 §4)",
    "- prompts/writing/rules/output-format.md          (출력 형식 계약 - 구 §6~10, 코드와 직결)",
    "- docs/seo-guide.md                                (제목·본문·키워드·이미지·태그 규칙)",
    `- ${styleFile}   (이 카테고리의 실제 발행 최종본 기반 구조·흐름·제목 기법)`,
    // 2026-09-16: 어투·어미는 카테고리와 무관하게 voice.md 하나다(카테고리마다 어미 규칙이 달라
    // 원고마다 톤이 흔들리던 문제). incident만 제외 - incident.md의 습니다체·1인칭 금지가 그대로다.
    job.category === "incident"
      ? null
      : "- prompts/writing/style/voice.md                 (공통 어투·어미·인칭 - 카테고리 파일은 구조만, 목소리는 이 파일)",
    `- ${researchFilePath}   (이 원고의 사실 전부. 여기 없는 수치·날짜·기관명·인용은 쓰지 않는다)`,
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}`,
    job.category ? `- category: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- 원문 제목: ${job.headline}` : null,
    `- 오늘 날짜: ${today}`,
    isMedical ? "- 이 주제는 의학 정보를 다룬다. writer.md의 의학 관련 규칙을 반드시 적용한다." : null,
    "",
    ...(input.brief
      ? [
          "기획 브리프(이 키워드를 검색한 독자가 알고 싶은 것 - writer.md §3-1이 이걸 소비한다):",
          formatBriefForPrompt(input.brief),
          "",
        ]
      : []),
    "파이프라인 오버라이드(위 문서와 충돌하면 이 지시가 우선):",
    ...(input.brief
      ? [
          "- writer.md §3-1대로 소제목은 브리프의 Q1~Q5 순서를 뼈대로 잡는다. 리서치 파일의 섹션 순서를",
          "  따라 쓰지 않는다. 리서치에 답이 없는 질문은 억지로 채우지 말고 frontmatter `unanswered`에",
          "  \"Q{n}\"으로 적고, `brief_coverage`에 \"답한 개수/전체\"(예: 4/5)를 적는다.",
        ]
      : []),
    `- 출력은 writer.md §9의 이름·경로 규칙을 무시하고 정확히 이 절대 경로에 Write한다: ${draftFilePath}`,
    "- writer.md §9 frontmatter(keyword·title·char_count·hashtags·verdict_from_research 등)를 그대로 채운다.",
    "- writer.md §2의 Skill 호출(/parenting-blog-writer 등) 대신 moai-marketer:content-blog 스킬로",
    `  초안을 쓰되, 구조·흐름은 위에서 Read한 ${styleFile}를, 어투·어미는 style/voice.md를 그대로 따른다`,
    "  (§2의 문체 표보다 이 파일들이 우선 - 더 구체적이고 실제 발행본 기반이다). §10대로",
    "  moai-writer:korean-humanize로 마무리한다.",
    // 사건·사고는 문체 선택의 문제가 아니라 무죄추정·신원보호·자극적 묘사 금지 규칙이라,
    // "문체는 style 파일을 따른다"에 묻히면 안 된다. 구속력을 따로 못박는다.
    job.category === "incident"
      ? "- **예외: 이 job은 category=incident(사건·사고)다. writer.md §2-1과 위 문체 파일의 규칙은" +
        " '참고'가 아니라 반드시 지켜야 하며, §5 후킹 제목 기법과 충돌하면 §2-1이 이긴다.**"
      : null,
    "- 소제목은 writer.md §6 규격대로 `**소제목**` 볼드 한 줄로 쓴다(`##` 마크다운 헤더 금지 -",
    "  2026-09-06부터 이 파이프라인의 변환 단계가 `##`가 아니라 볼드를 기준으로 파싱한다).",
    "  소제목 앞에는 빈 줄 1개, 바로 다음 줄에는 빈 줄 없이 그 소제목의 문단이 붙는다.",
    "  본문 맨 위 제목은 이 규칙과 별개로 `# ` 한 줄로 둔다(frontmatter 없을 때 title 폴백용).",
    "- 본문에 `[IMAGE: 설명]` 마커를 섹션 전환마다 최소 5개 넣는다(writer.md §8). 실제 이미지는",
    "  사람이 나중에 삽입하므로 마커만 정확히 남긴다.",
    "- 각 마커의 프롬프트는 **바로 위 문단을 한 장으로 요약**한다(output-format.md §8-1) - 그 문단의",
    "  구체 요소(누가·무엇·몇 개·어떤 구조)를 2개 이상 담고, 문단과 무관한 분위기 컷을 만들지 않는다.",
    "  **단, `— 웹 검색` 자리 중 실존 인물·특정 방송·특정 경기처럼 대상이 정해진 자리는 예외다**",
    "  (output-format.md §8-1-1). 둘째 줄(IMAGE PROMPT)을 장면 요약이 아니라 **이름 2~4단어**로",
    "  쓴다 - \"김주하 얼굴형 이상형 발언 방송 캡처\"가 아니라 \"김주하 현봉식\"이다. 장면을 서술한",
    "  검색어는 그런 캡션이 달린 사진이 세상에 없어 후보가 0건으로 실패한다(실측 2026-09-21).",
    "  첫 줄 설명(캡션)에는 지금처럼 장면을 그대로 쓴다 - 바뀌는 건 둘째 줄뿐이다.",
    "- 획득 방식은 **웹 검색 → 페이지 캡처 → 표 생성 → AI 생성** 순서로 판정한다(output-format.md §8-4).",
    "  **AI 생성은 앞의 셋이 전부 불가능할 때만** 쓰는 폴백이다 - 1순위로 쓰지 않는다.",
    "- `— 페이지 캡처` 자리의 URL은 **자료조사 파일 `## 11. 캡처할 페이지`에 적힌 것만** 쓴다.",
    "  그 목록에 없는 주소를 지어내면 없는 페이지를 찍게 된다. 둘째 줄에는 URL만 넣는다.",
    "- 사실은 위 자료조사 파일에서만 가져온다. WebSearch를 쓰지 않는다.",
    "",
    `완료하면 파일을 저장한 뒤 마지막 줄에 \`SAVED: ${draftFilePath}\`만 답하라.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
