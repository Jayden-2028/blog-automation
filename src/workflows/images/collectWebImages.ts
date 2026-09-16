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

import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { keywordSlug } from "../../config/pipelinePaths.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson, runHeadlessCodex } from "../../services/llm/runHeadlessCodex.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { WEB_IMAGES_FILE, readImageSize, readWebImages } from "../manuscripts/exportManuscript.js";
import type { WebImageRecord } from "../manuscripts/exportManuscript.js";

/** 구글 디스커버는 너비 1200px 이상을 큰 썸네일 조건으로 본다(docs/seo-guide.md). 그 아래는 경고만 한다. */
const PREFERRED_MIN_WIDTH = 1200;
/** 이보다 작으면 본문에 쓸 수 없는 크기로 보고 거부한다. */
const HARD_MIN_WIDTH = 600;
/** 가로/세로가 이보다 작으면 정사각·세로다 - 디스커버 썸네일 후보에서 빠진다(output-format.md §8). */
const MIN_LANDSCAPE_RATIO = 1.3;
/** 첫 자리는 대표 이미지(디스커버·소셜 미리보기)라 16:9(1.78)에 가까워야 한다. 여유를 둬 1.5로 자른다. */
const FIRST_SLOT_MIN_RATIO = 1.5;

/**
 * 재사용 권한 분류. Codex가 자유 문장이 아니라 **이 값 중 하나를 고르게** 한다.
 *
 * 왜 자유 문자열이 아닌가(2026-09-17 실측): 처음엔 Codex가 쓴 `license` 문장을 정규식으로 걸렀는데,
 * 같은 "남의 저작물"을 "설계사 공식 프로젝트 페이지"라고 적어 놓으면 `포트폴리오` 패턴에 안 걸린다.
 * 표현은 무한하고 규정은 유한하니, 판단을 문장이 아니라 **분류**로 받는다. 자유 문장(`license`)은
 * 메타데이터 표기용으로 그대로 두고, 저장 여부는 이 분류로만 결정한다.
 *
 * 배경: 이 블로그는 광고가 붙는 상업적 이용이고 이미지를 크롭·리사이즈해서 쓴다. 첫 배치에서
 * 경찰서 청사 사진이 `CC BY-NC-ND`인 채로 저장됐는데 NC는 광고 블로그에서 위반이고 ND는 크롭조차
 * 막는다. 방송사 공식 포스터·스틸은 허용한다(사용자 결정, 2026-09-17 - 홍보 목적 배포물).
 */
const REUSE_PERMISSIONS = [
  "public_domain", // CC0·퍼블릭도메인
  "public_nuri", // 공공누리 1·2유형
  "cc_by", // CC BY (NC·ND 없음)
  "official_press_release", // 정부·공공기관 보도자료·배포 이미지
  "official_company", // 기업 공식 홈페이지·공식 SNS
  "broadcaster_promo", // 방송사·배급사 홍보용 공식 포스터·스틸
  "cc_nc_or_nd", // NC/ND 붙음 - 거부
  "third_party_photo", // 개인·회사 포트폴리오, 사진작가, 뉴스사 자체 촬영 - 거부
  "marketplace_repost", // 가격비교·쇼핑몰·오픈마켓 재배포본 - 거부
  "unclear", // 확인 불가 - 거부
] as const;

type ReusePermission = (typeof REUSE_PERMISSIONS)[number];

const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set<ReusePermission>([
  "public_domain",
  "public_nuri",
  "cc_by",
  "official_press_release",
  "official_company",
  "broadcaster_promo",
]);

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

export type VerifyImageInput = {
  /** 내려받아 저장한 파일의 절대 경로. 검증자가 직접 열어 본다. */
  filePath: string;
  /** Codex가 적은 설명(alt). 실제 이미지와 어긋나는지 보는 기준이다. */
  alt: string;
  /** 이 이미지가 요약해야 할 문단. */
  context: string;
  keyword: string;
};

export type VerifyImageResult = { ok: boolean; reason: string };

export type CollectWebImagesOptions = {
  /** 테스트 주입 지점. 기본은 실제 codex 실행. */
  runCodex?: typeof runHeadlessCodex;
  /** referer는 그 이미지가 실린 페이지다 - 핫링크 차단을 넘기려면 필요하다(실측: 403 3건). */
  fetchImage?: (input: {
    url: string;
    referer: string;
  }) => Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }>;
  readSize?: (buffer: Buffer) => { width: number; height: number } | null;
  /** 내려받은 이미지를 실제로 열어 보고 판정한다. 기본은 Claude(claude -p + Read). */
  verifyImage?: (input: VerifyImageInput) => Promise<VerifyImageResult>;
  /** false면 비전 검증을 건너뛴다(시간·호출을 아끼고 싶을 때). 기본 true. */
  verify?: boolean;
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
          reusePermission: { type: "string", enum: [...REUSE_PERMISSIONS] },
          rationale: { type: "string" },
          skipped: { type: "boolean" },
          skipReason: { type: "string" },
        },
        required: [
          "index",
          "imageUrl",
          "sourcePage",
          "alt",
          "caption",
          "license",
          "reusePermission",
          "rationale",
          "skipped",
          "skipReason",
        ],
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
    "4. **라이선스를 실제로 확인한다. 출처가 있다는 것과 써도 된다는 것은 다르다.**",
    "   이 블로그는 광고가 붙는 **상업적 이용**이고, 이미지를 크롭·리사이즈해서 쓴다.",
    "   `reusePermission`에 아래 분류 중 하나를 **정확히** 고른다(자유롭게 쓰지 말고 값 그대로):",
    "   - `public_domain` — CC0·퍼블릭도메인",
    "   - `public_nuri` — 공공누리 제1·2유형",
    "   - `cc_by` — CC BY (NC도 ND도 붙지 않은 것만)",
    "   - `official_press_release` — 정부·공공기관이 배포한 보도자료 사진",
    "   - `official_company` — 기업 공식 홈페이지·공식 SNS가 배포한 자료",
    "   - `broadcaster_promo` — 방송사·배급사가 홍보용으로 배포한 공식 포스터·스틸컷",
    "   여기까지가 쓸 수 있는 것이다. 아래에 해당하면 그 자리는 **건너뛴다**(`skipped: true`):",
    "   - `cc_nc_or_nd` — CC에 NC(비영리)나 ND(변경금지)가 붙음",
    "   - `third_party_photo` — 건축사무소·사진작가 등 개인·회사가 촬영한 사진, 뉴스사 자체 보도사진",
    "   - `marketplace_repost` — 가격비교·쇼핑몰·오픈마켓이 재배포한 상품 이미지",
    "   - `unclear` — 재사용 근거를 확인하지 못함",
    "   **애매하면 `unclear`를 고른다.** 쓸 수 있는 쪽으로 넘겨짚지 않는다.",
    "   `license`에는 사람이 읽을 근거를 한 줄로 적는다(예: \"공공누리 제1유형\", \"삼성전자 공식 홈페이지\").",
    "5. **가로 16:9에 가까운 것을 고른다.** 정사각(1:1)과 세로는 구글 디스커버 썸네일 후보에서 빠진다 -",
    "   특히 **자리 1은 대표 이미지**라 반드시 가로여야 한다. 너비는 1200px 이상, 600px 미만은 고르지 않는다.",
    "   글자가 화면 대부분을 덮는 홍보 배너보다 **실사 사진**을 우선한다.",
    "6. `imageUrl`은 반드시 이미지 파일 자체의 직접 URL이어야 한다(.jpg/.png/.webp 등). 검색 결과",
    "   페이지나 기사 본문 URL을 넣지 않는다. `sourcePage`에 그 이미지가 실린 페이지 URL을 따로 적는다.",
    "",
    "법령 조문·정부 포털·기관 홈페이지 **화면 캡처는 더 이상 쓰지 않는다**(2026-09-17 결정). 그런 자리를",
    "만나면 `skipped: true`로 두되, `skipReason`에 **대신 쓸 현장 실사 이미지를 한 줄로 제안**한다",
    "(예: \"조문 화면 대신 카페 카운터에서 응대하는 직원 사진을 권함\"). 화면을 찾아 넣으려 하지 않는다.",
    "",
    "**특정 날짜의 회의·발표·의회 현장**(예: \"9월 16일 국가정책조정회의\", \"OO시의회 조례안 부결\")도",
    "마찬가지로 건너뛴다 - 그런 사진은 거의 항상 언론사 저작물이다. `skipReason`에 \"그 제도가 적용되는",
    "일반적 현장을 AI 생성으로 만드는 편이 낫다\"고 적고 어떤 장면인지 한 줄로 제안한다.",
    "",
    "**한국 공공저작물을 먼저 뒤진다.** 정부·공공기관 자료는 아래에 공공누리로 풀려 있어 상업적 이용과",
    "변형이 허용된다 - 일반 웹 검색보다 여기를 먼저 본다:",
    "- 정책브리핑 korea.kr (부처 정책 사진·인포그래픽, 대부분 공공누리 제1유형)",
    "- 공공누리 포털 kogl.or.kr (기관 통합 검색)",
    "- 각 부처·지자체 보도자료에 첨부된 사진",
    "검색어에 `공공누리`, `보도자료`, `정책브리핑`을 붙여 보는 것이 효과적이다.",
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

/**
 * 브라우저가 페이지 안에서 이미지를 불러올 때 실제로 보내는 헤더들.
 *
 * 왜 이만큼 흉내 내는가(2026-09-17 실측): 경복궁 원고 3자리가 전부 HTTP 403으로 막혔다. 원인은
 * **핫링크 차단**이다 - 많은 사이트가 `Referer`가 자기 도메인이 아니면 이미지를 거부한다. UA만
 * 바꿔서는 안 뚫린다. 우리는 Codex가 그 페이지에서 찾은 이미지를 받는 것이므로, 그 페이지를
 * `Referer`로 보내는 것이 실제 상황과도 맞는다(위장이 아니라 출처 그대로다).
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "same-origin",
};

async function fetchOnce(
  url: string,
  referer: string | null
): Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }> {
  try {
    const headers = { ...BROWSER_HEADERS };
    if (referer) {
      headers.Referer = referer;
      // 같은 사이트에서 온 것처럼 보이게 한다 - 핫링크 차단은 대개 이 조합을 본다.
      try {
        headers.Origin = new URL(referer).origin;
      } catch {
        // referer가 URL로 안 파싱되면 Origin은 빼고 진행한다.
      }
    }
    const response = await fetch(url, { headers, redirect: "follow" });
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

async function defaultFetchImage(input: {
  url: string;
  referer: string;
}): Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }> {
  const withReferer = await fetchOnce(input.url, input.referer);
  if (withReferer.ok) return withReferer;

  // 반대 방향으로 막는 서버도 있다(크로스 오리진 Referer 자체를 거부). 한 번만 더 시도한다.
  const bare = await fetchOnce(input.url, null);
  if (bare.ok) return bare;

  return { ok: false, error: `${withReferer.error} (Referer 없이 재시도: ${bare.error})` };
}

/**
 * 내려받은 이미지를 **실제로 열어 보고** 그 자리에 맞는지 판정한다.
 *
 * 왜 필요한가(2026-09-17 실측): Codex는 URL과 페이지 맥락만 보고 고를 뿐 **이미지를 보지 않는다.**
 * 대만 OTT에서 가져온 파일은 `alt`에 "공식 포스터"라고 적혀 있었지만 실제 내용은 스틸컷이었다.
 * 설명과 실물이 어긋나면 캡션·ALT가 통째로 거짓말이 되므로 발행 전에 걸러야 한다.
 *
 * 왜 Codex가 아니라 Claude가 보는가: 고른 쪽이 자기 선택을 검수하면 같은 착각을 반복한다. 다른
 * 모델이 독립적으로 보는 편이 낫고, CLAUDE.md의 역할 분담(Claude가 최종 검증)과도 맞는다.
 */
async function defaultVerifyImage(input: VerifyImageInput): Promise<VerifyImageResult> {
  const prompt = [
    "아래 이미지 파일을 Read 도구로 열어 실제 내용을 보고, 블로그 원고의 그 자리에 쓸 수 있는지 판정한다.",
    "",
    `파일: ${input.filePath}`,
    `원고 주제: ${input.keyword}`,
    `이 자리에 들어가야 할 것(수집기가 적은 설명): ${input.alt}`,
    "이 이미지가 요약해야 할 문단:",
    `"""${input.context.slice(0, 600)}"""`,
    "",
    "하나라도 어긋나면 불합격이다:",
    "1. 이미지의 **실제 내용이 위 설명과 일치**하는가? (설명은 '포스터'인데 실제는 스틸컷이면 불합격)",
    "2. 그 문단이 말하는 것을 보여주는가? 분위기만 맞는 무관한 사진이면 불합격.",
    "3. 한국 이야기인데 외국 간판·차량·지폐 등 다른 나라 맥락이 드러나면 불합격.",
    "4. 워터마크, 다른 사이트 로고, 검색 결과 화면, 깨진 이미지, 광고가 섞였으면 불합격.",
    "",
    '마지막 줄에 JSON 한 줄만 답한다: {"ok": true, "reason": "한 문장"}',
  ].join("\n");

  const result = await runHeadlessClaude({
    prompt,
    allowedTools: ["Read"],
    permissionMode: "acceptEdits",
    timeoutMs: 120_000,
  });

  // 검증자가 못 돌면 이미지를 버리지 않는다 - 판정 불가와 불합격은 다르다. 사람이 보도록 남긴다.
  if (!result.ok) return { ok: true, reason: `검증 건너뜀(${result.error})` };

  const parsed = extractTrailingJson(result.output) as { ok?: unknown; reason?: unknown } | null;
  if (!parsed || typeof parsed.ok !== "boolean") {
    return { ok: true, reason: "검증 결과를 읽지 못해 그대로 둡니다" };
  }
  return { ok: parsed.ok, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

type CodexSlotResult = {
  index: number;
  imageUrl: string;
  sourcePage: string;
  alt: string;
  caption: string;
  license: string;
  reusePermission: string;
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
  const verifyImage = options.verifyImage ?? defaultVerifyImage;
  const verify = options.verify ?? true;
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

    // 라이선스는 내려받기 **전에** 본다 - 쓸 수 없는 이미지를 디스크에 남길 이유가 없다.
    if (!ALLOWED_PERMISSIONS.has(result.reusePermission)) {
      failures.push(
        `[자리 ${slot.index}] 재사용 권한이 없어 건너뜁니다(${result.reusePermission}: ${result.license}) - 광고가 붙는 블로그에서 쓸 수 없거나 근거가 확인되지 않은 자료입니다.`
      );
      continue;
    }

    const downloaded = await fetchImage({ url: result.imageUrl, referer: result.sourcePage });
    if (!downloaded.ok || !downloaded.buffer) {
      // URL을 같이 남긴다 - 자동으로 못 받은 이미지는 사람이 브라우저로 직접 저장할 수 있다.
      failures.push(
        `[자리 ${slot.index}] 내려받기 실패: ${downloaded.error ?? "알 수 없는 오류"}\n      이미지: ${result.imageUrl}\n      출처: ${result.sourcePage}`
      );
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

    const ratio = size ? size.width / size.height : null;
    // 자리 1은 디스커버·소셜 미리보기가 집어가는 대표 이미지다 - 세로·정사각이면 큰 썸네일을 못 받으므로
    // 저장하지 않고 다시 찾게 한다. 나머지 자리는 아쉬울 뿐이라 경고만 남기고 저장한다.
    if (ratio !== null && slot.index === 1 && ratio < FIRST_SLOT_MIN_RATIO) {
      failures.push(
        `[자리 1] 대표 이미지가 가로가 아닙니다(${size?.width}×${size?.height}) - 16:9 가로만 큰 썸네일을 받습니다.`
      );
      continue;
    }
    if (ratio !== null && ratio < MIN_LANDSCAPE_RATIO) {
      failures.push(`[자리 ${slot.index}] ⚠️ 정사각·세로입니다(${size?.width}×${size?.height}) - 디스커버 썸네일 후보에서 빠지지만 저장했습니다.`);
    }
    if (size && size.width < PREFERRED_MIN_WIDTH) {
      failures.push(`[자리 ${slot.index}] ⚠️ 너비 ${size.width}px - 디스커버 큰 썸네일 기준(${PREFERRED_MIN_WIDTH}px) 미달이지만 저장했습니다.`);
    }

    const stem = `${String(slot.index).padStart(2, "0")}-${keywordSlug(result.alt || slot.description).slice(0, 40).replace(/-+$/, "") || "image"}`;
    const fileName = `${stem}.${extension}`;
    const filePath = resolve(input.dir, fileName);
    await writeFile(filePath, downloaded.buffer);

    // 검증자가 파일을 열어 봐야 하므로 저장한 뒤에 본다. 불합격이면 지운다.
    if (verify) {
      const verdict = await verifyImage({
        filePath,
        alt: result.alt || slot.description,
        context: slot.context,
        keyword: input.keyword,
      });
      if (!verdict.ok) {
        await rm(filePath, { force: true });
        failures.push(`[자리 ${slot.index}] 이미지가 설명과 맞지 않아 버렸습니다: ${verdict.reason}`);
        continue;
      }
    }

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
    // 이번에 찾은 것만 쓰면 지난 실행에서 채운 자리가 사라진다 - 호출부가 빈 자리만 넘길 수 있으므로
    // 기존 사이드카와 index 기준으로 합친다(같은 자리는 이번 결과가 이긴다).
    const previous = await readWebImages(input.dir);
    const merged = [...previous.filter((p) => !found.some((f) => f.index === p.index)), ...found].sort(
      (a, b) => a.index - b.index
    );
    await writeFile(resolve(input.dir, WEB_IMAGES_FILE), `${JSON.stringify({ images: merged }, null, 2)}\n`);
  }

  return { found, failures };
}
