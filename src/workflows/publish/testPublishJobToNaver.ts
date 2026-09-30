// publishJobToNaver 테스트. 브라우저·LLM·DB를 전부 주입해 오케스트레이션만 본다.
//
// 지켜야 할 것: ① 기본이 비공개다 ② 같은 job을 두 번 올리지 않는다 ③ 작성 단계 원고를 그대로 올린다
// (2026-09-30 배리에이션 폐지 - LLM 호출 없음) ④ 이미지는 Blogspot과 같은 것을 쓴다 ⑤ 실패도 기록한다.
import { publishJobToNaver } from "./publishJobToNaver.js";
import type { ArticleJobRow, ArticleRow, PublicationRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

function job(over: Partial<ArticleJobRow> = {}): ArticleJobRow {
  return {
    id: "job-1",
    keyword: "테스트 키워드",
    category: "entertainment",
    status: "approved",
    metadata: {},
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    ...over,
  } as ArticleJobRow;
}

function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 1,
    job_id: "job-1",
    title: "블로그 제목",
    content: "본문입니다. ".repeat(20),
    status: "approved",
    ai_model: "claude",
    platform: null,
    created_at: "x",
    updated_at: "x",
    ...over,
  } as ArticleRow;
}

const okPublish = async () => ({ ok: true as const, draftUrl: "https://blog.naver.com/whyissuenow/1" });

const baseDeps = {
  loadJob: async () => job(),
  loadArticles: async () => [article()],
  loadJobPublications: async () => [] as PublicationRow[],
  savePublication: async (i: { articleId: number; status: PublicationRow["status"]; publishedUrl: string | null }) =>
    ({ id: 9, article_id: i.articleId, platform: "naver", status: i.status, published_url: i.publishedUrl, published_at: null, created_at: "x" }) as PublicationRow,
  publish: okPublish,
};

async function main(): Promise<void> {
  console.log("▶ publishJobToNaver 테스트 시작\n");

  // 1) 기본 공개 범위는 비공개다. 잘못 켜졌을 때 조용히 공개되는 쪽보다 안 보이는 쪽이 낫다.
  {
    const saved = process.env.NAVER_PUBLISH_VISIBILITY;
    delete process.env.NAVER_PUBLISH_VISIBILITY;
    let seen: string = "";
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      publish: async (_input, visibility) => {
        seen = visibility;
        return okPublish();
      },
    });
    assert(out.ok, `발행이 성공해야 한다 (${JSON.stringify(out)})`);
    assert(seen === "private", `기본은 비공개여야 한다 (${seen})`);

    process.env.NAVER_PUBLISH_VISIBILITY = "public";
    let seenPublic: string = "";
    await publishJobToNaver("job-1", {
      ...baseDeps,
      publish: async (_i, v) => {
        seenPublic = v;
        return okPublish();
      },
    });
    assert(seenPublic === "public", "환경변수로만 공개로 바뀐다");
    if (saved) process.env.NAVER_PUBLISH_VISIBILITY = saved;
    else delete process.env.NAVER_PUBLISH_VISIBILITY;
    console.log("✅ 기본 비공개 / 환경변수로만 공개 전환");
  }

  // 2) 이미 올라간 job은 다시 올리지 않는다. 같은 글이 네이버에 두 번 올라가면 유사문서 사고다.
  {
    let publishCalls = 0;
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      loadJobPublications: async () =>
        [{ id: 7, article_id: 2, platform: "naver", status: "published", published_url: "https://b/x", published_at: null, created_at: "x" }] as PublicationRow[],
      publish: async () => {
        publishCalls += 1;
        return okPublish();
      },
    });
    assert(out.ok && out.alreadyDone, "이미 올라갔으면 alreadyDone이어야 한다");
    assert(publishCalls === 0, "이미 올라갔으면 브라우저를 띄우면 안 된다");
    console.log("✅ 중복 발행 방지 - 브라우저도 안 띄운다");
  }

  // 2-1) Blogspot 발행 기록은 네이버 발행을 막지 않는다(채널이 다르다).
  {
    let publishCalls = 0;
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      loadJobPublications: async () =>
        [{ id: 7, article_id: 1, platform: "blogspot", status: "published", published_url: "https://b/x", published_at: null, created_at: "x" }] as PublicationRow[],
      publish: async () => {
        publishCalls += 1;
        return okPublish();
      },
    });
    assert(out.ok && !out.alreadyDone && publishCalls === 1, "Blogspot 기록이 네이버를 막으면 안 된다");
    console.log("✅ 채널이 다르면 막지 않는다");
  }

  // 3) 작성 단계 원고 그대로 올린다: 참고 자료 링크아웃만 빼고 해시태그·고지는 남긴다.
  {
    let html = "";
    let titleSeen = "";
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      loadArticles: async () => [
        article({ title: "최종 제목", content: "본문 문단입니다.\n\n**참고 자료**\n- [출처 하나](https://src.example.com/1)\n- [출처 둘](https://src.example.com/2)\n\n#태그1 #태그2" }),
      ],
      publish: async (input) => {
        html = input.bodyHtml;
        titleSeen = input.title;
        return okPublish();
      },
    });
    assert(out.ok, `발행이 성공해야 한다 (${JSON.stringify(out)})`);
    assert(titleSeen === "최종 제목", "작성 단계 원고의 제목을 그대로 써야 한다");
    assert(!html.includes("src.example.com") && !html.includes("참고 자료"), "참고 자료 링크아웃은 네이버에 싣지 않는다");
    assert(html.includes("#태그1"), "해시태그 줄은 남겨야 한다");
    console.log("✅ 작성 단계 원고 그대로 발행 - 참고 자료만 제외");
  }

  // 4) 이미지는 Blogspot과 같은 것(job.metadata.images)을 쓰고, 남은 마커는 지운다.
  {
    let html = "";
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      loadJob: async () =>
        job({
          metadata: {
            images: [
              { index: 1, description: "확정된 사진", prompt: null, url: "https://img/1.png", provider: "web", fileName: "01.png" },
            ],
          },
        }),
      loadArticles: async () => [
        article({ content: "앞 문단입니다.\n\n[IMAGE: 확정된 사진]\n\n[IMAGE: 못 채운 자리 — 웹 검색]\n\n뒤 문단입니다." }),
      ],
      publish: async (input) => {
        html = input.bodyHtml;
        return okPublish();
      },
    });
    assert(out.ok, `발행이 성공해야 한다 (${JSON.stringify(out)})`);
    assert(html.includes("https://img/1.png"), "확정된 이미지가 본문에 들어가야 한다");
    assert(!html.includes("웹 검색"), "못 채운 마커가 독자에게 보이면 안 된다");
    assert(!html.includes("[IMAGE:"), "마커 텍스트가 남으면 안 된다");
    console.log("✅ 이미지 - 확정분 삽입 + 남은 마커 제거");
  }

  // 5) 실패도 기록한다. 조용히 죽는 job을 만들지 않는다.
  {
    let failedRecorded = false;
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      publish: async () => ({ ok: false as const, stage: "save" as const, error: "발행 버튼을 못 찾음" }),
      savePublication: async (i) => {
        if (i.status === "failed") failedRecorded = true;
        return baseDeps.savePublication(i);
      },
    });
    assert(!out.ok && out.reason === "naver_failed", `실패 사유가 분명해야 한다 (${JSON.stringify(out)})`);
    assert(out.detail.includes("발행 버튼을 못 찾음"), "원래 오류가 보존돼야 한다");
    assert(failedRecorded, "실패도 publications에 남겨야 한다");
    console.log("✅ 실패 - 사유 보존 + 기록");
  }

  // 6) 승인되지 않은 job은 올리지 않는다.
  {
    let publishCalls = 0;
    const out = await publishJobToNaver("job-1", {
      ...baseDeps,
      loadJob: async () => job({ status: "review" }),
      publish: async () => {
        publishCalls += 1;
        return okPublish();
      },
    });
    assert(!out.ok && out.reason === "job_not_approved", "미승인은 막아야 한다");
    assert(publishCalls === 0, "미승인이면 브라우저를 띄우면 안 된다");
    console.log("✅ 미승인 job 차단");
  }

  console.log("\n✅ 전체 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
