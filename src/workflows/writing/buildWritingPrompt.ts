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
// - 소제목은 `## ` 마크다운으로 유지해야 한다 - Telegraph/네이버/HTML 변환기가 `##`를 쓴다.
// - 사실 출처는 research/[키워드].md 하나뿐 - 웹 검색 없음(감사기록 유지).

import type { ArticleJobRow } from "../../types/database.js";

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
};

export function buildWritingPrompt(input: BuildWritingPromptInput): string {
  const { job, researchFilePath, draftFilePath, isMedical, today } = input;
  const styleFile = pickStyleFile(job.category);

  return [
    "너는 네이버 블로그 원고를 쓰는 편집자다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격이나 자료조사 파일을 못 읽으면 draft 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/writing/writer.md   (문체·구조·사실 태도·규칙 충돌 해소·저장 전 체크리스트)",
    "- docs/seo-guide.md           (제목·본문·키워드·이미지·태그 규칙)",
    `- ${styleFile}   (이 카테고리의 실제 발행 최종본 기반 문체·구조 - 반드시 이 목소리로 쓴다)`,
    `- ${researchFilePath}   (이 원고의 사실 전부. 여기 없는 수치·날짜·기관명·인용은 쓰지 않는다)`,
    "",
    "이 job의 입력:",
    `- keyword: ${job.keyword}`,
    job.category ? `- category: ${job.category}` : null,
    job.headline && job.headline !== job.keyword ? `- 원문 제목: ${job.headline}` : null,
    `- 오늘 날짜: ${today}`,
    isMedical ? "- 이 주제는 의학 정보를 다룬다. writer.md의 의학 관련 규칙을 반드시 적용한다." : null,
    "",
    "파이프라인 오버라이드(위 문서와 충돌하면 이 지시가 우선):",
    `- 출력은 writer.md §9의 이름·경로 규칙을 무시하고 정확히 이 절대 경로에 Write한다: ${draftFilePath}`,
    "- writer.md §9 frontmatter(keyword·title·char_count·hashtags·verdict_from_research 등)를 그대로 채운다.",
    "- writer.md §2의 Skill 호출(/parenting-blog-writer 등) 대신 moai-marketer:content-blog 스킬로",
    `  초안을 쓰되, 문체·구조는 위에서 Read한 ${styleFile}를 그대로 따른다(§2의 문체 표보다 이 파일이`,
    "  우선 - 더 구체적이고 실제 발행본 기반이다). §10대로 moai-writer:korean-humanize로 마무리한다.",
    // 사건·사고는 문체 선택의 문제가 아니라 무죄추정·신원보호·자극적 묘사 금지 규칙이라,
    // "문체는 style 파일을 따른다"에 묻히면 안 된다. 구속력을 따로 못박는다.
    job.category === "incident"
      ? "- **예외: 이 job은 category=incident(사건·사고)다. writer.md §2-1과 위 문체 파일의 규칙은" +
        " '참고'가 아니라 반드시 지켜야 하며, §5 후킹 제목 기법과 충돌하면 §2-1이 이긴다.**"
      : null,
    "- 소제목은 `## ` 마크다운 헤더로 쓴다(writer.md의 '# 기호 금지'는 네이버 붙여넣기용이며,",
    "  이 파이프라인의 변환 단계가 처리한다). 본문 맨 위 제목은 `# ` 한 줄로 둔다.",
    "- 본문에 `[IMAGE: 설명]` 마커를 섹션 전환마다 최소 5개 넣는다(writer.md §8). 실제 이미지는",
    "  사람이 나중에 삽입하므로 마커만 정확히 남긴다.",
    "- 사실은 위 자료조사 파일에서만 가져온다. WebSearch를 쓰지 않는다.",
    "",
    `완료하면 파일을 저장한 뒤 마지막 줄에 \`SAVED: ${draftFilePath}\`만 답하라.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
