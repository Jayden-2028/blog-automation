// 뷰어 "후보 이미지 클릭 교체" 1건을 적용한다(2026-10-07 VIEWER-REFINE §3).
//
// 흐름: 뷰어 후보 클릭 -> Pages Function(functions/api/image-pick.ts, Access 토큰 검증) ->
// repository_dispatch(image_pick) -> .github/workflows/image-pick.yml -> applyImagePickCli -> 이 파일.
//
// 텔레그램 "🖼 이미지 수정"(N번 후보M)은 원고 준비 전체를 다시 돌린다(무겁다). 이쪽은 **그 슬롯만** 바꾼다:
// 후보 URL 내려받기 -> 검사 -> 긴 세로 자르기 -> Storage 업로드(같은 경로 upsert) -> metadata.images[슬롯]
// 갱신 -> imageCandidates.picked 이동 -> manifest -> 페이지 배포. 원고 준비·완료 알림은 다시 돌리지 않는다.
//
// 신뢰 경계: 클라이언트가 보낸 URL은 쓰지 않는다. 후보 URL은 **DB의 imageCandidates에서 번호로 찾는다**.
// fromUrl(뷰어가 본 현재 채택 이미지)은 "그 사이 다른 교체가 있었나"를 보는 경합 검사에만 쓴다.
//
// 계산(요청 검사·후보 해석·갱신 패치)은 순수 함수고, 입출력은 deps로 주입한다(테스트가 가짜를 준다).
// manuscriptManifest.ts는 **타입만** 가져온다(값을 import하면 Supabase 클라이언트가 로드 시점에 초기화돼
// 자격증명 없는 테스트가 죽는다 - applyViewerEditRequest.ts와 같은 이유).

import { IMAGE_PICK_PENDING_KEY, IMAGE_PICK_RECORD_KEY } from "./viewerEditGuard.js";
import type { ImageCandidateRecord, ImagePickRecord, ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FROM_URL_LENGTH = 2000;
/** 내려받은 파일 상한. 13MB짜리가 실측으로 있었다(uploadArticleImage 주석) - 그보다 넉넉히 둔다. */
export const MAX_PICK_BYTES = 30 * 1024 * 1024;
/** 이보다 좁으면 본문에 쓸 수 없다(collectWebImages의 HARD_MIN_WIDTH와 같다). */
export const MIN_PICK_WIDTH = 400;
/** 1:2보다 길면 자른다(cropTallImage의 CROP_TRIGGER_RATIO와 같다). */
export const PICK_CROP_TRIGGER_RATIO = 0.5;

export type ImagePickRequest = {
  jobId: string;
  /** 슬롯(자리) 번호. 본문 [IMAGE] 마커 순서(1부터). */
  index: number;
  candidateNumber: number;
  /** 뷰어가 본 현재 채택 이미지 URL. 없으면(빈 자리) 빈 문자열. */
  fromUrl: string;
};

/** client_payload를 검증한다. Function이 이미 걸렀어도 여기서 다시 본다 - 이쪽이 DB에 쓴다. */
export function parseImagePickRequest(raw: unknown): ImagePickRequest {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("요청 형식이 아닙니다");
  const { jobId, index, candidateNumber, fromUrl } = value as Record<string, unknown>;
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) throw new Error("jobId가 UUID가 아닙니다");
  if (!Number.isInteger(index) || (index as number) < 1 || (index as number) > 999) throw new Error("index가 올바르지 않습니다");
  if (!Number.isInteger(candidateNumber) || (candidateNumber as number) < 1 || (candidateNumber as number) > 99) {
    throw new Error("candidateNumber가 올바르지 않습니다");
  }
  if (fromUrl !== undefined && fromUrl !== null && typeof fromUrl !== "string") throw new Error("fromUrl이 문자열이 아닙니다");
  const from = typeof fromUrl === "string" ? fromUrl : "";
  if (from.length > MAX_FROM_URL_LENGTH) throw new Error("fromUrl이 너무 깁니다");
  return { jobId, index: index as number, candidateNumber: candidateNumber as number, fromUrl: from };
}

/** job.metadata.imageCandidates를 읽는다(images/applyImageEditRequest.readImageCandidates와 같은 모양, 값 import 없이). */
export function readCandidates(metadata: Record<string, unknown> | null | undefined): Record<string, ImageCandidateRecord[]> {
  const raw = metadata?.imageCandidates;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ImageCandidateRecord[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const list = value.filter(
      (c): c is ImageCandidateRecord =>
        !!c && typeof c === "object" && typeof (c as ImageCandidateRecord).url === "string" && Number.isInteger((c as ImageCandidateRecord).number)
    );
    if (list.length > 0) out[key] = list;
  }
  return out;
}

function jobImages(job: ArticleJobRow): ManuscriptImage[] {
  const raw = job.metadata?.images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((image): image is ManuscriptImage => !!image && typeof image === "object" && "index" in image);
}

export type ResolvedPick =
  | { ok: true; candidate: ImageCandidateRecord; current: ManuscriptImage | null }
  | { ok: false; reason: string };

/**
 * 후보를 번호로 찾고 경합을 검사한다. 순수 함수.
 * - 후보가 기록에 없으면 중단.
 * - 뷰어가 본 채택본(fromUrl)이 지금 DB의 채택본과 다르면 중단 - 그 사이 다른 교체가 있었다는 뜻이라
 *   사용자가 화면에서 본 것과 다른 상태에 덮어쓰게 된다.
 */
export function resolvePick(
  request: ImagePickRequest,
  candidates: Record<string, ImageCandidateRecord[]>,
  images: readonly ManuscriptImage[]
): ResolvedPick {
  const candidate = (candidates[String(request.index)] ?? []).find((c) => c.number === request.candidateNumber);
  if (!candidate) return { ok: false, reason: `${request.index}번 자리에 후보 ${request.candidateNumber}번이 없습니다(원고가 다시 준비됐을 수 있습니다 - 새로고침 후 다시 고르세요)` };
  if (!/^https?:\/\//i.test(candidate.url)) return { ok: false, reason: "후보 주소가 http(s)가 아닙니다" };

  const current = images.find((image) => image.index === request.index) ?? null;
  const currentUrl = current?.url ?? "";
  if (request.fromUrl !== currentUrl) {
    return { ok: false, reason: `${request.index}번 이미지가 그 사이 바뀌었습니다 - 새로고침해서 현재 상태를 확인한 뒤 다시 고르세요` };
  }
  return { ok: true, candidate, current };
}

/** 내려받은 파일을 검사한다. 순수 함수(크기 읽기는 주입). */
export function validatePicked(input: {
  byteLength: number;
  contentType: string;
  size: { width: number; height: number } | null;
}): { ok: true } | { ok: false; reason: string } {
  if (input.byteLength === 0) return { ok: false, reason: "빈 파일입니다" };
  if (input.byteLength > MAX_PICK_BYTES) return { ok: false, reason: `파일이 너무 큽니다(${Math.round(input.byteLength / 1024 / 1024)}MB)` };
  if (!/^image\/(jpe?g|png|webp|avif)/i.test(input.contentType)) {
    return { ok: false, reason: `이미지가 아닙니다(${input.contentType || "형식 없음"})` };
  }
  if (input.size && input.size.width < MIN_PICK_WIDTH) {
    return { ok: false, reason: `너무 작습니다(너비 ${input.size.width}px, 최소 ${MIN_PICK_WIDTH}px)` };
  }
  return { ok: true };
}

/** imageCandidates의 picked를 새 번호로 옮긴다. 다른 자리는 그대로. 순수 함수. */
export function movePicked(
  candidates: Record<string, ImageCandidateRecord[]>,
  index: number,
  candidateNumber: number
): Record<string, ImageCandidateRecord[]> {
  const key = String(index);
  const list = candidates[key];
  if (!list) return candidates;
  return { ...candidates, [key]: list.map((c) => ({ ...c, picked: c.number === candidateNumber })) };
}

export type FetchedImage = { ok: true; buffer: Buffer; contentType: string } | { ok: false; error: string };

export type ApplyImagePickDeps = {
  loadJob: (jobId: string) => Promise<ArticleJobRow | null>;
  loadManifest: () => Promise<ManuscriptManifest>;
  /** 외부 이미지 내려받기. referer는 후보의 출처 페이지. */
  fetchImage: (input: { url: string; referer: string }) => Promise<{ ok: boolean; buffer?: Buffer; contentType?: string; error?: string }>;
  readSize: (buffer: Buffer) => { width: number; height: number } | null;
  /** 1:2보다 긴 세로 이미지를 주요 부분만 잘라낸다. 실패하면 원본을 쓴다. */
  cropTall: (input: {
    buffer: Buffer;
    mimeType: string;
    width: number;
    height: number;
    alt: string;
    context: string;
  }) => Promise<{ ok: true; buffer: Buffer; mimeType: string; width: number; height: number } | { ok: false; error: string }>;
  upload: (input: { jobId: string; index: number; buffer: Buffer; mimeType: string }) => Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  mergeJobMetadata: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
  saveTopic: (topic: ManuscriptTopicEntry) => Promise<void>;
  publishPage: (manifest: ManuscriptManifest) => Promise<void>;
  /** 이 원고가 이미 발행됐는지(publications 또는 발행 큐 done). */
  isPublished: (job: ArticleJobRow) => Promise<boolean>;
  /** 실패·경고를 텔레그램으로 알린다. 알림 실패가 처리를 막지 않는다(호출부가 삼킨다). */
  notify: (job: ArticleJobRow, text: string) => Promise<void>;
  now?: () => Date;
};

export type ApplyImagePickOutcome =
  | { status: "applied"; record: ImagePickRecord }
  | { status: "failed"; reason: string; record: ImagePickRecord | null };

export async function applyImagePick(request: ImagePickRequest, deps: ApplyImagePickDeps): Promise<ApplyImagePickOutcome> {
  const now = deps.now ?? (() => new Date());

  const job = await deps.loadJob(request.jobId);
  if (!job) return { status: "failed", reason: `job을 찾을 수 없습니다: ${request.jobId}`, record: null };

  // 접수 표식을 먼저 남긴다 - 발행 폴러·텔레그램 발행 콜백이 이 사이에 옛 이미지를 집어 가지 않게(§3-c).
  await deps.mergeJobMetadata(job.id, { [IMAGE_PICK_PENDING_KEY]: now().toISOString() });

  /** 실패를 기록하고(= pending 해제) manifest·페이지에 사유를 남긴 뒤 알린다. */
  const fail = async (reason: string, topic: ManuscriptTopicEntry | null, manifest: ManuscriptManifest | null): Promise<ApplyImagePickOutcome> => {
    const record: ImagePickRecord = {
      at: now().toISOString(),
      index: request.index,
      candidateNumber: request.candidateNumber,
      status: "failed",
      error: reason,
    };
    await deps.mergeJobMetadata(job.id, { [IMAGE_PICK_RECORD_KEY]: record });
    if (topic && manifest) {
      const updated: ManuscriptTopicEntry = { ...topic, manuscript: { ...topic.manuscript, imagePick: record } };
      try {
        await deps.saveTopic(updated);
        await deps.publishPage({ topics: [...manifest.topics.filter((t) => t.jobId !== updated.jobId), updated] });
      } catch (error) {
        console.warn(`⚠️ 실패 기록의 페이지 반영 실패(무시): ${error instanceof Error ? error.message : error}`);
      }
    }
    try {
      await deps.notify(
        job,
        `⚠️ 이미지 교체 실패 — "${job.keyword}" ${request.index}번\n${reason}\n다른 후보를 고르거나, 후보가 다 마음에 안 들면 텔레그램 "🖼 이미지 수정"으로 다시 수집하세요.`
      );
    } catch (error) {
      console.warn(`⚠️ 텔레그램 알림 실패(무시): ${error instanceof Error ? error.message : error}`);
    }
    return { status: "failed", reason, record };
  };

  const manifest = await deps.loadManifest();
  const topic = manifest.topics.find((t) => t.jobId === request.jobId) ?? null;
  if (!topic) return fail("원고 페이지에 없는 job입니다(원고 준비 전)", null, null);

  // 후보·채택본은 DB(job.metadata)가 기준이다 - manifest는 뷰어용 사본이다.
  const candidates = readCandidates(job.metadata);
  const images = jobImages(job);
  const resolved = resolvePick(request, candidates, images);
  if (!resolved.ok) return fail(resolved.reason, topic, manifest);
  const { candidate, current } = resolved;

  const downloaded = await deps.fetchImage({ url: candidate.url, referer: candidate.sourcePage });
  if (!downloaded.ok || !downloaded.buffer) {
    return fail(`후보 이미지를 내려받지 못했습니다: ${downloaded.error ?? "알 수 없는 오류"} (원본 사이트가 막았거나 사라졌을 수 있습니다)`, topic, manifest);
  }

  let buffer = downloaded.buffer;
  let mimeType = (downloaded.contentType ?? "").split(";")[0].trim() || "image/jpeg";
  let size = deps.readSize(buffer);
  const check = validatePicked({ byteLength: buffer.length, contentType: mimeType, size });
  if (!check.ok) return fail(`후보 ${request.candidateNumber}번을 쓸 수 없습니다: ${check.reason}`, topic, manifest);

  // 긴 세로 이미지는 왜곡 없이 주요 부분만 자른다. 자르지 못하면 원본을 쓴다(수집 경로와 같은 정책).
  if (size && size.width / size.height < PICK_CROP_TRIGGER_RATIO) {
    const description = current?.description ?? "";
    const cropped = await deps.cropTall({ buffer, mimeType, width: size.width, height: size.height, alt: description, context: topic.keyword });
    if (cropped.ok) {
      buffer = cropped.buffer;
      mimeType = cropped.mimeType;
      size = { width: cropped.width, height: cropped.height };
    } else {
      console.warn(`⚠️ 세로가 너무 길지만 자르지 못해 원본을 씁니다: ${cropped.error}`);
    }
  }

  const uploaded = await deps.upload({ jobId: job.id, index: request.index, buffer, mimeType });
  if (!uploaded.ok) return fail(`업로드 실패: ${uploaded.error}`, topic, manifest);

  // 슬롯 갱신. 캡션(description)·prompt는 **유지**한다 - 사용자가 뷰어 캡션 수정으로 고친다(§3-b-4).
  const nextImage: ManuscriptImage = {
    ...(current ?? { index: request.index, description: "", prompt: null, fileName: "" }),
    index: request.index,
    url: uploaded.url,
    provider: "web",
    sourcePage: candidate.sourcePage || null,
    license: current?.license && current.provider === "web" && current.sourcePage === candidate.sourcePage ? current.license : "출처 확인 필요",
    fileName: current?.fileName || `${String(request.index).padStart(2, "0")}-image.${mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg"}`,
    error: null,
  };
  const nextImages = current ? images.map((image) => (image.index === request.index ? nextImage : image)) : [...images, nextImage].sort((a, b) => a.index - b.index);
  const nextCandidates = movePicked(candidates, request.index, request.candidateNumber);

  const alreadyPublished = await deps.isPublished(job);
  const record: ImagePickRecord = {
    at: now().toISOString(),
    index: request.index,
    candidateNumber: request.candidateNumber,
    status: "done",
    ...(alreadyPublished ? { alreadyPublished: true } : {}),
  };

  // DB(발행이 읽는 쪽)를 먼저, 뷰어 사본은 그 다음 - applyViewerEditRequest와 같은 순서 원칙.
  await deps.mergeJobMetadata(job.id, { images: nextImages, imageCandidates: nextCandidates, [IMAGE_PICK_RECORD_KEY]: record });

  const updated: ManuscriptTopicEntry = {
    ...topic,
    manuscript: { ...topic.manuscript, images: nextImages, imageCandidates: nextCandidates, imagePick: record },
  };
  await deps.saveTopic(updated);
  await deps.publishPage({ topics: [...manifest.topics.filter((t) => t.jobId !== updated.jobId), updated] });

  if (alreadyPublished) {
    try {
      await deps.notify(job, `ℹ️ "${job.keyword}" ${request.index}번 이미지를 바꿨습니다. 이미 발행된 글에는 반영되지 않습니다(원고·뷰어만 바뀜).`);
    } catch (error) {
      console.warn(`⚠️ 텔레그램 알림 실패(무시): ${error instanceof Error ? error.message : error}`);
    }
  }
  return { status: "applied", record };
}
