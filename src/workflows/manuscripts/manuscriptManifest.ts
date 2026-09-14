// 채널별 원고 열람 페이지(manuscripts/index.html)가 읽는 인덱스. 날짜 -> 주제(job) -> 채널 3개
// 구조를 그대로 담아, renderManuscriptPage가 이 파일 하나만 보고 트리를 그릴 수 있게 한다.
//
// job 1건 = topic 1건(jobId로 upsert). 재실행해도 같은 topic 슬롯을 덮어쓴다(중복 생성 방지).
//
// 2026-09-15: 로컬 파일(manuscripts/manifest.json) 대신 Supabase manuscript_manifest_topics
// 테이블에 저장한다. GitHub Actions(job-publish-prepare.yml)는 매번 새로 체크아웃되는 일회용
// 컴퓨터라 로컬 파일이 실행마다 없는 상태로 시작했고, 그 결과 새로 승인된 job만 담긴 "거의 빈"
// 목록으로 페이지를 통째로 다시 배포해 이미 준비돼 있던 다른 원고들이 사라지는 사고가 실제로
// 발생했다(4건, docs/ai-handoff/CURRENT_STATE.md 참고). job_id로 upsert하는 행 단위 저장이라
// 서로 다른 실행 환경(로컬/GitHub Actions)이 동시에 처리해도 서로의 행을 지우지 않는다 - 이 파일이
// 내보내는 함수 시그니처(loadManifest/saveManifest/upsertTopicEntry)는 그대로라 호출부(
// buildManuscriptPageCli.ts/prepareApprovedManuscripts.ts)는 변경이 필요 없다.
//
// 스키마: supabase/migrations/20260915013000_manuscript_manifest_topics.sql.

import { supabase } from "../../services/supabase/client.js";
import type { ManuscriptManifestTopicRow } from "../../types/database.js";
import type { ManuscriptChannel } from "../../config/pipelinePaths.js";

export type ManuscriptChannelEntry = {
  channel: ManuscriptChannel;
  title: string;
  searchDescription: string | null;
  slug: string | null;
  tags: string[];
  body: string;
  /**
   * body에 등장하는 [IMAGE: 설명] 마커와 같은 순서로 짝을 맞추는 이미지 제작 프롬프트
   * (job.metadata.imagePrompts, parseDraftFile.ts가 본문에서 빼내 둔 것). parseManuscriptBlocks가
   * 렌더링 시 이 배열과 본문의 마커 개수를 대조한다 - 개수가 안 맞으면 프롬프트 없이 보여준다.
   */
  imagePrompts: string[];
  /** PIPELINE_ROOT 기준 상대 경로(표시용). 본문 자체는 body에 인라인으로 들어 있다. */
  filePath: string;
};

export type ManuscriptTopicEntry = {
  jobId: string;
  keyword: string;
  category: string | null;
  /** Asia/Seoul 기준 YYYY-MM-DD. */
  date: string;
  readyAt: string;
  channels: ManuscriptChannelEntry[];
};

export type ManuscriptManifest = {
  topics: ManuscriptTopicEntry[];
};

const EMPTY_MANIFEST: ManuscriptManifest = { topics: [] };

function rowToTopic(row: ManuscriptManifestTopicRow): ManuscriptTopicEntry {
  return {
    jobId: row.job_id,
    keyword: row.keyword,
    category: row.category,
    date: row.date,
    readyAt: row.ready_at,
    channels: (row.channels as ManuscriptChannelEntry[] | null) ?? [],
  };
}

export async function loadManifest(): Promise<ManuscriptManifest> {
  const { data, error } = await supabase
    .from("manuscript_manifest_topics")
    .select("*")
    .order("date", { ascending: false })
    .order("ready_at", { ascending: false });
  if (error) throw error;
  if (!data) return { ...EMPTY_MANIFEST };
  return { topics: data.map(rowToTopic) };
}

/**
 * manifest.topics 전부를 job_id로 upsert한다(삭제는 하지 않는다). 호출자가 loadManifest()로
 * 읽은 것을 그대로 다시 저장하는 패턴이 흔한데, 이때 다른 실행이 그 사이 새로 추가한 행이 있어도
 * 이 함수는 그 행을 모른 채 자기가 아는 행만 upsert하므로 지우지 않는다 - 전체 겹어쓰기(overwrite)
 * 방식이었다면 재현됐을 유실을 원천적으로 막는다.
 */
export async function saveManifest(manifest: ManuscriptManifest): Promise<void> {
  if (manifest.topics.length === 0) return;
  const now = new Date().toISOString();
  const rows = manifest.topics.map((topic) => ({
    job_id: topic.jobId,
    keyword: topic.keyword,
    category: topic.category,
    date: topic.date,
    ready_at: topic.readyAt,
    channels: topic.channels,
    updated_at: now,
  }));
  const { error } = await supabase.from("manuscript_manifest_topics").upsert(rows, { onConflict: "job_id" });
  if (error) throw error;
}

/** 같은 jobId의 기존 topic을 새 entry로 교체한다(없으면 추가). 순수 함수 - DB 접근 없음. */
export function upsertTopicEntry(manifest: ManuscriptManifest, entry: ManuscriptTopicEntry): ManuscriptManifest {
  return { topics: [...manifest.topics.filter((t) => t.jobId !== entry.jobId), entry] };
}
