// 이미지 수집 기록이 사람 눈에 닿는지 본다. 실행: npm run test:image-notes
//
// 왜 이 테스트가 있는가(2026-10-01): 그 전까지 "왜 이 자리가 비었는지"는 `console.warn`으로만
// 나갔다. GitHub Actions 로그를 여는 사람은 없고, 뷰어는 "채울 자리"만 보여줄 뿐 이유를 말하지
// 않았다. 그래서 사용자가 규칙을 고쳐 품질을 올리려 해도 **무엇이 왜 실패했는지 알 수가 없었다.**
//
// 지켜야 할 것: ① 자리별 기록이 그 자리에 붙어 보인다 ② 자리에 안 매인 기록은 자리에 섞이지
// 않는다 ③ 기록이 없는 옛 원고도 터지지 않는다 ④ 알림이 빈 자리 수를 말한다.
import { renderManuscriptPage } from "./renderManuscriptPage.js";
import { buildManuscriptReadyMessage } from "./notifyManuscriptsReady.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";
import type { ArticleJobRow } from "../../types/database.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const BODY = [
  "도입 문단입니다.",
  "[IMAGE: 첫 자리 — 웹 검색]",
  "둘째 문단입니다.",
  "[IMAGE: 둘째 자리 — 웹 검색]",
].join("\n\n");

function topic(over: Partial<ManuscriptTopicEntry["manuscript"]> = {}): ManuscriptTopicEntry {
  return {
    jobId: "054bfe0b-1234-4abc-8def-0123456789ab",
    keyword: "테스트 키워드",
    category: "living",
    date: "2026-10-01",
    readyAt: "2026-10-01T00:00:00.000Z",
    manuscript: {
      title: "제목",
      searchDescription: null,
      slug: null,
      tags: [],
      body: BODY,
      imagePrompts: ["검색어 1", "검색어 2"],
      images: [
        { index: 1, description: "채워진 사진", prompt: null, url: "https://x/1.jpg", provider: "web", fileName: "01.jpg" },
      ],
      imageNotes: [
        "[자리 2] 후보가 전부 다른 자리와 같은 컷이라 비웠습니다.",
        "ℹ️ 키노라이츠 공식 스틸 3장을 후보에 넣었습니다.",
      ],
      filePath: "manuscripts/2026-10-01/테스트.md",
      naver: null,
      ...over,
    },
  };
}

function page(entry: ManuscriptTopicEntry): string {
  const manifest: ManuscriptManifest = { topics: [entry] };
  return renderManuscriptPage(manifest, new Date("2026-10-01T09:00:00Z"));
}

async function main(): Promise<void> {
  console.log("▶ 이미지 수집 기록 테스트 시작\n");

  // 1) 기록이 페이지 데이터에 실린다. 여기까지 와야 화면에서 쓸 수 있다.
  {
    const html = page(topic());
    assert(html.includes("후보가 전부 다른 자리와 같은 컷이라 비웠습니다"), "자리별 기록이 페이지에 실려야 한다");
    assert(html.includes("키노라이츠 공식 스틸 3장"), "원고 전체 기록도 실려야 한다");
    console.log("✅ 수집 기록이 뷰어 데이터에 실린다");
  }

  // 2) 자리별 기록을 자리 번호로 갈라 쓴다. 섞이면 2번 자리의 사유가 1번에 붙는다.
  {
    const html = page(topic());
    const fn = html.match(/function notesFor\(topic, n\) \{[\s\S]*?\n {4}\}/);
    assert(fn, "뷰어에 notesFor 함수가 있어야 한다");
    const notesFor = new Function(`${fn![0]}; return notesFor;`)() as (
      t: { imageNotes: string[] },
      n: number
    ) => string[];
    const data = { imageNotes: topic().manuscript.imageNotes as string[] };
    assert(notesFor(data, 2).length === 1, "2번 자리 기록이 하나여야 한다");
    assert(notesFor(data, 2)[0].startsWith("후보가 전부"), "접두사를 떼고 보여줘야 한다");
    assert(notesFor(data, 1).length === 0, "1번 자리에는 기록이 없어야 한다");
    console.log("✅ 자리 번호로 갈라 쓴다 - 남의 사유가 붙지 않는다");
  }

  // 3) 기록이 없는 옛 원고도 터지지 않는다(imageNotes가 통째로 없는 행).
  {
    const html = page(topic({ imageNotes: undefined }));
    assert(html.includes("원고 뷰어"), "기록이 없어도 페이지가 그려져야 한다");
    console.log("✅ 기록 없는 옛 원고도 안전");
  }

  // 4) 알림이 빈 자리 수를 말한다. 뷰어를 열기 전에 알 수 있어야 한다.
  {
    const job = { id: "job-1", keyword: "테스트 키워드" } as ArticleJobRow;
    const message = buildManuscriptReadyMessage(
      { job, result: { status: "success", topic: topic(), imageFailures: [] } } as never,
      "https://pages.example.dev"
    );
    assert(message.text.includes("빈 자리 1개"), `빈 자리 수를 알려야 한다 (${message.text})`);
    console.log("✅ 알림이 빈 자리 수를 말한다");
  }

  // 5) 자리가 다 차면 빈 자리 문구를 붙이지 않는다. 늘 붙으면 경고가 무뎌진다.
  {
    const job = { id: "job-1", keyword: "테스트 키워드" } as ArticleJobRow;
    const full = topic({
      images: [
        { index: 1, description: "a", prompt: null, url: "https://x/1.jpg", provider: "web", fileName: "01.jpg" },
        { index: 2, description: "b", prompt: null, url: "https://x/2.jpg", provider: "web", fileName: "02.jpg" },
      ],
    });
    const message = buildManuscriptReadyMessage(
      { job, result: { status: "success", topic: full, imageFailures: [] } } as never,
      "https://pages.example.dev"
    );
    assert(!message.text.includes("빈 자리"), `다 찼으면 빈 자리 문구가 없어야 한다 (${message.text})`);
    console.log("✅ 다 찬 원고에는 경고를 붙이지 않는다");
  }

  console.log("\n✅ 이미지 수집 기록 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
