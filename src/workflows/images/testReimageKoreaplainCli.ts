// koreaplain 소급 교체 도구 테스트(2026-11-10). 라이브 API·DB·Blogger·Pages·LLM 호출 없음 - 전부 가짜 의존성이다.
//
// 가장 중요한 단정은 둘이다.
//   1. --apply 없이는 Blogger·Pages·DB·Storage에 **한 번도 쓰지 않는다**(이벤트 로그에 쓰기 이벤트가 0건).
//   2. 백업이 본문 패치·Pages 배포보다 **먼저** 저장된다(이벤트 순서).
// 실행 시 SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY는 더미여야 한다(import 체인이 클라이언트를 만든다 - 호출은 하지 않는다).

import { existsSync, readFileSync } from "node:fs";
import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
import type { RehostResult } from "../../services/images/rehostImagesToPages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import { AI_ILLUSTRATION_CREDIT, toIllustrationCaption } from "./koreaplainImageSources.js";
import {
  buildReimagePrompt,
  buildRetryPrompt,
  captionForVerify,
  generateReplacementImages,
  listFigureSrcs,
  parseReimageDecisions,
  reimageJob,
  runReimage,
  runRestore,
  selectReimageJobs,
  selectReimageTargets,
  swapFigureImages,
} from "./reimageKoreaplain.js";
import type { GenerateSlot, ReimageBackup, ReimageDeps, ReimageJob, VerifyInput, VerifyResult } from "./reimageKoreaplain.js";
import { parseArgs } from "./reimageKoreaplainArgs.js";
import { validateAiPrompt } from "./refixImageMarkers.js";
import { buildVerifyPrompt, defaultVerifyDeps, parseVerifyVerdict, verifyImageWithClaude } from "./verifyReimagedImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const NEWS = "https://n.news.naver.com/article/001/0000000001";
const GOV = "https://www.seoul.go.kr/story/photo/1";
const WIKI = "https://commons.wikimedia.org/wiki/File:Seoul.jpg";
const GOOD_PROMPT = "photorealistic photograph of a busy subway platform in Korea, no text, no letters, 16:9";

const sbOld = (jobId: string, index: number) => `https://sb.test/${jobId}/${index}-web.jpg?v=old`;
const pagesOld = (jobId: string, index: number) => `https://pages.test/${jobId.slice(0, 8)}/${index}-old.jpg`;
const pagesNew = (jobId: string, index: number) => `https://pages.test/${jobId.slice(0, 8)}/${index}-new.webp`;

function image(jobId: string, index: number, sourcePage: string | null): ManuscriptImage {
  return {
    index,
    description: `Scene number ${index}. Photo: Naver News`,
    prompt: `검색어 ${index}`,
    url: sbOld(jobId, index),
    provider: null,
    fileName: `${index}-web.jpg`,
    error: null,
    sourcePage,
    license: sourcePage ? "출처 표기" : null,
    width: 800,
    height: 450,
  };
}

function figure(src: string, caption: string): string {
  return `<figure><img src="${src}" alt="${caption}" width="800" height="450" loading="lazy"><figcaption style="font-size:16px">${caption}</figcaption></figure>`;
}

function makeJob(id: string, sources: (string | null)[], category: string | null = KOREAPLAIN_TRACK): ReimageJob {
  const images = sources.map((source, i) => image(id, i + 1, source));
  return {
    id,
    keyword: `topic ${id}`,
    category,
    imagesRehostedAt: "2026-11-01T00:00:00Z",
    images,
    rehostedBySource: Object.fromEntries(images.map((img) => [img.url as string, pagesOld(id, img.index)])),
    hasBackup: false,
  };
}

function htmlOf(job: ReimageJob): string {
  return `<p>intro</p>${job.images.map((img) => figure(pagesOld(job.id, img.index), img.description)).join("<p>text</p>")}<p>end</p>`;
}

type Env = {
  deps: ReimageDeps;
  events: string[];
  html: Map<string, string>;
  metadata: Map<string, Record<string, unknown>>;
  maxActiveRehost: () => number;
  generateCalls: { jobId: string; slots: GenerateSlot[] }[];
  askCount: () => number;
  verifyCalls: VerifyInput[];
  maxActiveVerify: () => number;
  logs: string[];
};

function makeEnv(
  jobs: ReimageJob[],
  options: {
    /** 자리 번호 -> skip 사유. 나머지는 프롬프트를 낸다. */
    skip?: Record<string, Record<number, string>>;
    failGenerateFor?: string;
    /** 검증 가짜. 생략하면 전부 통과. n은 이 환경에서 verifyImage가 불린 순번(1부터). */
    verify?: (input: VerifyInput, n: number) => VerifyResult | Promise<VerifyResult>;
  } = {}
): Env {
  const events: string[] = [];
  const html = new Map(jobs.map((job) => [job.id, htmlOf(job)]));
  const metadata = new Map<string, Record<string, unknown>>();
  const generateCalls: Env["generateCalls"] = [];
  let active = 0;
  let maxActive = 0;
  let asks = 0;
  const verifyCalls: VerifyInput[] = [];
  const logs: string[] = [];
  let activeVerify = 0;
  let maxVerify = 0;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const jobOfPost = (postId: string) => postId.replace("post-", "");

  const deps: ReimageDeps = {
    listJobs: async () => jobs,
    findPostPath: async (jobId) => `/2026/11/${jobId}.html`,
    blogger: {
      findPostId: async (path) => `post-${path.split("/").pop()?.replace(".html", "")}`,
      getContent: async (postId) => {
        events.push(`blogger:get:${jobOfPost(postId)}`);
        return { ok: true, content: html.get(jobOfPost(postId)) as string };
      },
      patchContent: async (postId, next) => {
        events.push(`blogger:patch:${jobOfPost(postId)}`);
        html.set(jobOfPost(postId), next);
        return { ok: true };
      },
    },
    askPrompts: async (prompt) => {
      asks += 1;
      events.push("llm");
      const jobId = [...byId.keys()].find((id) => prompt.includes(`topic ${id}`)) as string;
      const indexes = [...prompt.matchAll(/### 자리 (\d+)/g)].map((m) => Number(m[1]));
      const items = indexes.map((index) => {
        const reason = options.skip?.[jobId]?.[index];
        return reason ? { index, action: "skip", reason } : { index, action: "prompt", prompt: GOOD_PROMPT };
      });
      return { ok: true, output: `알겠습니다.\n${JSON.stringify(items)}\n끝` };
    },
    generate: async (job, slots) => {
      events.push(`generate:${job.id}`);
      generateCalls.push({ jobId: job.id, slots });
      if (options.failGenerateFor === job.id) throw new Error("OpenAI 500");
      return {
        images: slots.map((slot) => ({
          index: slot.index,
          description: toIllustrationCaption(slot.description),
          prompt: slot.prompt,
          url: `https://sb.test/${job.id}/${slot.index}.webp?v=${generateCalls.length > 1 ? "retry" : "new"}`,
          provider: "openai",
          fileName: `${slot.index}.webp`,
          error: null,
        })),
        failures: [],
      };
    },
    verifyImage: async (input) => {
      verifyCalls.push(input);
      events.push(`verify:${input.imageUrl.split("/")[3]}:${input.index}`);
      activeVerify += 1;
      maxVerify = Math.max(maxVerify, activeVerify);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeVerify -= 1;
      return options.verify ? options.verify(input, verifyCalls.length) : { ok: true };
    },
    loadBackup: async (jobId) => (metadata.get(jobId)?.reimageBackup as ReimageBackup | null | undefined) ?? null,
    rehost: async (job, images): Promise<RehostResult> => {
      events.push(`rehost:start:${job.id}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      events.push(`rehost:end:${job.id}`);
      return {
        images: images.map((img) => ({ ...img, url: pagesNew(job.id, img.index), width: 1536, height: 864 })),
        rehosted: images.length,
        complete: true,
        deployed: true,
        failures: [],
      };
    },
    saveMetadata: async (jobId, patch) => {
      events.push(`db:${Object.keys(patch).join("+")}:${jobId}`);
      metadata.set(jobId, { ...(metadata.get(jobId) ?? {}), ...patch });
    },
    now: () => new Date("2026-11-10T12:00:00Z"),
    log: (line) => {
      logs.push(line);
    },
  };
  return { deps, events, html, metadata, maxActiveRehost: () => maxActive, generateCalls, askCount: () => asks, verifyCalls, maxActiveVerify: () => maxVerify, logs };
}

const WRITE_EVENT = /^(generate|rehost|blogger:patch|db:)/;

async function main(): Promise<void> {
  console.log("▶ koreaplain 소급 교체 도구 테스트 시작\n");

  // 1) 대상 선별
  {
    const job = makeJob("job-aaaaaaaa", [NEWS, GOV, WIKI, null, "https://blog.naver.com/someone/1", "https://m.news1.kr/a"]);
    const targets = selectReimageTargets(job).map((img) => img.index);
    assert(JSON.stringify(targets) === "[1,5,6]", `비공공 출처만 대상이어야 한다(실제: ${JSON.stringify(targets)})`);
    assert(!targets.includes(2) && !targets.includes(3), "화이트리스트(.go.kr·wikimedia) 통과 이미지는 교체 대상에 들어가면 안 된다");
    assert(!targets.includes(4), "sourcePage가 없는 생성 이미지는 대상이 아니다");
    const redone = { ...job, images: job.images.map((img) => (img.index === 1 ? { ...img, sourcePage: null } : img)) };
    assert(selectReimageTargets(redone).length === 2, "이미 교체된 자리(sourcePage=null)는 다시 선별되지 않아야 한다(멱등)");
    console.log("✅ 선별: 비공공 출처만, 화이트리스트·생성 이미지·교체 끝난 자리는 제외");
  }

  // 2) 다른 트랙은 선별되지 않는다 - 목록 단계와 처리 단계 둘 다
  {
    const kp = makeJob("job-kp000001", [NEWS]);
    const ent = makeJob("job-ent00001", [NEWS], "entertainment");
    const social = makeJob("job-soc00001", [NEWS], "social");
    const unrehosted = { ...makeJob("job-raw00001", [NEWS]), imagesRehostedAt: null };
    const picked = selectReimageJobs([kp, ent, social, unrehosted]).map((job) => job.id);
    assert(JSON.stringify(picked) === '["job-kp000001"]', `koreaplain 발행본만 선별해야 한다(실제: ${JSON.stringify(picked)})`);

    const env = makeEnv([ent, social]);
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(summary.outcomes.length === 0 && env.events.length === 0, "다른 트랙 글은 LLM·Blogger·생성 어디도 호출하지 않아야 한다");
    const direct = await reimageJob(ent, env.deps, { apply: true });
    assert(direct.jobError !== null && env.events.length === 0, "처리 함수에 직접 넘겨도 다른 트랙은 거부해야 한다");
    console.log("✅ 다른 트랙(entertainment·social)·미이전 글은 선별되지 않고, 직접 넘겨도 거부");
  }

  // 3) dry-run: 쓰기 0건
  {
    const job = makeJob("job-dry00001", [NEWS, GOV, "https://m.news1.kr/a"]);
    const env = makeEnv([job], { skip: { "job-dry00001": { 3: "글자·숫자가 정보인 자리: 요금표" } } });
    const summary = await runReimage(env.deps, { apply: false, jobPrefix: null, limit: null });
    const writes = env.events.filter((event) => WRITE_EVENT.test(event));
    assert(writes.length === 0, `--apply 없이는 Blogger·Pages·DB·Storage에 쓰면 안 된다(실제: ${writes.join(", ")})`);
    assert(env.metadata.size === 0 && env.html.get(job.id) === htmlOf(job), "dry-run은 본문도 메타도 그대로여야 한다");
    assert(env.generateCalls.length === 0, "dry-run은 이미지를 생성하면 안 된다(유료·Storage 쓰기)");
    assert(summary.replaced === 1 && summary.skipped === 1 && summary.failed === 0, `dry-run 계획이 교체 1·건너뜀 1이어야 한다(실제: ${summary.replaced}/${summary.skipped}/${summary.failed})`);
    assert(env.askCount() === 1, "글 하나에 LLM 호출은 한 번이어야 한다");
    console.log("✅ dry-run: 쓰기 이벤트 0건, 생성 0건, 본문·메타 불변, LLM 1회");
  }

  // 4) skip -> 원본 URL 유지 / 5) 백업 순서 / 6) 캡션 / 9) 메타
  {
    const job = makeJob("job-app00001", [NEWS, "https://m.news1.kr/a", "https://blog.example.com/x"]);
    const before = htmlOf(job);
    const env = makeEnv([job], { skip: { "job-app00001": { 2: "글자·숫자가 정보인 자리: 층수 버튼" } } });
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(summary.replaced === 2 && summary.skipped === 1 && summary.failed === 0, `교체 2·건너뜀 1이어야 한다(실제: ${summary.replaced}/${summary.skipped}/${summary.failed})`);

    // skip: 원본 유지
    assert(env.generateCalls[0].slots.every((slot) => slot.index !== 2), "skip 받은 자리는 생성 요청에 들어가면 안 된다");
    const html = env.html.get(job.id) as string;
    assert(html.includes(pagesOld(job.id, 2)), "skip 받은 자리는 본문의 원본 URL이 그대로여야 한다");
    assert(html.includes("Scene number 2. Photo: Naver News"), "skip 받은 자리의 캡션(출처 표기)도 그대로여야 한다");
    const meta = env.metadata.get(job.id) as { images: ManuscriptImage[]; rehostedBySource: Record<string, string>; reimageBackup: { at: string; images: ManuscriptImage[]; html: string } };
    const skipped = meta.images.find((img) => img.index === 2) as ManuscriptImage;
    assert(skipped.url === sbOld(job.id, 2) && skipped.sourcePage === "https://m.news1.kr/a", "skip 자리의 metadata.images는 그대로여야 한다");
    console.log("✅ skip: 생성에서 빠지고, 본문 URL·캡션·메타가 원본 그대로");

    // 백업 순서
    const at = (prefix: string) => env.events.findIndex((event) => event.startsWith(prefix));
    const backupAt = at("db:reimageBackup");
    assert(backupAt >= 0, "reimageBackup이 저장돼야 한다");
    assert(backupAt < at("rehost:start") && backupAt < at("blogger:patch") && backupAt < env.events.findIndex((e) => e.startsWith("db:images")), "백업은 Pages 배포·본문 패치·메타 갱신보다 먼저 저장돼야 한다");
    assert(meta.reimageBackup.html === before, "백업 html은 교체 전 Blogger 본문이어야 한다");
    assert(JSON.stringify(meta.reimageBackup.images) === JSON.stringify(job.images), "백업 images는 교체 전 metadata.images 전체여야 한다");
    assert(meta.reimageBackup.at === "2026-11-10T12:00:00.000Z", "백업 시각이 기록돼야 한다");
    console.log("✅ 백업: Pages 배포·패치·메타 갱신보다 먼저, 교체 전 images 전체 + 본문 HTML");

    // 캡션
    assert((html.match(/Photo:/g) ?? []).length === 2, "Photo: 는 skip한 자리의 alt·figcaption(2건)에만 남아야 한다 - 교체된 자리에는 0건");
    const replacedFigures = [1, 3].map((i) => new RegExp(`<figure>(?:(?!</figure>)[\\s\\S])*${pagesNew(job.id, i).replace(/[.?]/g, "\\$&")}[\\s\\S]*?</figure>`).exec(html)?.[0] ?? "");
    for (const fig of replacedFigures) {
      assert(fig !== "", "교체된 <figure>를 찾아야 한다");
      assert(!/Photo:/i.test(fig), `교체된 figure에 Photo: 가 남았다: ${fig}`);
      assert(fig.includes(`. ${AI_ILLUSTRATION_CREDIT}</figcaption>`), "교체된 figcaption이 Illustration: AI-generated로 끝나야 한다");
      assert(fig.includes(`alt="Scene number`) && fig.includes(AI_ILLUSTRATION_CREDIT) && /alt="[^"]*Illustration: AI-generated"/.test(fig), "alt도 일러스트 캡션이어야 한다");
      assert(fig.includes('width="1536"') && fig.includes('height="864"') && !fig.includes('width="800"'), "치수는 새 이미지 기준으로 바뀌어야 한다");
      assert(fig.includes('loading="lazy"') && fig.includes('style="font-size:16px"'), "치수·캡션 외 속성과 스타일은 보존돼야 한다");
    }
    assert(!html.includes(pagesOld(job.id, 1)) && !html.includes(pagesOld(job.id, 3)), "교체된 자리의 옛 Pages URL이 본문에 남으면 안 된다");
    assert(html.startsWith("<p>intro</p>") && html.endsWith("<p>end</p>") && html.includes("<p>text</p>"), "figure 밖 본문은 한 글자도 바뀌면 안 된다");
    console.log("✅ 캡션: Photo: 제거 + Illustration: AI-generated, src·alt·치수 갱신, figure 밖 본문 불변");

    // 메타
    const replaced1 = meta.images.find((img) => img.index === 1) as ManuscriptImage;
    assert(replaced1.url === `https://sb.test/${job.id}/1.webp?v=new`, "url은 새 Supabase 원본이어야 한다(파이프라인 약속)");
    assert(replaced1.sourcePage === null && replaced1.license === null, "sourcePage·license는 null이어야 한다");
    assert(replaced1.provider === "openai" && replaced1.prompt === GOOD_PROMPT, "provider·prompt가 새 값이어야 한다");
    assert(replaced1.width === 1536 && replaced1.height === 864, "치수가 새 값이어야 한다");
    assert(replaced1.description.endsWith(AI_ILLUSTRATION_CREDIT) && !/Photo:/.test(replaced1.description), "description도 일러스트 캡션이어야 한다(재발행 때 Photo:가 되살아나면 안 된다)");
    assert(meta.rehostedBySource[replaced1.url as string] === pagesNew(job.id, 1), "rehostedBySource에 새 대응이 있어야 한다");
    assert(!(sbOld(job.id, 1) in meta.rehostedBySource), "교체된 자리의 옛 대응은 빠져야 한다");
    assert(meta.rehostedBySource[sbOld(job.id, 2)] === pagesOld(job.id, 2), "skip 자리의 대응은 그대로여야 한다");
    assert(selectReimageTargets({ images: meta.images }).length === 1, "교체 뒤 다시 선별하면 skip 자리만 남아야 한다");
    console.log("✅ 메타: url·prompt·provider·치수 갱신, sourcePage·license null, rehostedBySource 대응 교체");
  }

  // 7) 직렬: 두 글에서 Pages 배포가 겹치지 않는다
  {
    const a = makeJob("job-ser00001", [NEWS, NEWS]);
    const b = makeJob("job-ser00002", [NEWS]);
    const c = makeJob("job-ser00003", [NEWS]);
    const env = makeEnv([a, b, c]);
    await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(env.maxActiveRehost() === 1, `Pages 배포가 동시에 둘 이상 돌면 안 된다(최대 동시 ${env.maxActiveRehost()})`);
    const order = env.events.filter((event) => event.startsWith("rehost:") || event.startsWith("blogger:patch"));
    assert(
      JSON.stringify(order) ===
        JSON.stringify([
          "rehost:start:job-ser00001", "rehost:end:job-ser00001", "blogger:patch:job-ser00001",
          "rehost:start:job-ser00002", "rehost:end:job-ser00002", "blogger:patch:job-ser00002",
          "rehost:start:job-ser00003", "rehost:end:job-ser00003", "blogger:patch:job-ser00003",
        ]),
      `글 하나가 끝난 뒤에 다음 글이 시작해야 한다(실제: ${order.join(" > ")})`
    );
    assert(env.generateCalls.every((call) => call.slots.length >= 1), "글당 생성 호출은 한 번이어야 한다");
    console.log("✅ 직렬: 세 글의 Pages 배포가 겹치지 않고 글 단위로 끝까지 간 뒤 다음 글");
  }

  // 8) 실패 격리 + --job + --limit
  {
    const a = makeJob("job-bad00001", [NEWS]);
    const b = makeJob("job-bad00002", [NEWS]);
    const env = makeEnv([a, b], { failGenerateFor: "job-bad00001" });
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(summary.outcomes.length === 2, "한 글이 실패해도 다음 글을 처리해야 한다");
    assert(summary.failedJobs.length === 1 && summary.failedJobs[0].jobId === "job-bad00001", "실패 목록에 실패한 글이 있어야 한다");
    assert(summary.replaced === 1 && (env.html.get("job-bad00002") as string).includes(pagesNew("job-bad00002", 1)), "뒤 글은 정상 교체돼야 한다");
    assert(!env.events.some((event) => event === "db:reimageBackup:job-bad00001") && env.html.get("job-bad00001") === htmlOf(a), "생성에 실패한 글은 백업도 패치도 하지 않는다(아무것도 안 바뀜)");

    const env2 = makeEnv([a, b]);
    const one = await runReimage(env2.deps, { apply: false, jobPrefix: "job-bad00002", limit: null });
    assert(one.outcomes.length === 1 && one.outcomes[0].jobId === "job-bad00002", "--job은 접두사로 한 글만 처리해야 한다");
    const lim = await runReimage(makeEnv([a, b]).deps, { apply: false, jobPrefix: null, limit: 1 });
    assert(lim.outcomes.length === 1, "--limit은 처리 건수 상한이어야 한다");
    console.log("✅ 실패 격리(다음 글 계속·실패 목록), --job 접두사, --limit");
  }

  // 10) 본문에 대상 figure가 없으면 생성 전에 멈춘다 / 기존 백업은 덮지 않는다
  {
    const job = makeJob("job-nof00001", [NEWS]);
    const env = makeEnv([job]);
    env.html.set(job.id, "<p>no figure here</p>");
    const outcome = await reimageJob(job, env.deps, { apply: true });
    assert(outcome.failed.length === 1 && env.events.every((event) => !WRITE_EVENT.test(event)) && env.askCount() === 0, "본문에서 이미지를 못 찾으면 LLM·생성 비용 없이 실패로 끝나야 한다");

    const withBackup = { ...makeJob("job-bak00001", [NEWS]), hasBackup: true };
    const env2 = makeEnv([withBackup]);
    await reimageJob(withBackup, env2.deps, { apply: true });
    assert(!env2.events.some((event) => event.startsWith("db:reimageBackup")), "기존 reimageBackup은 덮어쓰지 않아야 한다(첫 백업이 원본에 가장 가깝다)");
    console.log("✅ 본문에 figure 없음 → 비용 전에 중단, 기존 백업은 보존");
  }

  // 11) 생성 어댑터: 신규 원고와 같은 경로를 쓰고 일러스트 캡션·low 화질
  {
    const qualities: (string | undefined)[] = [];
    const result = await generateReplacementImages(
      { id: "job-gen00001", keyword: "topic" },
      [{ index: 4, description: "Crowd at the airport. Photo: Yonhap News", prompt: GOOD_PROMPT }],
      {
        generate: async (input) => {
          qualities.push(input.quality);
          return { ok: true, imageBuffer: Buffer.from("x"), mimeType: "image/png", model: "gpt-image-2", usage: { inputTokens: 1, outputTokens: 1 } } as never;
        },
        upload: async (input) => ({ ok: true, url: `https://sb.test/${input.jobId}/${input.index}.webp`, path: `${input.jobId}/${input.index}.webp` }),
        record: async () => undefined as never,
      }
    );
    assert(result.images.length === 1 && result.images[0].index === 4, "본문 없이도 자리 번호(index)를 그대로 지켜 생성해야 한다");
    assert(result.images[0].description === `Crowd at the airport. ${AI_ILLUSTRATION_CREDIT}`, `캡션이 일러스트 표기여야 한다(실제: ${result.images[0].description})`);
    assert(qualities.length === 1 && qualities[0] === "low", `화질은 low로 고정이어야 한다(실제: ${qualities[0]})`);
    assert(result.images[0].url === "https://sb.test/job-gen00001/4.webp", "업로드 경로(jobId/index)를 그대로 쓴다 - 원본 `-web` 파일을 덮지 않는다");
    console.log("✅ 생성 어댑터: generateManuscriptImages 재사용, index 보존, low 화질, 일러스트 캡션");
  }

  // 12) 판정 파서·프롬프트·HTML 도우미
  {
    const parsed = parseReimageDecisions(`네.\n[{"index":1,"action":"prompt","prompt":"a  b\\nc"},{"index":2,"action":"skip","reason":"요금표"},{"index":"x","action":"skip"},{"index":3,"action":"prompt"}]\n끝`);
    assert(parsed.size === 2 && JSON.stringify(parsed.get(1)) === '{"kind":"prompt","prompt":"a b c"}', "프롬프트 한 줄 정리");
    assert(parsed.get(2)?.kind === "skip", "skip 판정을 읽어야 한다");
    assert(parseReimageDecisions("JSON 아님").size === 0 && parseReimageDecisions("[깨진").size === 0, "깨진 응답은 빈 결과");

    const prompt = buildReimagePrompt("seoul subway", [image("job-p", 7, NEWS)]);
    for (const needle of ["skip", "글자·숫자", "요금표", "노선도", "no text", "16:9", "### 자리 7", "한글·일본어 가나", "실존 인물"]) {
      assert(prompt.includes(needle), `LLM 프롬프트에 "${needle}" 기준이 있어야 한다`);
    }

    const html = `<figure><img src="https://a.test/x?a=1&amp;b=2" alt="x"><figcaption>cap. Photo: X</figcaption></figure><img src="https://a.test/bare.jpg">`;
    assert(listFigureSrcs(html).has("https://a.test/x?a=1&b=2"), "src의 &amp;를 풀어 비교해야 한다");
    const swapped = swapFigureImages(html, [
      { oldSrc: "https://a.test/x?a=1&b=2", newSrc: "https://p.test/n.webp", caption: "New <b>. Illustration: AI-generated" },
      { oldSrc: "https://a.test/bare.jpg", newSrc: "https://p.test/z.webp", caption: "z" },
    ]);
    assert(swapped.replaced.length === 1 && swapped.missing[0] === "https://a.test/bare.jpg", "figure 밖 <img>는 건드리지 않고 missing으로 보고해야 한다");
    assert(swapped.html.includes("New &lt;b&gt;. Illustration") && !swapped.html.includes("Photo:"), "캡션은 이스케이프해 넣고 옛 표기는 사라져야 한다");
    console.log("✅ 판정 파서·LLM 프롬프트 기준(skip·글자숫자·실존 인물)·HTML 치환 도우미");
  }

  // 13) 내용 검증: 통과 -> 지금까지와 똑같이 교체. 검증은 백업·배포·패치보다 먼저, 직렬.
  {
    const job = makeJob("job-ver00001", [NEWS, "https://m.news1.kr/a"]);
    const env = makeEnv([job]);
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(summary.replaced === 2 && summary.failed === 0 && env.generateCalls.length === 1, `검증 통과면 교체 2·실패 0·생성 1회여야 한다(실제: ${summary.replaced}/${summary.failed}/${env.generateCalls.length})`);
    assert(env.verifyCalls.length === 2, "생성된 자리마다 검증이 한 번씩 불려야 한다");
    assert(env.verifyCalls.every((call) => /\?v=new$/.test(call.imageUrl) && call.prompt === GOOD_PROMPT), "검증에는 생성된 이미지 URL과 생성 프롬프트가 넘어가야 한다");
    assert(env.verifyCalls[0].caption === "Scene number 1" && !env.verifyCalls.some((call) => /Photo:|Illustration:/.test(call.caption)), `캡션은 출처·일러스트 표기를 뗀 독자용 문장이어야 한다(실제: ${env.verifyCalls[0].caption})`);
    const at = (prefix: string) => env.events.findIndex((event) => event.startsWith(prefix));
    const lastVerify = env.events.map((event, i) => (event.startsWith("verify:") ? i : -1)).filter((i) => i >= 0).pop() as number;
    assert(lastVerify < at("db:reimageBackup") && lastVerify < at("rehost:start") && lastVerify < at("blogger:patch"), "검증은 백업·Pages 배포·본문 패치보다 먼저 끝나야 한다");
    assert(at("generate:") < at("verify:"), "검증은 생성 직후다");
    assert(env.maxActiveVerify() === 1, "검증도 직렬이다(동시에 둘 이상 돌면 안 된다)");
    assert(env.logs.filter((line) => line.includes("검증 통과")).length === 2, "자리마다 통과 한 줄이 로그에 남아야 한다");
    assert(captionForVerify("Gift desk. Illustration: AI-generated") === "Gift desk", "일러스트 표기는 검증 캡션에서 빠져야 한다");
    console.log("✅ 검증 통과: 교체는 그대로, 검증은 생성 직후·백업/배포/패치 전·직렬, 자리마다 로그");
  }

  // 14) 1회 실패 후 재생성 통과
  {
    const job = makeJob("job-ret00001", [NEWS, "https://m.news1.kr/a", "https://blog.example.com/x"]);
    const FUNERAL = "Shows a funeral hall (black suits, white chrysanthemums); must be a bright wedding hall.";
    const env = makeEnv([job], { verify: (input, n) => (n === 2 ? { ok: false, reason: FUNERAL } : { ok: true }) });
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(env.generateCalls.length === 2, `생성은 정확히 2번(처음 + 재생성 1회)이어야 한다(실제: ${env.generateCalls.length})`);
    assert(env.generateCalls[0].slots.length === 3 && JSON.stringify(env.generateCalls[1].slots.map((slot) => slot.index)) === "[2]", "재생성은 틀린 자리만 묶어 한 번에 불러야 한다");
    const retryPrompt = env.generateCalls[1].slots[0].prompt;
    assert(retryPrompt.includes(GOOD_PROMPT) && retryPrompt.includes("previous attempt was rejected") && retryPrompt.includes("funeral hall") && retryPrompt.includes("wedding hall"), `재생성 프롬프트에 원 프롬프트와 실패 사유가 들어가야 한다(실제: ${retryPrompt})`);
    assert(validateAiPrompt(retryPrompt) === null, "재생성 프롬프트도 규격(영어·no text·비율)을 지켜야 한다");
    assert(env.verifyCalls.length === 4 && env.verifyCalls[3].imageUrl.endsWith("?v=retry") && env.verifyCalls[3].prompt === retryPrompt, "재생성분도 같은 검증을 받아야 한다(재생성 프롬프트로)");
    assert(summary.replaced === 3 && summary.failed === 0, `재생성이 통과하면 3장 모두 교체돼야 한다(실제: ${summary.replaced}/${summary.failed})`);
    const meta = env.metadata.get(job.id) as { images: ManuscriptImage[] };
    assert((meta.images.find((img) => img.index === 2) as ManuscriptImage).url === `https://sb.test/${job.id}/2.webp?v=retry`, "교체된 자리 2는 재생성분 URL이어야 한다");
    assert(env.logs.some((line) => line.includes("자리 2 검증 실패 → 재생성 1회") && line.includes("funeral")) && env.logs.some((line) => line.includes("자리 2 재생성분 검증 통과")), "재시도 사유와 재생성 통과가 로그에 남아야 한다");
    assert(buildRetryPrompt("p, no text, 16:9", "한글만 있는 사유") .includes("rejected for not matching") && validateAiPrompt(buildRetryPrompt("photorealistic photograph, no text, 16:9", "장례식")) === null, "한글뿐인 사유도 영어 프롬프트 규격을 깨지 않아야 한다");
    console.log("✅ 검증 1회 실패 → 재생성(틀린 자리만 한 번에, 사유 포함) 통과 → 교체");
  }

  // 15) 2회 실패: 그 자리는 원본 유지 + failed에 사유, 같은 글의 통과한 자리는 정상 교체
  {
    const job = makeJob("job-two00001", [NEWS, "https://m.news1.kr/a", "https://blog.example.com/x"]);
    const before = htmlOf(job);
    const env = makeEnv([job], {
      verify: (input) => (input.index === 2 ? { ok: false, reason: input.imageUrl.endsWith("retry") ? "still a funeral" : "shows a funeral" } : { ok: true }),
    });
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(env.generateCalls.length === 2, "재생성은 딱 한 번이다(세 번째 생성 금지)");
    assert(summary.replaced === 2 && summary.failed === 1, `통과한 2장은 교체, 실패 1장이어야 한다(실제: ${summary.replaced}/${summary.failed})`);
    const outcome = summary.outcomes[0];
    assert(outcome.failed.length === 1 && outcome.failed[0].index === 2 && outcome.failed[0].reason.includes("shows a funeral") && outcome.failed[0].reason.includes("still a funeral"), `failed에 1차·2차 사유가 남아야 한다(실제: ${JSON.stringify(outcome.failed)})`);
    const html = env.html.get(job.id) as string;
    assert(html.includes(pagesOld(job.id, 2)) && html.includes("Scene number 2. Photo: Naver News"), "실패한 자리는 본문의 원본 URL·캡션이 그대로여야 한다");
    assert(html.includes(pagesNew(job.id, 1)) && html.includes(pagesNew(job.id, 3)), "같은 글의 통과한 자리는 교체돼야 한다");
    const meta = env.metadata.get(job.id) as { images: ManuscriptImage[]; rehostedBySource: Record<string, string>; reimageBackup: { html: string } };
    const kept = meta.images.find((img) => img.index === 2) as ManuscriptImage;
    assert(JSON.stringify(kept) === JSON.stringify(job.images[1]), "실패한 자리의 metadata.images는 한 글자도 안 바뀌어야 한다");
    assert(meta.rehostedBySource[sbOld(job.id, 2)] === pagesOld(job.id, 2), "실패한 자리의 rehostedBySource 대응도 그대로여야 한다");
    assert(meta.reimageBackup.html === before, "백업은 교체 전 본문이어야 한다");
    assert(env.logs.some((line) => line.includes("자리 2 검증 최종 실패") && line.includes("still a funeral")), "최종 실패 사유가 로그에 남아야 한다");
    console.log("✅ 검증 2회 실패: 그 자리만 원본 유지·failed 사유, 같은 글의 통과분은 교체");
  }

  // 16) 모든 자리가 실패하면 백업·배포·패치를 한 번도 안 부른다
  {
    const job = makeJob("job-all00001", [NEWS, "https://m.news1.kr/a"]);
    const env = makeEnv([job], { verify: () => ({ ok: false, reason: "wrong scene" }) });
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    const writes = env.events.filter((event) => /^(rehost|blogger:patch|db:)/.test(event));
    assert(writes.length === 0, `전부 실패하면 백업·Pages 배포·Blogger 패치·메타 저장이 한 번도 없어야 한다(실제: ${writes.join(", ")})`);
    assert(summary.replaced === 0 && summary.failed === 2 && env.generateCalls.length === 2, "교체 0·실패 2·생성 2회(처음+재생성)");
    assert(env.html.get(job.id) === htmlOf(job) && env.metadata.size === 0, "본문·메타 불변");
    console.log("✅ 전부 검증 실패: 백업·Pages·Blogger·메타 쓰기 0건");
  }

  // 17) dry-run: verifyImage 호출 0 + 검증 단계 켜짐 한 줄
  {
    const job = makeJob("job-dr200001", [NEWS]);
    const env = makeEnv([job]);
    await runReimage(env.deps, { apply: false, jobPrefix: null, limit: null });
    assert(env.verifyCalls.length === 0 && env.generateCalls.length === 0, "dry-run은 생성도 검증도 하지 않는다");
    assert(env.logs.some((line) => line.includes("내용 검증: 켜짐")), "dry-run 로그에 '검증 단계가 켜져 있다'는 한 줄이 있어야 한다");
    console.log("✅ dry-run: 검증 호출 0, '내용 검증: 켜짐' 로그");
  }

  // 18) 검증을 못 돌린 경우(던짐): 재생성 없이 원본 유지
  {
    const job = makeJob("job-unv00001", [NEWS, "https://m.news1.kr/a"]);
    const env = makeEnv([job], {
      verify: (input) => {
        if (input.index === 1) throw new Error("claude 로그인 만료");
        return { ok: true };
      },
    });
    const summary = await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    assert(env.generateCalls.length === 1, "검증 불가는 재생성하지 않는다(돈 낭비)");
    assert(summary.replaced === 1 && summary.failed === 1 && summary.outcomes[0].failed[0].reason.includes("검증 불가") && summary.outcomes[0].failed[0].reason.includes("로그인 만료"), "검증 불가 사유로 실패에 남고 나머지는 교체돼야 한다");
    assert((env.html.get(job.id) as string).includes(pagesOld(job.id, 1)), "검증 불가 자리는 원본 유지");
    console.log("✅ 검증 불가(던짐): 재생성 없이 원본 유지, 나머지 자리는 계속");
  }

  // 19) 되돌리기: --apply
  {
    const job = makeJob("job-rst00001", [NEWS, "https://m.news1.kr/a"]);
    const before = htmlOf(job);
    const env = makeEnv([job]);
    await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    const replacedMeta = env.metadata.get(job.id) as { reimageBackup: ReimageBackup };
    assert(env.html.get(job.id) !== before && Boolean(replacedMeta.reimageBackup), "되돌리기 전제: 교체돼 있고 백업이 있다");
    env.events.length = 0;

    const result = await runRestore(env.deps, { apply: true, jobPrefix: "job-rst" });
    assert(result.restored && result.jobError === null, `되돌리기가 성공해야 한다(실제: ${JSON.stringify(result)})`);
    assert(env.html.get(job.id) === before, "본문이 백업 html과 정확히 같아야 한다");
    const meta = env.metadata.get(job.id) as { images: ManuscriptImage[]; rehostedBySource: Record<string, string>; reimageBackup?: unknown };
    assert(JSON.stringify(meta.images) === JSON.stringify(job.images), "metadata.images가 백업과 정확히 같아야 한다");
    assert(JSON.stringify(meta.rehostedBySource) === JSON.stringify(job.rehostedBySource), "rehostedBySource가 백업과 정확히 같아야 한다");
    assert(meta.reimageBackup == null && (await env.deps.loadBackup(job.id)) === null, "되돌린 뒤 reimageBackup은 지워져야 한다(남기면 다음 교체 때 새 백업이 안 찍힌다)");
    assert(env.events.filter((event) => event.startsWith("blogger:patch")).length === 1 && !env.events.some((event) => /^(generate|rehost|llm|verify)/.test(event)), "되돌리기는 패치 1번과 메타 저장뿐이다(생성·Pages·LLM·검증 없음)");
    assert(selectReimageTargets({ images: meta.images }).length === 2, "복원 뒤에는 다시 교체 대상이 된다");
    console.log("✅ --restore --apply: 본문·images·rehostedBySource가 백업과 동일, reimageBackup 삭제, 다른 쓰기 없음");
  }

  // 20) 되돌리기: --apply 없이(dry-run) = 쓰기 0건
  {
    const job = makeJob("job-rd200001", [NEWS]);
    const env = makeEnv([job]);
    await runReimage(env.deps, { apply: true, jobPrefix: null, limit: null });
    const htmlAfter = env.html.get(job.id) as string;
    const metaAfter = JSON.stringify(env.metadata.get(job.id));
    env.events.length = 0;
    const result = await runRestore(env.deps, { apply: false, jobPrefix: "job-rd2" });
    assert(!result.restored && result.jobError === null, "dry-run 되돌리기는 정상 종료하되 restored=false");
    assert(env.events.filter((event) => WRITE_EVENT.test(event)).length === 0, "--apply 없는 되돌리기는 쓰기가 0건이어야 한다");
    assert(env.html.get(job.id) === htmlAfter && JSON.stringify(env.metadata.get(job.id)) === metaAfter, "본문·메타 불변");
    console.log("✅ --restore (apply 없음): 쓰기 0건, 본문·메타·백업 불변");
  }

  // 21) 되돌리기: 백업 없음 / 다른 트랙 / 접두사 모호 -> 아무것도 안 한다
  {
    const job = makeJob("job-nob00001", [NEWS]);
    const env = makeEnv([job]);
    const none = await runRestore(env.deps, { apply: true, jobPrefix: "job-nob" });
    assert(!none.restored && Boolean(none.jobError) && none.jobError?.includes("백업"), `백업이 없으면 사유를 남기고 끝나야 한다(실제: ${JSON.stringify(none)})`);
    assert(env.events.filter((event) => WRITE_EVENT.test(event)).length === 0 && env.html.get(job.id) === htmlOf(job), "백업이 없으면 아무것도 쓰지 않는다");

    const ent = makeJob("job-ent00009", [NEWS], "entertainment");
    const env2 = makeEnv([ent]);
    env2.metadata.set(ent.id, { reimageBackup: { at: "x", images: [], html: "<p>x</p>", rehostedBySource: {} } });
    const other = await runRestore(env2.deps, { apply: true, jobPrefix: "job-ent" });
    assert(!other.restored && env2.events.length === 0, "다른 트랙은 되돌리기 대상이 아니다");

    const a = makeJob("job-amb00001", [NEWS]);
    const b = makeJob("job-amb00002", [NEWS]);
    const env3 = makeEnv([a, b]);
    const ambiguous = await runRestore(env3.deps, { apply: true, jobPrefix: "job-amb" });
    assert(!ambiguous.restored && Boolean(ambiguous.jobError) && env3.events.length === 0, "접두사가 여러 글과 맞으면 거부해야 한다");
    console.log("✅ --restore: 백업 없음·다른 트랙·접두사 모호 → 아무것도 하지 않음");
  }

  // 22) 인자: --restore는 --job 없이 거부, 교체 경로로 가지 않는다
  {
    const job = makeJob("job-arg00001", [NEWS]);
    const env = makeEnv([job]);
    assert(typeof parseArgs(["--restore"]) === "string" && typeof parseArgs(["--restore", "--apply"]) === "string", "--restore를 --job= 없이 주면 인자 오류여야 한다");
    assert(typeof parseArgs(["--restore", "--job=job-arg", "--limit=1"]) === "string", "--restore에 --limit은 오류");
    const ok = parseArgs(["--restore", "--job=JOB-ARG"]);
    assert(typeof ok !== "string" && ok.restore && !ok.apply && ok.jobPrefix === "job-arg", "--restore --job=…는 dry-run 되돌리기로 읽혀야 한다");
    const apply = parseArgs(["--job=job-arg", "--restore", "--apply"]);
    assert(typeof apply !== "string" && apply.restore && apply.apply, "--restore --apply");
    const plain = parseArgs(["--apply", "--limit=2"]);
    assert(typeof plain !== "string" && !plain.restore && plain.limit === 2, "기존 인자는 그대로 읽혀야 한다");
    let threw = false;
    try {
      await runRestore(env.deps, { apply: true, jobPrefix: null });
    } catch {
      threw = true;
    }
    assert(threw && env.events.length === 0 && env.askCount() === 0, "runRestore는 --job 없이는 던지고 아무것도 호출하지 않는다");
    await runRestore(env.deps, { apply: true, jobPrefix: "job-arg" });
    assert(env.askCount() === 0 && env.generateCalls.length === 0, "--restore는 교체 경로(LLM·생성)로 가지 않는다");
    console.log("✅ 인자: --restore는 --job 필수, --limit 불가, 교체 경로로 안 간다");
  }

  // 23) 실제 검증기: 임시 디렉터리·Read만 허용·정리, 판정 해석
  {
    assert(parseVerifyVerdict('좋아요\n{"ok": true}')?.ok === true, "통과 응답을 읽어야 한다");
    const failVerdict = parseVerifyVerdict('{"ok": false, "reason": "Shows a funeral\\n   hall"}');
    assert(failVerdict && !failVerdict.ok && failVerdict.reason === "Shows a funeral hall", "실패 응답의 사유를 한 줄로 읽어야 한다");
    assert(parseVerifyVerdict("글쎄요") === null && parseVerifyVerdict('{"ok":"maybe"}') === null && parseVerifyVerdict("{깨진") === null, "해석할 수 없는 응답은 null(호출자가 던진다)");

    const prompt = buildVerifyPrompt({ fileName: "slot-4.webp", caption: "Cash gift reception desk at a wedding hall entrance", prompt: GOOD_PROMPT });
    for (const needle of ["slot-4.webp", "Read", "Cash gift reception desk", "장례식장", "흰 국화", "결혼식", "명절", "제사", "지하철", "기차", "글자·숫자", "실존 인물", "로고", "손가락", "애매하면 실패", '{"ok": true}', '"ok": false']) {
      assert(prompt.includes(needle), `검증 프롬프트에 "${needle}"가 있어야 한다`);
    }

    const seen: { cwd?: string; tools?: string[]; fileExisted?: boolean; fileBytes?: string; prompt?: string } = {};
    let removed: string | null = null;
    const base = defaultVerifyDeps();
    const deps = {
      ...base,
      fetchImage: async () => ({ bytes: new Uint8Array(Buffer.from("fake-webp-bytes")), contentType: "image/webp" }),
      runClaude: async (options: { prompt: string; allowedTools?: string[]; cwd?: string }) => {
        seen.cwd = options.cwd;
        seen.tools = options.allowedTools;
        seen.prompt = options.prompt;
        const file = `${options.cwd}/slot-4.webp`;
        seen.fileExisted = existsSync(file);
        seen.fileBytes = seen.fileExisted ? readFileSync(file, "utf8") : "";
        return { ok: true as const, output: '{"ok": false, "reason": "Shows a funeral"}', durationMs: 1 };
      },
      removeDir: async (dir: string) => {
        removed = dir;
        await base.removeDir(dir);
      },
    };
    const verdict = await verifyImageWithClaude({ index: 4, imageUrl: "https://sb.test/j/4.webp?v=new", caption: "Gift desk", prompt: GOOD_PROMPT }, deps);
    assert(!verdict.ok && verdict.reason === "Shows a funeral", "판정이 그대로 돌아와야 한다");
    assert(JSON.stringify(seen.tools) === '["Read"]', "Read 도구만 허용해야 한다");
    assert(Boolean(seen.cwd) && seen.cwd === removed && seen.cwd !== process.cwd(), "임시 디렉터리를 cwd로 쓰고 그 디렉터리를 지워야 한다");
    assert(seen.fileExisted === true && seen.fileBytes === "fake-webp-bytes" && seen.prompt?.includes("slot-4.webp"), "판정 시점에 이미지 파일이 임시 디렉터리에 있고 프롬프트가 파일 이름을 가리켜야 한다");
    assert(!existsSync(seen.cwd as string), "판정 뒤 임시 디렉터리(파일 포함)가 지워져야 한다");

    let dirOnFailure = "";
    const failing = {
      ...deps,
      runClaude: async (options: { cwd?: string }) => {
        dirOnFailure = options.cwd as string;
        return { ok: false as const, error: "claude 종료 코드 1", durationMs: 1 };
      },
    };
    let threw = "";
    try {
      await verifyImageWithClaude({ index: 4, imageUrl: "https://sb.test/j/4.webp", caption: "x", prompt: GOOD_PROMPT }, failing);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    assert(threw.includes("종료 코드 1") && !existsSync(dirOnFailure), "claude 실행이 실패하면 던지고, 그래도 임시 디렉터리는 지워야 한다");
    console.log("✅ 실제 검증기: 임시 디렉터리 파일 → Read만 허용한 claude, 판정 해석, 실패해도 정리");
  }

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
