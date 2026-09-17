// 원고 본문을 소제목/텍스트/이미지 블록으로 나눈다. 문단 경계는 빈 줄 1개 이상(writer.md §6·§7과
// 같은 관례 - convertArticleToHtml.ts/convertArticleToNaverHtml.ts와 동일한 블록 분할 기준을
// 써서, 이 페이지에서 보이는 블록과 채널별 HTML 변환 결과의 블록이 1:1로 대응하게 한다).
//
// writer.md §6(2026-09-06)부터 소제목은 "**볼드**" 한 줄이고, 바로 다음 줄에 빈 줄 없이 그 소제목의
// 첫 문단이 붙는다 - 그래서 소제목과 그 문단은 같은 블록(같은 `\n{2,}` 구간) 안에 있다.
//
// writer.md §8은 집필 단계 산출물(drafts/*.md)에 [IMAGE: 설명] 다음 줄에 [IMAGE PROMPT: ...]를
// 붙여 쓰라고 하지만, 그 파일이 DB(articles.content)로 들어갈 때 parseDraftFile.ts의
// extractImagePrompts()가 [IMAGE PROMPT:] 줄을 본문에서 빼내 job.metadata.imagePrompts 배열로
// 따로 저장한다(발행 본문에 안 넣으려는 의도적 설계, runArticleJob.ts 참고). 그래서 이 파이프라인이
// 다루는 본문 대부분은 [IMAGE: 설명] 단독 줄만 있고 프롬프트가 없다 - 프롬프트는 본문에 나오는
// 순서대로 imagePrompts[i]와 짝을 맞춰야 한다.
//
// 다만 일부 채널 원고(articles.content)는 [IMAGE: 설명] 바로 다음 줄에 [IMAGE PROMPT: ...]가
// 이미 붙은 채로 저장돼 있다(2026-09-15 발견 - 로컬 .md 파일 전용이어야 할 reinsertImagePrompts
// 결과가 그대로 DB에도 들어간 과거 이력). 이 형태를 텍스트 블록으로 오인하면 이미지 캡션 표·
// 이미지 프롬프트 팩 버튼이 통째로 안 뜬다 - 그래서 "[IMAGE:]" 한 줄+"[IMAGE PROMPT:]" 한 줄
// 조합도 이미지 블록으로 인식하고, 그 경우엔 인라인 프롬프트를 그대로 쓴다(같은 줄에 붙어 있어
// 배열 순서 정렬보다 더 확실하다).
//
// 순서가 어긋나면(배리에이션이 마커를 빠뜨리거나 추가하면) 엉뚱한 이미지에 엉뚱한 프롬프트를
// 붙이는 것보다는 프롬프트 없이 보여주는 편이 안전하다 - 그래서 마커 개수와 imagePrompts 길이가
// 다르면(그리고 인라인 프롬프트도 없으면) 그 문서 전체를 "프롬프트 미상"으로 처리한다.

import type { ManuscriptImage } from "./manuscriptManifest.js";

/**
 * 이미지 자리를 무엇으로 채우는가(output-format.md §8 "획득 방식"). 설명 끝의 `— AI 생성` /
 * `— 웹 검색`에서 읽는다.
 *
 * 왜 필요한가(2026-09-16 실측 사고): 이 구분이 없어서 generateManuscriptImages가 마커를 가리지 않고
 * 전부 생성했다. `웹 검색` 마커의 "프롬프트"는 한국어 검색어 한 줄인데(예: "2026 아시안게임 야구
 * 대진표 조 편성 공식"), 그게 그대로 gpt-image-2에 이미지 생성 프롬프트로 들어갔다 - output-format.md
 * §8이 AI 생성 프롬프트에 요구하는 영어·`no text, no letters`·3~6줄 규격이 하나도 안 실린 채로다.
 * 09-16 남양주 카페 원고는 마커 5개 중 3개가 웹 검색이었고 그 3장이 전부 이 경로로 나왔다.
 *
 * `unknown`은 획득 방식을 안 적은 옛 원고다. 기존 동작(생성)을 유지한다.
 */
export type ImageAcquisition = "ai" | "search" | "table" | "unknown";

export type ManuscriptBlock =
  | { type: "text"; content: string }
  | { type: "heading"; heading: string; body: string }
  | { type: "image"; description: string; prompt: string | null; acquisition: ImageAcquisition };

const IMAGE_LINE_RE = /^\[IMAGE:\s*([\s\S]*?)\]\s*$/;
const IMAGE_PROMPT_LINE_RE = /^\[IMAGE PROMPT:\s*([\s\S]*?)\]\s*$/;
const HEADING_LINE_RE = /^\*\*(.+)\*\*$/;

/**
 * 설명에서 획득 방식을 읽는다. 규격은 `설명 — 웹 검색`이지만 대시 종류(—/–/-)와 뒤에 붙는 단서
 * ("웹 검색, 출처 표기 필요")가 실제 원고마다 흔들려서, 구분자에 기대지 않고 표기 자체를 찾는다.
 * 둘 다 있으면 `search`가 이긴다 - 잘못 생성하는 쪽이 안 만드는 쪽보다 비싸다(유료 API + 저품질 이미지).
 */
export function parseImageAcquisition(description: string): ImageAcquisition {
  // `표 생성`이 가장 먼저다(2026-09-18): 일정표·순위표 같은 데이터 자리는 웹 검색으로도 못 찾고
  // (실측: 민생지원금·아시안게임 대진표 전패) 이미지 모델은 한글을 못 써서 AI로도 못 만든다.
  // 본문에 이미 있는 표·목록을 그대로 HTML로 렌더해 PNG로 만드는 경로다.
  if (/표\s*생성|인포그래픽\s*생성/.test(description)) return "table";
  if (/웹\s*검색/.test(description)) return "search";
  if (/AI\s*생성/i.test(description)) return "ai";
  return "unknown";
}

/**
 * raw 블록이 이미지 마커(단독, 또는 뒤에 IMAGE PROMPT가 붙은 형태)인지 판정한다.
 *
 * IMAGE PROMPT가 **여러 줄**일 수 있다(2026-09-17 실측 사고): rules/output-format.md §8은 AI 생성
 * 프롬프트를 "3~6줄로 쓴다"고 요구하는데, 예전 구현은 정확히 2줄짜리 블록만 이미지로 인정했다.
 * 그래서 규칙대로 쓴 원고일수록 마커가 이미지로 인식되지 않고 **본문 텍스트로 새어나갔다** -
 * 뷰어에 이미지 자리로 안 뜨고, 생성·수집 대상에서도 빠지고, 발행 본문에 `[IMAGE: ...]`가 글자
 * 그대로 남는다. 실측 당시 30건 중 5건에서 마커 10개가 이 상태였다.
 */
export function matchImageBlock(raw: string): { description: string; inlinePrompt: string | null } | null {
  const lines = raw.split("\n");
  const first = lines[0].match(IMAGE_LINE_RE);
  if (!first) return null;
  if (lines.length === 1) return { description: first[1].trim(), inlinePrompt: null };

  // 둘째 줄부터 끝까지를 한 덩어리로 보고 [IMAGE PROMPT: ...]인지 본다(줄 수 무관).
  const rest = lines.slice(1).join("\n").trim();
  const second = rest.match(IMAGE_PROMPT_LINE_RE);
  if (second) return { description: first[1].trim(), inlinePrompt: second[1].trim().replace(/\s*\n\s*/g, " ") };
  return null;
}

export function parseManuscriptBlocks(body: string, imagePrompts: string[] = []): ManuscriptBlock[] {
  const rawBlocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const markerCount = rawBlocks.filter((b) => matchImageBlock(b) !== null).length;
  const promptsAligned = markerCount > 0 && markerCount === imagePrompts.length;

  const blocks: ManuscriptBlock[] = [];
  let imageIndex = 0;

  for (const raw of rawBlocks) {
    const imageMatch = matchImageBlock(raw);
    if (imageMatch) {
      blocks.push({
        type: "image",
        description: imageMatch.description,
        prompt: imageMatch.inlinePrompt ?? (promptsAligned ? imagePrompts[imageIndex] : null),
        acquisition: parseImageAcquisition(imageMatch.description),
      });
      imageIndex += 1;
      continue;
    }

    const lines = raw.split("\n");
    const headingMatch = lines[0].match(HEADING_LINE_RE);
    if (headingMatch) {
      blocks.push({ type: "heading", heading: headingMatch[1].trim(), body: lines.slice(1).join("\n").trim() });
      continue;
    }

    blocks.push({ type: "text", content: raw });
  }

  return blocks;
}

/** 이미지 마커 줄(과 바로 붙은 IMAGE PROMPT 줄)을 뺀 본문. "복사" 버튼이 붙여넣을 때 마커
 *  텍스트가 섞이지 않게 한다. */
export function manuscriptBodyWithoutImages(body: string): string {
  // 줄 단위로 거르면 여러 줄짜리 [IMAGE PROMPT: ...]의 가운데·끝 줄이 남는다(matchImageBlock 주석의
  // 같은 사고) - 마커를 통째로 지운 뒤 빈 줄을 정리한다.
  return body
    .replace(/^[ \t]*\[IMAGE PROMPT:[\s\S]*?\][ \t]*$/gm, "")
    .replace(/^[ \t]*\[IMAGE:[^\]]*\][ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Blogspot 자동 발행(publishArticleToBlogspot.ts)이 HTML로 변환하기 직전에 쓴다. [IMAGE: 설명]
 * 마커를 그 위치(1부터 시작하는 등장 순서)에 해당하는 이미지가 **정확히 1장** 확정됐을 때만 실제
 * `![설명](url)` 마크다운으로 치환한다.
 *
 * A/B 비교 모드(IMAGE_AB_COMPARE=true)에서는 같은 위치에 provider가 다른 후보가 2장 들어오는데,
 * 어느 쪽을 쓸지는 사람이 원고 페이지에서 눈으로 보고 고르는 과정이라 manifest에 "선택됨" 표시가
 * 없다(2026-09-15 기준) - 그래서 후보가 2장 이상이거나(아직 사람이 안 고름) 전부 실패(url 없음)면
 * 마커를 그대로 둔다. convertArticleToHtml이 그 경우도 플레이스홀더 텍스트로 안전하게 렌더한다 -
 * 엉뚱한 이미지를 자동으로 골라 발행하는 것보다 낫다.
 */
export function substituteConfirmedImages(body: string, images: ManuscriptImage[]): string {
  const rawBlocks = body.split(/\n{2,}/);
  let markerIndex = 0;

  return rawBlocks
    .map((raw) => {
      const match = matchImageBlock(raw.trim());
      if (!match) return raw;
      markerIndex += 1;

      const confirmed = images.filter((image) => image.index === markerIndex && image.url);
      if (confirmed.length !== 1) return raw;

      return `![${match.description}](${confirmed[0].url})`;
    })
    .join("\n\n");
}
