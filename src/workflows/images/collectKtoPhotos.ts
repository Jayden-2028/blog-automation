// Korea Plain(koreaplain) 이미지 자리의 **1순위 출처: 한국관광공사 관광사진 API**(2026-11-25 사용자 결정).
//
// 수집 순서(koreaplain만, collectWebImagesForJob.ts가 배선):
//   ① 관광사진 API(이 파일) → ② 웹 검색(collectWebImages.ts - 언론사 제외, `KOREAPLAIN_IMAGE_SOURCES=whitelist`면 화이트리스트)
//   → ③ 공식 페이지 캡처(정보 화면 자리, capturePagesForJob.ts) → ④ AI 생성(실사, generateManuscriptImages.ts)
// 한식진흥원 사진은 쓰지 않는다(사용자 결정). 웹 검색은 2026-11-25부터 엔터와 같은 후보 풀에서 언론사만 뺀다.
//
// 이 단계가 하는 일
//   1. 자리마다 한글 음식명(koreanFoodNames.ts)으로 API를 부른다 - **자리당 최대 2 키워드, 원고당 최대 8호출**(개발계정 하루 1,000건).
//      같은 키워드는 원고 안에서 한 번만 부른다(음식 글은 자리 대부분이 같은 음식이다).
//   2. 메타데이터로 후보를 고른다(scoreKtoPhoto): 제목·검색키워드의 음식명 일치(필수) > 지역 일치 가점 > 사람·글자·전경 위주 감점
//      > 최근 촬영 가점. 한 원고 안에서 같은 사진(contentId)을 두 자리에 주지 않는다.
//   3. 자리당 상위 3장을 내려받아 해상도를 보고(긴 변 600px 미만 탈락), 비전 판정(collectWebImages의 chooseImage)으로 하나를 고른다.
//      판정이 "맞는 것이 없다"고 하면 그 자리는 다음 단계(웹 검색)로 넘어간다.
//      **관광사진은 취사선택이다**(2026-11-25 사용자 지시 - "문단 내용에 맞지 않는 사진을 반드시 쓸 필요는 없다"). 관광사진은 음식명
//      검색이라 음식 종류만 같고 문단이 보여주려는 장면(비비는 손, 두 그릇 비교, 특정 고명)과 다른 경우가 많다 - 냉면 원고에서
//      "양념에 비비는 장면" 자리에 함흥냉면 그릇 사진이 들어갔다. 그래서 판정자에게 **문단 내용이 사진에 실제로 보일 때만** 고르라고
//      못 박고(KTO_FIT_CAUTION), 판정을 못 받은 경우(호출 실패·결과 해석 실패)는 1순위를 쓰지 않고 웹 검색으로 넘긴다. 같은 촬영 묶음
//      (촬영자·촬영지·제목이 같은 사진)은 한 원고에 한 장만 쓴다 - 바이트가 달라 중복 검사기를 통과해도 독자에겐 같은 사진이다.
//   4. 캡션은 사진 소개 + `Photo: Korea Tourism Organization (촬영자), KOGL Type 1`(공공누리 제1유형 출처 표시).
// 실패는 전부 비치명이다 - 못 채운 자리는 기존 경로가 받는다.

import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { keywordSlug } from "../../config/pipelinePaths.js";
import { mapWithConcurrency } from "../../services/mapWithConcurrency.js";
import { KTO_DATASET_PAGE } from "../../services/images/ktoPhotoGallery.js";
import type { KtoPhoto, KtoSearch } from "../../services/images/ktoPhotoGallery.js";
import { readImageSize } from "../manuscripts/exportManuscript.js";
import type { WebImageRecord } from "../manuscripts/exportManuscript.js";
import type { ImageCandidateRecord } from "../manuscripts/manuscriptManifest.js";
import { stripAcquisitionSuffix } from "../manuscripts/parseManuscriptBlocks.js";
import { defaultChooseImage, defaultFetchImage, imageExtensionFor } from "./collectWebImages.js";
import type { ChooseImageInput, ChooseImageResult, WebImageSlot } from "./collectWebImages.js";
import type { ImageDeduper } from "./imageFingerprint.js";
import { KTO_PHOTO_LICENSE, isAllowedKoreaplainImageSource, toKtoPhotoCaption } from "./koreaplainImageSources.js";
import type { KtoSlotHint } from "./koreanFoodNames.js";

/** 원고당 관광사진 API 호출 상한(사용자 지시). */
export const KTO_MAX_CALLS_PER_MANUSCRIPT = 8;
/** 자리당 내려받아 비교할 후보 수. */
export const KTO_DOWNLOADS_PER_SLOT = 3;
/** 긴 변이 이보다 작으면 쓰지 않는다(웹 수집의 400보다 높다 - 16:9 1600×900 보정 뒤에도 알아볼 수 있어야 한다). */
export const KTO_MIN_LONG_SIDE = 600;
const SLOT_CONCURRENCY = 3;

/** 사람이 주인공인 사진(관광객이 먹는 장면·체험·축제). 음식 자리에는 음식이 주인공이어야 한다. */
const PEOPLE_TERMS = ["관광객", "여행객", "사람들", "사람", "인물", "모델", "가족", "커플", "연인", "외국인", "어린이", "아이들", "학생", "체험", "시식", "먹방", "셀카", "축제", "행사", "공연"];
/** 글자가 주인공인 사진(간판·메뉴판·안내판). 영문 독자에게 한글 글자 사진은 정보가 안 된다. */
const TEXT_TERMS = ["간판", "메뉴판", "메뉴", "안내판", "안내", "포스터", "표지판", "현수막", "지도"];
/** 음식이 아니라 장소가 주인공인 사진. */
const SCENERY_TERMS = ["전경", "외관", "야경", "입구", "골목"];

/**
 * 관광사진 판정 기준(2026-11-25). 판정자는 후보가 관광사진뿐이어도 "그중 제일 나은 것"을 고르는 경향이 있어, 맞지 않으면 비우라고
 * 분명히 적는다 - 비운 자리는 웹 검색(블로그·식당 사진 포함)이 문단에 맞는 사진을 따로 찾는다.
 */
export const KTO_FIT_CAUTION =
  "이 후보들은 한국관광공사 관광사진으로, 음식 이름으로만 검색한 것이다. 음식 종류가 같다는 이유로 고르지 않는다. " +
  "자리 설명과 문단이 보여주려는 것(먹는 동작·비교·특정 고명·상차림·가게 등)이 사진에 실제로 보일 때만 고른다. " +
  "조금이라도 어긋나면 picked: null - 이 자리는 웹 검색이 따로 찾는다. 사람·간판·메뉴판이 주인공인 사진은 고르지 않는다.";

/** 같은 촬영 묶음의 열쇠. 촬영자·촬영지·제목이 같으면 한 장면을 여러 번 찍은 사진이다. */
export function ktoShootKey(photo: Pick<KtoPhoto, "photographer" | "location" | "title">): string {
  return [photo.photographer, photo.location, photo.title].map((v) => compact(v ?? "")).join("|");
}

export type KtoScoredPhoto = { photo: KtoPhoto; score: number; matched: string; reasons: string[] };

function compact(text: string): string {
  return (text ?? "").replace(/\s+/g, "");
}

/**
 * 메타데이터 점수. **음식명 일치가 없으면 null**(후보 아님) - 키워드 검색이 지명·축제명으로 엉뚱한 사진을 끌어오는 것을 막는다.
 * 자리의 첫 음식명(가장 구체적인 이름)이 둘째(일반 이름)보다 높다.
 */
export function scoreKtoPhoto(photo: KtoPhoto, hint: Pick<KtoSlotHint, "dishes" | "regions">): KtoScoredPhoto | null {
  const title = compact(photo.title);
  const keywords = compact(photo.searchKeywords);
  const reasons: string[] = [];
  let score = 0;
  let matched = "";
  hint.dishes.some((dish, order) => {
    const name = compact(dish);
    if (!name) return false;
    if (title.includes(name)) {
      score += order === 0 ? 60 : 45;
      matched = dish;
      reasons.push(`제목에 "${dish}"`);
      if (title.length <= name.length + 4) {
        score += 10;
        reasons.push("제목이 음식명 위주");
      }
      return true;
    }
    if (keywords.includes(name)) {
      score += order === 0 ? 30 : 20;
      matched = dish;
      reasons.push(`검색키워드에 "${dish}"`);
      return true;
    }
    return false;
  });
  if (!matched) return null;

  const location = compact(photo.location);
  if (hint.regions.some((region) => location.includes(region) || title.includes(region))) {
    score += 15;
    reasons.push("지역 일치");
  }
  const meta = `${title} ${keywords}`;
  if (PEOPLE_TERMS.some((term) => meta.includes(term))) {
    score -= 35;
    reasons.push("사람 위주");
  }
  if (TEXT_TERMS.some((term) => meta.includes(term))) {
    score -= 25;
    reasons.push("글자 위주");
  }
  if (SCENERY_TERMS.some((term) => title.includes(term))) {
    score -= 15;
    reasons.push("장소 위주");
  }
  const year = Number(photo.photographyMonth.slice(0, 4));
  if (year >= 2000 && year <= 2100) {
    const recency = Math.max(0, Math.min(8, Math.floor((year - 2010) / 2)));
    if (recency > 0) score += recency;
  }
  return { photo, score, matched, reasons };
}

/** 점수 순(같으면 최근 촬영 순). 같은 사진(contentId·주소)은 한 번만. 허용 호스트 밖 주소는 버린다. */
export function rankKtoPhotos(photos: readonly KtoPhoto[], hint: Pick<KtoSlotHint, "dishes" | "regions">): KtoScoredPhoto[] {
  const seen = new Set<string>();
  const scored: KtoScoredPhoto[] = [];
  for (const photo of photos) {
    const id = photo.contentId || photo.imageUrl;
    if (seen.has(id)) continue;
    seen.add(id);
    // 화이트리스트를 여기서도 지킨다 - API가 다른 호스트를 주면(정책 변경 등) 쓰지 않는다.
    if (!isAllowedKoreaplainImageSource(photo.imageUrl)) continue;
    const result = scoreKtoPhoto(photo, hint);
    if (result) scored.push(result);
  }
  return scored.sort((a, b) => b.score - a.score || b.photo.photographyMonth.localeCompare(a.photo.photographyMonth));
}

/** 자리 순서대로 후보를 나눠 준다 - 앞 자리가 쓴 사진은 뒤 자리 후보에서 뺀다(한 원고 안 중복 회피). */
export function assignKtoCandidates(
  ranked: ReadonlyMap<number, KtoScoredPhoto[]>,
  perSlot: number = KTO_DOWNLOADS_PER_SLOT
): Map<number, KtoScoredPhoto[]> {
  const used = new Set<string>();
  const assigned = new Map<number, KtoScoredPhoto[]>();
  for (const index of [...ranked.keys()].sort((a, b) => a - b)) {
    const picks: KtoScoredPhoto[] = [];
    for (const candidate of ranked.get(index) ?? []) {
      if (picks.length >= perSlot) break;
      const id = candidate.photo.contentId || candidate.photo.imageUrl;
      if (used.has(id)) continue;
      picks.push(candidate);
    }
    // 첫 후보만 "사용 중"으로 묶는다 - 나머지는 이 자리가 안 고르면 뒤 자리가 쓸 수 있다. 같은 사진이 두 자리에서 동시에
    // 채택되는 경우는 중복 검사기(바이트 해시)가 뒤 자리를 다음 후보로 넘긴다.
    if (picks[0]) used.add(picks[0].photo.contentId || picks[0].photo.imageUrl);
    if (picks.length > 0) assigned.set(index, picks);
  }
  return assigned;
}

export type CollectKtoPhotosInput = {
  keyword: string;
  /** 후보 파일을 잠깐 내려받을 폴더(호출부가 지운다). */
  dir: string;
  slots: WebImageSlot[];
  hints: Record<number, KtoSlotHint>;
};

export type CollectKtoPhotosOptions = {
  search: KtoSearch;
  fetchImage?: (input: { url: string; referer: string }) => Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }>;
  chooseImage?: (input: ChooseImageInput) => Promise<ChooseImageResult>;
  /** false면 비전 판정 없이 점수·해상도로 고른다. 기본 true. */
  verify?: boolean;
  readSize?: (buffer: Buffer) => { width: number; height: number } | null;
  upload?: (input: {
    index: number;
    fileName: string;
    buffer: Buffer;
    mimeType: string;
  }) => Promise<{ ok: true; url: string; extension?: string; width?: number; height?: number } | { ok: false; error: string }>;
  deduper?: ImageDeduper;
  captionLanguage?: "ko" | "en";
  /** 원고당 호출 상한. 기본 8. */
  maxCalls?: number;
};

export type CollectKtoPhotosResult = {
  found: WebImageRecord[];
  failures: string[];
  candidates: Record<number, ImageCandidateRecord[]>;
  /** 실제로 부른 API 호출 수. */
  calls: number;
};

/** 영어본이 아니면(한국어 캡션) 출처를 한국어 관행으로 적는다. 이 트랙은 대개 영어본이다. */
function captionFor(intro: string, photographer: string, language: "ko" | "en" | undefined): string {
  if (language === "en") return toKtoPhotoCaption(intro, photographer);
  const cleaned = (intro ?? "").replace(/[.\s]+$/, "");
  const credit = `사진=한국관광공사${photographer ? `(${photographer})` : ""}, 공공누리 제1유형`;
  return cleaned ? `${cleaned}. ${credit}` : credit;
}

export async function collectKtoPhotos(input: CollectKtoPhotosInput, options: CollectKtoPhotosOptions): Promise<CollectKtoPhotosResult> {
  const failures: string[] = [];
  const candidateLog: Record<number, ImageCandidateRecord[]> = {};
  const maxCalls = options.maxCalls ?? KTO_MAX_CALLS_PER_MANUSCRIPT;
  const fetchImage = options.fetchImage ?? defaultFetchImage;
  const chooseImage = options.chooseImage ?? defaultChooseImage;
  const verify = options.verify ?? true;
  const readSize = options.readSize ?? readImageSize;

  const slots = input.slots.filter((slot) => (input.hints[slot.index]?.dishes.length ?? 0) > 0).sort((a, b) => a.index - b.index);
  if (slots.length === 0) return { found: [], failures, candidates: candidateLog, calls: 0 };

  // ---- 1. 검색(키워드 캐시 + 원고당 상한) ----
  const cache = new Map<string, KtoPhoto[]>();
  let calls = 0;
  let capped = false;
  const searchOnce = async (keyword: string): Promise<KtoPhoto[]> => {
    const cached = cache.get(keyword);
    if (cached) return cached;
    if (calls >= maxCalls) {
      capped = true;
      return [];
    }
    calls += 1;
    const result = await options.search(keyword).catch((error: unknown) => ({
      ok: false as const,
      error: `"${keyword}" ${error instanceof Error ? error.name : "오류"}`,
    }));
    const photos = result.ok ? result.photos : [];
    if (!result.ok) failures.push(`⚠️ 관광사진 검색 실패: ${result.error}`);
    cache.set(keyword, photos);
    return photos;
  };

  /** 이 원고에서 이미 쓴 촬영 묶음 → 쓴 자리. */
  const usedShoots = new Map<string, number>();
  const ranked = new Map<number, KtoScoredPhoto[]>();
  for (const slot of slots) {
    const hint = input.hints[slot.index];
    const pool: KtoPhoto[] = [];
    for (const keyword of hint.dishes) {
      pool.push(...(await searchOnce(keyword)));
      // 첫 키워드로 후보가 충분하면 둘째(일반 이름)는 부르지 않는다 - 호출을 아낀다.
      if (rankKtoPhotos(pool, hint).length >= KTO_DOWNLOADS_PER_SLOT) break;
    }
    const list = rankKtoPhotos(pool, hint);
    if (list.length > 0) ranked.set(slot.index, list);
    else failures.push(`[자리 ${slot.index}] 관광사진: "${hint.dishes.join(", ")}"에 맞는 사진이 없어 다음 단계로 넘깁니다.`);
  }
  failures.push(
    `ℹ️ 한국관광공사 관광사진 API ${calls}회 호출(원고당 상한 ${maxCalls})${capped ? " - 상한에 닿아 일부 키워드를 건너뛰었습니다" : ""}.`
  );

  // ---- 2. 후보 배정 → 3. 내려받기·판정·업로드 ----
  const assigned = assignKtoCandidates(ranked);
  const targets = slots.filter((slot) => assigned.has(slot.index));
  options.deduper?.planOrder(targets.map((slot) => slot.index));

  const processSlot = async (slot: WebImageSlot): Promise<WebImageRecord | null> => {
    const picks = assigned.get(slot.index) ?? [];
    const stem = `${String(slot.index).padStart(2, "0")}-${keywordSlug(`kto-${picks[0]?.matched ?? "photo"}`).slice(0, 40).replace(/-+$/, "") || "kto"}`;

    type Downloaded = {
      number: number;
      filePath: string;
      buffer: Buffer;
      contentType: string;
      extension: string;
      size: { width: number; height: number } | null;
      scored: KtoScoredPhoto;
    };
    const downloaded: Downloaded[] = [];
    const rejected: string[] = [];
    for (const scored of picks) {
      const url = scored.photo.imageUrl;
      let referer = "";
      try {
        referer = new URL(url).origin;
      } catch {
        rejected.push("주소 형식이 아님");
        continue;
      }
      const got = await fetchImage({ url, referer });
      if (!got.ok || !got.buffer) {
        rejected.push(`내려받기 실패(${got.error ?? "알 수 없음"})`);
        continue;
      }
      const extension = imageExtensionFor(got.contentType ?? "");
      if (!extension) {
        rejected.push(`이미지가 아님(${got.contentType || "content-type 없음"})`);
        continue;
      }
      const size = readSize(got.buffer);
      if (size && Math.max(size.width, size.height) < KTO_MIN_LONG_SIDE) {
        rejected.push(`너무 작음(${size.width}×${size.height})`);
        continue;
      }
      const number = downloaded.length + 1;
      const filePath = resolve(input.dir, `${stem}-kto${number}.${extension}`);
      await writeFile(filePath, got.buffer);
      downloaded.push({ number, filePath, buffer: got.buffer, contentType: got.contentType || `image/${extension}`, extension, size, scored });
    }
    if (downloaded.length === 0) {
      failures.push(`[자리 ${slot.index}] 관광사진 후보를 쓸 수 없어 다음 단계로 넘깁니다: ${rejected.join(", ") || "후보 없음"}`);
      return null;
    }
    candidateLog[slot.index] = downloaded.map((d) => ({
      number: d.number,
      url: d.scored.photo.imageUrl,
      sourcePage: KTO_DATASET_PAGE,
      width: d.size?.width ?? null,
      height: d.size?.height ?? null,
    }));

    // 판정 없이 고를 때: 메타 점수 + 해상도(긴 변 2000px까지 최대 +10).
    const byMeta = [...downloaded].sort(
      (a, b) =>
        b.scored.score + Math.min(2000, Math.max(b.size?.width ?? 0, b.size?.height ?? 0)) / 200 -
        (a.scored.score + Math.min(2000, Math.max(a.size?.width ?? 0, a.size?.height ?? 0)) / 200)
    );
    let chosen = byMeta[0];
    let rewrittenCaption = "";
    const openable = downloaded.filter((d) => d.extension !== "avif");
    if (verify && openable.length > 0) {
      const verdict = await chooseImage({
        candidates: openable.map((d) => ({
          number: d.number,
          filePath: d.filePath,
          alt: `${d.scored.photo.title} (한국관광공사 관광사진, 촬영지 ${d.scored.photo.location || "미상"})`,
          sourcePage: KTO_DATASET_PAGE,
        })),
        markerDescription: slot.description,
        context: slot.context,
        caution: [slot.caution, KTO_FIT_CAUTION].filter(Boolean).join(" "),
        keyword: input.keyword,
        captionLanguage: options.captionLanguage,
      }).catch((error: unknown) => ({ picked: null, reason: `판정 실패: ${error instanceof Error ? error.message : String(error)}` }) as ChooseImageResult);
      // 판정을 못 받았으면(호출 실패·결과 해석 실패 - defaultChooseImage는 이때 1순위를 돌려준다) 관광사진을 쓰지 않는다.
      // 웹 수집에서는 1순위라도 쓰는 게 낫지만, 관광사진은 내용이 맞는지 모르는 채로 넣을 이유가 없다(웹 검색이 뒤에 있다).
      const unjudged = /^(검증 건너뜀|검증 결과를 읽지 못해|판정 실패)/.test(verdict.reason ?? "");
      if (verdict.picked === null || unjudged) {
        for (const d of downloaded) await rm(d.filePath, { force: true });
        failures.push(
          unjudged
            ? `[자리 ${slot.index}] 관광사진 판정을 받지 못해 쓰지 않고 웹 검색으로 넘깁니다: ${verdict.reason}`
            : `[자리 ${slot.index}] 관광사진 후보 ${openable.length}장이 문단 내용과 맞지 않아 웹 검색으로 넘깁니다: ${verdict.reason}`
        );
        delete candidateLog[slot.index];
        return null;
      }
      chosen = openable.find((d) => d.number === verdict.picked) ?? chosen;
      if (verdict.caption) rewrittenCaption = verdict.caption;
    }

    // 한 원고 안에서 같은 컷·같은 촬영 묶음을 두 번 쓰지 않는다(images.md §8-8). **판정을 받았으면 판정자가 고른 한 장만** 본다 -
    // 그 사진이 중복이라고 판정 안 받은 다른 관광사진으로 바꿔 끼우면 "문단에 맞을 때만 쓴다"가 깨진다(2026-11-25). 웹 검색이 뒤에 있다.
    const judged = verify && openable.length > 0;
    const ordered = judged ? [chosen] : [chosen, ...byMeta.filter((d) => d !== chosen)];
    let accepted: Downloaded | null = null;
    for (const candidate of ordered) {
      // 중복 검사기는 자리 순서대로 차례를 준다(planOrder) - 촬영 묶음 확인을 그 **뒤에** 해야 앞 자리가 고른 묶음을 본다.
      if (options.deduper) {
        const check = await options.deduper.claim(`자리 ${slot.index}`, candidate.buffer, candidate.contentType, {
          index: slot.index,
          filePath: candidate.filePath,
        });
        if (check.duplicate) {
          failures.push(`[자리 ${slot.index}] ⚠️ 관광사진 ${candidate.number}번이 ${check.against}와 같은 컷이라 건너뜁니다.`);
          continue;
        }
      }
      const shoot = ktoShootKey(candidate.scored.photo);
      const shootOwner = usedShoots.get(shoot);
      if (shootOwner !== undefined && shootOwner !== slot.index) {
        failures.push(`[자리 ${slot.index}] ⚠️ 관광사진 ${candidate.number}번이 자리 ${shootOwner}와 같은 촬영 묶음이라 건너뜁니다.`);
        continue;
      }
      accepted = candidate;
      usedShoots.set(shoot, slot.index);
      break;
    }
    if (!accepted) {
      for (const d of downloaded) await rm(d.filePath, { force: true });
      delete candidateLog[slot.index];
      failures.push(`[자리 ${slot.index}] 관광사진이 다른 자리와 겹쳐(같은 컷·같은 촬영 묶음) 웹 검색으로 넘깁니다.`);
      return null;
    }
    if (accepted !== chosen) rewrittenCaption = ""; // 판정자가 본 사진이 아니다 - 캡션은 자리 설명으로.
    chosen = accepted;
    for (const d of downloaded) if (d !== chosen) await rm(d.filePath, { force: true });
    for (const logged of candidateLog[slot.index] ?? []) logged.picked = logged.number === chosen.number;

    let fileName = `${stem}.${chosen.extension}`;
    const filePath = resolve(input.dir, fileName);
    await writeFile(filePath, chosen.buffer);
    if (filePath !== chosen.filePath) await rm(chosen.filePath, { force: true });

    let storageUrl: string | null = null;
    let storedSize: { width: number; height: number } | null = null;
    if (options.upload) {
      const uploaded = await options.upload({ index: slot.index, fileName, buffer: chosen.buffer, mimeType: chosen.contentType });
      if (!uploaded.ok) {
        await rm(filePath, { force: true });
        failures.push(`[자리 ${slot.index}] 관광사진 업로드 실패: ${uploaded.error}`);
        return null;
      }
      storageUrl = uploaded.url;
      if (uploaded.width && uploaded.height) storedSize = { width: uploaded.width, height: uploaded.height };
      if (uploaded.extension && uploaded.extension !== chosen.extension) fileName = `${stem}.${uploaded.extension}`;
    }

    const photo = chosen.scored.photo;
    const intro = rewrittenCaption || stripAcquisitionSuffix(slot.description);
    failures.push(
      `[자리 ${slot.index}] ℹ️ 한국관광공사 관광사진으로 채웠습니다: "${photo.title}"(${photo.location || "촬영지 미상"}, ` +
        `${chosen.size ? `${chosen.size.width}×${chosen.size.height}, ` : ""}후보 ${downloaded.length}장 중 ${chosen.number}번 · ${chosen.scored.reasons.join("·")}).`
    );
    return {
      index: slot.index,
      fileName,
      imageUrl: photo.imageUrl,
      sourcePage: KTO_DATASET_PAGE,
      alt: slot.description,
      caption: captionFor(intro, photo.photographer, options.captionLanguage),
      license: `${KTO_PHOTO_LICENSE}${photo.contentId ? ` · galContentId ${photo.contentId}` : ""}`,
      storageUrl,
      storedSize,
    };
  };

  const outcomes = await mapWithConcurrency(targets, SLOT_CONCURRENCY, async (slot) => {
    try {
      return await processSlot(slot);
    } finally {
      options.deduper?.releaseTurn(slot.index);
    }
  });
  const found = outcomes.filter((o): o is WebImageRecord => o !== null);
  return { found, failures, candidates: candidateLog, calls };
}
