// 제미나이 집필에 보여 줄 **발행본 예시**(2026-11-19 사용자 결정 - "예시 5편 넣기").
//
// 처음엔 zero-base(우리 규칙 0)였다. 사용자가 실제로 발행한 인물 글 5편을 집필 단계에 예시로 보여 주기로 바꿨다.
// 모델을 학습시키는 것이 아니라(구독 CLI는 파인튜닝이 없다) **매 집필 프롬프트에 함께 넣는 것**이다.
// 우리 규격 문서(researcher.md·writer.md·core-rules.md·style·rules·seo-guide)는 여전히 넣지 않는다 -
// 비교 축은 "규칙으로 쓰게 한 글" 대 "발행본만 보고 쓴 제미나이 글"이다. 조사 단계에는 예시를 주지 않는다.
//
// ⚠️ **글 전문을 저장소에 두지 않는다.** 저장소가 공개(PUBLIC)라, 커밋하면 GitHub 사본이 네이버 원문과
// 유사문서로 잡힐 수 있다. 그래서 글 번호만 두고 맥미니가 실행할 때 네이버에서 읽어 오며, 캐시는 저장소 밖
// (`~/.cache/blog-automation/gemini-person-examples/`)에 둔다.
//
// **같은 인물의 발행본은 빼고 보여 준다** - 수지 원고를 쓰는데 수지 발행본을 보여 주면 답을 미리 보는 셈이다.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 기본 예시: 2026-11-19 사용자가 링크로 준 whyissuenow 인물 발행본 5편(수지·문가영·한효주·조이현·신민아). */
export const DEFAULT_EXAMPLE_LOG_NOS = ["224483331921", "224479072127", "224474170029", "224469694655", "224468724168"];
const BLOG_ID = "whyissuenow";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export type ExamplePost = { logNo: string; title: string; body: string };

/** `GEMINI_PERSON_EXAMPLE_POSTS`(콤마 구분 글 번호)로 바꿀 수 있다. `none`이면 예시 없이(옛 zero-base). */
export function exampleLogNos(raw: string | undefined = process.env.GEMINI_PERSON_EXAMPLE_POSTS): string[] {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_EXAMPLE_LOG_NOS;
  if (value.toLowerCase() === "none") return [];
  return value.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * 네이버 PostView HTML에서 제목과 본문 문단만 뽑는다. **사진 캡션은 뺀다**(제미나이 버전은 이미지를 보류해서,
 * 캡션 줄을 보여 주면 사진 없는 캡션을 흉내 낸다).
 */
export function extractNaverPost(html: string): { title: string; body: string } | null {
  const titleMatch = html.match(/<title>([\s\S]*?) : 네이버 블로그<\/title>/);
  const start = html.indexOf("se-main-container");
  if (start < 0) return null;
  const end = html.indexOf('class="post_footer_contents"', start);
  let main = html.slice(start, end > 0 ? end : undefined);
  // 이미지 컴포넌트(사진 + 캡션)를 통째로 걷어낸다.
  main = main.replace(/<div class="se-component se-image[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, "");
  main = main.replace(/<div class="se-caption[\s\S]*?<\/div>/g, "");
  const paras = [...main.matchAll(/<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g)].map((m) =>
    decode(m[1].replace(/<[^>]+>/g, "")).replace(/​/g, "").trim()
  );
  const body = paras.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return null;
  return { title: titleMatch ? decode(titleMatch[1]).trim() : "", body };
}

export type LoadExamplesDeps = {
  fetchHtml?: (url: string) => Promise<string | null>;
  cacheDir?: string;
  now?: () => number;
};

async function defaultFetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * 예시를 읽는다. 캐시(7일)가 있으면 그걸 쓰고, 없으면 네이버에서 받는다. **던지지 않는다** - 못 읽은 글은 빠지고
 * `missing`에 남는다(호출부가 경고로 남긴다). 인물 이름이 제목에 들어간 글은 뺀다.
 */
export async function loadExamplePosts(
  personName: string,
  logNos: string[] = exampleLogNos(),
  deps: LoadExamplesDeps = {}
): Promise<{ examples: ExamplePost[]; missing: string[]; excludedSamePerson: string[] }> {
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml;
  const cacheDir = deps.cacheDir ?? join(homedir(), ".cache", "blog-automation", "gemini-person-examples");
  const now = deps.now ?? (() => Date.now());
  const examples: ExamplePost[] = [];
  const missing: string[] = [];
  const excludedSamePerson: string[] = [];
  const name = personName.trim();

  for (const logNo of logNos) {
    let post: ExamplePost | null = null;
    const cacheFile = join(cacheDir, `${logNo}.json`);
    try {
      const info = await stat(cacheFile);
      if (now() - info.mtimeMs < CACHE_TTL_MS) post = JSON.parse(await readFile(cacheFile, "utf8")) as ExamplePost;
    } catch {
      // 캐시 없음
    }
    if (!post) {
      const html = await fetchHtml(`https://blog.naver.com/PostView.naver?blogId=${BLOG_ID}&logNo=${logNo}`);
      const extracted = html ? extractNaverPost(html) : null;
      if (extracted) {
        post = { logNo, ...extracted };
        try {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(cacheFile, JSON.stringify(post));
        } catch {
          // 캐시 실패는 무시한다
        }
      }
    }
    if (!post) {
      missing.push(logNo);
      continue;
    }
    if (name && post.title.includes(name)) {
      excludedSamePerson.push(logNo);
      continue;
    }
    examples.push(post);
  }
  return { examples, missing, excludedSamePerson };
}
