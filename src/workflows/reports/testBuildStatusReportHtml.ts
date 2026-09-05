// buildStatusReportHtml / summarize 테스트. git 없이 순수 변환만 검증한다.

import { buildStatusReportHtml, summarize } from "./buildStatusReportHtml.js";
import type { StatusReportInput } from "./buildStatusReportHtml.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BASE: StatusReportInput = {
  branches: [
    {
      name: "claude/telegram-bot-setup-7bqiyc",
      ahead: 2,
      behind: 35,
      merged: false,
      lastCommitDate: "2026-09-03",
      lastCommitSubject: "fix(publish): 중복 실패 알림 제거",
      uniqueCommits: ["b399021 fix(publish): 실패 사유 dedup", "4b61a19 fix(publish): 중복 실패 알림 제거"],
    },
    {
      name: "claude/branch-cleanup-k0t9bs",
      ahead: 0,
      behind: 7,
      merged: true,
      lastCommitDate: "2026-09-04",
      lastCommitSubject: "merge: 브랜치 정리",
      uniqueCommits: [],
    },
  ],
  prod: {
    path: "/Users/x/blog-automation-prod",
    exists: true,
    branch: "main",
    head: "e7e6852",
    behindMain: 0,
    dirty: false,
  },
  devDirty: false,
  devBranch: "claude/project-main-window-glrf11",
  mainHead: "e7e6852 merge: 키워드 수집 개선",
};

function main(): void {
  console.log("▶ buildStatusReportHtml 테스트 시작\n");

  // 요약: 미병합이 있으면 커밋 수까지 알려준다
  const notes = summarize(BASE);
  assert(notes.some((n) => n.includes("미병합 브랜치 1개") && n.includes("커밋 2건")), `미병합 요약 (실제: ${notes.join(" / ")})`);
  assert(notes.some((n) => n.includes("배포 최신")), "prod가 main과 같으면 최신이라고 알린다");
  console.log("✅ 요약: 미병합 커밋 수 + 배포 최신 여부");

  // prod가 뒤처지면 경고
  const behind = summarize({ ...BASE, prod: { ...BASE.prod, behindMain: 12 } });
  assert(behind.some((n) => n.includes("12커밋 뒤처져")), "prod 지연 경고");
  console.log("✅ 요약: prod가 뒤처지면 배포 필요 경고");

  // 전부 병합됐으면 그렇게 말한다
  const allMerged = summarize({ ...BASE, branches: BASE.branches.filter((b) => b.merged) });
  assert(allMerged.some((n) => n.includes("미병합 브랜치가 없습니다")), "전부 병합 시 안내");
  console.log("✅ 요약: 미병합 0건일 때");

  // prod worktree가 없을 때도 죽지 않는다
  const noProd = summarize({ ...BASE, prod: { ...BASE.prod, exists: false, behindMain: null } });
  assert(noProd.some((n) => n.includes("운영 worktree를 찾지 못했습니다")), "prod 없음 안내");
  console.log("✅ 요약: 운영 worktree 없음");

  const html = buildStatusReportHtml(BASE, new Date("2026-09-04T04:00:00.000Z"));
  assert(html.startsWith("<!doctype html>"), "완결된 HTML");
  assert(html.includes("claude/telegram-bot-setup-7bqiyc"), "브랜치 이름 포함");
  assert(html.includes("4b61a19 fix(publish): 중복 실패 알림 제거"), "미병합 커밋 목록 노출");
  assert(html.includes("미병합 2커밋"), "미병합 뱃지에 커밋 수");
  console.log("✅ HTML: 브랜치 + 미병합 커밋 목록");

  // 미병합이 병합된 것보다 위에 온다(사람이 처리할 것 우선)
  const unmergedIndex = html.indexOf("claude/telegram-bot-setup-7bqiyc");
  const mergedIndex = html.indexOf("claude/branch-cleanup-k0t9bs");
  assert(unmergedIndex < mergedIndex, "미병합 브랜치가 위에 정렬돼야 한다");
  console.log("✅ HTML: 미병합 우선 정렬");

  console.log("\n✅ buildStatusReportHtml 테스트 완료");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
