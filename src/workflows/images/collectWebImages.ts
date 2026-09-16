// 원고의 `웹 검색` 이미지 자리를 Codex(`codex exec --search`)로 채운다.
//
// 배경(2026-09-16 사용자 결정): 이 자리를 AI로 생성해 봤더니 저품질이 너무 많았다. 실제 사진·
// 공식 자료 화면이 필요한 자리는 만드는 게 아니라 찾는 작업이고, 원고 1건에서 이 자리 비중이
// 예상보다 컸다(09-16 남양주 카페 원고는 5자리 중 3자리).
//
// 역할 분담:
//   Codex - 검색과 판단만 한다. "이 문단을 한 장으로 요약하는 이미지"를 찾아 URL과 출처를 돌려준다.
//   Node  - 내려받기·형식/해상도 검증·파일 배치·메타데이터 기록을 한다.
// 이렇게 가르면 Codex에 파일 쓰기 권한을 줄 필요가 없어(read-only 샌드박스) delegate-codex의
// "저장소 밖에 쓰지 않는다" 규칙을 손대지 않아도 되고, 결과를 코드로 검증할 수 있다.
//
// 판단 기준은 rules/output-format.md §8-1("바로 위 문단을 한 장으로 요약")을 그대로 쓴다 -
// 그래서 슬롯마다 바로 위 문단 원문을 함께 넘긴다.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { keywordSlug } from "../../config/pipelinePaths.js";
import { runHeadlessCodex } from "../../services/llm/runHeadlessCodex.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { WEB_IMAGES_FILE, readImageSize } from "../manuscripts/exportManuscript.js";
import type { WebImageRecord } from "../manuscripts/exportManuscript.js";

/** 구글 디스커버는 너비 1200px 이상을 큰 썸네일 조건으로 본다(docs/seo-guide.md). 그 아래는 경고만 한다. */
const PREFERRED_MIN_WIDTH = 1200;
/** 이보다 작으면 본문에 쓸 수 없는 크기로 보고 거부한다. */
const HARD_MIN_WIDTH = 600;

export type WebImageSlot = {
  index: number;
  description: string;
  /** writer가 남긴 한국어 검색어. */
  query: string | null;
  /** 바로 위 문단(또는 소제목+문단) 원문. 이 문단을 한 장으로 요약하는 것이 판단 기준이다. */
  context: string;
};

export type CollectWebImagesResult = {
  found: WebImageRecord[];
  failures: string[];
};

export type CollectWebImagesOptions = {
  /** 테스트 주입 지점. 기본은 실제 codex 실행. */
  runCodex?: typeof runHeadlessCodex;
  fetchImage?: (url: string) => Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }>;
  readSize?: (buffer: Buffer) => { width: number; height: number } | null;
};

/**
 * 본문에서 `웹 검색` 자리와 그 바로 위 문단을 뽑는다. index는 전체 이미지 마커 기준(1부터)이라
 * 내보내기 폴더의 파일 번호와 그대로 맞는다.
 */
export function buildWebImageSlots(body: string, imagePrompts: string[]): WebImageSlot[] {
  const blocks = parseManuscriptBlocks(body, imagePrompts);
  const slots: WebImageSlot[] = [];
  let imageIndex = 0;
  let lastText = "";

  for (const block of blocks) {
    if (block.type === "image") {
      imageIndex += 1;
      if (block.acquisition === "search") {
        slots.push({ index: imageIndex, description: block.description, query: block.prompt, context: lastText });
      }
      continue;
    }
    lastText = block.type === "heading" ? `${block.heading}\n${block.body}` : block.content;
  }

  return slots;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    slots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          imageUrl: { type: "string" },
          sourcePage: { type: "string" },
          alt: { type: "string" },
          caption: { type: "string" },
          license: { type: "string" },
          rationale: { type: "string" },
          skipped: { type: "boolean" },
          skipReason: { type: "string" },
        },
        required: ["index", "imageUrl", "sourcePage", "alt", "caption", "license", "rationale", "skipped", "skipReason"],
        additionalProperties: false,
      },
    },
  },
  required: ["slots"],
  additionalProperties: false,
} as const;

export function buildPrompt(keyword: string, slots: WebImageSlot[]): string {
  const lines = [
    "너는 한국어 블로그 원고에 넣을 **실제 이미지**를 웹에서 찾는다. 이미지를 만들지 않는다.",
    "web_search 도구로 찾고, 각 자리마다 바로 쓸 수 있는 이미지 파일 URL 하나를 고른다.",
    "",
    `## 원고 주제: ${keyword}`,
    "",
    "## 고르는 기준",
    "1. **바로 위 문단을 한 장으로 요약**하는 이미지여야 한다. 문단의 구체 요소(누가·무엇·몇 개·어떤 구조)가",
    "   보이지 않고 분위기만 맞는 사진은 고르지 않는다.",
    "2. **출처 페이지가 이 원고 주제와 실제로 관련이 있어야 한다.** 생김새만 비슷한 이미지를 무관한",
    "   페이지에서 가져오지 않는다 - 그건 스톡 사진을 붙인 것과 같고, 출처를 밝혀도 독자에게 거짓이 된다.",
    "   (실패 예: 한국 카페 사건 기사에 캐나다 공항 스타벅스 매장 소개 페이지의 사진을 고른 경우.)",
    "3. **한국 이야기면 한국에서 찍힌/만들어진 자료여야 한다.** 간판·차량·제복·화폐·문서 양식이 한국이어야",
    "   본문과 따로 놀지 않는다. 해외 자료로 대신하지 않는다.",
    "4. 저작권이 안전한 쪽을 우선한다: 공공저작물, 정부·공공기관 배포 이미지, 기업 공식 보도자료·공식",
    "   홈페이지, 공식 SNS. 연예인 프로필, 뉴스사 자체 촬영 사진, 드라마 스틸컷은 피한다.",
    "5. 너비 1200px 이상, 가로형(16:9 근처)을 우선한다. 600px 미만은 고르지 않는다.",
    "6. `imageUrl`은 반드시 이미지 파일 자체의 직접 URL이어야 한다(.jpg/.png/.webp 등). 검색 결과",
    "   페이지나 기사 본문 URL을 넣지 않는다. `sourcePage`에 그 이미지가 실린 페이지 URL을 따로 적는다.",
    "",
    "관공서 화면·법령 조문·통계 표처럼 **웹에 직접 이미지 파일로 올라와 있지 않은 자료**는 억지로 비슷한",
    "사진으로 대체하지 말고 그냥 건너뛴다(`skipped: true`). 그 자리는 사람이 직접 캡처하는 것이 맞다.",
    "",
    "## 자리별 지시",
  ];

  for (const slot of slots) {
    lines.push("");
    lines.push(`### 자리 ${slot.index}`);
    lines.push(`- 필요한 이미지: ${slot.description}`);
    if (slot.query) lines.push(`- 원고가 제안한 검색어: ${slot.query}`);
    lines.push("- 이 이미지가 요약해야 할 문단:");
    lines.push(`  """${slot.context.slice(0, 600)}"""`);
  }

  lines.push(
    "",
    "## 출력",
    "자리마다 항목 하나씩, 위 스키마대로 JSON만 답한다.",
    "- `license`: 왜 써도 되는지 한 마디(예: \"공공저작물\", \"기관 공식 홈페이지\", \"기업 보도자료\").",
    "- `rationale`: 이 이미지가 그 문단의 무엇을 보여주는지 한 문장.",
    "- 기준에 맞는 이미지를 못 찾았으면 `skipped: true`와 `skipReason`을 채우고 `imageUrl`은 빈 문자열로 둔다.",
    "  억지로 비슷한 것을 고르지 않는다 - 빈 자리가 잘못된 이미지보다 낫다.",
    "- 그 외 자리는 `skipped: false`, `skipReason`은 빈 문자열."
  );

  return lines.join("\n");
}

function extensionFor(contentType: string): string | null {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return null;
}

async function defaultFetchImage(
  url: string
): Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }> {
  try {
    const response = await fetch(url, {
      // 일부 사이트는 기본 UA를 막는다. 사람이 브라우저로 여는 것과 같은 자료를 받으려는 것뿐이다.
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return {
      ok: true,
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type CodexSlotResult = {
  index: number;
  imageUrl: string;
  sourcePage: string;
  alt: string;
  caption: string;
  license: string;
  rationale: string;
  skipped: boolean;
  skipReason: string;
};

function parseCodexSlots(data: unknown): CodexSlotResult[] {
  if (!data || typeof data !== "object") return [];
  const slots = (data as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return [];
  return slots.filter((slot): slot is CodexSlotResult => !!slot && typeof slot === "object" && "index" in slot);
}

/**
 * 웹 검색 자리를 Codex로 채워 `dir`에 파일과 사이드카(web-images.json)를 쓴다.
 * 이미지가 하나도 안 나와도 예외를 던지지 않는다 - 빈 자리로 남기고 사유를 돌려준다.
 */
export async function collectWebImages(
  input: { keyword: string; dir: string; slots: WebImageSlot[] },
  options: CollectWebImagesOptions = {}
): Promise<CollectWebImagesResult> {
  const runCodex = options.runCodex ?? runHeadlessCodex;
  const fetchImage = options.fetchImage ?? defaultFetchImage;
  const failures: string[] = [];

  if (input.slots.length === 0) return { found: [], failures };

  const run = await runCodex({
    prompt: buildPrompt(input.keyword, input.slots),
    outputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    search: true,
  });

  if (!run.ok) return { found: [], failures: [`Codex 실행 실패: ${run.error}`] };

  const results = parseCodexSlots(run.data);
  if (results.length === 0) return { found: [], failures: ["Codex가 자리 정보를 돌려주지 않았습니다."] };

  const found: WebImageRecord[] = [];

  for (const slot of input.slots) {
    const result = results.find((r) => r.index === slot.index);
    if (!result) {
      failures.push(`[자리 ${slot.index}] Codex 응답에 없습니다.`);
      continue;
    }
    if (result.skipped || !result.imageUrl) {
      failures.push(`[자리 ${slot.index}] 찾지 못함: ${result.skipReason || "사유 없음"}`);
      continue;
    }
    if (!/^https?:\/\//i.test(result.imageUrl) || !/^https?:\/\//i.test(result.sourcePage)) {
      failures.push(`[자리 ${slot.index}] URL 형식이 아닙니다(${result.imageUrl.slice(0, 60)}).`);
      continue;
    }

    const downloaded = await fetchImage(result.imageUrl);
    if (!downloaded.ok || !downloaded.buffer) {
      failures.push(`[자리 ${slot.index}] 내려받기 실패: ${downloaded.error ?? "알 수 없는 오류"}`);
      continue;
    }

    const extension = extensionFor(downloaded.contentType ?? "");
    if (!extension) {
      // 이미지가 아닌 것(검색 결과 페이지 HTML 등)을 집어온 경우다 - 파일로 남기면 안 된다.
      failures.push(`[자리 ${slot.index}] 이미지가 아닙니다(content-type: ${downloaded.contentType || "없음"}).`);
      continue;
    }

    const readSize = options.readSize ?? readImageSize;
    const size = readSize(downloaded.buffer);
    if (size && size.width < HARD_MIN_WIDTH) {
      failures.push(`[자리 ${slot.index}] 너무 작습니다(${size.width}×${size.height}, 최소 ${HARD_MIN_WIDTH}px).`);
      continue;
    }
    if (size && size.width < PREFERRED_MIN_WIDTH) {
      failures.push(`[자리 ${slot.index}] ⚠️ 너비 ${size.width}px - 디스커버 큰 썸네일 기준(${PREFERRED_MIN_WIDTH}px) 미달이지만 저장했습니다.`);
    }

    const stem = `${String(slot.index).padStart(2, "0")}-${keywordSlug(result.alt || slot.description).slice(0, 40).replace(/-+$/, "") || "image"}`;
    const fileName = `${stem}.${extension}`;
    await writeFile(resolve(input.dir, fileName), downloaded.buffer);

    found.push({
      index: slot.index,
      fileName,
      imageUrl: result.imageUrl,
      sourcePage: result.sourcePage,
      alt: result.alt || slot.description,
      caption: result.caption || slot.description,
      license: result.license || "출처 확인 필요",
    });
  }

  if (found.length > 0) {
    await writeFile(resolve(input.dir, WEB_IMAGES_FILE), `${JSON.stringify({ images: found }, null, 2)}\n`);
  }

  return { found, failures };
}
