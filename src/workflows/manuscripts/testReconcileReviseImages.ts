// ✏️ 수정의 이미지 마커 diff 테스트(PIPELINE-MERGE-2026-10.md §1-c). 실행: npm run test:revise-images
import { applyUnifiedRevision } from "../writing/applyUnifiedRevision.js";
import { diffImageMarkers, extractImageMarkers, planReviseImages } from "./reconcileReviseImages.js";
import { parseRevisionOutput } from "../writing/reviseArticleWithFeedback.js";
import type { ManuscriptImage } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const body = (markers: string[], text = "본문") =>
  markers.map((m, i) => `${text} ${i + 1} 문단입니다.\n\n[IMAGE: ${m}]\n[IMAGE PROMPT: 프롬프트 ${i + 1}]`).join("\n\n");

// ---- 추출 / diff ----
assert(extractImageMarkers(body(["가", "나", "다"])).join("|") === "가|나|다", "마커 설명을 순서대로 뽑는다([IMAGE PROMPT:]는 마커가 아니다)");
assert(extractImageMarkers("마커 없는 글").length === 0, "마커가 없으면 빈 배열");
const same = diffImageMarkers(["가", "나"], ["가", "나"]);
assert(same.unchanged && same.changedIndexes.length === 0, "같으면 unchanged");
const edited = diffImageMarkers(["가", "나", "다"], ["가", "나2", "다"]);
assert(!edited.unchanged && edited.changedIndexes.join() === "2" && !edited.countChanged, "같은 개수에서 설명이 바뀐 자리만");
const added = diffImageMarkers(["가", "나"], ["가", "신규", "나"]);
assert(added.countChanged && added.firstChanged === 2 && added.changedIndexes.join() === "2,3", "중간에 추가되면 처음 달라진 자리부터 뒤쪽");
const appended = diffImageMarkers(["가", "나"], ["가", "나", "신규"]);
assert(appended.changedIndexes.join() === "3", "끝에 추가되면 새 자리만");
const removed = diffImageMarkers(["가", "나", "다"], ["가", "나"]);
assert(removed.countChanged && removed.changedIndexes.length === 0 && removed.firstChanged === 3, "끝을 지우면 갱신할 자리는 없고 뒤 이미지만 버린다");
console.log("✅ 마커 추출 / diff 5가지");

// ---- 계획 ----
const image = (index: number): ManuscriptImage => ({
  index, description: `설명${index}`, prompt: null, url: `https://img/${index}.png`, provider: "web", fileName: `${index}.png`,
});
const current = {
  images: [image(1), image(2), image(3)],
  imagePrompts: ["프롬프트 1", "프롬프트 2", "프롬프트 3"],
  imageCandidates: { "1": [], "2": [], "3": [] },
  imageRequirements: { "2": "정면 사진", "3": "AI로" },
  imageDirectUrls: { "3": "https://x/y.jpg" },
};

// 불변: 이미지·게이트를 건드리지 않는다.
{
  const before = body(["가", "나", "다"]);
  const plan = planReviseImages(before, before.replace("본문 2", "다듬은 본문 2"), current);
  assert(plan.kind === "keep", "마커가 같으면 이미지 유지(keep)");
}
// 같은 개수 + 2번 설명 변경: 2번만 비우고 1·3번 이미지는 그대로, 게이트를 열어 재수집.
{
  const plan = planReviseImages(body(["가", "나", "다"]), body(["가", "나-수정", "다"]), current);
  assert(plan.kind === "refresh", "refresh");
  if (plan.kind !== "refresh") throw new Error("unreachable");
  const images = plan.patch.images as ManuscriptImage[];
  assert(images.find((i) => i.index === 1)?.url && images.find((i) => i.index === 3)?.url, "바뀌지 않은 1·3번은 그대로");
  assert(images.find((i) => i.index === 2)?.url === null, "바뀐 2번만 비운다");
  assert(plan.patch.channelManuscriptsReadyAt === null && plan.patch.webImagesReadyAt === null, "재수집 게이트 열림(기존 이미지수정 경로)");
  assert((plan.patch.imagePrompts as string[]).join("|") === "프롬프트 1|나-수정|프롬프트 3", "프롬프트 길이는 마커 수와 같고, 바뀐 자리만 새 설명");
  assert(!("2" in ((plan.patch.imageRequirements as Record<string, string>) ?? {})) && (plan.patch.imageRequirements as Record<string, string>)["3"] === "AI로", "바뀐 자리의 요구사항만 버리고 나머지는 유지");
  assert(plan.patch.imagePlan === null && plan.patch.planImagesGeneratedAt === null, "낡은 기획·AI생성 캐시는 비운다");
}
// 중간에 마커 추가: 앞쪽(1번)은 보존, 2번부터 갱신(파일 경로 덮어쓰기 방지).
{
  const plan = planReviseImages(body(["가", "나", "다"]), body(["가", "신규", "나", "다"]), current);
  if (plan.kind !== "refresh") throw new Error("refresh 기대");
  const images = plan.patch.images as ManuscriptImage[];
  assert(images.length === 1 && images[0].index === 1, "처음 달라진 자리 앞의 이미지만 남긴다");
  assert((plan.patch.imagePrompts as string[]).length === 4, "프롬프트 수 = 새 마커 수");
  assert(plan.patch.imageRequirements === null && plan.patch.imageDirectUrls === null, "2번 이후 번호 키는 모두 버린다(밀린 번호에 붙이지 않는다)");
}
console.log("✅ 계획 - 불변 keep / 같은 개수 부분 갱신 / 개수 변경 뒤쪽 갱신");

// ---- applyUnifiedRevision: 메타 패치 + 발화 ----
const job = (metadata: Record<string, unknown>) =>
  ({ id: "054bfe0b-5cf7-4386-941f-810146c25e12", keyword: "키워드", status: "approved", metadata } as unknown as ArticleJobRow);
{
  const patches: Record<string, unknown>[] = [];
  let dispatched = 0;
  const before = body(["가", "나"]);
  const out = await applyUnifiedRevision(job({ images: [image(1), image(2)], imagePrompts: ["프롬프트 1", "프롬프트 2"], channelManuscriptsReadyAt: "t", autoApprovedAt: "t" }), before, before + "\n\n끝에 한 줄", {
    mergeJobMetadata: async (_id, patch) => void patches.push(patch),
    dispatchPrepare: async () => void (dispatched += 1),
    now: () => new Date("2026-10-08T00:00:00Z"),
  });
  assert(out.dispatched && dispatched === 1 && out.plan.kind === "keep", "마커 불변: 발화 1회");
  assert(patches.length === 1 && patches[0].channelManuscriptsReadyAt === null, "준비 완료 표식만 비운다");
  assert(!("images" in patches[0]) && !("webImagesReadyAt" in patches[0]), "이미지·수집 게이트는 건드리지 않는다(재수집·재생성 없음)");
  assert(patches[0].reviewDecision === "confirmed" && patches[0].editRequestMessageId === null, "다음 ✏️를 받을 수 있게 되돌린다");
  assert(patches[0].lastRevisionImages === "kept", "추적 기록");
  console.log("✅ applyUnifiedRevision - 마커 불변이면 이미지 유지, 뷰어 재배포(prepare)만");
}
{
  const out = await applyUnifiedRevision(job({}), body(["가"]), body(["가"]), {
    mergeJobMetadata: async () => {},
    dispatchPrepare: async () => { throw new Error("403"); },
  });
  assert(!out.dispatched && out.error === "403", "발화 실패는 결과로 돌려준다(던지지 않는다)");
  console.log("✅ applyUnifiedRevision - 발화 실패는 결과로 반환");
}

// ---- revise 프롬프트: 마커 유지 지시 1줄이 들어 있다 ----
{
  let seen = "";
  const { reviseArticleWithFeedback } = await import("../writing/reviseArticleWithFeedback.js");
  await reviseArticleWithFeedback({
    keyword: "k", category: null, originalTitle: "t", originalBody: body(["가"]), feedback: "톤 낮춰줘", enforceRules: false,
    generate: async (prompt) => { seen = prompt; return { ok: true, output: "### TITLE\nt\n### BODY\n" + body(["가"], "충분히 긴 본문 ".repeat(40)) } as never; },
  });
  assert(seen.includes("위치·개수·내용을 그대로 유지"), "revise 프롬프트에 마커 유지 지시가 있어야 한다");
  assert(parseRevisionOutput("### TITLE\nT\n### BODY\n본문", "x").title === "T", "기존 파서는 그대로");
  console.log("✅ revise 프롬프트 - 이미지 마커 위치·개수·내용 유지 지시");
}
console.log("\n✅ testReconcileReviseImages 전체 통과");
