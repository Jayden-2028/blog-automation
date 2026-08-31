// 헤드리스 writer 에이전트에게 넘길 프롬프트.
//
// Node는 조율만 한다(CLAUDE.md 원고 파이프라인 운영 규칙): 규격은 prompts/writing/writer.md +
// docs/seo-guide.md. 이 함수는 "읽고 따르라"고 지시하고 job 컨텍스트 + 자료조사 파일 경로 +
// 정확한 출력 경로 + 파이프라인 오버라이드만 박아 넣는다.
//
// 파이프라인 오버라이드가 필요한 이유:
// - writer.md §2 스킬 라우팅(/parenting-blog-writer 등)은 anthropic-skills 네임스페이스라 헤드리스
//   `claude -p`에서 로드되지 않는다(실측) - moai-marketer:content-blog + moai-writer:korean-humanize로
//   대체한다(둘 다 헤드리스 가용).
// - 소제목은 `## ` 마크다운으로 유지해야 한다 - Telegraph/네이버/HTML 변환기가 `##`를 쓴다.
// - 사실 출처는 research/[키워드].md 하나뿐 - 웹 검색 없음(감사기록 유지).

import { pickStyleRules } from "./buildArticlePrompt.js";
import type { ArticleJobRow } from "../../types/database.js";

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
  const styleRules = pickStyleRules(job.category);

  return [
    "너는 네이버 블로그 원고를 쓰는 편집자다. 아래 규격 문서를 Read로 읽고 그 계약을 그대로 따른다.",
    "규격이나 자료조사 파일을 못 읽으면 draft 파일을 만들지 말고 그 사실만 한 줄로 답하라.",
    "",
    "- prompts/writing/writer.md   (문체·구조·사실 태도·규칙 충돌 해소·저장 전 체크리스트)",
    "- docs/seo-guide.md           (제목·본문·키워드·이미지·태그 규칙)",
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
    "- writer.md §2 스킬 라우팅 대신 moai-marketer:content-blog 스킬로 초안을 쓰고, §10대로",
    "  moai-writer:korean-humanize로 마무리한다. §2의 문체 표는 참고만 한다.",
    "- 소제목은 `## ` 마크다운 헤더로 쓴다(writer.md의 '# 기호 금지'는 네이버 붙여넣기용이며,",
    "  이 파이프라인의 변환 단계가 처리한다). 본문 맨 위 제목은 `# ` 한 줄로 둔다.",
    "- 본문에 `[IMAGE: 설명]` 마커를 섹션 전환마다 최소 5개 넣는다(writer.md §8). 실제 이미지는",
    "  사람이 나중에 삽입하므로 마커만 정확히 남긴다.",
    "- 사실은 위 자료조사 파일에서만 가져온다. WebSearch를 쓰지 않는다.",
    "",
    "카테고리 톤(writer.md §2 보강 - 실제 네이버 블로그 샘플 관찰):",
    ...styleRules.map((r) => `- ${r}`),
    "",
    `완료하면 파일을 저장한 뒤 마지막 줄에 \`SAVED: ${draftFilePath}\`만 답하라.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
