// approved인데 아직 발행되지 않은 job을 활성 채널로 fan-out하는 폴러. SPRINT_5_DESIGN.md §5.
//
// 2026-09-15: 이 폴러는 dormant다(CLAUDE.md 원고 파이프라인 운영 규칙 - 반자동 업로드 중단).
// 같은 날 티스토리 운영 중단으로 티스토리 분기를 걷어냈다(BLOGSPOT_ONLY_DESIGN.md §6).
// 네이버 분기는 사용자가 별도 프로세스로 재설계 예정이라 그대로 둔다.
//
// 승인 콜백 안에서 발행하지 않는 이유(§5): Playwright/배리에이션 LLM이 수 분 걸려
// 콜백이 멈추고, 잠자기 중 죽으면 발행이 유실된다. approved는 "발행 완료"가 아니라 "발행 대기열"이고,
// 이 폴러가 launchd 주기로 큐를 비운다. 재시도·부분성공·상한초과가 자연스럽게 처리된다.
//
// 채널 실패 격리: 한 채널이 실패해도 다른 채널을 막지 않는다. job.status는 활성 채널이 전부
// "성공(또는 임시저장)"일 때만 published로 넘긴다.

import { BLOGGER_CONFIG } from "../../config/publishTargets.js";
import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { listImagesByArticleId } from "../../services/supabase/repositories/imageRepository.js";
import { listPublicationsByArticleId } from "../../services/supabase/repositories/publicationRepository.js";
import { publishArticleToNaver } from "../../services/publish/publishArticleToNaver.js";
import { BLOGSPOT_PLATFORM, publishArticleToBlogspot } from "./publishArticleToBlogspot.js";
import type { ArticleJobRow } from "../../types/database.js";

export type ChannelName = "naver" | "blogspot";

export type ChannelOutcome =
  | { channel: ChannelName; status: "published"; url: string }
  | { channel: ChannelName; status: "draft"; url: string }
  | { channel: ChannelName; status: "already_done"; url: string }
  | { channel: ChannelName; status: "skipped"; reason: string }
  | { channel: ChannelName; status: "deferred"; reason: string }
  | { channel: ChannelName; status: "failed"; reason: string };

export type JobPublishResult = {
  job: ArticleJobRow;
  channels: ChannelOutcome[];
  /** 이번 실행에서 job.status가 published로 넘어갔는지. */
  markedPublished: boolean;
};

export type PublishApprovedArticlesOptions = {
  loadApprovedJobs?: () => Promise<ArticleJobRow[]>;
  publishNaver?: (jobId: string) => ReturnType<typeof publishArticleToNaver>;
  publishBlogspot?: (jobId: string) => ReturnType<typeof publishArticleToBlogspot>;
  markJobPublished?: (jobId: string) => Promise<unknown>;
  /** job이 발행 가능한 상태인지 사전 점검. 반환값이 문자열이면 그 사유로 job 전체를 건너뛴다(deferred). */
  preflight?: (job: ArticleJobRow) => Promise<string | null>;
  /** 활성 채널 override(테스트). 생략하면 config로 판정. naver는 항상 활성(반자동 임시저장). */
  activeChannels?: ChannelName[];
  /** job당 처리 상한(한 번의 폴링이 너무 오래 돌지 않게). 기본 3. */
  maxJobsPerRun?: number;
};

/**
 * 기본 preflight: 기준 원고의 이미지가 전부 우리 Supabase Storage URL인지 확인한다.
 * example.com 플레이스홀더나 외부 URL이 섞인 job(테스트 잔재, 수동 편집 실수)은 발행하지 않는다 -
 * 네이버 이미지 업로드가 404로 실패하며 무한 재시도에 빠지거나, Blogspot에 깨진 이미지가 올라간다.
 */
export async function defaultPreflight(job: ArticleJobRow): Promise<string | null> {
  const supabaseHost = (() => {
    try {
      return new URL(process.env.SUPABASE_URL ?? "").host;
    } catch {
      return "";
    }
  })();

  const articles = await listArticlesByJobId(job.id);
  const baseArticle = [...articles].reverse().find((a) => a.platform == null);
  if (!baseArticle) return "기준 원고 없음";

  const images = await listImagesByArticleId(baseArticle.id);
  for (const image of images) {
    const url = image.image_url ?? "";
    if (!url) continue;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      return `이미지 URL 형식 오류: ${url.slice(0, 60)}`;
    }
    if (supabaseHost && host !== supabaseHost) {
      return `우리 스토리지가 아닌 이미지 URL(${host}) - 수동 정리 필요`;
    }
  }
  if (/example\.com|placeholder/i.test(baseArticle.content ?? "")) {
    return "본문에 placeholder/example.com 참조 - 수동 정리 필요";
  }
  return null;
}

function resolveActiveChannels(override?: ChannelName[]): ChannelName[] {
  if (override) return override;
  const channels: ChannelName[] = ["naver"]; // 반자동 임시저장 - 항상 돈다
  if (BLOGGER_CONFIG.enabled) channels.push("blogspot");
  return channels;
}

export async function publishApprovedArticles(
  options: PublishApprovedArticlesOptions = {}
): Promise<JobPublishResult[]> {
  const loadApprovedJobs = options.loadApprovedJobs ?? (() => ArticleJobRepository.listByStatus("approved", 20));
  const publishNaver = options.publishNaver ?? ((jobId) => publishArticleToNaver(jobId));
  const publishBlogspot = options.publishBlogspot ?? ((jobId) => publishArticleToBlogspot(jobId));
  const markJobPublished = options.markJobPublished ?? ((jobId) => ArticleJobRepository.updateStatus(jobId, "published"));
  const maxJobsPerRun = options.maxJobsPerRun ?? 3;
  const preflight = options.preflight ?? defaultPreflight;
  const activeChannels = resolveActiveChannels(options.activeChannels);

  const jobs = (await loadApprovedJobs()).slice(0, maxJobsPerRun);
  const results: JobPublishResult[] = [];

  for (const job of jobs) {
    const channels: ChannelOutcome[] = [];

    const blocker = await preflight(job);
    if (blocker) {
      // job 전체를 이번엔 건너뛴다. approved로 남으므로 다음 폴링에서 재시도하지만, 사람이
      // 정리(job:close 또는 이미지 교체)하기 전까지는 계속 deferred다.
      results.push({
        job,
        channels: activeChannels.map((channel) => ({ channel, status: "deferred" as const, reason: blocker })),
        markedPublished: false,
      });
      continue;
    }

    for (const channel of activeChannels) {
      try {
        if (channel === "naver") {
          const r = await publishNaver(job.id);
          if (r.ok) {
            channels.push(
              r.alreadyDone
                ? { channel, status: "already_done", url: r.draftUrl }
                : { channel, status: "draft", url: r.draftUrl }
            );
          } else if (r.reason === "job_not_approved") {
            channels.push({ channel, status: "skipped", reason: r.detail });
          } else {
            channels.push({ channel, status: "failed", reason: r.detail });
          }
        } else {
          const r = await publishBlogspot(job.id);
          if (r.ok) {
            channels.push(
              r.alreadyDone
                ? { channel, status: "already_done", url: r.url }
                : r.isDraft
                  ? { channel, status: "draft", url: r.url }
                  : { channel, status: "published", url: r.url }
            );
          } else if (r.reason === "disabled" || r.reason === "job_not_approved") {
            channels.push({ channel, status: "skipped", reason: r.detail });
          } else if (r.reason === "daily_limit") {
            channels.push({ channel, status: "deferred", reason: r.detail });
          } else {
            channels.push({ channel, status: "failed", reason: r.detail });
          }
        }
      } catch (error) {
        channels.push({
          channel,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // job.status -> published 조건: 활성 채널 전부가 "성공/임시저장/이미완료"여야 한다.
    // deferred(상한초과, 미구현)나 failed가 하나라도 있으면 approved로 남겨 다음 폴링에서 재시도한다.
    const allSettled = channels.every(
      (c) => c.status === "published" || c.status === "draft" || c.status === "already_done"
    );
    let markedPublished = false;
    if (allSettled && channels.length > 0) {
      await markJobPublished(job.id).catch(() => {});
      markedPublished = true;
    }

    results.push({ job, channels, markedPublished });
  }

  return results;
}

/** publications 조회 헬퍼 - 알림에서 채널별 최종 URL을 다시 확인할 때 쓴다(현재는 미사용, 확장 지점). */
export async function collectChannelUrls(jobId: string): Promise<Record<string, string>> {
  const articles = await listArticlesByJobId(jobId);
  const urls: Record<string, string> = {};
  for (const article of articles) {
    const pubs = await listPublicationsByArticleId(article.id);
    for (const pub of pubs) {
      if (pub.published_url && pub.platform) urls[pub.platform] = pub.published_url;
    }
  }
  return urls;
}
