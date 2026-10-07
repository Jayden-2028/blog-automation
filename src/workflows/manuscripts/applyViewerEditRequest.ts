// "📤 수정본 반영" 요청 1건을 DB에 적용하고 원고 페이지를 다시 배포한다(2026-10-03 사용자 요청).
//
// 흐름: 뷰어 버튼 -> Pages Function(functions/api/manuscript-edit.ts, Access 토큰 검증) ->
// repository_dispatch(manuscript_edit) -> .github/workflows/manuscript-edit.yml -> 이 파일.
//
// 쓰는 곳(순서가 의미 있다):
//   1) articles.content            - 발행 버튼이 읽는 본문. **먼저 쓴다**: 뒤 단계가 실패해도 발행은
//                                    고친 글로 나간다. 반대 순서면 화면은 고쳐졌는데 발행은 옛 글인
//                                    원래 사고가 조용히 재현된다.
//   2) job.metadata.images / viewerEdit - 발행 캡션과 반영 기록.
//   3) manuscript_manifest_topics  - 뷰어가 읽는 행(이 job 한 행만 upsert).
//   4) 페이지 다시 그려 배포        - 나머지 원고는 DB에 있는 그대로 다시 그린다.
// 계산은 applyViewerEdits.ts(순수 함수)가 한다. 여기는 읽고 쓰기만 한다.

import { applyViewerEdits, normalizeEditText, VIEWER_EDIT_KEY_RE } from "./applyViewerEdits.js";
import type { ViewerEdits } from "./applyViewerEdits.js";
import { VIEWER_EDIT_PENDING_KEY } from "./viewerEditGuard.js";
import { pickFinalArticle } from "./pickFinalArticle.js";
// manuscriptManifest.ts는 **타입만** 가져온다. 값을 import하면 Supabase 클라이언트가 모듈 로드 시점에
// 초기화돼 자격증명 없는 테스트가 import 단계에서 죽는다. 그래서 거기 있는 작은 순수 함수 둘
// (readJobManuscriptImages, upsertTopicEntry)과 같은 일을 아래에서 직접 한다.
import type { ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry, ViewerEditRecord } from "./manuscriptManifest.js";
import type { ArticleJobRow, ArticleRow } from "../../types/database.js";

export type ViewerEditRequest = { jobId: string; edits: ViewerEdits };

/** manuscriptManifest.readJobManuscriptImages와 같다. */
function jobImages(job: ArticleJobRow): ManuscriptImage[] {
  const raw = job.metadata?.images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((image): image is ManuscriptImage => !!image && typeof image === "object" && "index" in image);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EDITS = 300;
const MAX_VALUE_LENGTH = 20000;

/** client_payload를 검증한다. Function이 이미 걸렀어도 여기서 다시 본다 - 이쪽이 DB에 쓴다. */
export function parseViewerEditRequest(raw: unknown): ViewerEditRequest {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("요청 형식이 아닙니다");
  const { jobId, edits } = value as { jobId?: unknown; edits?: unknown };
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) throw new Error("jobId가 UUID가 아닙니다");
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) throw new Error("edits가 객체가 아닙니다");
  const entries = Object.entries(edits as Record<string, unknown>);
  if (entries.length === 0) throw new Error("고친 항목이 없습니다");
  if (entries.length > MAX_EDITS) throw new Error(`고친 항목이 너무 많습니다(${entries.length}개)`);
  const clean: ViewerEdits = {};
  for (const [key, edit] of entries) {
    if (!VIEWER_EDIT_KEY_RE.test(key)) throw new Error(`알 수 없는 키: ${key}`);
    const { from, to } = (edit ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string") throw new Error(`${key}: from/to가 문자열이 아닙니다`);
    if (from.length > MAX_VALUE_LENGTH || to.length > MAX_VALUE_LENGTH) throw new Error(`${key}: 값이 너무 깁니다`);
    clean[key] = { from, to };
  }
  return { jobId, edits: clean };
}

export type ApplyViewerEditDeps = {
  loadJob: (jobId: string) => Promise<ArticleJobRow | null>;
  loadArticles: (jobId: string) => Promise<ArticleRow[]>;
  updateArticleContent: (articleId: number, content: string) => Promise<void>;
  /** 제목 수정(2026-10-07). 본문과 **같은 final article 행**에 쓴다 - 발행 3채널이 읽는 곳이다. */
  updateArticleTitle?: (articleId: number, title: string) => Promise<void>;
  mergeJobMetadata: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
  loadManifest: () => Promise<ManuscriptManifest>;
  saveTopic: (topic: ManuscriptTopicEntry) => Promise<void>;
  publishPage: (manifest: ManuscriptManifest) => Promise<void>;
  now?: () => Date;
};

export type ApplyViewerEditOutcome =
  | { status: "applied" | "nothing"; record: ViewerEditRecord; articleChanged: boolean; imagesChanged: boolean; titleChanged: boolean }
  | { status: "failed"; reason: string };

export async function applyViewerEditRequest(
  request: ViewerEditRequest,
  deps: ApplyViewerEditDeps
): Promise<ApplyViewerEditOutcome> {
  const now = deps.now ?? (() => new Date());

  const job = await deps.loadJob(request.jobId);
  if (!job) return { status: "failed", reason: `job을 찾을 수 없습니다: ${request.jobId}` };

  // 접수 표식(2026-10-07, VIEWER-REFINE §2-c). 반영이 끝나 viewerEdit.appliedAt이 이 시각 뒤로 남을 때까지 발행 큐 폴러와
  // 텔레그램 발행 콜백이 이 원고를 집지 않는다 - 반영 직전의 옛 본문이 나가는 경합을 닫는다. 아래에서 어떤 이유로 일찍 끝나도
  // (실패 반환) 표식이 남으면 10분 뒤 stale로 풀린다(경고 알림 후 진행).
  await deps.mergeJobMetadata(job.id, { [VIEWER_EDIT_PENDING_KEY]: now().toISOString() });

  const manifest = await deps.loadManifest();
  const topic = manifest.topics.find((t) => t.jobId === request.jobId);
  // 아무것도 쓰지 못하고 끝나는 실패는 표식을 바로 푼다(그대로 두면 10분 동안 발행이 막힌다).
  const release = () => deps.mergeJobMetadata(job.id, { [VIEWER_EDIT_PENDING_KEY]: null }).catch(() => {});
  if (!topic) {
    await release();
    return { status: "failed", reason: "원고 페이지에 없는 job입니다(원고 준비 전)" };
  }

  const picked = pickFinalArticle(await deps.loadArticles(request.jobId));
  if (!picked) {
    await release();
    return { status: "failed", reason: "발행할 원고(article)가 없습니다" };
  }

  const m = topic.manuscript;
  const result = applyViewerEdits({
    manifestBody: m.body,
    imagePrompts: m.imagePrompts,
    articleContent: picked.final.content ?? "",
    // 캡션의 "수정 전" 대조는 뷰어가 본 값(manifest)으로 한다.
    images: m.images,
    manifestTitle: m.title,
    edits: request.edits,
  });

  const record: ViewerEditRecord = {
    appliedAt: now().toISOString(),
    applied: result.applied,
    skipped: result.skipped,
  };

  // 1) 발행 본문
  if (result.articleChanged) await deps.updateArticleContent(picked.final.id, result.articleContent);
  if (result.titleChanged) {
    if (!deps.updateArticleTitle) throw new Error("updateArticleTitle 의존성이 없습니다");
    await deps.updateArticleTitle(picked.final.id, result.title);
  }

  // 2) 발행 캡션 + 기록. 캡션은 job.metadata.images에도 같은 자리 번호로 옮긴다(발행이 읽는 쪽).
  const patch: Record<string, unknown> = { viewerEdit: record };
  if (result.imagesChanged) {
    patch.images = jobImages(job).map((image) => {
      const key = `cap:${image.index}`;
      return result.applied.includes(key) ? { ...image, description: normalizeEditText(request.edits[key].to) } : image;
    });
  }
  await deps.mergeJobMetadata(job.id, patch);

  // 3) 뷰어 행
  const updated: ManuscriptTopicEntry = {
    ...topic,
    manuscript: { ...m, title: result.title, body: result.manifestBody, images: result.images, viewerEdit: record },
  };
  await deps.saveTopic(updated);

  // 4) 페이지. 건너뛴 것만 있어도 다시 그린다 - 왜 안 들어갔는지가 화면에 떠야 한다.
  await deps.publishPage({ topics: [...manifest.topics.filter((t) => t.jobId !== updated.jobId), updated] });

  return {
    status: result.applied.length > 0 ? "applied" : "nothing",
    record,
    articleChanged: result.articleChanged,
    imagesChanged: result.imagesChanged,
    titleChanged: result.titleChanged,
  };
}
