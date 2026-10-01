// 유튜브 예고편 자동 프레임 테스트. 실행: npm run test:youtube-frames
//
// 지켜야 할 것: ① 리서치 글에서 영상 ID를 제대로 뽑는다 ② 없는 프레임은 후보에 넣지 않는다
// ③ 공식 스틸이 있으면 예고편 프레임을 쓰지 않는다(스틸이 훨씬 크다) ④ 작품 카테고리에서만 돈다.
//
// 네트워크는 기본으로 치지 않는다. `--live`를 주면 실제 i.ytimg.com에 HEAD를 날려 **주소 규칙이
// 아직 유효한지** 확인한다(유튜브가 바꾸면 조용히 0장이 되는 경로라, 가끔 눈으로 봐야 한다).
import { collectWebImages } from "./collectWebImages.js";
import {
  extractYoutubeVideoIds,
  fetchTrailerFrameCandidates,
  trailerFrameUrl,
} from "./youtubeTrailerFrames.js";
import type { ImageCandidate } from "./searchNaverImages.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const SLOT = {
  index: 1,
  description: "작품 공식 스틸",
  query: "연애박사 스틸컷",
  prompt: null,
  context: "문단",
};

/**
 * collectWebImages가 어떤 후보를 프롬프트에 넣었는지 보려고 runCodex를 가로챈다.
 *
 * 자리를 `skipped`로 돌려준다 - 빈 `slots`를 주면 collectWebImages가 "자리 정보를 돌려주지
 * 않았습니다"로 **일찍 반환하면서 그때까지 쌓인 메시지를 버린다**(collectWebImages.ts:931).
 * 그러면 후보를 넣었다는 기록까지 사라져 이 테스트가 보려는 것을 못 본다.
 */
function captureCandidates() {
  const seen: string[] = [];
  return {
    seen,
    runCodex: async ({ prompt }: { prompt: string }) => {
      seen.push(prompt);
      return {
        ok: true as const,
        data: { slots: [{ index: 1, skipped: true, skipReason: "테스트라 고르지 않는다" }] },
        durationMs: 1,
      };
    },
  };
}

async function main(): Promise<void> {
  console.log("▶ 유튜브 예고편 프레임 테스트 시작\n");

  // 1) 링크 모양별로 ID를 뽑는다.
  {
    const text = [
      "참고: https://www.youtube.com/watch?v=kucWTDH7bX4 (공식 티저)",
      "짧은 주소 https://youtu.be/9bZkp7q19f0?t=30",
      "임베드 https://www.youtube.com/embed/dQw4w9WgXcQ",
      "쇼츠 https://youtube.com/shorts/aaaaaaaaaaa",
      "같은 영상 또 https://youtu.be/kucWTDH7bX4",
    ].join("\n");
    const ids = extractYoutubeVideoIds(text, 10);
    assert(ids.includes("kucWTDH7bX4"), "watch?v= 형식을 뽑아야 한다");
    assert(ids.includes("9bZkp7q19f0"), "youtu.be 형식을 뽑아야 한다");
    assert(ids.includes("dQw4w9WgXcQ"), "embed 형식을 뽑아야 한다");
    assert(ids.filter((i) => i === "kucWTDH7bX4").length === 1, "같은 영상이 두 번 나오면 안 된다");
    console.log(`✅ 링크에서 영상 ID 추출 (${ids.length}편)`);
  }

  // 2) URL처럼 생기지 않은 11자 토큰은 줍지 않는다. 리서치 파일 전문을 그대로 넣는 용도라
  //    본문 문장에서 아무거나 긁으면 엉뚱한 영상의 프레임이 들어온다.
  {
    const ids = extractYoutubeVideoIds("이 문단에는 abcdefghijk 같은 11자 토큰이 있지만 링크가 아니다.");
    assert(ids.length === 0, `링크가 아니면 뽑으면 안 된다 (${JSON.stringify(ids)})`);
    console.log("✅ 링크가 아닌 토큰은 무시");
  }

  // 3) 없는 프레임은 후보에서 빠진다(720p 미만 업로드 등).
  {
    const frames = await fetchTrailerFrameCandidates(["kucWTDH7bX4"], {
      headImage: async (url) => url.endsWith("maxres2.jpg"),
    });
    assert(frames.length === 1, `있는 프레임만 남아야 한다 (${frames.length}장)`);
    assert(frames[0].link === trailerFrameUrl("kucWTDH7bX4", 2), "남은 것이 2번 프레임이어야 한다");
    assert(frames[0].width === 1280 && frames[0].height === 720, "크기를 1280x720으로 적어야 한다");
    assert(
      frames[0].sourcePage === "https://www.youtube.com/watch?v=kucWTDH7bX4",
      "출처는 영상 페이지여야 한다(캡션 출처 표기에 쓴다)"
    );
    console.log("✅ 없는 프레임 제외 + 크기·출처 기록");
  }

  // 4) 공식 스틸이 있으면 예고편 프레임을 아예 가져오지 않는다. 스틸은 3000x2000이고 프레임은
  //    1280x720이라, 섞으면 §8-7의 "공식 스틸이 있으면 공식 스틸을 고른다"와 부딪힌다.
  {
    let called = 0;
    const cap = captureCandidates();
    await collectWebImages(
      { keyword: "연애박사", dir: "/tmp", slots: [SLOT] },
      {
        category: "ott",
        researchText: "https://youtu.be/kucWTDH7bX4",
        searchImages: async () => [],
        searchKinolights: async () => [{ imageUrl: "https://kino/1.jpg", sourcePage: "https://m.kinolights.com/title/1" }],
        fetchTrailerFrames: async () => {
          called += 1;
          return [];
        },
        runCodex: cap.runCodex,
      } as never
    );
    assert(called === 0, "공식 스틸이 있으면 예고편 프레임을 가져오지 않아야 한다");
    console.log("✅ 공식 스틸 우선 - 예고편 경로를 타지 않는다");
  }

  // 5) 공식 스틸이 없으면 예고편 프레임이 후보에 들어간다.
  {
    const cap = captureCandidates();
    const frame: ImageCandidate = {
      title: "유튜브 공식 영상 자동 프레임 1",
      link: trailerFrameUrl("kucWTDH7bX4", 1),
      thumbnail: trailerFrameUrl("kucWTDH7bX4", 1),
      width: 1280,
      height: 720,
      sourcePage: "https://www.youtube.com/watch?v=kucWTDH7bX4",
    };
    const outcome = await collectWebImages(
      { keyword: "연애박사", dir: "/tmp", slots: [SLOT] },
      {
        category: "ott",
        researchText: "공식 예고편 https://youtu.be/kucWTDH7bX4",
        searchImages: async () => [],
        searchKinolights: async () => [],
        fetchTrailerFrames: async () => [frame],
        runCodex: cap.runCodex,
      } as never
    );
    assert(cap.seen.length === 1, "에이전트를 한 번 불러야 한다");
    assert(cap.seen[0].includes("maxres1.jpg"), "예고편 프레임이 후보 목록에 실려야 한다");
    assert(
      outcome.failures.some((f) => f.includes("자동 프레임")),
      `후보에 넣었다는 기록이 남아야 한다 (${JSON.stringify(outcome.failures)})`
    );
    console.log("✅ 공식 스틸이 없으면 예고편 프레임을 후보에 넣는다");
  }

  // 6) 작품이 아닌 카테고리에서는 돌지 않는다. 사건사고 원고에 예고편 프레임이 들어갈 이유가 없다.
  {
    let called = 0;
    const cap = captureCandidates();
    await collectWebImages(
      { keyword: "어떤 사건", dir: "/tmp", slots: [SLOT] },
      {
        category: "incident",
        researchText: "https://youtu.be/kucWTDH7bX4",
        searchImages: async () => [],
        fetchTrailerFrames: async () => {
          called += 1;
          return [];
        },
        runCodex: cap.runCodex,
      } as never
    );
    assert(called === 0, "작품 카테고리에서만 돌아야 한다");
    console.log("✅ 작품 카테고리에서만 동작");
  }

  // 7) --live: 주소 규칙이 아직 유효한지 실제로 확인한다.
  if (process.argv.includes("--live")) {
    const frames = await fetchTrailerFrameCandidates(["kucWTDH7bX4"]);
    assert(frames.length > 0, "실제 영상에서 자동 프레임을 못 받았다 - 주소 규칙이 바뀌었을 수 있다");
    console.log(`✅ [live] 실제 프레임 ${frames.length}장 확인 (${frames.map((f) => f.link.split("/").pop()).join(", ")})`);
  } else {
    console.log("ℹ️ 네트워크 확인은 건너뜀 - `npm run test:youtube-frames -- --live`로 실제 주소를 검사합니다.");
  }

  console.log("\n✅ 유튜브 예고편 프레임 테스트 전부 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
