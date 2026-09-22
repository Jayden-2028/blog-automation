import { supabase } from "../client.js";
import type {
  PublicationInsert,
  PublicationRow,
  PublicationStatus,
  PublicationUpdate,
} from "../../../types/database.js";

export async function createPublication(
  input: PublicationInsert
): Promise<PublicationRow> {
  const { data, error } = await supabase
    .from("publications")
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updatePublicationStatus(
  id: number,
  status: PublicationStatus,
  /**
   * 초안을 공개로 전환하면 URL이 편집 주소에서 공개 주소로 바뀐다(2026-09-19). 생략하면 기존 값을
   * 그대로 둔다 - status만 바꾸는 호출이 URL을 지워버리면 안 된다.
   */
  publishedUrl?: string
): Promise<PublicationRow> {
  const { data, error } = await supabase
    .from("publications")
    .update({ status, ...(publishedUrl ? { published_url: publishedUrl } : {}) } satisfies PublicationUpdate)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listPublicationsByArticleId(
  articleId: number
): Promise<PublicationRow[]> {
  const { data, error } = await supabase
    .from("publications")
    .select("*")
    .eq("article_id", articleId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * 여러 article의 publication을 한 번에 가져온다(최신순).
 *
 * 왜 필요한가(2026-09-19): 수정 반영이 들어오면 배리에이션 article row가 새로 생긴다. article
 * 한 건만 보면 그 새 row에는 publication이 없어 "아직 안 올렸다"로 보이고, 같은 원고가 블로그에
 * 두 번 올라간다. job에 속한 article 전부를 봐야 이미 올라간 글을 찾을 수 있다.
 */
export async function listPublicationsByArticleIds(
  articleIds: number[]
): Promise<PublicationRow[]> {
  if (articleIds.length === 0) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("*")
    .in("article_id", articleIds)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * 한국시간 자정 기준 "오늘"의 시작 시각.
 *
 * 왜 로컬 자정이 아닌가(2026-09-21): 실제로 도는 곳은 GitHub Actions 러너이고 거기는 UTC다.
 * 로컬 자정을 쓰면 카운터가 **한국시간 오전 9시**에 초기화돼, 밤에 상한에 걸린 원고가 다음 날
 * 아침 9시까지 막힌다. 사용자가 보는 "오늘"과 어긋난다.
 *
 * KST는 서머타임이 없어 항상 UTC+9다 - 오프셋을 그대로 붙이면 된다.
 */
export function startOfKstDay(now: Date = new Date()): Date {
  const kstDate = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  return new Date(`${kstDate}T00:00:00+09:00`);
}

/**
 * 오늘(한국시간 자정 기준) 해당 platform으로 실제 발행/임시저장된 publication 수. 일일 상한
 * 하드 가드용. status='failed'는 세지 않는다(실패는 재시도되므로 상한을 잠식하면 안 된다).
 */
export async function countTodayPublicationsByPlatform(platform: string): Promise<number> {
  const startOfDay = startOfKstDay();

  const { count, error } = await supabase
    .from("publications")
    .select("id", { count: "exact", head: true })
    .eq("platform", platform)
    .neq("status", "failed")
    .gte("created_at", startOfDay.toISOString());

  if (error) throw error;
  return count ?? 0;
}

/** 이미 발행돼 링크를 걸 수 있는 글. 내부 링크 삽입(2026-09-22)이 후보로 쓴다. */
export type PublishedPost = {
  jobId: string;
  title: string;
  url: string;
  keyword: string;
  category: string | null;
  publishedAt: string;
};

/**
 * 실제로 발행된 글 목록(최신순). 내부 링크 후보용이다.
 *
 * 왜 필요한가(2026-09-22): 서치콘솔이 우리 글 대부분을 "참조 페이지 없음"으로 본다. 실측하니
 * 발행된 26개 URL 중 19개가 홈에서도 본문에서도 링크되지 않은 고아 페이지였고, 본문 내부 링크는
 * **0개**였다. 구글 공식 문서는 "매일 찾는 새 페이지의 압도적 다수는 링크를 통해서"라고 말한다 -
 * 링크가 없으면 사이트맵 하나에만 의존하게 된다.
 *
 * writer는 다른 글의 주소를 알 방법이 없어 구조적으로 링크를 쓸 수 없었다. 그래서 여기서 실제
 * 발행 기록을 읽어 넘겨준다(LLM이 지어낸 주소가 섞이지 않는다).
 */
export async function listPublishedPosts(limit = 200): Promise<PublishedPost[]> {
  const { data: publications, error: publicationError } = await supabase
    .from("publications")
    .select("article_id,published_url,created_at")
    .eq("status", "published")
    .not("published_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (publicationError) throw publicationError;
  if (!publications || publications.length === 0) return [];

  const { data: articles, error: articleError } = await supabase
    .from("articles")
    .select("id,job_id,title")
    .in("id", publications.map((row) => row.article_id));
  if (articleError) throw articleError;

  const articleById = new Map((articles ?? []).map((row) => [row.id as number, row]));
  const jobIds = [...new Set((articles ?? []).map((row) => row.job_id as string).filter(Boolean))];
  if (jobIds.length === 0) return [];

  const { data: jobs, error: jobError } = await supabase
    .from("article_jobs")
    .select("id,keyword,category")
    .in("id", jobIds);
  if (jobError) throw jobError;

  const jobById = new Map((jobs ?? []).map((row) => [row.id as string, row]));

  const posts: PublishedPost[] = [];
  const seenJobs = new Set<string>();
  for (const publication of publications) {
    const article = articleById.get(publication.article_id as number);
    if (!article) continue;
    const job = jobById.get(article.job_id as string);
    if (!job) continue;
    // 같은 job이 여러 번 발행됐어도(수정 재발행) 최신 것 하나만 후보로 둔다.
    if (seenJobs.has(job.id as string)) continue;
    seenJobs.add(job.id as string);
    posts.push({
      jobId: job.id as string,
      title: (article.title as string) ?? (job.keyword as string),
      url: publication.published_url as string,
      keyword: (job.keyword as string) ?? "",
      category: (job.category as string) ?? null,
      publishedAt: publication.created_at as string,
    });
  }
  return posts;
}
