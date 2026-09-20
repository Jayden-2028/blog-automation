// 색인 상태 분류와 알림 문구. 순수 함수만 둔다(외부 호출 없음).
//
// 왜 분류가 필요한가(2026-09-21 실측): GSC가 돌려주는 coverageState는 10가지가 넘는데,
// **그중 대부분은 문제가 아니다.** "Discovered - currently not indexed"는 신생 블로그에서
// 지극히 정상이고(구글이 순서를 기다리는 상태) 여기에 알림을 울리면 매주 거짓 경보가 된다.
// 반대로 "Redirect error"·"Not found"는 우리가 손대야 하는 진짜 고장이다.
//
// 그래서 세 갈래로만 가른다: 정상 / 대기 / 고장. 알림은 **고장이 있을 때만 시끄럽게** 한다.

import type { UrlInspectionResult } from "../../services/searchConsole/SearchConsoleClient.js";

export type HealthBucket = "indexed" | "pending" | "broken";

/**
 * 고장으로 볼 상태들. 여기 없는 값은 "대기"로 떨어진다 - **모르는 상태를 고장으로 치지 않는다.**
 * 구글이 문구를 바꾸거나 새 상태를 추가해도 거짓 경보가 나지 않는 쪽을 택했다.
 */
const BROKEN_PATTERNS = [
  /redirect error/i,
  /not found/i, // "Not found (404)"
  /server error/i, // "Server error (5xx)"
  /blocked by robots/i,
  /noindex/i, // "Excluded by 'noindex' tag"
  /unauthorized request/i, // 401/403
  /blocked due to access forbidden/i,
];

/** 색인 완료로 볼 상태들. */
const INDEXED_PATTERNS = [/submitted and indexed/i, /indexed, not submitted/i];

export function classifyCoverage(coverageState: string): HealthBucket {
  if (BROKEN_PATTERNS.some((p) => p.test(coverageState))) return "broken";
  if (INDEXED_PATTERNS.some((p) => p.test(coverageState))) return "indexed";
  return "pending";
}

export type HealthReport = {
  indexed: UrlInspectionResult[];
  pending: UrlInspectionResult[];
  broken: UrlInspectionResult[];
  /** 검사 자체가 실패한 URL(할당량·네트워크). 색인 상태와 구분한다. */
  failures: string[];
};

export function buildReport(
  results: UrlInspectionResult[],
  failures: string[] = []
): HealthReport {
  const report: HealthReport = { indexed: [], pending: [], broken: [], failures };
  for (const result of results) report[classifyCoverage(result.coverageState)].push(result);
  return report;
}

function shortPath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/** 텔레그램 HTML 파싱을 깨뜨리지 않게 최소 이스케이프. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 주간 알림 문구. 고장이 있으면 그것부터, 없으면 진척만 짧게 전한다.
 *
 * 매주 오는 알림이라 **평소에는 짧아야 한다.** 정상일 때 긴 표를 보내면 다음 주부터 안 읽힌다.
 */
export function buildHealthMessage(report: HealthReport, total: number): string {
  const lines: string[] = [];
  const hasProblem = report.broken.length > 0;

  lines.push(hasProblem ? "⚠️ <b>색인 점검 - 고장 발견</b>" : "🔍 <b>색인 점검</b>");
  lines.push("");
  lines.push(`색인됨 ${report.indexed.length} · 대기 ${report.pending.length} · 고장 ${report.broken.length} (전체 ${total})`);

  if (hasProblem) {
    lines.push("");
    lines.push("<b>손봐야 할 글</b>");
    // 너무 많으면 메시지가 잘린다 - 앞의 몇 건만 보이고 나머지는 수만 알린다.
    for (const item of report.broken.slice(0, 8)) {
      lines.push(`· ${escapeHtml(shortPath(item.url))}`);
      lines.push(`  ${escapeHtml(item.coverageState)}`);
    }
    if (report.broken.length > 8) lines.push(`· 외 ${report.broken.length - 8}건`);
  }

  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`검사 실패 ${report.failures.length}건(할당량·네트워크) - 다음 주에 다시 봅니다.`);
  }

  if (!hasProblem && report.indexed.length === 0) {
    // 전부 대기인 상태. 신생 블로그에서는 정상이라 걱정할 일이 아님을 같이 적는다.
    lines.push("");
    lines.push("아직 색인된 글이 없습니다. 신생 블로그는 2~4주 걸리는 게 보통이라 기다리면 됩니다.");
  }

  return lines.join("\n");
}
