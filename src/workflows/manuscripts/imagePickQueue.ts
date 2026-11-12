// 뷰어 "후보 이미지 클릭 교체" 요청 큐의 읽기·쓰기(2026-11-12).
//
// 왜 큐인가: 교체 한 건이 1~2분 걸리는데 사용자는 그 사이 다른 자리도 누른다. PR #80이 jobId별
// concurrency로 2건은 직렬화했지만, GitHub은 그룹당 **대기분을 하나만** 들고 있어서 한 건이 도는 중에
// 두 건이 더 들어오면 가운데 것이 조용히 취소된다(대기 중 취소는 스텝이 돌지 않아 알림도 못 보낸다).
// 요청을 DB에 보관하면 대기분이 취소돼도 **요청 행은 남고**, 뒤에 실제로 도는 run이 큐를 통째로 비운다.
//
// `metadata` JSON이 아니라 **별도 테이블**인 이유: metadata에 쌓으면 `ArticleJobRepository.mergeMetadata`의
// 버전 검사 없는 read-modify-write와 경합해 또 같은 lost update가 난다 - 그게 2026-11-12 사고의 원인이었다.
//
// **마이그레이션 적용 전에도 깨지지 않는다**: 테이블이 없으면 PostgREST가 42P01/PGRST205로 돌려주는데,
// 그걸 `ImagePickQueueUnavailableError`로 바꿔 호출부(drainImagePicks)가 옛 경로(단건 처리)로 떨어진다.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, ImagePickRequestRow } from "../../types/database.js";

/** 큐 한 건(코드가 쓰는 모양). DB 컬럼 이름(snake_case)과의 변환은 이 파일 안에서만 한다. */
export type ImagePickQueueItem = {
  id: string;
  jobId: string;
  slotIndex: number;
  candidateNumber: number;
  fromUrl: string;
  requestedAt: string;
};

/**
 * 테이블이 아직 없다(migration 미적용). 호출부는 이걸 받으면 **큐를 쓰지 않고** 디스패치 payload 한 건만
 * 처리한다 - 적용 전에 병합해도 기존 동작이 그대로 돌게 하는 장치다.
 */
export class ImagePickQueueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePickQueueUnavailableError";
  }
}

/** PostgREST가 "그런 테이블 없다"고 답했는지. 42P01 = undefined_table, PGRST205 = 스키마 캐시에 없음. */
export function isQueueTableMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  return /image_pick_requests/.test(message) && /(does not exist|could not find|schema cache)/i.test(message);
}

/** 드레인이 쓰는 큐 인터페이스. 테스트는 가짜를 준다(원격 DB를 건드리지 않는다). */
export type ImagePickQueue = {
  /** 이 job의 pending을 requested_at 오름차순으로. 테이블이 없으면 ImagePickQueueUnavailableError. */
  listPending: (jobId: string) => Promise<ImagePickQueueItem[]>;
  /** 처리 결과를 적는다. skipped = 같은 슬롯에 더 나중 요청이 있어 접힌 건. */
  markProcessed: (id: string, status: "done" | "failed" | "skipped", error?: string) => Promise<void>;
};

function toItem(row: ImagePickRequestRow): ImagePickQueueItem {
  return {
    id: row.id,
    jobId: row.job_id,
    slotIndex: row.slot_index,
    candidateNumber: row.candidate_number,
    fromUrl: row.from_url ?? "",
    requestedAt: row.requested_at,
  };
}

/** 한 run이 한 번에 읽는 상한. 이상이 쌓이면 다음 요청이 이어서 비운다(러너 시한 안에 끝나야 한다). */
export const QUEUE_READ_LIMIT = 50;

export function supabaseImagePickQueue(client: SupabaseClient<Database>): ImagePickQueue {
  return {
    async listPending(jobId) {
      const { data, error } = await client
        .from("image_pick_requests")
        .select("*")
        .eq("job_id", jobId)
        .eq("status", "pending")
        .order("requested_at", { ascending: true })
        .limit(QUEUE_READ_LIMIT);
      if (error) {
        if (isQueueTableMissing(error)) {
          throw new ImagePickQueueUnavailableError(`image_pick_requests 테이블이 없습니다(migration 미적용): ${error.message}`);
        }
        throw error;
      }
      return (data ?? []).map((row) => toItem(row as ImagePickRequestRow));
    },

    async markProcessed(id, status, error) {
      const { error: updateError } = await client
        .from("image_pick_requests")
        .update({ status, error: error ?? null, processed_at: new Date().toISOString() })
        .eq("id", id);
      if (updateError) {
        if (isQueueTableMissing(updateError)) {
          throw new ImagePickQueueUnavailableError(`image_pick_requests 테이블이 없습니다: ${updateError.message}`);
        }
        throw updateError;
      }
    },
  };
}
