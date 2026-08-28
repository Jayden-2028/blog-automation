// job의 최신 원고에 확보한 이미지를 기록한다(SPRINT_3_DESIGN.md 13절 "한다" 항목).
//
// 이미지가 손에 들어오는 시점이 사람을 거치므로(브리프 -> ChatGPT -> 사용자가 확보), 이 함수는
// "사용자가 이미지 URL을 알려주면 기록한다"는 마지막 조각이다. 브리프만 만들고 끝나는 게 아니라
// 결과가 DB에 남아야 Sprint 4가 집어갈 수 있다.

import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { createImage } from "../../services/supabase/repositories/imageRepository.js";
import { parseImageCopyright } from "../../config/imageCopyrightRules.js";
import type { ImageRow } from "../../types/database.js";

export type RecordArticleImageInput = {
  jobId: string;
  imageUrl: string;
  copyrightStatus: string;
  altText?: string | null;
};

export type RecordArticleImageResult =
  | { status: "recorded"; image: ImageRow }
  | { status: "no_article"; reason: string }
  | { status: "invalid_copyright"; reason: string };

/**
 * copyright_status를 세 형식(ai-generated:/press-release:/stock:) 중 하나로 강제한다
 * (imageCopyrightRules.ts) - 형식이 안 맞으면 저장 자체를 거부한다. 자유 문자열이 섞이면
 * 나중에 어느 이미지가 실제로 안전한 근거를 가졌는지 가려낼 수 없기 때문이다(설계 11절).
 */
export async function recordArticleImage(input: RecordArticleImageInput): Promise<RecordArticleImageResult> {
  if (!parseImageCopyright(input.copyrightStatus)) {
    return {
      status: "invalid_copyright",
      reason:
        `copyright_status 형식이 올바르지 않습니다: "${input.copyrightStatus}". ` +
        `ai-generated:<도구> / press-release:<도메인> / stock:<서비스>:<라이선스> 중 하나여야 합니다.`,
    };
  }

  const articles = await listArticlesByJobId(input.jobId);
  const article = articles[articles.length - 1];
  if (!article) {
    return { status: "no_article", reason: `job에 연결된 원고가 없습니다: ${input.jobId}` };
  }

  const image = await createImage({
    article_id: article.id,
    image_url: input.imageUrl,
    source: "chatgpt", // 이번 스프린트는 조달 경로가 ChatGPT로 고정이다(설계 9절 결정).
    copyright_status: input.copyrightStatus,
    alt_text: input.altText ?? null,
  });

  return { status: "recorded", image };
}
