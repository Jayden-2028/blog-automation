// 브랜치·배포 현황을 한 화면으로 만드는 순수 변환(status:all).
//
// 왜 필요한가(2026-09-04 사용자 요청): 세션(창)을 기능별로 여러 개 열어 각자 브랜치에서 작업하다
// 보니 "어떤 브랜치가 병합됐고, 어떤 게 prod에 배포됐는지"를 사람이 추적할 수 없게 됐다. git이
// 이미 답을 알고 있지만 명령을 몇 개 조합해야 나오는 정보라, 한 번에 보여주는 화면이 없었다.
//
// 이 파일은 데이터 -> HTML 변환만 한다. git 조회는 scripts/statusDashboard.ts가 담당한다.

export type BranchStatus = {
  name: string;
  /** origin/main에 없는 이 브랜치만의 커밋 수. 0이면 병합 완료(또는 뒤처지기만 함). */
  ahead: number;
  /** 이 브랜치에 없는 origin/main 커밋 수. 클수록 오래 방치된 브랜치다. */
  behind: number;
  merged: boolean;
  lastCommitDate: string;
  lastCommitSubject: string;
  /** 미병합일 때만 채운다. 병합하면 main에 들어갈 커밋들. */
  uniqueCommits: string[];
};

export type ProdStatus = {
  path: string;
  exists: boolean;
  branch: string | null;
  head: string | null;
  /** origin/main 대비 몇 커밋 뒤처져 있는지. 0이면 배포 최신. */
  behindMain: number | null;
  /** 커밋 안 된 변경이 있는지. prod에 있으면 안 되는 상태다. */
  dirty: boolean;
};

export type StatusReportInput = {
  branches: BranchStatus[];
  prod: ProdStatus;
  /** 개발 레포에 커밋 안 된 변경이 있는지. */
  devDirty: boolean;
  devBranch: string;
  mainHead: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 사람이 바로 행동할 수 있게 "지금 뭘 해야 하는지"를 한 줄로 만든다. */
export function summarize(input: StatusReportInput): string[] {
  const notes: string[] = [];

  const unmerged = input.branches.filter((b) => !b.merged);
  if (unmerged.length === 0) {
    notes.push("✅ 미병합 브랜치가 없습니다. 모든 작업이 main에 들어와 있습니다.");
  } else {
    const total = unmerged.reduce((sum, b) => sum + b.ahead, 0);
    notes.push(`⚠️ 미병합 브랜치 ${unmerged.length}개 (커밋 ${total}건) - main에 병합해야 다른 세션·prod에 반영됩니다.`);
  }

  if (!input.prod.exists) {
    notes.push(`⚠️ 운영 worktree를 찾지 못했습니다: ${input.prod.path}`);
  } else if (input.prod.behindMain === null) {
    notes.push("⚠️ 운영 worktree의 main 대비 상태를 확인하지 못했습니다.");
  } else if (input.prod.behindMain > 0) {
    notes.push(`⚠️ 운영(prod)이 main보다 ${input.prod.behindMain}커밋 뒤처져 있습니다 - 배포하지 않으면 자동화는 옛 코드로 돕니다.`);
  } else {
    notes.push("✅ 운영(prod)이 main과 같습니다. 배포 최신입니다.");
  }

  if (input.prod.dirty) {
    notes.push("⚠️ 운영 worktree에 커밋되지 않은 변경이 있습니다 - prod에서는 직접 수정하지 않는 것이 원칙입니다.");
  }
  if (input.devDirty) {
    notes.push(`ℹ️ 개발 레포(${input.devBranch})에 커밋되지 않은 변경이 있습니다.`);
  }

  return notes;
}

function renderBranchRow(branch: BranchStatus): string {
  const state = branch.merged
    ? `<span class="badge ok">병합됨</span>`
    : `<span class="badge warn">미병합 ${branch.ahead}커밋</span>`;
  const commits =
    branch.uniqueCommits.length > 0
      ? `<div class="commits">${branch.uniqueCommits.map((c) => `<div>${escapeHtml(c)}</div>`).join("")}</div>`
      : "";

  return `      <tr class="${branch.merged ? "" : "unmerged"}">
        <td class="name">${escapeHtml(branch.name)}${commits}</td>
        <td>${state}</td>
        <td class="num">${branch.behind}</td>
        <td class="date">${escapeHtml(branch.lastCommitDate)}</td>
        <td class="subject">${escapeHtml(branch.lastCommitSubject)}</td>
      </tr>`;
}

export function buildStatusReportHtml(input: StatusReportInput, generatedAt: Date = new Date()): string {
  // 미병합을 위로: 사람이 처리해야 할 것이 먼저 보여야 한다.
  const sorted = [...input.branches].sort((a, b) => {
    if (a.merged !== b.merged) return a.merged ? 1 : -1;
    return b.lastCommitDate.localeCompare(a.lastCommitDate);
  });

  const generated = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  }).format(generatedAt);

  const prodLine = input.prod.exists
    ? `${escapeHtml(input.prod.branch ?? "?")} @ ${escapeHtml(input.prod.head ?? "?")}` +
      (input.prod.behindMain === 0
        ? ` <span class="badge ok">배포 최신</span>`
        : ` <span class="badge warn">main보다 ${input.prod.behindMain ?? "?"}커밋 뒤</span>`)
    : `<span class="badge warn">찾을 수 없음</span>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>개발 현황</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --card:#f6f8fa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --card:#161b22; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:24px 0 8px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:16px; }
  .summary { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; margin-bottom:20px; }
  .summary div { margin:3px 0; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  .card { flex:1 1 240px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; }
  .card .label { color:var(--muted); font-size:12.5px; }
  .card .value { font-size:15px; margin-top:2px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12.5px; color:var(--muted); font-weight:600; white-space:nowrap; }
  .name { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
  .num, .date { color:var(--muted); font-size:13px; white-space:nowrap; }
  .subject { color:var(--muted); font-size:13px; }
  tr.unmerged .name { font-weight:700; }
  .commits { margin-top:6px; padding-left:10px; border-left:2px solid var(--line); color:var(--muted); font-size:12px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; color:#fff; font-size:12px; white-space:nowrap; }
  .badge.ok { background:#15803d; }
  .badge.warn { background:#b45309; }
  code { background:var(--card); border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:12.5px; }
</style>
</head>
<body>
  <h1>개발 현황</h1>
  <div class="meta">생성 ${escapeHtml(generated)} (KST) · 갱신하려면 <code>npm run status:all</code></div>

  <div class="summary">
${summarize(input).map((line) => `    <div>${escapeHtml(line)}</div>`).join("\n")}
  </div>

  <div class="cards">
    <div class="card"><div class="label">main 최신</div><div class="value"><code>${escapeHtml(input.mainHead)}</code></div></div>
    <div class="card"><div class="label">운영 worktree (자동화가 실행하는 코드)</div><div class="value">${prodLine}</div></div>
    <div class="card"><div class="label">개발 레포 현재 브랜치</div><div class="value"><code>${escapeHtml(input.devBranch)}</code>${input.devDirty ? ' <span class="badge warn">변경 있음</span>' : ""}</div></div>
  </div>

  <h2>브랜치 (${input.branches.length}개)</h2>
  <table>
    <thead><tr><th>브랜치</th><th>상태</th><th>main보다 뒤</th><th>마지막 커밋</th><th>내용</th></tr></thead>
    <tbody>
${sorted.map(renderBranchRow).join("\n")}
    </tbody>
  </table>
</body>
</html>
`;
}
