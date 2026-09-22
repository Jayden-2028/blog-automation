// 발행된 글 중 관련 있는 것을 골라 본문 끝에 내부 링크로 붙인다(2026-09-22).
//
// 왜 필요한가: 서치콘솔 URL 검사가 우리 글을 전부 "참조 페이지: 감지된 페이지 없음"으로 본다.
// 실측하니 발행된 26개 URL 중 19개가 홈에서도 본문에서도 링크되지 않은 고아 페이지였고, 본문
// 내부 링크는 **0개**였다(색인 0건 상태). 구글 공식 문서:
//
//   "구글이 매일 찾는 새 페이지의 압도적 다수는 링크를 통해서입니다."
//
// 링크가 없으면 발견 경로가 사이트맵 하나뿐이다. 그리고 방향이 중요하다 - **새 글이 옛 글을
// 가리켜야** 한다. 새 글은 홈 첫 화면에 있어 어차피 발견되지만, 홈에서 밀려난 옛 글은 링크가
// 없으면 고아가 된다. 새 글마다 옛 글 몇 개를 건지는 구조다.
//
// LLM에게 맡기지 않는다. writer는 다른 글의 주소를 모르고, 알려줘도 지어낼 위험이 있다.
// 발행 기록(publications)에서 실제 URL을 읽어 **결정론적으로** 삽입한다.

import { similarity } from "./alignImagePrompts.js";
import type { PublishedPost } from "../../services/supabase/repositories/publicationRepository.js";

/** 본문에 넣는 제목. 이 줄을 기준으로 멱등 처리한다(다시 돌려도 중복으로 쌓이지 않게). */
export const RELATED_HEADING = "**함께 보면 좋은 글**";

/** 이 점수 아래면 "관련 있다"고 보지 않는다. 억지로 붙이면 독자에게도 검색엔진에도 잡음이다. */
const MIN_SCORE = 0.08;
/** 한 글에 붙일 최대 개수. 너무 많으면 본문 끝이 링크 목록이 된다. */
const MAX_LINKS = 3;
/** 같은 카테고리면 점수를 올려준다. 주제가 이어지는 글끼리 묶이는 편이 독자에게 자연스럽다. */
const SAME_CATEGORY_BONUS = 0.05;

export type RelatedLink = { title: string; url: string };

/**
 * 관련 있는 발행글을 고른다. 자기 자신은 제외한다.
 *
 * 점수가 모자라도 **최소 1개는 남긴다** - 이 기능의 목적이 고아 페이지를 줄이는 것이라,
 * 주제가 좀 멀어도 링크 하나가 아예 없는 것보다 낫다. 대신 그 경우에도 가장 가까운 것을 고른다.
 */
export function pickRelatedPosts(
  input: { jobId: string; keyword: string; category: string | null },
  candidates: readonly PublishedPost[],
  limit = MAX_LINKS
): RelatedLink[] {
  const others = candidates.filter((post) => post.jobId !== input.jobId && post.url && post.title);
  if (others.length === 0) return [];

  const scored = others
    .map((post) => {
      const base = similarity(input.keyword, post.keyword);
      const bonus = input.category && post.category === input.category ? SAME_CATEGORY_BONUS : 0;
      return { post, score: base + bonus };
    })
    .sort((a, b) => b.score - a.score);

  const related = scored.filter((entry) => entry.score >= MIN_SCORE).slice(0, limit);
  // 전부 기준 미달이면 가장 가까운 것 하나만 - 링크가 0개가 되는 것은 피한다.
  const chosen = related.length > 0 ? related : scored.slice(0, 1);
  return chosen.map((entry) => ({ title: entry.post.title, url: entry.post.url }));
}

/** 이미 붙어 있는 "함께 보면 좋은 글" 블록을 통째로 들어낸다(멱등 처리용). */
function stripExisting(body: string): string {
  const start = body.indexOf(RELATED_HEADING);
  if (start < 0) return body;
  const rest = body.slice(start + RELATED_HEADING.length);
  // 다음 빈 줄 둘(= 다음 블록 시작)까지가 이 블록이다.
  const end = rest.indexOf("\n\n");
  const after = end < 0 ? "" : rest.slice(end + 2);
  return (body.slice(0, start) + after).replace(/\n{3,}/g, "\n\n");
}

/**
 * 본문에 내부 링크 블록을 끼워 넣는다. 자리는 `**참고 자료**`(바깥 출처) **앞**이다 -
 * 우리 글 링크가 남의 출처 뒤로 밀리면 독자가 못 본다.
 *
 * 링크가 없으면 본문을 그대로 돌려준다. 이미 블록이 있으면 새 것으로 갈아 끼운다.
 */
export function appendRelatedPosts(body: string, related: readonly RelatedLink[]): string {
  const cleaned = stripExisting(body);
  if (related.length === 0) return cleaned;

  const block = [
    RELATED_HEADING,
    ...related.map((link) => `- [${link.title}](${link.url})`),
  ].join("\n");

  const referenceIndex = cleaned.indexOf("**참고 자료**");
  if (referenceIndex >= 0) {
    const head = cleaned.slice(0, referenceIndex).replace(/\s+$/, "");
    const tail = cleaned.slice(referenceIndex);
    return `${head}\n\n${block}\n\n${tail}`;
  }

  // 참고 자료가 없으면 해시태그 줄 앞에. 그것도 없으면 맨 끝에 붙인다.
  const lines = cleaned.split("\n");
  const hashtagIndex = lines.findIndex((line) => line.trim().startsWith("#") && line.includes(" #"));
  if (hashtagIndex >= 0) {
    const head = lines.slice(0, hashtagIndex).join("\n").replace(/\s+$/, "");
    const tail = lines.slice(hashtagIndex).join("\n");
    return `${head}\n\n${block}\n\n${tail}`;
  }
  return `${cleaned.replace(/\s+$/, "")}\n\n${block}\n`;
}
