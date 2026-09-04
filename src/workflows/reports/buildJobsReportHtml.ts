// job 목록을 검색 가능한 단일 HTML 페이지로 만든다(report:jobs).
//
// 왜 필요한가(2026-09-03 사용자 요청): 재시도·수정 명령이 전부 jobId를 요구하는데
// (`npm run job:write -- <jobId>`, `job:research`, `job:reject`, `job:close`), 사람이 그 UUID를
// 매번 찾아내기가 어렵다. 지금은 `job:write`(인자 없이)나 `debug:approved-jobs`로 부분 목록만
// 볼 수 있고 status별로 흩어져 있다. 이 리포트는 status와 무관하게 "원고 제목 ↔ jobId"를 한 화면에
// 모아 검색하게 한다.
//
// 왜 순수 함수인가: DB 없이 테스트할 수 있어야 한다(이 저장소의 evaluateWatchdog·formatStageSummary와
// 같은 패턴). 조회는 호출자(runJobsReportCli)가 하고 여기서는 행 -> HTML 변환만 한다.
//
// 왜 CDN을 안 쓰는가: 로컬 파일(logs/jobs.html)로 열리는 페이지라 오프라인에서도 그대로 떠야 한다.
// 검색·복사 기능은 의존성 없이 순수 JS 몇 줄로 충분하다.

import type { ArticleJobStatus } from "../../types/database.js";

export type JobsReportRow = {
  jobId: string;
  /** 생성된 원고 제목. 아직 원고가 없으면 null - 이때는 headline/keyword로 대체 표시한다. */
  articleTitle: string | null;
  headline: string | null;
  keyword: string;
  category: string | null;
  status: ArticleJobStatus;
  /** ISO 문자열. 표시는 Asia/Seoul 기준으로 변환한다. */
  selectedAt: string;
};

/** status별 한글 라벨 + 뱃지 색. 값이 늘면 여기만 고치면 된다. */
const STATUS_META: Record<ArticleJobStatus, { label: string; color: string }> = {
  selected: { label: "선택됨", color: "#6b7280" },
  researching: { label: "자료조사 중", color: "#0891b2" },
  writing: { label: "집필 중", color: "#7c3aed" },
  review: { label: "검수 대기", color: "#d97706" },
  approved: { label: "승인됨(발행 대기)", color: "#059669" },
  published: { label: "발행 완료", color: "#15803d" },
  rejected: { label: "반려", color: "#b91c1c" },
};

/** 이 페이지에서 jobId를 필요로 하는 명령들. 상단 안내에 그대로 노출한다. */
const COMMAND_HINTS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "npm run job:research -- <jobId>", description: "자료조사만 다시 실행" },
  { command: "npm run job:write -- <jobId>", description: "원고 작성(멈춘 job 재시도 포함)" },
  { command: "npm run job:publish -- <jobId>", description: "네이버 임시저장 수동 실행" },
  { command: "npm run job:reject -- <jobId>", description: "job 중단(반려)" },
  { command: "npm run job:close -- <jobId>", description: "발행 대기열에서 제외" },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** ISO -> "2026-09-03 21:44" (Asia/Seoul). 파싱 실패하면 원본을 그대로 보여준다. */
export function formatSeoulDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  // sv-SE 로케일은 "2026-09-03 21:44" 형태를 준다(ISO에 가까워 정렬·가독 모두 유리).
  return parts;
}

/** 표시용 제목: 원고 제목 > 원문 헤드라인 > 키워드 순으로 있는 것을 쓴다. */
export function displayTitle(row: JobsReportRow): string {
  return row.articleTitle?.trim() || row.headline?.trim() || row.keyword;
}

function renderRow(row: JobsReportRow): string {
  const meta = STATUS_META[row.status] ?? { label: row.status, color: "#6b7280" };
  const title = displayTitle(row);
  // 검색은 제목·키워드·jobId·상태를 한 문자열로 합쳐서 대소문자 무시 비교한다.
  const haystack = [title, row.keyword, row.headline ?? "", row.jobId, meta.label, row.category ?? ""]
    .join(" ")
    .toLowerCase();

  return `      <tr data-search="${escapeHtml(haystack)}">
        <td class="title">${escapeHtml(title)}</td>
        <td class="keyword">${escapeHtml(row.keyword)}</td>
        <td><span class="badge" style="background:${meta.color}">${escapeHtml(meta.label)}</span></td>
        <td class="date">${escapeHtml(formatSeoulDateTime(row.selectedAt))}</td>
        <td><button class="job-id" data-id="${escapeHtml(row.jobId)}" title="클릭하면 전체 jobId가 복사됩니다">${escapeHtml(row.jobId.slice(0, 8))}…</button></td>
      </tr>`;
}

export function buildJobsReportHtml(rows: JobsReportRow[], generatedAt: Date = new Date()): string {
  const tableRows = rows.map(renderRow).join("\n");
  const commandList = COMMAND_HINTS.map(
    (hint) => `      <li><code>${escapeHtml(hint.command)}</code> <span>${escapeHtml(hint.description)}</span></li>`
  ).join("\n");

  const emptyNotice =
    rows.length === 0
      ? `    <p class="empty">아직 job이 없습니다. 텔레그램에서 키워드를 선택(Go)하면 여기에 나타납니다.</p>`
      : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>원고 job 목록</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --card: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #30363d; --card: #161b22; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  details { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; }
  summary { cursor: pointer; font-weight: 600; }
  details ul { margin: 10px 0 2px; padding-left: 18px; }
  details li { margin-bottom: 4px; }
  code { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
  details span { color: var(--muted); font-size: 12.5px; }
  #search {
    width: 100%; padding: 10px 12px; font-size: 15px; margin-bottom: 14px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 8px;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12.5px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .title { font-weight: 600; }
  .keyword, .date { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; color: #fff; font-size: 12px; white-space: nowrap; }
  .job-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; cursor: pointer;
    background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px;
  }
  .job-id:hover { border-color: var(--muted); }
  .job-id.copied { background: #15803d; color: #fff; border-color: #15803d; }
  .empty { color: var(--muted); padding: 24px 0; }
  #no-result { color: var(--muted); padding: 16px 0; display: none; }
</style>
</head>
<body>
  <h1>원고 job 목록</h1>
  <div class="meta">${rows.length}건 · 생성 ${escapeHtml(formatSeoulDateTime(generatedAt.toISOString()))} (KST) · 갱신하려면 <code>npm run report:jobs</code></div>

  <details>
    <summary>jobId가 필요한 명령들</summary>
    <ul>
${commandList}
    </ul>
  </details>

  <input id="search" type="search" placeholder="제목 · 키워드 · jobId · 상태로 검색" autofocus>
${emptyNotice}
  <table>
    <thead>
      <tr><th>제목</th><th>키워드</th><th>상태</th><th>선택 시각</th><th>jobId</th></tr>
    </thead>
    <tbody id="rows">
${tableRows}
    </tbody>
  </table>
  <p id="no-result">검색 결과가 없습니다.</p>

<script>
  // 검색: 미리 만들어둔 data-search 문자열만 비교한다(행 수가 수백 건이라 이걸로 충분히 즉각적).
  const search = document.getElementById('search');
  const rows = Array.from(document.querySelectorAll('#rows tr'));
  const noResult = document.getElementById('no-result');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let visible = 0;
    for (const tr of rows) {
      const hit = q === '' || tr.dataset.search.includes(q);
      tr.hidden = !hit;
      if (hit) visible++;
    }
    noResult.style.display = visible === 0 && rows.length > 0 ? 'block' : 'none';
  });

  // jobId 클릭 -> 전체 UUID 복사. 이 페이지의 존재 이유라 피드백을 확실히 준다.
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.job-id');
    if (!button) return;
    const id = button.dataset.id;
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // file:// 에서 클립보드 API가 막히는 브라우저가 있다 - 그때는 선택 가능한 형태로 보여준다.
      window.prompt('아래 jobId를 복사하세요', id);
      return;
    }
    const original = button.textContent;
    button.textContent = '복사됨';
    button.classList.add('copied');
    setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 1200);
  });
</script>
</body>
</html>
`;
}
