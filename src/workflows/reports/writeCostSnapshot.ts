// 비용 집계를 manuscripts/cost.json으로 떨군다. 개인 대시보드가 이 파일 하나만 fetch한다.
//
// 왜 원고 페이지 디렉터리인가: 이미 Cloudflare Pages로 배포되는 유일한 디렉터리라서다. 별도
// 배포 대상을 만들면 또 하나의 시크릿·워크플로·실패 지점이 생긴다.
//
// ⚠️ 왜 cost.json만 따로 배포하지 않는가: `wrangler pages deploy <dir>`는 그 디렉터리를 **통째로**
// 새 배포로 올린다. cost.json만 든 디렉터리로 배포하면 index.html이 사라진다 - 2026-09-14/15에
// 원고 목록이 통째로 날아간 사고와 정확히 같은 실패 유형이다(manuscript_manifest_topics migration
// 주석 참고). 그래서 이 함수는 **배포를 하지 않고**, 페이지를 그린 직후 같은 디렉터리에 파일만
// 보태 놓는다. 배포는 기존 경로가 그대로 한 번에 처리한다.
//
// best-effort다. 비용 스냅샷을 못 써도 원고 준비·배포는 그대로 성공해야 한다.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { listFixedCosts } from "../../config/fixedCosts.js";
import { manuscriptCostSnapshotPath } from "../../config/pipelinePaths.js";
import { ApiUsageRepository } from "../../repositories/ApiUsageRepository.js";
import { buildCostSummary } from "./buildCostSummary.js";
import type { CostSummary } from "./buildCostSummary.js";

/** 이번 달 + 최근 7일을 모두 덮으려면 40일이면 충분하다(달 초에도 7일 창이 온전히 들어온다). */
const LOOKBACK_DAYS = 40;

export type WriteCostSnapshotResult =
  | { status: "success"; path: string; summary: CostSummary }
  | { status: "failed"; error: string };

export async function writeCostSnapshot(now: Date = new Date()): Promise<WriteCostSnapshotResult> {
  try {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const rows = await ApiUsageRepository.listSince(since);
    const summary = buildCostSummary({ rows, fixedCosts: listFixedCosts(), now });

    const path = manuscriptCostSnapshotPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    return { status: "success", path, summary };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
