// koreaplain 발행본의 비공공 출처 이미지를 AI 삽화로 소급 교체한다(2026-11-10). CLI는 reimageKoreaplainCli.ts.
//
// 왜 소급하는가: PR #69는 **신규 원고**에만 새 출처 정책(공공 출처 화이트리스트 + AI 생성)을 건다. 이미 발행된
// 66건에는 언론사 사진(imgnews.naver.net 등)과 상업 블로그 이미지가 남아 있고, 애드센스 심사를 앞두고 저작권
// 위험을 없애기로 했다(사용자 결정: 라이선스 없는 사진을 찾기보다 AI로 다시 그린다).
//
// 이 파일은 **판단과 순서**를 가진다 - 무엇을 바꿀지 고르고, 어떤 순서로 쓰는지. DB·Blogger·Pages·LLM·생성은 전부
// `ReimageDeps`로 주입받는다(테스트가 가짜로 갈아 끼운다). 실제 연결은 reimageKoreaplainCli.ts에 있다.
//
// 글 하나의 순서(전부 직렬이다 - 아래 "왜 직렬인가" 참고):
//   1. 대상 선별      category = koreaplain, imagesRehostedAt 있음, sourcePage가 있고 화이트리스트를 못 넘는 자리
//   2. Blogger 읽기   글을 찾고 본문을 읽는다(읽기 전용). 대상 <img>가 본문에 실제로 있는지 확인한다 -
//                     못 찾는 글을 그리느라 생성 비용을 쓰지 않는다. 백업의 원본이기도 하다.
//   3. 프롬프트·판정  글 하나에 LLM 한 번. 자리마다 영어 생성 프롬프트 또는 SKIP(글자·숫자가 정보인 자리 등).
//   ---- 여기까지가 dry-run이다. 아래는 --apply에서만 ----
//   4. 생성·업로드    generateManuscriptImages 경로를 그대로 쓴다(gpt-image-2, quality low, 1536x864, Supabase Storage).
//   5. 백업           job.metadata.reimageBackup = { at, images, html, rehostedBySource } - **Pages 배포·본문 패치·메타 갱신보다 먼저**.
//   6. Pages 복사     rehostImagesToPages. 한 번에 한 글.
//   7. Blogger 패치   대상 <img>의 src·alt와 figcaption을 바꾼다(`Photo: …` 표기는 남지 않는다). 저장된 본문을 다시 읽어 확인한다.
//   8. 메타 갱신      metadata.images의 해당 자리 + rehostedBySource.
//
// 왜 직렬인가: Pages 배포는 사이트 전체의 스냅샷이다. 동시에 배포하면 늦게 끝난 쪽이 앞 글의 파일을 못 본 채 덮어 404가
// 난다(2026-10-15, 2026-10-31 실제로 두 번 터졌다 - rehostImagesToPages.ts 머리말). 글 사이도 같다.
//
// 되돌리는 법: reimageBackup.html을 patchPostContent로 다시 쓰고, reimageBackup.images·rehostedBySource를 metadata에 복원한다.
// 옛 Pages 파일은 manifest가 지우지 않으므로 백업 본문이 가리키는 URL이 그대로 살아 있다. 옛 Supabase 원본은
// storage-cleanup이 발행 14일 뒤 지울 수 있다(복원 때 그 URL은 쓰지 않는다 - 서비스는 Pages가 한다).

import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
import { MANUSCRIPT_IMAGE_CONFIG } from "../../config/manuscriptImages.js";
import { escapeHtml } from "../../services/publish/renderPublishBlocks.js";
import type { RehostResult } from "../../services/images/rehostImagesToPages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import { generateManuscriptImages } from "./generateManuscriptImages.js";
import type { GenerateManuscriptImagesOptions } from "./generateManuscriptImages.js";
import { isAllowedKoreaplainImageSource } from "./koreaplainImageSources.js";
import { validateAiPrompt } from "./refixImageMarkers.js";

// ---------- 타입 ----------

/** 소급 대상 후보 job. 목록 조회는 metadata 조각만 받으므로(egress) 필요한 칸만 담는다. */
export type ReimageJob = {
  id: string;
  keyword: string;
  category: string | null;
  /** metadata.imagesRehostedAt - 발행 HTML이 Pages URL을 가리킨다는 표식. */
  imagesRehostedAt: string | null;
  /** metadata.images 전체(백업 대상이기도 하다). */
  images: ManuscriptImage[];
  /** metadata.rehostedBySource (Supabase 원본 URL -> Pages URL). */
  rehostedBySource: Record<string, string>;
  /** 이미 reimageBackup이 있으면 true - 첫 백업(가장 원본에 가까운 상태)을 덮어쓰지 않는다. */
  hasBackup: boolean;
};

export type BloggerResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export type GenerateSlot = { index: number; description: string; prompt: string };

export type ReimageDeps = {
  /** 후보 job 목록(최신 순서는 호출자 몫). 선별은 selectReimageJobs가 한 번 더 거른다. */
  listJobs: () => Promise<ReimageJob[]>;
  /** 이 job의 발행 글 경로(`/2026/10/slug.html`). 발행 기록이 없으면 null. */
  findPostPath: (jobId: string) => Promise<string | null>;
  blogger: {
    findPostId: (path: string) => Promise<string | null>;
    getContent: (postId: string) => Promise<BloggerResult<{ content: string }>>;
    patchContent: (postId: string, html: string) => Promise<BloggerResult<object>>;
  };
  /** 글 하나의 프롬프트·판정 요청(LLM 한 번). */
  askPrompts: (prompt: string) => Promise<BloggerResult<{ output: string }>>;
  /** 생성 + Supabase Storage 업로드. 성공한 자리는 url이 있고 description은 이미 일러스트 캡션이다. */
  generate: (job: ReimageJob, slots: GenerateSlot[]) => Promise<{ images: ManuscriptImage[]; failures: string[] }>;
  /** Pages 복사(배포). 호출은 글당 한 번이고 항상 직렬이다. */
  rehost: (job: ReimageJob, images: ManuscriptImage[]) => Promise<RehostResult>;
  /** job.metadata에 얕게 병합한다(ArticleJobRepository.mergeMetadata). */
  saveMetadata: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
};

export type SlotNote = { index: number; reason: string };

export type JobOutcome = {
  jobId: string;
  keyword: string;
  /** dry-run에서는 "교체 예정"이다. */
  replaced: number[];
  skipped: SlotNote[];
  failed: SlotNote[];
  /** 글 전체가 막혔을 때의 사유(Blogger 글 못 찾음 등). 자리별 실패가 아니다. */
  jobError: string | null;
};

// ---------- 1. 대상 선별 ----------

/**
 * 교체할 자리: **웹에서 가져온 이미지**(sourcePage가 있다)이면서 그 출처가 화이트리스트를 못 넘는 것.
 * 생성 이미지는 sourcePage가 없어 여기 안 걸린다 - 그래서 한 번 교체한 자리는 다시 선별되지 않는다(멱등).
 */
export function selectReimageTargets(job: Pick<ReimageJob, "images">): ManuscriptImage[] {
  return job.images.filter((image) => {
    if (!image.url || image.error) return false;
    const sourcePage = (image.sourcePage ?? "").trim();
    if (!sourcePage) return false;
    return !isAllowedKoreaplainImageSource(sourcePage);
  });
}

/**
 * 소급 대상 job: **koreaplain 트랙**이고 이미지를 Pages로 옮긴 발행본이며 교체할 자리가 있는 것.
 * 조회 쿼리도 같은 조건을 걸지만 여기서 한 번 더 거른다 - 다른 트랙(엔터·사회·인물)은 어떤 경로로도 들어오면 안 된다.
 */
export function selectReimageJobs(jobs: ReimageJob[]): ReimageJob[] {
  return jobs.filter((job) => job.category === KOREAPLAIN_TRACK && Boolean(job.imagesRehostedAt) && selectReimageTargets(job).length > 0);
}

/** 발행 HTML이 이 자리를 가리키는 주소: Pages 대응이 있으면 그것, 없으면 원본 URL. */
export function publishedSrcOf(job: Pick<ReimageJob, "rehostedBySource">, image: ManuscriptImage): string {
  return job.rehostedBySource[image.url as string] ?? (image.url as string);
}

// ---------- 3. 프롬프트·판정 ----------

export function buildReimagePrompt(keyword: string, targets: ManuscriptImage[]): string {
  const lines = [
    "영문 블로그(Korea Plain - 한국 생활 안내) 글에 이미 실린 사진 몇 장을 **AI로 새로 그린 삽화로 바꾸려 한다.**",
    "원래 사진은 언론사·상업 사이트에서 가져온 것이라 저작권 위험이 있어 쓸 수 없다. 자리마다 이미지 생성",
    "프롬프트를 하나씩 쓰거나, 그릴 수 없는 자리면 `skip`으로 답한다.",
    "",
    `## 글 주제: ${keyword}`,
    "",
    "## 먼저 판정한다 - 이런 자리는 그리지 않고 skip이다",
    "AI는 글자·숫자를 틀리게 그린다(실측: 엘리베이터 층수 버튼에 5가 두 번 나왔다). 틀린 정보가 박힌 그림은 원본 사진을",
    "그대로 두는 것보다 나쁘다. 아래에 해당하면 **무조건 skip**이고, 사유에 해당 항목을 적는다.",
    "- **글자·숫자 자체가 정보인 자리**: 버튼 숫자, 층수 표시, 요금표·운임표, 운영시간·안내 표지판, 노선도, 지도,",
    "  영수증·메뉴판·가격표, 간판 문구, 앱·키오스크·전광판 화면, 서류 양식, 차트·표·인포그래픽.",
    "- **특정 실존 인물이 핵심인 자리**(누가 무엇을 했다고 서술된 자리 포함), **특정 작품의 포스터·스틸**, **특정 브랜드·제품의",
    "  실제 외형·로고**. AI가 그리면 가짜가 된다.",
    "판단이 애매하면 skip이다. 틀리게 그리는 것보다 원본을 두는 쪽이 안전하다(사람이 나중에 공식 페이지 캡처로 채운다).",
    "",
    "## 그려도 되는 자리 - 보편적 장면으로 일반화한다",
    "'다른 날 찍은 비슷한 사진을 넣어도 글이 성립하는' 자리다: 지하철 승강장, 편의점 계산대, 버스 정류장, 공항 입국장 줄,",
    "관광지 거리, 식당 풍경 등. 원래 사진의 구도를 따라 그리지 않는다(2차적저작물이 될 수 있다) - **같은 이야기를 하는",
    "누구나 흔히 보는 장면**으로 새로 쓴다.",
    "",
    "## 프롬프트 규칙 (하나라도 어기면 그 자리는 버려진다)",
    "- **영어로만** 쓴다. 한글·일본어 가나가 한 글자라도 섞이면 안 된다.",
    "- 반드시 `no text, no letters`를 넣는다(이미지에 글자가 있으면 안 된다).",
    "- 반드시 비율 `16:9`를 넣는다.",
    "- `photorealistic photograph`로 시작하는 실사 장면이다. 한국 배경임이 드러나게 쓴다(`in Korea`, `Korean`).",
    "- 사람이 무언가를 하는 장면 또는 그 장소의 자연스러운 모습. 텅 빈 공간·상징물 클로즈업은 금지다.",
    "- 실존 인물의 얼굴, 로고, 간판·표지판의 글자는 그리지 않는다.",
    "",
    "## 자리",
  ];

  for (const image of targets) {
    lines.push("", `### 자리 ${image.index}`);
    lines.push(`- 현재 캡션(원래 사진이 보여주던 것): ${image.description}`);
    if (image.prompt) lines.push(`- 집필 때 적어 둔 이미지 지시(검색어일 수 있다): ${image.prompt}`);
  }

  lines.push(
    "",
    "## 출력",
    "JSON 배열 하나로만 답한다. 설명·머리말·코드펜스를 붙이지 않는다. 위 자리를 **하나도 빠뜨리지 않고** 각각 한 항목씩 쓴다.",
    '그릴 자리: {"index": <자리 번호>, "action": "prompt", "prompt": "<영어 프롬프트 한 줄>"}',
    '그리지 않을 자리: {"index": <자리 번호>, "action": "skip", "reason": "<왜 skip인지 한 줄 - 위 항목 중 무엇인지>"}'
  );
  return lines.join("\n");
}

export type ReimageDecision = { kind: "prompt"; prompt: string } | { kind: "skip"; reason: string };

/** LLM 응답에서 JSON 배열을 꺼내 자리 번호별 판정으로 바꾼다. 잡음이 앞뒤에 붙어도 첫 `[`부터 마지막 `]`까지만 읽는다. */
export function parseReimageDecisions(raw: string): Map<number, ReimageDecision> {
  const decisions = new Map<number, ReimageDecision>();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return decisions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return decisions;
  }
  if (!Array.isArray(parsed)) return decisions;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { index, action, prompt, reason } = item as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (action === "skip") {
      decisions.set(index, { kind: "skip", reason: typeof reason === "string" && reason.trim() ? reason.trim() : "사유 없음" });
    } else if (action === "prompt" && typeof prompt === "string" && prompt.trim()) {
      decisions.set(index, { kind: "prompt", prompt: prompt.replace(/\s+/g, " ").trim() });
    }
  }
  return decisions;
}

// ---------- 7. Blogger 본문 치환 ----------

export type FigureSwap = { oldSrc: string; newSrc: string; caption: string; width?: number | null; height?: number | null };

export type FigureSwapResult = {
  html: string;
  /** 치환한 swap의 oldSrc. */
  replaced: string[];
  /** 본문에서 찾지 못한 swap의 oldSrc. */
  missing: string[];
  /** 치환한 <figure> 안에 아직 출처 표기(`Photo:` 등)가 남은 oldSrc. 0이어야 한다. */
  creditLeft: string[];
};

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return match ? match[1] : null;
}

/** 속성을 바꾸거나(값이 있으면) 지운다(null). 없으면 `>` 앞에 넣는다. */
function setAttr(tag: string, name: string, value: string | null): string {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, "i");
  if (value === null) return tag.replace(pattern, "");
  const next = ` ${name}="${escapeHtml(value)}"`;
  if (pattern.test(tag)) return tag.replace(pattern, next);
  return tag.replace(/\s*\/?>$/, (end) => `${next}${end.trimStart()}`);
}

/** 발행 HTML의 <figure> 안 <img>를 새 주소·캡션으로 바꾼다. 다른 곳은 한 글자도 건드리지 않는다. */
export function swapFigureImages(html: string, swaps: FigureSwap[]): FigureSwapResult {
  const pending = new Map(swaps.map((swap) => [swap.oldSrc, swap]));
  const replaced: string[] = [];
  const creditLeft: string[] = [];

  const out = html.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (figure) => {
    const imgTag = /<img\b[^>]*>/i.exec(figure)?.[0];
    if (!imgTag) return figure;
    const src = decodeEntities(attrOf(imgTag, "src") ?? "");
    const swap = pending.get(src);
    if (!swap) return figure;
    pending.delete(src);

    // 치수는 새 바이트 기준이다 - 옛 치수가 남으면 레이아웃이 틀어지므로 모르면 지운다(틀린 치수는 없는 것보다 나쁘다).
    let nextImg = setAttr(imgTag, "src", swap.newSrc);
    nextImg = setAttr(nextImg, "alt", swap.caption);
    nextImg = setAttr(nextImg, "width", swap.width ? String(swap.width) : null);
    nextImg = setAttr(nextImg, "height", swap.height ? String(swap.height) : null);

    let next = figure.replace(imgTag, () => nextImg);
    const captionText = escapeHtml(swap.caption);
    if (/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/i.test(next)) {
      next = next.replace(/(<figcaption\b[^>]*>)[\s\S]*?(<\/figcaption>)/i, (_m, open: string, close: string) => `${open}${captionText}${close}`);
    } else {
      next = next.replace(/<\/figure>$/i, () => `<figcaption>${captionText}</figcaption></figure>`);
    }
    replaced.push(swap.oldSrc);
    // 캡션 밖(출처 링크 등)에 크레디트가 따로 있었는지 본다. 일러스트 표기(`Illustration: AI-generated`)는 걸리지 않는다.
    if (/\b(Photo|Source|Image)\s*:/i.test(next.replace(/<[^>]+>/g, " "))) creditLeft.push(swap.oldSrc);
    return next;
  });

  return { html: out, replaced, missing: [...pending.keys()], creditLeft };
}

/** 본문의 <figure> 안 <img> 주소 목록(읽기 전용). 대상이 본문에 실제로 있는지 생성 전에 확인하는 데 쓴다. */
export function listFigureSrcs(html: string): Set<string> {
  const srcs = new Set<string>();
  for (const figure of html.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi) ?? []) {
    const imgTag = /<img\b[^>]*>/i.exec(figure)?.[0];
    const src = imgTag ? attrOf(imgTag, "src") : null;
    if (src) srcs.add(decodeEntities(src));
  }
  return srcs;
}

// ---------- 4. 생성 어댑터 ----------

/**
 * 생성·업로드는 신규 원고와 **같은 경로**(generateManuscriptImages)를 쓴다 - 모델·화질·치수·업로드 규칙이 한 벌이다.
 * 본문 없이 `fallbackSlots`로 자리만 넘기고, `aiIllustrations`로 화질을 low로 고정하며 캡션을 일러스트 표기로 바꾼다.
 * 설정은 기본값에서 켬/끔·A/B만 고정한다(MANUSCRIPT_IMAGE_GENERATION=false 환경에서도 이 도구는 돈다 - 명시적으로 실행한 것이다).
 */
export async function generateReplacementImages(
  job: Pick<ReimageJob, "id" | "keyword">,
  slots: GenerateSlot[],
  options: GenerateManuscriptImagesOptions = {}
): Promise<{ images: ManuscriptImage[]; failures: string[] }> {
  return generateManuscriptImages(
    { jobId: job.id, keyword: job.keyword, date: "", body: "", imagePrompts: [] },
    {
      config: { ...MANUSCRIPT_IMAGE_CONFIG, enabled: true, abCompare: false, maxPerArticle: Math.max(slots.length, 1) },
      fallbackSlots: slots.map((slot) => ({ index: slot.index, description: slot.description, prompt: slot.prompt })),
      aiIllustrations: true,
      ...options,
    }
  );
}

// ---------- 글 하나 ----------

export type ReimageOptions = { apply: boolean };

function jobFailure(job: ReimageJob, error: string, partial: Partial<JobOutcome> = {}): JobOutcome {
  return { jobId: job.id, keyword: job.keyword, replaced: [], skipped: [], failed: [], jobError: error, ...partial };
}

export async function reimageJob(job: ReimageJob, deps: ReimageDeps, options: ReimageOptions): Promise<JobOutcome> {
  const { log } = deps;
  const targets = selectReimageTargets(job);
  const outcome: JobOutcome = { jobId: job.id, keyword: job.keyword, replaced: [], skipped: [], failed: [], jobError: null };
  if (job.category !== KOREAPLAIN_TRACK) return jobFailure(job, `koreaplain 트랙이 아닙니다(category=${job.category ?? "null"}) - 건드리지 않습니다`);
  if (targets.length === 0) return outcome;

  // 2) Blogger 읽기(읽기 전용): 글을 찾고 본문을 읽는다. 여기서 막히면 생성 비용을 쓰지 않는다.
  const path = await deps.findPostPath(job.id);
  if (!path) return jobFailure(job, "발행 기록(published_url)을 찾지 못했습니다");
  const postId = await deps.blogger.findPostId(path);
  if (!postId) return jobFailure(job, `Blogger에서 글을 찾지 못했습니다(${path})`);
  const original = await deps.blogger.getContent(postId);
  if (!original.ok) return jobFailure(job, `Blogger 본문을 읽지 못했습니다: ${original.error}`);

  const present = listFigureSrcs(original.content);
  const located: ManuscriptImage[] = [];
  for (const image of targets) {
    if (present.has(publishedSrcOf(job, image))) located.push(image);
    else outcome.failed.push({ index: image.index, reason: "발행 본문에서 이 이미지의 <figure>를 찾지 못했습니다" });
  }
  if (located.length === 0) return outcome;

  // 3) 프롬프트·판정: 글 하나에 LLM 한 번.
  const asked = await deps.askPrompts(buildReimagePrompt(job.keyword, located));
  if (!asked.ok) {
    for (const image of located) outcome.failed.push({ index: image.index, reason: `프롬프트 요청 실패: ${asked.error}` });
    return outcome;
  }
  const decisions = parseReimageDecisions(asked.output);
  const slots: GenerateSlot[] = [];
  for (const image of located) {
    const decision = decisions.get(image.index);
    if (!decision) {
      outcome.failed.push({ index: image.index, reason: "LLM이 이 자리의 판정을 돌려주지 않았습니다" });
    } else if (decision.kind === "skip") {
      outcome.skipped.push({ index: image.index, reason: decision.reason });
    } else {
      const invalid = validateAiPrompt(decision.prompt);
      if (invalid) outcome.failed.push({ index: image.index, reason: `프롬프트 규격 위반: ${invalid}` });
      else slots.push({ index: image.index, description: image.description, prompt: decision.prompt });
    }
  }

  if (!options.apply) {
    outcome.replaced = slots.map((slot) => slot.index);
    for (const slot of slots) log(`   · 자리 ${slot.index} → 교체 예정: ${slot.prompt}`);
    return outcome;
  }
  if (slots.length === 0) return outcome;

  // 4) 생성·업로드
  const generated = await deps.generate(job, slots);
  const made = generated.images.filter((image) => image.url && !image.error);
  for (const slot of slots) {
    if (!made.some((image) => image.index === slot.index)) {
      const failure = generated.images.find((image) => image.index === slot.index)?.error ?? generated.failures.find((f) => f.includes(`[이미지 ${slot.index}`)) ?? "생성 실패";
      outcome.failed.push({ index: slot.index, reason: `생성 실패: ${failure}` });
    }
  }
  if (made.length === 0) return outcome;

  // 5) 백업: Pages 배포·본문 패치·메타 갱신보다 먼저. 이미 백업이 있으면 첫 백업(원본에 가장 가까운 상태)을 지키고 덮지 않는다.
  if (!job.hasBackup) {
    try {
      await deps.saveMetadata(job.id, {
        reimageBackup: { at: deps.now().toISOString(), images: job.images, html: original.content, rehostedBySource: job.rehostedBySource },
      });
    } catch (error) {
      const reason = `백업을 저장하지 못해 교체하지 않습니다: ${error instanceof Error ? error.message : String(error)}`;
      for (const image of made) outcome.failed.push({ index: image.index, reason });
      return outcome;
    }
  } else {
    log("   · 기존 reimageBackup 유지(덮어쓰지 않음)");
  }

  // 6) Pages 복사 - 새로 만든 자리만 넘긴다(나머지는 이미 Pages에 있다).
  let rehost: RehostResult;
  try {
    rehost = await deps.rehost(job, made);
  } catch (error) {
    const reason = `Pages 복사 예외: ${error instanceof Error ? error.message : String(error)}`;
    for (const image of made) outcome.failed.push({ index: image.index, reason });
    return outcome;
  }
  const moved = made.flatMap((image) => {
    const after = rehost.images.find((candidate) => candidate.index === image.index);
    if (!after?.url || after.url === image.url) {
      outcome.failed.push({ index: image.index, reason: `Pages 복사 실패: ${rehost.failures.join(" / ") || "사유 없음"}` });
      return [];
    }
    return [{ supabase: image, pages: after }];
  });
  if (moved.length === 0) return outcome;

  // 7) Blogger 패치
  const swapped = swapFigureImages(
    original.content,
    moved.map(({ supabase, pages }) => {
      const target = located.find((image) => image.index === supabase.index) as ManuscriptImage;
      return { oldSrc: publishedSrcOf(job, target), newSrc: pages.url as string, caption: supabase.description, width: pages.width, height: pages.height };
    })
  );
  if (swapped.replaced.length === 0) {
    for (const { supabase } of moved) outcome.failed.push({ index: supabase.index, reason: "본문 치환 대상을 찾지 못했습니다" });
    return outcome;
  }
  const patched = await deps.blogger.patchContent(postId, swapped.html);
  if (!patched.ok) {
    for (const { supabase } of moved) outcome.failed.push({ index: supabase.index, reason: `Blogger 패치 실패(본문·메타는 그대로, Pages 파일만 올라감): ${patched.error}` });
    return outcome;
  }
  const stored = await deps.blogger.getContent(postId);
  const done = moved.filter(({ pages }) => !stored.ok || stored.content.includes(pages.url as string));
  for (const { supabase } of moved) {
    if (!done.some((entry) => entry.supabase.index === supabase.index)) {
      outcome.failed.push({ index: supabase.index, reason: "패치 뒤 저장된 본문에 새 이미지가 없습니다(Blogger가 반영하지 않음)" });
    }
  }
  if (!stored.ok) log(`   ⚠️ 패치 뒤 본문을 다시 읽지 못해 반영 확인을 건너뜁니다: ${stored.error}`);
  for (const oldSrc of swapped.creditLeft) log(`   ⚠️ 출처 표기가 캡션 밖에 남았습니다(${oldSrc}) - 눈으로 확인하세요`);
  if (done.length === 0) return outcome;

  // 8) 메타 갱신: images는 새 Supabase URL을 들고(발행 파이프라인의 약속), rehostedBySource가 Pages로 잇는다.
  const doneBy = new Map(done.map((entry) => [entry.supabase.index, entry]));
  const nextBySource = { ...job.rehostedBySource };
  const nextImages = job.images.map((image) => {
    const entry = doneBy.get(image.index);
    if (!entry) return image;
    delete nextBySource[image.url as string];
    nextBySource[entry.supabase.url as string] = entry.pages.url as string;
    return {
      ...image,
      description: entry.supabase.description,
      prompt: entry.supabase.prompt,
      url: entry.supabase.url,
      provider: entry.supabase.provider,
      fileName: entry.supabase.fileName,
      sourcePage: null,
      license: null,
      error: null,
      width: entry.pages.width ?? null,
      height: entry.pages.height ?? null,
    } satisfies ManuscriptImage;
  });
  try {
    await deps.saveMetadata(job.id, { images: nextImages, rehostedBySource: nextBySource });
  } catch (error) {
    outcome.jobError = `Blogger는 패치됐지만 메타 갱신에 실패했습니다(백업은 저장됨): ${error instanceof Error ? error.message : String(error)}`;
  }
  outcome.replaced = done.map((entry) => entry.supabase.index);
  return outcome;
}

// ---------- 전체 ----------

export type RunOptions = { apply: boolean; jobPrefix: string | null; limit: number | null };

export type RunSummary = { outcomes: JobOutcome[]; replaced: number; skipped: number; failed: number; failedJobs: JobOutcome[] };

export function formatOutcome(outcome: JobOutcome, apply: boolean): string {
  const head = `── ${outcome.jobId.slice(0, 8)} (${outcome.keyword})`;
  if (outcome.jobError && outcome.replaced.length === 0 && outcome.skipped.length === 0 && outcome.failed.length === 0) {
    return `${head} ❌ ${outcome.jobError}`;
  }
  const verb = apply ? "교체" : "교체 예정";
  return `${head} ${verb} ${outcome.replaced.length}장 / 건너뜀 ${outcome.skipped.length}장 / 실패 ${outcome.failed.length}장${outcome.jobError ? ` ⚠️ ${outcome.jobError}` : ""}`;
}

/**
 * 후보 job을 **하나씩 차례로** 처리한다. 한 글이 실패해도(예외 포함) 다음 글로 간다.
 * `await`를 루프 안에서 직접 기다리는 것이 직렬의 전부다 - Promise.all·mapWithConcurrency로 바꾸면 Pages 배포가 겹친다.
 */
export async function runReimage(deps: ReimageDeps, options: RunOptions): Promise<RunSummary> {
  let jobs = selectReimageJobs(await deps.listJobs());
  if (options.jobPrefix) jobs = jobs.filter((job) => job.id.startsWith(options.jobPrefix as string));
  if (options.limit !== null) jobs = jobs.slice(0, options.limit);

  const outcomes: JobOutcome[] = [];
  for (const job of jobs) {
    deps.log(`── ${job.id.slice(0, 8)} (${job.keyword}) 대상 ${selectReimageTargets(job).length}장`);
    let outcome: JobOutcome;
    try {
      outcome = await reimageJob(job, deps, { apply: options.apply });
    } catch (error) {
      outcome = jobFailure(job, `예외: ${error instanceof Error ? error.message : String(error)}`);
    }
    deps.log(formatOutcome(outcome, options.apply));
    for (const note of outcome.skipped) deps.log(`   · 자리 ${note.index} 건너뜀(원본 유지): ${note.reason}`);
    for (const note of outcome.failed) deps.log(`   · 자리 ${note.index} 실패: ${note.reason}`);
    outcomes.push(outcome);
  }

  return {
    outcomes,
    replaced: outcomes.reduce((n, o) => n + o.replaced.length, 0),
    skipped: outcomes.reduce((n, o) => n + o.skipped.length, 0),
    failed: outcomes.reduce((n, o) => n + o.failed.length, 0),
    failedJobs: outcomes.filter((o) => o.failed.length > 0 || o.jobError),
  };
}
