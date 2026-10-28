// 원고 후보 읽기 전용 조회: articles(platform null, approved/published) + article_jobs(category·keyword).
import { supabase } from "../../services/supabase/client.js";
import { kstDate } from "./text.js";
import type { MatchArticle } from "./match.js";
import { manuscriptParagraphs } from "./manuscript.js";
import type { PostParagraph } from "./naverPost.js";

/** 문체 학습 대상 카테고리(엔터·person 계열). 사용자가 네이버에서 직접 윤문하는 트랙이다. */
export const STYLE_CATEGORIES = ["entertainment", "ott", "person"] as const;

export type ArticleCandidate = MatchArticle & { category: string; status: string; paragraphs: PostParagraph[] };

export async function loadArticleCandidates(sinceIso: string): Promise<ArticleCandidate[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id,title,content,status,job_id,created_at")
    .is("platform", null)
    .in("status", ["approved", "published"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`articles 조회 실패: ${error.message}`);
  const rows = (data ?? []).filter((r) => r.job_id && r.content);
  const jobIds = [...new Set(rows.map((r) => r.job_id as string))];
  const jobs = new Map<string, { category: string | null; keyword: string }>();
  for (let i = 0; i < jobIds.length; i += 100) {
    const res = await supabase.from("article_jobs").select("id,category,keyword").in("id", jobIds.slice(i, i + 100));
    if (res.error) throw new Error(`article_jobs 조회 실패: ${res.error.message}`);
    for (const j of res.data ?? []) jobs.set(j.id, { category: j.category, keyword: j.keyword });
  }
  const out: ArticleCandidate[] = [];
  for (const r of rows) {
    const job = jobs.get(r.job_id as string);
    const category = job?.category?.trim().toLowerCase() ?? "";
    if (!(STYLE_CATEGORIES as readonly string[]).includes(category)) continue;
    const paragraphs = manuscriptParagraphs(r.content as string);
    out.push({
      id: r.id,
      title: r.title ?? "",
      keyword: job?.keyword ?? "",
      createdDate: kstDate(new Date(r.created_at)),
      text: paragraphs.map((p) => p.text).join("\n"),
      category,
      status: r.status,
      paragraphs,
    });
  }
  return out;
}
