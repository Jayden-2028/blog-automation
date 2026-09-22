// 내부 링크 삽입 테스트. 실행: npm run test:related-posts
//
// 지켜야 할 것: ① 자기 자신을 링크하지 않는다 ② 같은 자리에 두 번 쌓이지 않는다(멱등)
// ③ 우리 글 링크가 바깥 출처(참고 자료) 뒤로 밀리지 않는다 ④ 링크가 지어내진 것이 아니다.
import { appendRelatedPosts, pickRelatedPosts, RELATED_HEADING } from "./appendRelatedPosts.js";
import type { PublishedPost } from "../../services/supabase/repositories/publicationRepository.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const post = (over: Partial<PublishedPost> & { jobId: string }): PublishedPost => ({
  title: `${over.jobId} 제목`,
  url: `https://b.example.com/${over.jobId}.html`,
  keyword: "",
  category: null,
  publishedAt: "2026-09-20T00:00:00Z",
  ...over,
});

const BODY = [
  "본문 시작입니다.",
  "",
  "**요약**",
  "요약 문단입니다.",
  "",
  "**참고 자료**",
  "- [바깥 기사](https://news.example.com/1)",
].join("\n");

// --- 1. 자기 자신은 고르지 않는다 -------------------------------------------------------------
{
  const picked = pickRelatedPosts(
    { jobId: "me", keyword: "안은진 옷 스트라이프 후디", category: "entertainment" },
    [post({ jobId: "me", keyword: "안은진 옷 스트라이프 후디", category: "entertainment" })]
  );
  assert(picked.length === 0, "후보가 자기 자신뿐이면 링크가 없어야 한다");
  console.log("✅ 자기 자신은 링크하지 않는다");
}

// --- 2. 관련 있는 글이 앞에 온다 ---------------------------------------------------------------
{
  const picked = pickRelatedPosts(
    { jobId: "me", keyword: "안은진 옷 스트라이프 후디", category: "entertainment" },
    [
      post({ jobId: "far", keyword: "가을 숫꽃게 손질법", category: "living" }),
      post({ jobId: "near", keyword: "안은진 드라마 시청률", category: "entertainment" }),
    ]
  );
  assert(picked[0].url.includes("near"), `관련 있는 글이 먼저 와야 한다 (${JSON.stringify(picked)})`);
  console.log("✅ 관련도 순으로 고른다");
}

// --- 3. 전부 멀어도 하나는 남긴다 --------------------------------------------------------------
// 이 기능의 목적은 고아 페이지를 줄이는 것이다. 주제가 좀 멀어도 링크 0개보다는 낫다.
{
  const picked = pickRelatedPosts(
    { jobId: "me", keyword: "안은진 옷", category: "entertainment" },
    [post({ jobId: "far", keyword: "가을 숫꽃게 손질법", category: "living" })]
  );
  assert(picked.length === 1, `관련이 멀어도 하나는 붙여야 한다 (${picked.length}개)`);
  console.log("✅ 후보가 멀어도 링크 0개로 끝내지 않는다");
}

// --- 4. 참고 자료 **앞**에 들어간다 -------------------------------------------------------------
{
  const out = appendRelatedPosts(BODY, [{ title: "다른 글", url: "https://b.example.com/a.html" }]);
  const relatedAt = out.indexOf(RELATED_HEADING);
  const referenceAt = out.indexOf("**참고 자료**");
  assert(relatedAt >= 0, "블록이 들어가야 한다");
  assert(relatedAt < referenceAt, "우리 글 링크가 바깥 출처보다 앞에 와야 한다");
  assert(out.includes("- [다른 글](https://b.example.com/a.html)"), "마크다운 링크 형식이어야 한다");
  assert(out.includes("**요약**"), "기존 본문이 보존돼야 한다");
  console.log("✅ 참고 자료 앞에 삽입 + 본문 보존");
}

// --- 5. 두 번 돌려도 쌓이지 않는다(멱등) --------------------------------------------------------
// prepareManuscript는 재실행될 수 있다. 돌릴 때마다 링크 블록이 늘어나면 본문이 망가진다.
{
  const once = appendRelatedPosts(BODY, [{ title: "첫 번째", url: "https://b.example.com/1.html" }]);
  const twice = appendRelatedPosts(once, [{ title: "두 번째", url: "https://b.example.com/2.html" }]);
  const count = twice.split(RELATED_HEADING).length - 1;
  assert(count === 1, `블록이 하나만 있어야 한다 (${count}개)`);
  assert(twice.includes("두 번째") && !twice.includes("첫 번째"), "새 링크로 갈아 끼워야 한다");
  assert(twice.includes("**참고 자료**"), "갈아 끼우면서 뒷부분을 잃으면 안 된다");
  console.log("✅ 재실행해도 블록이 쌓이지 않는다");
}

// --- 6. 참고 자료가 없으면 해시태그 앞에 ---------------------------------------------------------
{
  const body = "본문입니다.\n\n마무리 문단입니다.\n\n#태그하나 #태그둘 #태그셋";
  const out = appendRelatedPosts(body, [{ title: "글", url: "https://b.example.com/x.html" }]);
  assert(out.indexOf(RELATED_HEADING) < out.indexOf("#태그하나"), "해시태그 앞에 와야 한다");
  assert(out.trimEnd().endsWith("#태그셋"), "해시태그 줄이 마지막이어야 한다");
  console.log("✅ 참고 자료가 없으면 해시태그 앞");
}

// --- 7. 링크가 없으면 본문을 건드리지 않는다 -----------------------------------------------------
{
  assert(appendRelatedPosts(BODY, []) === BODY, "링크가 없으면 원본 그대로여야 한다");
  console.log("✅ 링크가 없으면 본문 무변경");
}

console.log("\n🎉 내부 링크 삽입 테스트 통과");
