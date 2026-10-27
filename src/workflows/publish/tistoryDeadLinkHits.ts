// 옛(404) 티스토리 주소를 본문(articles.content)에 품은 글 찾기(DB 읽기 전용). 교정 CLI(tistoryUrlAuditCli)에서
// 2026-10-28에 떼어 내 링크 치환 CLI(tistoryFixLinksCli)와 같이 쓴다.

import { supabase } from "../../services/supabase/client.js";
import { slugFromEntryUrl } from "../../services/publish/tistory/tistoryPublishedUrl.js";

export type DeadUrlRow = { id: number; currentUrl: string };

export type BodyHit = { articleId: number; jobId: string | null; title: string; deadUrlIds: number[]; jobPublished: boolean };

/** LIKE 패턴 이스케이프(퍼센트 인코딩 주소에 %가 가득하다). */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 옛 주소를 본문에 품은 글(내부 링크). 인코딩된 주소와 풀린 주소 둘 다 찾는다. */
export async function findBodyHits(dead: readonly DeadUrlRow[]): Promise<BodyHit[]> {
  const hits = new Map<number, BodyHit>();
  for (const row of dead) {
    const slug = slugFromEntryUrl(row.currentUrl);
    const needles = [...new Set([row.currentUrl.replace(/^https?:\/\//, ""), slug ? `/entry/${slug}` : ""].filter(Boolean))];
    for (const needle of needles) {
      const { data, error } = await supabase.from("articles").select("id, job_id, title").ilike("content", `%${likeEscape(needle)}%`);
      if (error) throw error;
      for (const article of data ?? []) {
        const hit = hits.get(article.id) ?? { articleId: article.id, jobId: article.job_id, title: article.title ?? "", deadUrlIds: [], jobPublished: false };
        if (!hit.deadUrlIds.includes(row.id)) hit.deadUrlIds.push(row.id);
        hits.set(article.id, hit);
      }
    }
  }
  // 그 글이 실제로 (어느 채널이든) 발행됐나 - job 단위로 본다(수정 반영으로 article row가 여럿일 수 있다).
  const jobIds = [...new Set([...hits.values()].map((hit) => hit.jobId).filter((id): id is string => Boolean(id)))];
  if (jobIds.length > 0) {
    const { data: jobArticles, error } = await supabase.from("articles").select("id, job_id").in("job_id", jobIds);
    if (error) throw error;
    const { data: pubs, error: pubError } = await supabase
      .from("publications")
      .select("article_id, status")
      .in("article_id", (jobArticles ?? []).map((article) => article.id))
      .eq("status", "published");
    if (pubError) throw pubError;
    const publishedArticles = new Set((pubs ?? []).map((pub) => pub.article_id));
    const publishedJobs = new Set((jobArticles ?? []).filter((article) => publishedArticles.has(article.id)).map((article) => article.job_id));
    for (const hit of hits.values()) hit.jobPublished = hit.jobId ? publishedJobs.has(hit.jobId) : false;
  }
  return [...hits.values()].sort((a, b) => b.articleId - a.articleId);
}
