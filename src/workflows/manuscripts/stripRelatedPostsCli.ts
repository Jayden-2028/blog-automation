// 이미 원고에 들어간 "함께 보면 좋은 글" 블록을 걷어 낸다(2026-11-16 사용자 결정).
//
// 왜 필요한가: 준비 단계는 이제 이 블록을 붙이지 않지만(prepareManuscript), 2026-10-04~11-16 사이에
// 준비된 원고는 **블록이 붙은 본문이 DB(articles.content)에 저장돼 있다.** 그래서 다시 준비해도
// 되살아난다 - 실측 2건이 관계없는 글을 달고 있었다(기안84 원고에 유홍준, 남주혁·한소희 드라마 원고에
// 백제금동대향로. 점수 미달이어도 가장 가까운 하나는 남기는 pickRelatedPosts 설계 때문이다).
//
// **발행된 글은 건드리지 않는다**(사용자 결정은 "앞으로"다). publications에 published 행이 있으면
// 건너뛴다 - DB 본문만 바꿔도 발행본은 그대로여서 둘이 어긋나고, 티스토리 본문은 이 도구로 못 고친다.
//
// 세 곳을 함께 갱신한다(어긋나면 다음 실행에서 옛 본문이 되살아난다):
//   1. articles.content (기준 원고 행 - pickFinalArticle)
//   2. manuscript_manifest_topics (뷰어·내보내기가 읽는 사본)
//   3. manuscripts/<날짜>/<주제>.md (보관함)
//
// 기본은 **미리보기**다. 실제 DB 쓰기는 --apply를 붙일 때만 한다(CLAUDE.md 승인 게이트).
//
// 사용법:
//   npm run manuscripts:strip-related                      미발행 원고 전체 미리보기
//   npm run manuscripts:strip-related -- <jobId> [<jobId>]  그 job만 미리보기
//   npm run manuscripts:strip-related -- <jobId> --apply    실제 반영
//   npm run manuscripts:strip-related -- --all --apply      미발행 원고 전체 반영
//   npm run manuscripts:strip-related -- <jobId> --apply --no-deploy   뷰어 배포 생략
import "dotenv/config";

import { supabase } from "../../services/supabase/client.js";
import { listArticlesByJobId } from "../../services/supabase/repositories/articleRepository.js";
import { listPublicationsByArticleIds } from "../../services/supabase/repositories/publicationRepository.js";
import { RELATED_HEADING, removeRelatedPosts } from "./appendRelatedPosts.js";
import { exportManuscript } from "./exportManuscript.js";
import { loadManifest, saveManifest } from "./manuscriptManifest.js";
import type { ManuscriptTopicEntry } from "./manuscriptManifest.js";
import { pickFinalArticle } from "./pickFinalArticle.js";
import { writeManuscriptPages } from "./writeManuscriptPages.js";
import { deployManuscriptsPage } from "./deployManuscriptsPage.js";

type Outcome =
  | { status: "stripped"; jobId: string; keyword: string; articleId: number; removed: string }
  | { status: "skipped"; jobId: string; keyword: string; reason: string };

/**
 * 블록 안의 링크 제목만 한 줄로 뽑는다(무엇이 붙어 있었는지 로그에 남긴다).
 *
 * **경계는 stripExisting과 같아야 한다** - 제목 줄부터 다음 빈 줄까지다. 본문 끝까지 훑으면 바로 뒤의
 * "참고 자료" 링크아웃까지 "떼어낸다"고 찍혀, 지우지도 않은 것을 지웠다고 보고한다.
 */
function describeRemoved(body: string): string {
  const at = body.indexOf(RELATED_HEADING);
  if (at < 0) return "(블록 없음)";
  const rest = body.slice(at + RELATED_HEADING.length);
  const end = rest.indexOf("\n\n");
  const block = end < 0 ? rest : rest.slice(0, end);
  const titles = [...block.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
  return titles.length > 0 ? titles.join(" / ") : "(링크 없음)";
}

async function hasPublished(articleIds: number[]): Promise<boolean> {
  if (articleIds.length === 0) return false;
  const publications = await listPublicationsByArticleIds(articleIds);
  return publications.some((p) => p.status === "published");
}

async function stripOne(topic: ManuscriptTopicEntry, apply: boolean): Promise<Outcome> {
  const base = { jobId: topic.jobId, keyword: topic.keyword };
  const articles = await listArticlesByJobId(topic.jobId);
  const picked = pickFinalArticle(articles);
  if (!picked) return { ...base, status: "skipped", reason: "기준 원고 행이 없습니다" };

  // 발행본이 있으면 손대지 않는다. 기준 원고·배리에이션 양쪽의 발행 기록을 본다.
  const ids = [picked.base.id, ...(picked.legacyVariant ? [picked.legacyVariant.id] : [])];
  if (await hasPublished(ids)) return { ...base, status: "skipped", reason: "이미 발행된 글입니다" };

  const target = picked.final;
  const content = target.content ?? "";
  const next = removeRelatedPosts(content);
  const viewerNext = removeRelatedPosts(topic.manuscript.body);
  if (next === content && viewerNext === topic.manuscript.body) {
    return { ...base, status: "skipped", reason: "블록이 없습니다" };
  }

  const removed = describeRemoved(content) !== "(블록 없음)" ? describeRemoved(content) : describeRemoved(topic.manuscript.body);
  if (!apply) return { ...base, status: "stripped", articleId: target.id, removed };

  const { error } = await supabase.from("articles").update({ content: next }).eq("id", target.id);
  if (error) return { ...base, status: "skipped", reason: `articles 갱신 실패: ${error.message}` };

  const updated: ManuscriptTopicEntry = { ...topic, manuscript: { ...topic.manuscript, body: viewerNext } };
  await saveManifest({ topics: [updated] });
  await exportManuscript(updated);
  return { ...base, status: "stripped", articleId: target.id, removed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const deploy = apply && !args.includes("--no-deploy");
  const jobIds = args.filter((a) => /^[0-9a-f-]{36}$/.test(a));

  const manifest = await loadManifest();
  // 블록이 남아 있을 수 있는 원고만 본다 - 본문이든 뷰어 사본이든 제목 줄이 있으면 후보다.
  const targets =
    jobIds.length > 0
      ? manifest.topics.filter((t) => jobIds.includes(t.jobId))
      : manifest.topics.filter((t) => t.manuscript.body.includes(RELATED_HEADING));

  if (jobIds.length === 0 && !args.includes("--all") && targets.length > 1 && apply) {
    throw new Error(`대상이 ${targets.length}건입니다. 전체에 반영하려면 --all을 붙이세요.`);
  }
  if (targets.length === 0) {
    console.log("대상 원고가 없습니다(manifest에 블록이 남은 원고가 보이지 않습니다).");
    return;
  }

  console.log(apply ? "▶ 모드: 실제 반영(--apply)\n" : "▶ 모드: 미리보기 (실제로 바꾸려면 --apply)\n");

  const outcomes: Outcome[] = [];
  for (const topic of targets) {
    const outcome = await stripOne(topic, apply);
    outcomes.push(outcome);
    if (outcome.status === "stripped") {
      console.log(`✅ ${topic.date} / ${topic.keyword}`);
      console.log(`   떼어낸 링크: ${outcome.removed} (article ${outcome.articleId})`);
    } else {
      console.log(`· ${topic.date} / ${topic.keyword} - 건너뜀: ${outcome.reason}`);
    }
  }

  const stripped = outcomes.filter((o) => o.status === "stripped").length;
  console.log(`\n합계: 대상 ${targets.length} · ${apply ? "반영" : "반영 예정"} ${stripped}`);

  if (!apply) {
    console.log("이대로 반영하려면 같은 명령에 --apply를 붙이세요.");
    return;
  }
  if (stripped === 0 || !deploy) {
    if (stripped > 0) console.log("뷰어 배포는 생략했습니다(--no-deploy) - 다음 원고 준비 때 함께 올라갑니다.");
    return;
  }

  // 뷰어에서도 바로 사라지게 한다. 여러 건을 고쳐도 배포는 한 번이다(image-pick 드레인과 같은 방식).
  await writeManuscriptPages(await loadManifest());
  const result = await deployManuscriptsPage();
  if (result.status === "success") console.log(`✅ 뷰어 배포 완료: ${result.url}`);
  else if (result.status === "failed") console.warn(`⚠️ 뷰어 배포 실패(DB·보관함은 이미 반영됨): ${result.error}`);
  else console.log(`ℹ️ 뷰어 배포 건너뜀: ${result.reason}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
