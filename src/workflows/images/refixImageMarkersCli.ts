// 규칙을 어긴 이미지 마커만 다시 설계해 원고에 반영한다(맥 로컬 전용 - claude CLI가 필요하다).
//
// 기본은 **미리보기**다. 실제 DB 갱신은 --apply를 붙일 때만 한다(CLAUDE.md 승인 게이트 - 원격 DB
// 쓰기는 사용자 승인이 필요하다. 먼저 before/after를 보여주고 승인을 받는 절차를 도구에 박아 둔다).
//
// 갱신 대상 세 곳(셋이 어긋나면 다음 실행에서 옛 마커가 되살아난다):
//   1. articles.content (platform=blogspot 행)  - 원본
//   2. article_jobs.metadata.imagePrompts        - 마커와 순서로 짝지어지는 프롬프트
//   3. manuscript_manifest_topics.channels[0]    - 뷰어·내보내기가 읽는 사본
//
// 사용법:
//   npm run images:refix -- <jobId>           제안만 보기(DB 안 건드림)
//   npm run images:refix -- --date 2026-09-16 그 날짜 전체 미리보기
//   npm run images:refix -- <jobId> --apply   실제 반영
import "dotenv/config";

import { ArticleJobRepository } from "../../repositories/ArticleJobRepository.js";
import { supabase } from "../../services/supabase/client.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { exportManuscript } from "../manuscripts/exportManuscript.js";
import { loadManifest, saveManifest } from "../manuscripts/manuscriptManifest.js";
import type { ManuscriptTopicEntry } from "../manuscripts/manuscriptManifest.js";
import { applyMarkerFixes, findMarkerViolations, proposeMarkerFixes } from "./refixImageMarkers.js";
import type { MarkerFix } from "./refixImageMarkers.js";

const BLOGSPOT_PLATFORM = "blogspot";

function selectTopics(topics: ManuscriptTopicEntry[], args: string[]): ManuscriptTopicEntry[] {
  const dateIndex = args.indexOf("--date");
  if (dateIndex >= 0) {
    const date = args[dateIndex + 1];
    if (!date) throw new Error("--date 다음에 날짜(YYYY-MM-DD)가 필요합니다.");
    return topics.filter((t) => t.date === date);
  }
  const jobId = args.find((a) => !a.startsWith("--") && !/^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!jobId) throw new Error("사용법: npm run images:refix -- <jobId> [--apply] (또는 --date YYYY-MM-DD)");
  return topics.filter((t) => t.jobId === jobId);
}

/** blogspot 원고 행의 본문을 갈아끼운다. 이 행이 manifest body의 원본이다(prepareManuscript 참고). */
async function updateBlogspotArticleBody(jobId: string, body: string): Promise<string | null> {
  const articles = await listArticlesByJobId(jobId);
  const target = [...articles].reverse().find((a) => a.platform === BLOGSPOT_PLATFORM);
  if (!target) return "blogspot 원고 행을 찾지 못했습니다(아직 준비 전인 job일 수 있습니다).";

  const { error } = await supabase.from("articles").update({ content: body }).eq("id", target.id);
  return error ? `articles 갱신 실패: ${error.message}` : null;
}

function printFixes(topic: ManuscriptTopicEntry, fixes: MarkerFix[]): void {
  for (const fix of fixes) {
    console.log(`\n   [자리 ${fix.index}] ${fix.rule === "screen_capture" ? "§8-2 화면 캡처" : "§8-3 특정 일시 현장"}`);
    console.log(`   - 이전: ${fix.before.description}`);
    if (fix.before.prompt) console.log(`           ${fix.before.prompt}`);
    console.log(`   + 이후: ${fix.after.description}`);
    console.log(`           ${fix.after.prompt.replace(/\n/g, "\n           ")}`);
    if (fix.reason) console.log(`     이유: ${fix.reason}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const manifest = await loadManifest();
  const targets = selectTopics(manifest.topics, args);
  if (targets.length === 0) {
    console.log("해당하는 원고를 manifest에서 찾지 못했습니다.");
    return;
  }

  console.log(apply ? "▶ 모드: 실제 반영(--apply)\n" : "▶ 모드: 미리보기 (실제로 바꾸려면 --apply)\n");

  let totalFixes = 0;

  for (const topic of targets) {
    const violations = findMarkerViolations(topic.manuscript.body, topic.manuscript.imagePrompts);
    console.log(`▶ ${topic.date} / ${topic.keyword}`);
    if (violations.length === 0) {
      console.log("   규칙을 어긴 마커가 없습니다.\n");
      continue;
    }

    console.log(`   위반 ${violations.length}자리 - 새 마커를 설계하는 중...`);
    const { fixes, rejected, error } = await proposeMarkerFixes({ keyword: topic.keyword, violations });
    if (error) {
      console.log(`   ⚠️ 설계 실패: ${error}\n`);
      continue;
    }

    for (const r of rejected) console.log(`   ⚠️ [자리 ${r.index}] 제안을 버렸습니다: ${r.reason}`);

    if (fixes.length === 0) {
      console.log("   그대로 둡니다(다시 실행하면 새로 설계합니다).\n");
      continue;
    }

    printFixes(topic, fixes);
    totalFixes += fixes.length;

    if (!apply) {
      console.log("");
      continue;
    }

    const next = applyMarkerFixes(topic.manuscript.body, topic.manuscript.imagePrompts, fixes);

    const articleError = await updateBlogspotArticleBody(topic.jobId, next.body);
    if (articleError) {
      console.log(`   ⚠️ ${articleError} - 이 원고는 건너뜁니다(세 곳이 어긋나면 안 됩니다).\n`);
      continue;
    }
    await ArticleJobRepository.mergeMetadata(topic.jobId, { imagePrompts: next.imagePrompts });

    const updated: ManuscriptTopicEntry = {
      ...topic,
      manuscript: { ...topic.manuscript, body: next.body, imagePrompts: next.imagePrompts },
    };
    await saveManifest({ topics: [updated] });
    await exportManuscript(updated);

    console.log(`   ✅ 반영 완료(articles·job.metadata·manifest) + 보관함 갱신\n`);
  }

  if (totalFixes === 0) return;
  console.log(
    apply
      ? "바뀐 자리를 채우려면: npm run images:collect -- <jobId>  (AI 생성 자리는 다음 원고 준비 때 생성됩니다)"
      : "이대로 반영하려면 같은 명령에 --apply를 붙이세요."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
