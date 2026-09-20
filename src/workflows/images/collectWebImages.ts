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
import { mapWithConcurrency } from "../../services/mapWithConcurrency.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { runClaudeWebSearch } from "../../services/llm/runClaudeWebSearch.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";
import type { WebSearchAgent } from "../../services/llm/runHeadlessCodex.js";
import { parseManuscriptBlocks } from "../manuscripts/parseManuscriptBlocks.js";
import { WEB_IMAGES_FILE, readImageSize, readWebImages } from "../manuscripts/exportManuscript.js";
import type { WebImageRecord } from "../manuscripts/exportManuscript.js";
import { searchNaverImages } from "./searchNaverImages.js";
import { CROP_TRIGGER_RATIO, cropTallImageWithFocus } from "./cropTallImage.js";
import type { ImageCandidate, SearchImages } from "./searchNaverImages.js";

/** 구글 디스커버는 너비 1200px 이상을 큰 썸네일 조건으로 본다(docs/seo-guide.md). 그 아래는 경고만 한다. */
const PREFERRED_MIN_WIDTH = 1200;
/** 한 자리에 내려받아 비교할 후보 수 상한(2026-09-18 B안). 프롬프트가 길어지고 내려받기도 늘어난다. */
const MAX_CANDIDATES = 4;
/** 동시에 처리할 자리 수(2026-09-21). 판정·내려받기가 전부 외부 호출이라 상한을 둔다. */
const SLOT_CONCURRENCY = 3;
/** 긴 변이 이보다 작으면 본문에 쓸 수 없는 크기로 보고 거부한다(2026-09-17 저녁: 너비→긴 변). */
const HARD_MIN_WIDTH = 600;
/** 가로/세로가 이보다 작으면 정사각·세로다 - 디스커버 썸네일 후보에서 빠진다(output-format.md §8). */
const MIN_LANDSCAPE_RATIO = 1.3;

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
  "public_nuri", // 공공누리
  "cc_by", // CC BY
  "official_press_release", // 정부·공공기관 보도자료·배포 이미지
  "official_company", // 기업·소속사 공식 홈페이지·공식 SNS(프로필 등)
  "official_site_screenshot", // 기업·기관 공식 홈페이지를 찍은 화면
  "broadcaster_promo", // 방송사·배급사 홍보용 공식 포스터·스틸
  "broadcast_capture", // 방송 장면 캡처
  "news_photo", // 언론사 보도사진 - C안에서 허용, 캡션 출처 필수
  "personal_sns", // 개인 SNS 게시물 - C안에서 허용, 캡션 출처 필수
  "cc_nc", // CC NC(비영리) - 허용(C안). 캡션 출처 필수
  "unclear", // 확인 불가 - 허용(C안). 캡션 출처 필수
  "cc_nd", // 변경금지 - 거부(크롭·리사이즈를 하므로)
  "paid_stock", // 게티·연합·셔터스톡 등 유료 스톡, 워터마크 - 거부
] as const;

type ReusePermission = (typeof REUSE_PERMISSIONS)[number];

/**
 * 2026-09-17 저녁 사용자 결정(C안): **유료 스톡과 변경금지(ND)만 거부한다.** 나머지는 전부 쓰되
 * 캡션에 출처를 반드시 표기한다. 그 전까지는 공공누리·CC BY·공식 배포물만 허용했는데, 그 기준으로
 * 실측 9자리 중 8자리를 "찾았는데 버렸다" - 소속사 프로필·영화 스틸·보도사진이 전부 탈락했고 그게
 * 정확히 사용자가 원하는 이미지였다. 리스크(언론사 사진의 이론상 청구 가능성)는 사용자가 인지하고
 * 결정했다. 분류 자체는 계속 받는다 - 메타데이터·캡션 출처 표기에 쓴다.
 */
const REJECTED_PERMISSIONS: ReadonlySet<string> = new Set<ReusePermission>(["cc_nd", "paid_stock"]);

export type WebImageSlot = {
  index: number;
  description: string;
  /** writer가 남긴 한국어 검색어. */
  query: string | null;
  /** 바로 위 문단(또는 소제목+문단) 원문. 이 문단을 한 장으로 요약하는 것이 판단 기준이다. */
  context: string;
};

/**
 * 끝내 못 채운 자리 하나. 사람이 읽는 `failures` 문장과 달리 **기계가 쓰는 구조체**다 -
 * 이걸로 AI 생성 폴백을 돌린다(2026-09-17).
 *
 * 왜 필요한가(실측): 수집기는 못 찾았을 때 `skipReason`에 "안동 지역 전통 탈춤단이 야외 무대에서
 * 공연하는 일반적 장면을 AI로 만드는 편이 낫다"처럼 **대안까지 적어 준다**. 그런데 지금까지는 그
 * 문장을 로그에 찍고 버렸고, 그 자리는 빈 채로 발행 대기에 올라갔다. 빈 자리보다 AI 이미지가
 * 낫다는 것이 이미 정해진 방침이므로(output-format.md §8-4) 그 제안을 받아서 쓴다.
 */
export type UnfilledSlot = {
  index: number;
  /** 마커 설명(획득 방식 접미사 제거 전 원문). */
  description: string;
  /** 이 이미지가 요약해야 할 문단. AI 프롬프트를 지을 때 근거가 된다. */
  context: string;
  /** 수집기가 적은 대안 제안 또는 실패 사유. 비어 있을 수 있다. */
  suggestion: string;
};

export type CollectWebImagesResult = {
  found: WebImageRecord[];
  failures: string[];
  /** 웹에서 못 채운 자리. 호출부가 AI 생성으로 넘긴다. */
  unfilled: UnfilledSlot[];
};

/** 검색을 시작조차 못 했을 때(실행 실패·응답 없음) 전 자리를 미충족으로 돌린다. */
function allUnfilled(slots: WebImageSlot[]): UnfilledSlot[] {
  return slots.map((slot) => ({
    index: slot.index,
    description: slot.description,
    context: slot.context,
    suggestion: "",
  }));
}

export type VerifyImageInput = {
  /** 내려받아 저장한 파일의 절대 경로. 검증자가 직접 열어 본다. */
  filePath: string;
  /**
   * **판정 기준**: 원고 마커가 요구한 것(`[IMAGE: 설명]`). 2026-09-18 이전에는 아래 `alt`로
   * 판정했는데, alt는 수집기가 URL만 보고 쓴 **추측**이라 틀리면 멀쩡한 사진이 탈락했다.
   * 실측: 이청아 자리 1은 실제 이청아 사진을 찾아 놓고 "설명은 선글라스 쓰고 거리인데 실제는
   * 실내 셀카"라는 이유로 버렸다 - 마커는 "최근 공식 프로필 사진"만 요구했는데도.
   */
  markerDescription: string;
  /** 수집기가 적은 설명(alt). **추측이라 틀릴 수 있어** 참고로만 쓴다. */
  alt: string;
  /** 이 이미지가 요약해야 할 문단. */
  context: string;
  keyword: string;
};

export type VerifyImageResult = { ok: boolean; reason: string };

/** 비전 판정에 넘기는 후보 하나. `number`로 답을 받는다. */
export type ImageChoiceCandidate = {
  number: number;
  filePath: string;
  /** 수집기가 URL만 보고 쓴 추측. 참고용이고 판정 기준이 아니다. */
  alt: string;
  sourcePage: string;
};

export type ChooseImageInput = {
  candidates: ImageChoiceCandidate[];
  /** 판정 기준: 원고 마커가 요구한 것. */
  markerDescription: string;
  context: string;
  keyword: string;
};

/** `picked`가 null이면 "쓸 만한 것이 없다"는 뜻이다. */
export type ChooseImageResult = { picked: number | null; reason: string };

export type CollectWebImagesOptions = {
  /** 테스트 주입 지점. 기본은 실제 codex 실행. */
  /**
   * 웹 검색 실행기. 기본은 Claude(`claude -p` + WebSearch) - 파이프라인에서도 도는 유일한 경로다.
   * 맥에서 Codex로 돌리고 싶으면 `runHeadlessCodex`를 넣는다(runClaudeWebSearch.ts 주석 참고).
   */
  runCodex?: WebSearchAgent;
  /**
   * 자리별 후보 이미지 검색(2026-09-17 저녁). 기본은 네이버 이미지 검색 API. 후보가 있으면 에이전트는
   * "검색창에 친 결과 중 고르기"를 하고, 없으면 예전처럼 web_search로 직접 찾는다. false면 생략.
   */
  searchImages?: false | SearchImages;
  /**
   * 1:2보다 긴 세로 이미지를 주요 부분만 잘라낸다(2026-09-18). 기본은 Chromium canvas + Claude 초점 판단.
   * false면 자르지 않는다(테스트 - 브라우저를 띄우면 안 된다).
   */
  cropTall?: false | typeof cropTallImageWithFocus;
  /** referer는 그 이미지가 실린 페이지다 - 핫링크 차단을 넘기려면 필요하다(실측: 403 3건). */
  fetchImage?: (input: {
    url: string;
    referer: string;
  }) => Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }>;
  readSize?: (buffer: Buffer) => { width: number; height: number } | null;
  /**
   * 내려받은 후보들을 **한 번에 열어 보고 하나를 고른다**(2026-09-18 B안). 기본은 Claude.
   *
   * 왜 한 번에 고르는가: 전에는 후보를 하나만 내려받아 합·불만 판정했고, 떨어지면 그 자리는 끝이었다.
   * 후보를 순차로 여러 번 검증하면 호출이 자리당 최대 4회가 되지만, 한 호출에 같이 열어 고르면
   * **호출은 1회 그대로**이고 비교 판단이라 정확도도 오른다(사용자 결정).
   */
  chooseImage?: (input: ChooseImageInput) => Promise<ChooseImageResult>;
  /** false면 비전 검증을 건너뛴다(시간·호출을 아끼고 싶을 때). 기본 true. */
  verify?: boolean;
  /**
   * 주면 검증을 통과한 이미지를 여기에 넘겨 영구 저장한다(파이프라인은 Supabase Storage).
   * 주지 않으면 `dir`의 파일이 결과물이다(맥 보관함).
   */
  upload?: (input: {
    index: number;
    fileName: string;
    buffer: Buffer;
    mimeType: string;
  }) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
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
          alternates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                imageUrl: { type: "string" },
                sourcePage: { type: "string" },
                license: { type: "string" },
              },
              required: ["imageUrl", "sourcePage", "license"],
              additionalProperties: false,
            },
          },
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
          "alternates",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["slots"],
  additionalProperties: false,
} as const;

export function buildPrompt(
  keyword: string,
  slots: WebImageSlot[],
  candidates: Map<number, ImageCandidate[]> = new Map()
): string {
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
    "4. **출처를 분류한다.** `reusePermission`에 아래 분류 중 하나를 **정확히** 고른다(자유롭게 쓰지 말고 값 그대로):",
    "   - `public_domain` / `public_nuri` / `cc_by` / `cc_nc` — 공개 라이선스",
    "   - `official_press_release` — 정부·공공기관 보도자료 사진",
    "   - `official_company` — 기업·소속사 공식 홈페이지·공식 SNS(**연예인 프로필은 대개 여기**)",
    "   - `official_site_screenshot` — 기업·기관 공식 홈페이지를 찍은 화면",
    "   - `broadcaster_promo` — 방송사·배급사·OTT가 배포한 공식 포스터·스틸컷(**영화·드라마 자리는 대개 여기**)",
    "   - `broadcast_capture` — 방송 장면 캡처",
    "   - `news_photo` — 언론사 보도사진",
    "   - `personal_sns` — 개인 SNS 게시물",
    "   - `unclear` — 어디서 온 건지 확인 못 함",
    "   **위 분류는 전부 쓸 수 있다**(2026-09-17 사용자 결정). 캡션에 출처가 붙으므로 `license`에",
    "   \"사진=SM C&C\", \"출처: 뉴시스\", \"@instagram_id\"처럼 **캡션에 그대로 쓸 출처 표기**를 적는다.",
    "   아래 둘만 **건너뛴다**(`skipped: true`):",
    "   - `paid_stock` — 게티이미지·연합뉴스·셔터스톡 등 유료 스톡, 워터마크가 찍힌 이미지",
    "   - `cc_nd` — 변경금지(ND)가 명시된 것(크롭·리사이즈를 하므로)",
    "   라이선스가 불확실하다는 이유로 건너뛰지 않는다. 불확실하면 `unclear`로 두고 **쓴다**.",
    "5. **크기는 긴 변 600px 이상이면 된다.** 가로 16:9가 있으면 좋지만 **세로 포스터·인물 프로필을",
    "   세로라는 이유로 버리지 않는다** - 내용이 맞는 세로 사진이 조건 맞는 빈 자리보다 낫다.",
    "   자리 1(대표 이미지)만 가능하면 가로를 고른다.",
    "6. `imageUrl`은 반드시 이미지 파일 자체의 직접 URL이어야 한다(.jpg/.png/.webp 등). 검색 결과",
    "   페이지나 기사 본문 URL을 넣지 않는다. `sourcePage`에 그 이미지가 실린 페이지 URL을 따로 적는다.",
    "",
    "법령 조문·정부 포털·지원금 신청 같은 **행정 절차 화면 캡처는 쓰지 않는다**(2026-09-17 결정).",
    "(기업·기관 **공식 홈페이지 화면**은 예외로 쓸 수 있다 - `official_site_screenshot`.) 그런 자리를",
    "만나면 `skipped: true`로 두되, `skipReason`에 **대신 쓸 현장 실사 이미지를 한 줄로 제안**한다",
    "(예: \"조문 화면 대신 카페 카운터에서 응대하는 직원 사진을 권함\"). 화면을 찾아 넣으려 하지 않는다.",
    "",
    "**아직 열리지 않은 행사·공연**(예: 이틀 뒤 결선 오프닝)은 그 장면 사진이 존재하지 않는다. 그때는 문자",
    "그대로 찾지 말고 **같은 주체의 다른 공연·행사 사진**(예: 안동탈놀이단의 지난 공연)으로 대체한다 -",
    "실측에서 '결선 오프닝'을 문자 그대로 찾다 빈 자리로 끝났다.",
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
    const found = candidates.get(slot.index) ?? [];
    if (found.length > 0) {
      lines.push("- 네이버 이미지 검색 후보(**먼저 여기서 고른다**. 제목으로 출처를 짐작하고, 맞는 게 없을 때만 web_search):");
      found.forEach((c, i) => {
        const size = c.width && c.height ? `${c.width}×${c.height}` : "크기 미상";
        lines.push(`  ${i + 1}. [${size}] ${c.title.slice(0, 60)} — ${c.link}`);
      });
      lines.push("  후보를 고르면 `imageUrl`에 그 URL을 그대로 넣고, `sourcePage`는 알면 적고 모르면 빈 문자열로 둔다.");
    }
  }

  lines.push(
    "",
    "## 출력",
    "자리마다 항목 하나씩, 위 스키마대로 JSON만 답한다.",
    "- `license`: 왜 써도 되는지 한 마디(예: \"공공저작물\", \"기관 공식 홈페이지\", \"기업 보도자료\").",
    "- `rationale`: 이 이미지가 그 문단의 무엇을 보여주는지 한 문장.",
    "- 기준에 맞는 이미지를 못 찾았으면 `skipped: true`와 `skipReason`을 채우고 `imageUrl`은 빈 문자열로 둔다.",
    "  억지로 비슷한 것을 고르지 않는다 - 빈 자리가 잘못된 이미지보다 낫다.",
    "- 그 외 자리는 `skipped: false`, `skipReason`은 빈 문자열.",
    "- **`alternates`에 대체 후보를 0~3개 더 담는다**(2026-09-18). 1순위와 같은 기준을 통과한 것만,",
    "  좋은 순서대로. 실제 파일을 열어 보는 건 다음 단계가 하므로, 네가 URL만 보고 1순위를 잘못 골라도",
    "  대체 후보가 있으면 거기서 건질 수 있다. 하나뿐이면 빈 배열로 둔다."
  );

  return lines.join("\n");
}

function extensionFor(rawContentType: string): string | null {
  // 서버가 "image/Jpeg"처럼 대소문자를 섞어 보내기도 한다(실측: 분장놀이 자리 5가 이걸로 탈락).
  const contentType = rawContentType.toLowerCase();
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  // 네이버 뉴스 CDN 등이 avif로 준다(실측: 너말고 자리 6). 브라우저·Storage 모두 받으므로 저장한다.
  // readImageSize가 avif를 못 읽어 크기 검증은 건너뛰지만, 비전 검증은 그대로 돈다.
  if (contentType.includes("avif")) return "avif";
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
/** 후보를 한 번에 열어 보고 하나를 고른다. 아무것도 안 맞으면 picked: null. */
export async function defaultChooseImage(input: ChooseImageInput): Promise<ChooseImageResult> {
  const prompt = [
    "블로그 원고의 이미지 자리 하나에 넣을 후보 사진을 내려받았다. Read 도구로 **후보를 전부 열어 보고**",
    "그 자리에 가장 맞는 것 하나를 고른다. 맞는 것이 하나도 없으면 고르지 않는다.",
    "",
    `원고 주제: ${input.keyword}`,
    `이 자리에 필요한 것(원고 마커): ${input.markerDescription}`,
    "이 이미지가 요약해야 할 문단:",
    `"""${input.context.slice(0, 600)}"""`,
    "",
    "## 후보",
    ...input.candidates.map(
      (c) => `${c.number}. ${c.filePath}\n   수집기 설명(추측 - 틀릴 수 있다): ${c.alt}\n   출처: ${c.sourcePage}`
    ),
    "",
    "## 고르는 기준",
    "1. **그 자리가 요구한 것**(위 '이 자리에 필요한 것')을 보여주는가? 이것이 유일한 판정 기준이다.",
    "   수집기 설명은 파일을 열어보지 않고 쓴 추측이라 **틀릴 수 있다** - 추측과 다르다는 이유로",
    "   떨어뜨리지 않는다. (실측 오판: 마커는 '공식 프로필 사진'만 요구했는데 수집기가 '선글라스 쓰고",
    "   거리에서'라고 잘못 적었고, 실내 사진이라는 이유로 진짜 인물 사진을 버렸다.)",
    "2. **같은 주제면 합격이다.** 문단이 사진보다 더 세부적인 것(결말 해석, 타임테이블, 수치)을",
    "   말하더라도 그 이유로 떨어뜨리지 않는다. 제외는 **다른 주제·다른 행사·다른 인물·다른 작품**일 때다.",
    "3. 한국 이야기인데 외국 간판·차량·지폐 등 다른 나라 맥락이 드러나면 제외.",
    "4. 워터마크, 다른 사이트 로고, 검색 결과 화면, 깨진 이미지, 광고가 섞였으면 제외.",
    "5. **단독 인물 자리인데 여러 명이 나온 단체·그룹 사진이면 제외한다** - '~의 모습', '~만' 같은",
    "   표현으로 그 자리가 한 사람만 보여줘야 하는 자리인데, 후보에 그 사람이 다른 여러 사람과",
    "   나란히 나와 있고 그 사람만 알아보기 어려우면 떨어뜨린다. 그 사람이 화면 중심에 크게 혼자",
    "   나온 사진(다른 사람이 배경에 살짝 스쳐도 무방)만 합격이다. 설명 자체가 '둘이 함께', '멤버들과'",
    "   처럼 여러 인물을 요구하면 이 규칙은 적용하지 않는다.",
    "6. 둘 이상이 맞으면 **문단을 더 구체적으로 보여주는 쪽**을, 그래도 비슷하면 큰 쪽을 고른다.",
    "",
    '마지막 줄에 JSON 한 줄만 답한다: {"picked": 2, "reason": "한 문장"}',
    '맞는 것이 하나도 없으면 {"picked": null, "reason": "왜 전부 안 되는지 한 문장"}.',
  ].join("\n");

  const result = await runHeadlessClaude({
    prompt,
    allowedTools: ["Read"],
    permissionMode: "acceptEdits",
    timeoutMs: 180_000,
  });

  // 검증 자체가 실패하면 1순위를 그대로 쓴다 - 판정을 못 했다고 빈 자리로 두는 건 과하다.
  if (!result.ok) return { picked: input.candidates[0]?.number ?? null, reason: `검증 건너뜀(${result.error})` };

  const parsed = extractTrailingJson(result.output) as { picked?: unknown; reason?: unknown } | null;
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "";
  if (!parsed || !("picked" in parsed)) {
    return { picked: input.candidates[0]?.number ?? null, reason: "검증 결과를 읽지 못해 1순위를 씁니다" };
  }
  if (parsed.picked === null) return { picked: null, reason };
  const picked = typeof parsed.picked === "number" ? parsed.picked : Number.NaN;
  return Number.isInteger(picked) && input.candidates.some((c) => c.number === picked)
    ? { picked, reason }
    : { picked: input.candidates[0]?.number ?? null, reason: "고른 번호가 후보에 없어 1순위를 씁니다" };
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
  /** 대체 후보(2026-09-18). 비전 검증이 1순위와 함께 열어 보고 그중 하나를 고른다. */
  alternates: { imageUrl: string; sourcePage: string; license: string }[];
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
  const runCodex = options.runCodex ?? runClaudeWebSearch;
  const fetchImage = options.fetchImage ?? defaultFetchImage;
  const chooseImage = options.chooseImage ?? defaultChooseImage;
  const verify = options.verify ?? true;
  const failures: string[] = [];

  if (input.slots.length === 0) return { found: [], failures, unfilled: [] };

  // 자리마다 검색창에 친 결과를 후보로 먼저 모은다. 실패하면 빈 배열 - 에이전트가 직접 찾는다.
  const searchImages = options.searchImages === undefined ? searchNaverImages : options.searchImages;
  const candidates = new Map<number, ImageCandidate[]>();
  if (searchImages) {
    await Promise.all(
      input.slots.map(async (slot) => {
        const query = (slot.query ?? slot.description).replace(/\s*—\s*웹\s*검색\s*$/, "").trim();
        const list = await searchImages(query);
        if (list.length > 0) candidates.set(slot.index, list);
      })
    );
  }

  const run = await runCodex({
    prompt: buildPrompt(input.keyword, input.slots, candidates),
    outputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    search: true,
  });

  if (!run.ok) return { found: [], failures: [`웹 검색 에이전트 실행 실패: ${run.error}`], unfilled: allUnfilled(input.slots) };

  const results = parseCodexSlots(run.data);
  if (results.length === 0)
    return { found: [], failures: ["Codex가 자리 정보를 돌려주지 않았습니다."], unfilled: allUnfilled(input.slots) };

  const found: WebImageRecord[] = [];

  // 자리마다 후보를 내려받아 **실제로 열어 보고** 고른다. 이 판정이 자리당 최대 3분이라
  // 순차로 돌면 자리 4개짜리 원고에서만 10분 넘게 쓴다(2026-09-21 실측 - 원고 1건 40~50분의
  // 큰 축이었다). 자리끼리는 완전히 독립이고 파일명도 자리 번호로 갈려 충돌하지 않는다.
  // 무제한 병렬이 아니라 상한을 두는 이유는 mapWithConcurrency 주석 참고(429·일시 차단 회피).
  const processSlot = async (slot: WebImageSlot): Promise<WebImageRecord | null> => {
    const result = results.find((r) => r.index === slot.index);
    if (!result) {
      failures.push(`[자리 ${slot.index}] 웹 검색 에이전트 응답에 없습니다.`);
      return null;
    }
    if (result.skipped || !result.imageUrl) {
      failures.push(`[자리 ${slot.index}] 찾지 못함: ${result.skipReason || "사유 없음"}`);
      return null;
    }

    // 출처 분류는 내려받기 **전에** 본다 - 쓸 수 없는 자료를 디스크에 남길 이유가 없다.
    // C안: 유료 스톡·ND만 막는다(2026-09-17 사용자 결정). 대체 후보도 같은 기준을 통과한 것만
    // 담으라고 프롬프트에 지시했으므로 자리 단위로 한 번 본다.
    if (REJECTED_PERMISSIONS.has(result.reusePermission)) {
      failures.push(
        `[자리 ${slot.index}] 쓸 수 없는 자료라 건너뜁니다(${result.reusePermission}: ${result.license}) - 유료 스톡이거나 변경 금지(ND)입니다.`
      );
      return null;
    }

    // 1순위 + 대체 후보를 함께 내려받아 **한 번에 비교해 고른다**(2026-09-18 B안).
    // 전에는 1순위 하나만 받아 합·불을 판정했고, 떨어지면 그 자리는 끝이었다.
    const rawCandidates = [
      { imageUrl: result.imageUrl, sourcePage: result.sourcePage, license: result.license },
      ...(result.alternates ?? []),
    ];

    const readSize = options.readSize ?? readImageSize;
    const stem = `${String(slot.index).padStart(2, "0")}-${keywordSlug(result.alt || slot.description).slice(0, 40).replace(/-+$/, "") || "image"}`;

    type Downloaded = {
      number: number;
      filePath: string;
      buffer: Buffer;
      contentType: string;
      extension: string;
      size: { width: number; height: number } | null;
      imageUrl: string;
      sourcePage: string;
      license: string;
    };
    const candidates: Downloaded[] = [];

    for (const cand of rawCandidates) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (!/^https?:\/\//i.test(cand.imageUrl)) {
        failures.push(`[자리 ${slot.index}] 후보가 URL 형식이 아닙니다(${cand.imageUrl.slice(0, 60)}).`);
        return null;
      }

      // 출처 페이지를 모르면(이미지 검색 후보에서 고른 경우) 이미지 도메인을 출처로 쓴다.
      let sourcePage = cand.sourcePage;
      if (!/^https?:\/\//i.test(sourcePage)) {
        try {
          sourcePage = new URL(cand.imageUrl).origin;
        } catch {
          failures.push(`[자리 ${slot.index}] 후보가 URL 형식이 아닙니다(${cand.imageUrl.slice(0, 60)}).`);
          return null;
        }
      }

      const downloaded = await fetchImage({ url: cand.imageUrl, referer: sourcePage });
      if (!downloaded.ok || !downloaded.buffer) {
        // URL을 같이 남긴다 - 자동으로 못 받은 이미지는 사람이 브라우저로 직접 저장할 수 있다.
        failures.push(
          `[자리 ${slot.index}] 후보 내려받기 실패: ${downloaded.error ?? "알 수 없는 오류"}\n      이미지: ${cand.imageUrl}\n      출처: ${sourcePage}`
        );
        return null;
      }
      const extension = extensionFor(downloaded.contentType ?? "");
      if (!extension) {
        failures.push(`[자리 ${slot.index}] 후보가 이미지가 아닙니다(content-type: ${downloaded.contentType || "없음"}).`);
        return null;
      }
      const size = readSize(downloaded.buffer);
      const longSide = size ? Math.max(size.width, size.height) : null;
      if (longSide !== null && longSide < HARD_MIN_WIDTH) {
        failures.push(`[자리 ${slot.index}] 후보가 너무 작습니다(${size?.width}×${size?.height}, 긴 변 최소 ${HARD_MIN_WIDTH}px).`);
        return null;
      }

      const number = candidates.length + 1;
      const filePath = resolve(input.dir, `${stem}-cand${number}.${extension}`);
      await writeFile(filePath, downloaded.buffer);
      candidates.push({
        number,
        filePath,
        buffer: downloaded.buffer,
        contentType: downloaded.contentType ?? `image/${extension}`,
        extension,
        size,
        imageUrl: cand.imageUrl,
        sourcePage,
        license: cand.license || result.license,
      });
    }

    if (candidates.length === 0) {
      failures.push(`[자리 ${slot.index}] 쓸 수 있는 후보를 하나도 내려받지 못했습니다.`);
      return null;
    }

    // avif는 검증자(Claude Read)가 열지 못해 "내용을 확인하지 못했다"로 오탈락한다(실측: 너말고 자리 6).
    // 그 형식은 판정 대상에서 빼고, 열 수 있는 후보가 하나도 없으면 1순위를 그대로 쓴다.
    const openable = candidates.filter((c) => c.extension !== "avif");
    let chosen = candidates[0];

    if (verify && openable.length === 0) {
      failures.push(`[자리 ${slot.index}] ⚠️ avif라 비전 검증을 건너뛰고 저장했습니다 - 뷰어에서 한 번 확인하세요.`);
    } else if (verify) {
      const verdict = await chooseImage({
        candidates: openable.map((c) => ({
          number: c.number,
          filePath: c.filePath,
          alt: result.alt || slot.description,
          sourcePage: c.sourcePage,
        })),
        markerDescription: slot.description,
        context: slot.context,
        keyword: input.keyword,
      });
      if (verdict.picked === null) {
        for (const c of candidates) await rm(c.filePath, { force: true });
        failures.push(
          `[자리 ${slot.index}] 후보 ${openable.length}장 중 쓸 만한 것이 없어 비웠습니다: ${verdict.reason}`
        );
        return null;
      }
      chosen = openable.find((c) => c.number === verdict.picked) ?? openable[0];
      if (candidates.length > 1) {
        failures.push(`[자리 ${slot.index}] ℹ️ 후보 ${candidates.length}장 중 ${chosen.number}번 채택: ${verdict.reason}`);
      }
    }

    for (const c of candidates) if (c !== chosen) await rm(c.filePath, { force: true });

    let { buffer, contentType, extension, size } = chosen;
    const rawExtension = extension;
    const ratio = size ? size.width / size.height : null;
    if (ratio !== null && ratio < MIN_LANDSCAPE_RATIO) {
      failures.push(`[자리 ${slot.index}] ⚠️ 정사각·세로입니다(${size?.width}×${size?.height}) - 디스커버 썸네일 후보에서 빠지지만 저장했습니다.`);
    }
    if (size && size.width < PREFERRED_MIN_WIDTH) {
      failures.push(`[자리 ${slot.index}] ⚠️ 너비 ${size.width}px - 디스커버 큰 썸네일 기준(${PREFERRED_MIN_WIDTH}px) 미달이지만 저장했습니다.`);
    }

    // 1:2보다 긴 세로 이미지는 **왜곡 없이 주요 부분만 잘라낸다**(2026-09-18 사용자 지시).
    // 실측: 국립중앙박물관 웹플라이어가 1080×13861(1:12.8)로 저장됐다 - 본문에 넣으면 스크롤만
    // 내려간다. 비율을 늘려 맞추면 글자가 뭉개지므로 자른다. 고른 뒤에 자른다 - 탈락할 후보를
    // 미리 자르는 건 낭비다.
    const cropTall = options.cropTall === undefined ? cropTallImageWithFocus : options.cropTall;
    if (cropTall && size && ratio !== null && ratio < CROP_TRIGGER_RATIO) {
      const cropped = await cropTall({
        buffer,
        mimeType: contentType,
        width: size.width,
        height: size.height,
        filePath: chosen.filePath,
        alt: result.alt || slot.description,
        context: slot.context,
      });
      if (cropped.ok) {
        failures.push(
          `[자리 ${slot.index}] ⚠️ 너무 길어(${size.width}×${size.height}) 주요 부분만 잘랐습니다 → ${cropped.width}×${cropped.height}.`
        );
        buffer = cropped.buffer;
        contentType = cropped.mimeType;
        extension = extensionFor(cropped.mimeType) ?? extension;
        size = { width: cropped.width, height: cropped.height };
      } else {
        failures.push(`[자리 ${slot.index}] ⚠️ 너무 길지만(${size.width}×${size.height}) 자르지 못해 원본을 씁니다: ${cropped.error}`);
      }
    }

    // 후보 파일명(`-cand1`)을 최종 이름으로 바꾼다. 내보내기 폴더가 이 이름을 그대로 쓴다.
    const fileName = `${stem}.${extension}`;
    const filePath = resolve(input.dir, fileName);
    await writeFile(filePath, buffer);
    if (filePath !== chosen.filePath) await rm(chosen.filePath, { force: true });

    // 파이프라인은 러너가 곧 사라지므로 Storage에 올려야 뷰어가 본다. 업로드가 실패하면 채택하지
    // 않는다 - manifest에 URL 없는 항목을 넣으면 뷰어가 "이미지 없음"으로 그릴 뿐이다.
    let storageUrl: string | null = null;
    if (options.upload) {
      const uploaded = await options.upload({ index: slot.index, fileName, buffer, mimeType: contentType });
      if (!uploaded.ok) {
        await rm(filePath, { force: true });
        failures.push(`[자리 ${slot.index}] 업로드 실패: ${uploaded.error}`);
        return null;
      }
      storageUrl = uploaded.url;
    }

    void rawExtension;
    return {
      index: slot.index,
      fileName,
      imageUrl: chosen.imageUrl,
      sourcePage: chosen.sourcePage,
      alt: result.alt || slot.description,
      caption: result.caption || slot.description,
      license: chosen.license || "출처 확인 필요",
      storageUrl,
    };
  };

  const outcomes = await mapWithConcurrency(input.slots, SLOT_CONCURRENCY, processSlot);
  for (const outcome of outcomes) if (outcome) found.push(outcome);

  // 못 채운 자리는 실패 지점마다 모으지 않고 **끝에서 한 번에 계산한다.** 실패 경로가 10곳이라
  // (응답 누락/URL 형식/403/크기/비율/검증 탈락/업로드 실패…) 각 지점에 push를 넣으면 언젠가 한
  // 곳을 빠뜨리고, 그 자리만 조용히 빈 채로 나간다. "채워졌다"의 반대가 "못 채웠다"이므로 found를
  // 기준으로 빼는 것이 판정을 한 벌로 유지하는 유일한 방법이다.
  const filledIndexes = new Set(found.map((f) => f.index));
  const unfilled: UnfilledSlot[] = input.slots
    .filter((slot) => !filledIndexes.has(slot.index))
    .map((slot) => ({
      index: slot.index,
      description: slot.description,
      context: slot.context,
      suggestion: results.find((r) => r.index === slot.index)?.skipReason ?? "",
    }));

  if (found.length > 0) {
    // 이번에 찾은 것만 쓰면 지난 실행에서 채운 자리가 사라진다 - 호출부가 빈 자리만 넘길 수 있으므로
    // 기존 사이드카와 index 기준으로 합친다(같은 자리는 이번 결과가 이긴다).
    const previous = await readWebImages(input.dir);
    const merged = [...previous.filter((p) => !found.some((f) => f.index === p.index)), ...found].sort(
      (a, b) => a.index - b.index
    );
    await writeFile(resolve(input.dir, WEB_IMAGES_FILE), `${JSON.stringify({ images: merged }, null, 2)}\n`);
  }

  return { found, failures, unfilled };
}
