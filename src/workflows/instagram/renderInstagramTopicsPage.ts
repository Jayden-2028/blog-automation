// top 20을 한 화면에서 보는 HTML. 데모 산출물(2026-09-21 사용자 결정 - 텔레그램 대신 HTML).
//
// 순위만 보여주면 "왜 이게 1등인지" 판단할 수 없어 교체 여부를 정할 수 없다. 그래서 각 주제마다
// **근거를 접어서** 붙인다 - 어느 페이지의 어떤 게시물이 평소 몇 배였는지, 원문 링크까지.

import type { RankedTopic } from "./types.js";

const CATEGORY_LABEL: Record<string, string> = {
  entertainment: "연예",
  issue: "이슈",
  life: "생활",
  culture: "문화",
  food: "먹거리",
  place: "장소",
  etc: "기타",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function saturationLabel(blogTotal: number | null): string {
  if (blogTotal === null) return "미확인";
  if (blogTotal < 1_000) return "빈틈";
  if (blogTotal < 50_000) return "보통";
  return "포화";
}

function renderTopic(topic: RankedTopic, rank: number): string {
  const posts = topic.posts
    .map(
      (post) =>
        `<li><a href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener">@${escapeHtml(post.username)}</a>` +
        ` <span class="muted">좋아요 ${post.likes.toLocaleString()} · 댓글 ${post.comments.toLocaleString()}</span>` +
        `<div class="caption">${escapeHtml(post.caption.slice(0, 160))}</div></li>`
    )
    .join("");

  return `
  <article class="topic">
    <div class="head">
      <span class="rank">${rank}</span>
      <div class="title">
        <h2>${escapeHtml(topic.label)}</h2>
        <div class="meta">
          <span class="tag">${escapeHtml(CATEGORY_LABEL[topic.category] ?? topic.category)}</span>
          <span class="tag sat sat-${saturationLabel(topic.blogTotal)}">${saturationLabel(topic.blogTotal)}</span>
          <code>${escapeHtml(topic.query)}</code>
        </div>
      </div>
      <span class="score">${topic.finalScore.toFixed(1)}</span>
    </div>
    <p class="reason">${escapeHtml(topic.reason)}</p>
    <details>
      <summary>근거 게시물 ${topic.posts.length}건</summary>
      <ul class="posts">${posts}</ul>
    </details>
  </article>`;
}

export function renderInstagramTopicsPage(topics: RankedTopic[], generatedAt: Date = new Date()): string {
  const stamp = generatedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>인스타 키워드 후보</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --accent:#ea580c; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg:#0f1115; --fg:#e8e8ea; --muted:#9aa0aa; --line:#272b33; --card:#171a20; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 64px; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif; line-height:1.6; }
  .wrap { max-width: 820px; margin: 0 auto; }
  header { border-bottom:2px solid var(--line); padding-bottom:16px; margin-bottom:24px; }
  h1 { margin:0 0 4px; font-size:22px; }
  .sub { color:var(--muted); font-size:13px; }
  .topic { border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:12px; background:var(--card); }
  .head { display:flex; gap:12px; align-items:flex-start; }
  .rank { flex:0 0 32px; height:32px; border-radius:8px; background:var(--accent); color:#fff;
          display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; }
  .title { flex:1; min-width:0; }
  h2 { margin:0; font-size:17px; line-height:1.4; }
  .meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:6px; }
  .tag { font-size:11px; padding:2px 8px; border-radius:99px; border:1px solid var(--line); color:var(--muted); }
  .sat-빈틈 { border-color:#16a34a; color:#16a34a; }
  .sat-포화 { border-color:#dc2626; color:#dc2626; }
  code { font-size:12px; color:var(--muted); }
  .score { flex:0 0 auto; font-variant-numeric:tabular-nums; font-weight:700; color:var(--accent); }
  .reason { margin:10px 0 0; font-size:13px; color:var(--muted); }
  details { margin-top:10px; }
  summary { cursor:pointer; font-size:13px; color:var(--muted); }
  .posts { margin:10px 0 0; padding-left:18px; font-size:13px; }
  .posts li { margin-bottom:10px; }
  .caption { color:var(--muted); font-size:12px; margin-top:2px; }
  .muted { color:var(--muted); font-size:12px; }
  @media (max-width:520px) { body { padding:16px 16px 48px; } h2 { font-size:16px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>인스타 키워드 후보 ${topics.length}건</h1>
    <div class="sub">${escapeHtml(stamp)} · 반응 순 · 카테고리는 라벨만</div>
  </header>
  ${topics.map((topic, i) => renderTopic(topic, i + 1)).join("\n")}
</div>
</body>
</html>`;
}
