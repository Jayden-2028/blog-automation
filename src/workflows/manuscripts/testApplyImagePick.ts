// 후보 이미지 클릭 교체 계산부·적용부 + 수정 진행 가드 테스트. 실행: npm run test:viewer-image-pick
// DB·네트워크를 쓰지 않는다(적용부는 가짜 저장소를 주입한다).
//
// 지켜야 할 것:
//  ① 요청 검사 - UUID·번호 범위. 클라이언트 URL은 필드로 존재하지 않는다.
//  ② 후보는 DB 기록에서 번호로 찾는다. 없는 번호는 중단.
//  ③ fromUrl이 지금 채택본과 다르면 중단(경합) - 빈 자리는 ""와 맞는다.
//  ④ 성공: 그 슬롯만 url/provider/sourcePage/error 갱신, 캡션 유지, picked 이동, manifest 동기화, 배포 1회.
//  ⑤ 실패(다운로드 403·너무 작음·업로드 실패): DB 이미지는 그대로, imagePick에 failed 기록, 텔레그램 알림.
//  ⑥ 접수 표식이 가장 먼저 쓰이고, 끝나면 imagePick.at이 그 뒤 시각이라 가드가 풀린다.
//  ⑦ 긴 세로 이미지는 자르고, 못 자르면 원본으로 간다.
//  ⑧ 가드: pending -> stale(10분) -> idle 전이, 두 종류(viewerEdit/imagePick).
import {
  applyImagePick,
  movePicked,
  parseImagePickRequest,
  resolvePick,
  validatePicked,
} from "./applyImagePick.js";
import type { ApplyImagePickDeps } from "./applyImagePick.js";
import { readEditPending } from "./viewerEditGuard.js";
import type { ImageCandidateRecord, ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "054bfe0b-1234-4abc-8def-0123456789ab";
const OLD_URL = "https://x.supabase.co/storage/v1/object/public/article-images/j/1-web.jpg?v=aaa";

const CANDS: Record<string, ImageCandidateRecord[]> = {
  "1": [
    { number: 1, url: "https://a.example/1.jpg", sourcePage: "https://a.example/p1", picked: true },
    { number: 2, url: "https://b.example/2.jpg", sourcePage: "https://b.example/p2" },
    { number: 3, url: "https://c.example/3.jpg", sourcePage: "https://c.example/p3" },
  ],
  "2": [{ number: 1, url: "https://d.example/x.jpg", sourcePage: "https://d.example/p", picked: true }],
};

function image(index: number, url: string | null): ManuscriptImage {
  return { index, description: `캡션${index}`, prompt: null, url, provider: "web", fileName: `0${index}-a.jpg`, sourcePage: "https://a.example/p1", license: "공식" };
}

function makeJob(over: Record<string, unknown> = {}): ArticleJobRow {
  return {
    id: JOB_ID,
    keyword: "테스트 키워드",
    metadata: { images: [image(1, OLD_URL), image(2, "https://x.supabase.co/2.jpg")], imageCandidates: CANDS, ...over },
  } as unknown as ArticleJobRow;
}

function makeTopic(job: ArticleJobRow): ManuscriptTopicEntry {
  return {
    jobId: JOB_ID,
    keyword: "테스트 키워드",
    category: null,
    date: "2026-10-07",
    readyAt: "2026-10-07T00:00:00Z",
    manuscript: {
      title: "t", searchDescription: null, slug: null, tags: [], body: "", imagePrompts: [], filePath: "",
      images: (job.metadata as { images: ManuscriptImage[] }).images,
      imageCandidates: CANDS,
    },
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);

type Calls = { events: string[]; metadata: Record<string, unknown>[]; topics: ManuscriptTopicEntry[]; published: number; notified: string[]; uploads: number };

function makeDeps(job: ArticleJobRow, over: Partial<ApplyImagePickDeps> = {}): { deps: ApplyImagePickDeps; calls: Calls } {
  const topic = makeTopic(job);
  const calls: Calls = { events: [], metadata: [], topics: [], published: 0, notified: [], uploads: 0 };
  const deps: ApplyImagePickDeps = {
    loadJob: async () => job,
    loadManifest: async () => ({ topics: [topic] }) as ManuscriptManifest,
    fetchImage: async () => ({ ok: true, buffer: JPEG, contentType: "image/jpeg" }),
    readSize: () => ({ width: 1600, height: 900 }),
    cropTall: async () => ({ ok: false, error: "no chromium" }),
    upload: async () => { calls.uploads += 1; calls.events.push("upload"); return { ok: true, url: "https://x.supabase.co/new.webp?v=bbb" }; },
    mergeJobMetadata: async (_id, patch) => { calls.events.push(`meta:${Object.keys(patch).join(",")}`); calls.metadata.push(patch); },
    saveTopic: async (t) => { calls.events.push("save"); calls.topics.push(t); },
    publishPage: async () => { calls.events.push("publish"); calls.published += 1; },
    isPublished: async () => false,
    notify: async (_j, text) => { calls.notified.push(text); },
    now: (() => { let n = 0; return () => new Date(Date.UTC(2026, 9, 7, 0, 0, n++)); })(),
    ...over,
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  // ① 요청 검사
  const ok = parseImagePickRequest({ jobId: JOB_ID, index: 2, candidateNumber: 3, fromUrl: OLD_URL, url: "https://evil.example/x.png" });
  assert(ok.index === 2 && ok.candidateNumber === 3 && !("url" in ok), "정상 요청 + 클라이언트 url 버림");
  for (const bad of [{ jobId: "x", index: 1, candidateNumber: 1 }, { jobId: JOB_ID, index: 0, candidateNumber: 1 }, { jobId: JOB_ID, index: 1, candidateNumber: 1.5 }, null]) {
    let threw = false;
    try { parseImagePickRequest(bad); } catch { threw = true; }
    assert(threw, `잘못된 요청 거절: ${JSON.stringify(bad)}`);
  }
  console.log("✅ 요청 검사");

  // ②③ 후보 해석·경합
  const imgs = [image(1, OLD_URL), image(2, null)];
  const r1 = resolvePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, CANDS, imgs);
  assert(r1.ok && r1.candidate.url === "https://b.example/2.jpg", "후보를 번호로 찾는다");
  assert(!resolvePick({ jobId: JOB_ID, index: 1, candidateNumber: 9, fromUrl: OLD_URL }, CANDS, imgs).ok, "없는 후보 번호 중단");
  assert(!resolvePick({ jobId: JOB_ID, index: 3, candidateNumber: 1, fromUrl: "" }, CANDS, imgs).ok, "후보 없는 자리 중단");
  const race = resolvePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: "https://old.example/stale.jpg" }, CANDS, imgs);
  assert(!race.ok && race.reason.includes("바뀌었"), "fromUrl 불일치는 경합으로 중단");
  const empty = resolvePick({ jobId: JOB_ID, index: 2, candidateNumber: 1, fromUrl: "" }, CANDS, imgs);
  assert(empty.ok, "빈 자리는 fromUrl 빈 문자열과 맞는다");
  assert(!resolvePick({ jobId: JOB_ID, index: 1, candidateNumber: 1, fromUrl: OLD_URL }, { "1": [{ number: 1, url: "javascript:alert(1)", sourcePage: "" }] }, imgs).ok, "http(s) 아닌 주소 거절");
  console.log("✅ 후보 해석·경합 검사");

  // 파일 검사·picked 이동
  assert(!validatePicked({ byteLength: 0, contentType: "image/jpeg", size: null }).ok, "빈 파일");
  assert(!validatePicked({ byteLength: 1000, contentType: "text/html", size: null }).ok, "HTML 응답 거절");
  assert(!validatePicked({ byteLength: 1000, contentType: "image/jpeg", size: { width: 300, height: 200 } }).ok, "너무 작음");
  assert(validatePicked({ byteLength: 1000, contentType: "image/webp", size: null }).ok, "크기를 못 읽어도(webp·avif) 통과");
  const moved = movePicked(CANDS, 1, 3);
  assert(moved["1"].filter((c) => c.picked).map((c) => c.number).join() === "3", "picked가 3번으로 이동");
  assert(moved["2"][0].picked === true, "다른 자리는 그대로");
  console.log("✅ 파일 검사·picked 이동");

  // ④ 성공 경로
  {
    const job = makeJob();
    const { deps, calls } = makeDeps(job);
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 3, fromUrl: OLD_URL }, deps);
    assert(out.status === "applied", `성공 (${JSON.stringify(out)})`);
    assert(calls.events[0].startsWith("meta:imagePickPendingAt"), "접수 표식이 가장 먼저");
    const finalPatch = calls.metadata[calls.metadata.length - 1] as { images: ManuscriptImage[]; imageCandidates: typeof CANDS; imagePick: { status: string } };
    const slot1 = finalPatch.images.find((i) => i.index === 1)!;
    assert(slot1.url === "https://x.supabase.co/new.webp?v=bbb" && slot1.provider === "web" && slot1.error === null, "슬롯 url·provider·error 갱신");
    assert(slot1.sourcePage === "https://c.example/p3", "출처가 새 후보의 것");
    assert(slot1.description === "캡션1", "캡션 유지");
    assert(finalPatch.images.find((i) => i.index === 2)!.url === "https://x.supabase.co/2.jpg", "다른 슬롯은 그대로");
    assert(finalPatch.imageCandidates["1"].find((c) => c.picked)?.number === 3, "picked 이동(DB)");
    assert(finalPatch.imagePick.status === "done", "완료 기록");
    const t = calls.topics[0].manuscript;
    assert(t.images.find((i) => i.index === 1)!.url === "https://x.supabase.co/new.webp?v=bbb" && t.imageCandidates!["1"].find((c) => c.picked)?.number === 3 && t.imagePick?.status === "done", "manifest 동기화");
    assert(calls.published === 1, "배포 1회");
    assert(calls.events.indexOf("save") > calls.events.findIndex((e) => e.startsWith("meta:images")), "DB가 먼저, 뷰어 사본이 나중");
    assert(calls.notified.length === 0, "정상 교체는 텔레그램 알림 없음(준비 완료 알림 재발송 금지)");
    // ⑥ 가드: 접수 -> 완료
    const merged = { ...(job.metadata as Record<string, unknown>), ...calls.metadata[0], ...finalPatch };
    assert(readEditPending(merged, Date.UTC(2026, 9, 7, 0, 0, 30)).state === "idle", "완료 후 가드 해제");
    assert(readEditPending({ ...(job.metadata as Record<string, unknown>), ...calls.metadata[0] }, Date.UTC(2026, 9, 7, 0, 0, 30)).state === "pending", "접수 직후엔 pending");
    console.log("✅ 성공 경로");
  }

  // 빈 자리 채우기
  {
    const job = makeJob({ images: [image(2, "https://x.supabase.co/2.jpg")] });
    const { deps, calls } = makeDeps(job);
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: "" }, deps);
    assert(out.status === "applied", "metadata.images에 슬롯이 없어도(빈 자리) 채운다");
    const patch = calls.metadata[calls.metadata.length - 1] as { images: ManuscriptImage[] };
    assert(patch.images.map((i) => i.index).join() === "1,2", "슬롯 추가·정렬");
    console.log("✅ 빈 자리 채우기");
  }

  // 이미 발행된 글
  {
    const { deps, calls } = makeDeps(makeJob(), { isPublished: async () => true });
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, deps);
    assert(out.status === "applied" && out.record.alreadyPublished === true, "발행본 미반영 표시");
    assert(calls.notified.length === 1 && calls.notified[0].includes("이미 발행"), "발행된 글이면 안내 알림");
    console.log("✅ 이미 발행된 글");
  }

  // ⑤ 실패 경로
  {
    const job = makeJob();
    const { deps, calls } = makeDeps(job, { fetchImage: async () => ({ ok: false, error: "HTTP 403" }) });
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, deps);
    assert(out.status === "failed" && out.reason.includes("403"), "다운로드 실패");
    assert(calls.uploads === 0, "업로드 안 함");
    assert(!calls.metadata.some((p) => "images" in p), "DB 이미지는 건드리지 않는다");
    const rec = calls.metadata[calls.metadata.length - 1] as { imagePick: { status: string; error: string } };
    assert(rec.imagePick.status === "failed" && rec.imagePick.error.includes("403"), "실패 기록");
    assert(calls.topics[0].manuscript.imagePick?.status === "failed", "manifest에 오류 기록(뷰어가 보여준다)");
    assert(calls.notified.length === 1 && calls.notified[0].includes("이미지 수정"), "텔레그램 안내 - 다른 후보/재수집");
    assert(readEditPending({ ...(job.metadata as Record<string, unknown>), ...calls.metadata[0], ...rec }, Date.UTC(2026, 9, 7, 0, 0, 30)).state === "idle", "실패해도 가드는 풀린다");
    console.log("✅ 다운로드 실패");
  }
  {
    const { deps, calls } = makeDeps(makeJob(), { readSize: () => ({ width: 200, height: 200 }) });
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, deps);
    assert(out.status === "failed" && calls.uploads === 0, "너무 작은 후보는 업로드 전에 중단");
  }
  {
    const { deps } = makeDeps(makeJob(), { upload: async () => ({ ok: false, error: "quota" }) });
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, deps);
    assert(out.status === "failed" && out.reason.includes("quota"), "업로드 실패");
  }
  {
    const { deps, calls } = makeDeps(makeJob());
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: "https://stale.example/old.jpg" }, deps);
    assert(out.status === "failed" && !calls.metadata.some((p) => "images" in p), "경합이면 아무것도 덮어쓰지 않는다");
  }
  {
    const { deps, calls } = makeDeps(makeJob(), { notify: async () => { throw new Error("telegram down"); } });
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 9, fromUrl: OLD_URL }, deps);
    assert(out.status === "failed" && calls.published === 1, "알림이 죽어도 실패 처리·기록은 끝까지 간다");
  }
  console.log("✅ 실패 경로(작음·업로드·경합·알림 오류)");

  // ⑦ 긴 세로
  {
    let cropped = 0;
    const { deps, calls } = makeDeps(makeJob(), {
      readSize: () => ({ width: 1000, height: 6000 }),
      cropTall: async () => { cropped += 1; return { ok: true, buffer: JPEG, mimeType: "image/jpeg", width: 1000, height: 1333 }; },
    });
    const out = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, deps);
    assert(out.status === "applied" && cropped === 1 && calls.uploads === 1, "긴 세로는 자르고 올린다");
    const { deps: d2 } = makeDeps(makeJob(), { readSize: () => ({ width: 1000, height: 6000 }) });
    const out2 = await applyImagePick({ jobId: JOB_ID, index: 1, candidateNumber: 2, fromUrl: OLD_URL }, d2);
    assert(out2.status === "applied", "자르지 못해도 원본으로 진행");
    console.log("✅ 긴 세로 이미지");
  }

  // ⑧ 가드 전이
  {
    const t0 = Date.UTC(2026, 9, 7, 0, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    assert(readEditPending({}, t0).state === "idle", "표식 없으면 idle");
    assert(readEditPending({ viewerEditPendingAt: iso(t0) }, t0 + 60_000).state === "pending", "viewerEdit 진행 중");
    assert(readEditPending({ viewerEditPendingAt: iso(t0), viewerEdit: { appliedAt: iso(t0 + 30_000) } }, t0 + 60_000).state === "idle", "appliedAt이 뒤면 끝남");
    assert(readEditPending({ viewerEditPendingAt: iso(t0), viewerEdit: { appliedAt: iso(t0 - 5_000) } }, t0 + 60_000).state === "pending", "이전 appliedAt은 이번 요청의 완료가 아님");
    const stale = readEditPending({ viewerEditPendingAt: iso(t0) }, t0 + 11 * 60_000);
    assert(stale.state === "stale", "10분 넘으면 stale(차단 해제)");
    assert(readEditPending({ imagePickPendingAt: iso(t0) }, t0 + 60_000).state === "pending", "imagePick 진행 중");
    assert(readEditPending({ imagePickPendingAt: iso(t0), viewerEditPendingAt: iso(t0 - 20 * 60_000) }, t0 + 60_000).state === "pending", "하나라도 진짜 진행 중이면 pending 우선");
    assert(readEditPending({ viewerEditPendingAt: "garbage" }, t0).state === "idle", "깨진 값은 막지 않는다");
    console.log("✅ 가드 전이");
  }

  console.log("\n✅ testApplyImagePick 전체 통과");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
