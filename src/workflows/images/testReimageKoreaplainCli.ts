// koreaplain 소급 교체 도구 테스트(2026-11-10). 라이브 API·DB·Blogger·Pages·LLM 호출 없음 - 전부 가짜 의존성이다.
//
// 가장 중요한 단정은 둘이다.
//   1. --apply 없이는 Blogger·Pages·DB·Storage에 **한 번도 쓰지 않는다**(이벤트 로그에 쓰기 이벤트가 0건).
//   2. 백업이 본문 패치·Pages 배포보다 **먼저** 저장된다(이벤트 순서).
// 실행 시 SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY는 더미여야 한다(import 체인이 클라이언트를 만든다 - 호출은 하지 않는다).

import { KOREAPLAIN_TRACK } from "../../config/koreaplainTrack.js";
import type { RehostResult } from "../../services/images/rehostImagesToPages.js";
import type { ManuscriptImage } from "../manuscripts/manuscriptManifest.js";
import { AI_ILLUSTRATION_CREDIT, toIllustrationCaption } from "./koreaplainImageSources.js";
import {
  buildReimagePrompt,
  generateReplacementImages,
  listFigureSrcs,
  parseReimageDecisions,
  reimageJob,
  runReimage,
  selectReimageJobs,
  selectReimageTargets,
  swapFigureImages,
} from "./reimageKoreaplain.js";
import type { GenerateSlot, ReimageDeps, ReimageJob } from "./reimageKoreaplain.js";

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
};

function makeEnv(
  jobs: ReimageJob[],
  options: {
    /** 자리 번호 -> skip 사유. 나머지는 프롬프트를 낸다. */
    skip?: Record<string, Record<number, string>>;
    failGenerateFor?: string;
  } = {}
): Env {
  const events: string[] = [];
  const html = new Map(jobs.map((job) => [job.id, htmlOf(job)]));
  const metadata = new Map<string, Record<string, unknown>>();
  const generateCalls: Env["generateCalls"] = [];
  let active = 0;
  let maxActive = 0;
  let asks = 0;
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
          url: `https://sb.test/${job.id}/${slot.index}.webp?v=new`,
          provider: "openai",
          fileName: `${slot.index}.webp`,
          error: null,
        })),
        failures: [],
      };
    },
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
    log: () => {},
  };
  return { deps, events, html, metadata, maxActiveRehost: () => maxActive, generateCalls, askCount: () => asks };
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

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
