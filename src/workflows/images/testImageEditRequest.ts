// 이미지 수정 답장 파싱 테스트. 실행: npm run test:image-edit
//
// 사람이 텔레그램에서 급히 치는 글이라 형식을 강제할 수 없다. 느슨하게 읽되 **잘못 읽지는
// 않아야** 한다 - 엉뚱한 자리를 다시 만들면 멀쩡한 이미지를 잃는다.
import { describeImageEditRequests, inferAcquisition, parseImageEditReply, splitSearchInstruction } from "./imageEditRequest.js";
import { applyImageEditRequest, rewriteAcquisitions } from "./applyImageEditRequest.js";
import { isLikelyImageUrl } from "./imageEditRequest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const eq = (text: string, expected: Array<[number, string]>) => {
  const got = parseImageEditReply(text);
  const want = expected.map(([index, requirement]) => ({ index, requirement }));
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `"${text}"\n     받은 값: ${JSON.stringify(got)}\n     기대값: ${JSON.stringify(want)}`
  );
};

// --- 1. 번호만 -------------------------------------------------------------------------------
{
  eq("2,5", [[2, ""], [5, ""]]);
  eq("2번 5번", [[2, ""], [5, ""]]);
  eq("3", [[3, ""]]);
  console.log("✅ 번호만 - 요구사항 없이 다시 찾기");
}

// --- 2. 번호 + 요구사항 ------------------------------------------------------------------------
{
  eq("2번은 인물 단독샷으로, 5번은 제품 컷으로", [[2, "인물 단독샷으로"], [5, "제품 컷으로"]]);
  eq("3번 더 큰 사진", [[3, "더 큰 사진"]]);
  eq("1번은 현장 사진이 좋겠어요", [[1, "현장 사진이 좋겠어요"]]);
  console.log("✅ 번호 + 요구사항 - 조사를 흡수하고 뒤 문구를 요구로 읽는다");
}

// --- 3. 섞여 있어도 -----------------------------------------------------------------------------
{
  eq("2번은 인물 단독샷 / 5", [[2, "인물 단독샷"], [5, ""]]);
  eq("4번  제품컷,  6번", [[4, "제품컷"], [6, ""]]);
  console.log("✅ 요구사항 있는 것과 없는 것이 섞여도 각각 읽는다");
}

// --- 4. 같은 번호를 두 번 쓰면 뒤엣것 ------------------------------------------------------------
// 사람이 고쳐 쓴 것으로 본다.
{
  eq("2번 인물샷, 2번은 역시 풍경으로", [[2, "역시 풍경으로"]]);
  console.log("✅ 같은 번호 반복 - 나중에 쓴 것을 쓴다");
}

// --- 5. 번호가 없으면 빈 배열 -------------------------------------------------------------------
// 호출부가 "빈 자리만 다시 채웁니다"로 처리한다 - 여기서 억지로 짐작하지 않는다.
{
  eq("이미지가 마음에 안 들어요", []);
  eq("", []);
  eq("   ", []);
  console.log("✅ 번호가 없으면 빈 배열 - 짐작하지 않는다");
}

// --- 6. 범위 밖 번호는 버린다 -------------------------------------------------------------------
// "2026년" 같은 연도나 오타가 자리 번호로 읽히면 멀쩡한 이미지를 날린다.
{
  eq("99번 바꿔주세요", []);
  eq("0번", []);
  assert(parseImageEditReply("2번 바꾸고 30번도", 20).length === 1, "상한을 넘는 번호는 버려야 한다");
  console.log("✅ 범위 밖 번호는 버린다 - 멀쩡한 자리를 날리지 않는다");
}

// --- 7. 되읽기 - 사용자가 확인할 수 있어야 한다 --------------------------------------------------
{
  const text = describeImageEditRequests([
    { index: 2, requirement: "인물 단독샷" },
    { index: 5, requirement: "" },
  ]);
  assert(text.includes("2번 - 인물 단독샷"), `요구사항이 보여야 한다 (${text})`);
  assert(text.includes("5번 - 다시 찾기"), `요구사항이 없으면 그렇게 보여야 한다 (${text})`);
  assert(describeImageEditRequests([]).includes("빈 자리만"), "지정이 없으면 그 사실을 알려야 한다");
  console.log("✅ 되읽기 - 잘못 읽었으면 사용자가 바로 안다");
}

// --- 8. 지시에서 획득 방식을 읽는다(2026-09-22 사용자 결정 - "지시대로 해라") ----------------
{
  // 검색이 가장 강한 신호다. "검색해서 나오는 카카오톡 캡쳐"는 캡처가 아니라 검색이다 -
  // 사용자가 "검색"이라 말한 이상 어디서 구할지는 정해졌고 "캡쳐"는 무엇을 구할지다.
  assert(inferAcquisition("SNL 주현영과 김원훈 으로 검색해서 나오는 투샷") === "search", "검색 지시");
  assert(inferAcquisition("주현영 김원훈 우연히 보자 검색해서 나오는 카카오톡 캡쳐") === "search", "검색이 캡처를 이긴다");
  assert(inferAcquisition("AI로 그려주세요") === "ai", "AI 지시");
  assert(inferAcquisition("일러스트로 넣어주세요") === "ai", "일러스트도 AI");
  assert(inferAcquisition("표로 정리해주세요") === "table", "표 지시");
  assert(inferAcquisition("공식 홈페이지 페이지 캡처로") === "capture", "페이지 캡처 지시");

  // 애매하면 바꾸지 않는다 - 잘못 바꾸면 멀쩡한 자리를 망친다.
  assert(inferAcquisition("더 큰 사진으로") === null, "방식 언급이 없으면 유지");
  assert(inferAcquisition("") === null, "빈 요구는 유지");
  console.log("✅ 획득 방식 추론 - 검색 우선, 애매하면 유지");
}

// --- 9. 본문 마커를 실제로 고친다(2026-09-22 실측 사고) -----------------------------------------
// 사용자가 "검색해서 나오는 카톡 캡처"를 요청한 자리가 `AI 생성`이라 검색이 한 번도 안 돌았다.
// 마커를 안 고치면 요청한 방식으로 채우는 코드가 그 자리를 쳐다보지도 않는다.
{
  const body = [
    "앞 문단입니다.",
    "",
    "[IMAGE: 주현영과 김원훈 투샷 — 웹 검색]",
    "",
    "가운데 문단입니다.",
    "",
    "[IMAGE: 스마트폰 카카오톡 화면을 보며 웃는 손 — AI 생성]",
    "",
    "[IMAGE: 조회수·추천수·댓글수 — 표 생성]",
  ].join("\n");

  const { body: next, changes } = rewriteAcquisitions(body, [
    { index: 2, requirement: "주현영 김원훈 카톡 검색해서 나오는 캡쳐" },
    { index: 3, requirement: "주현영 유튜브 영상 캡쳐 검색해서" },
  ]);

  assert(changes.length === 2, `두 자리가 바뀌어야 한다 (${JSON.stringify(changes)})`);
  assert(next.includes("[IMAGE: 스마트폰 카카오톡 화면을 보며 웃는 손 — 웹 검색]"), "AI 생성 -> 웹 검색");
  assert(next.includes("[IMAGE: 조회수·추천수·댓글수 — 웹 검색]"), "표 생성 -> 웹 검색");
  assert(next.includes("[IMAGE: 주현영과 김원훈 투샷 — 웹 검색]"), "지정 안 한 자리는 그대로");
  assert(next.includes("가운데 문단입니다."), "본문이 보존돼야 한다");

  // 이미 그 방식이면 바꾸지 않는다(변경 기록도 남기지 않는다).
  const same = rewriteAcquisitions(body, [{ index: 1, requirement: "다시 검색해주세요" }]);
  assert(same.changes.length === 0, "이미 웹 검색인 자리는 변경 없음");

  // 방식 지시가 없으면 본문을 건드리지 않는다.
  const untouched = rewriteAcquisitions(body, [{ index: 2, requirement: "더 큰 사진으로" }]);
  assert(untouched.body === body && untouched.changes.length === 0, "방식 지시가 없으면 본문 무변경");
  console.log("✅ 마커 수정 - 지시한 자리만 방식 전환, 나머지는 보존");
}

// --- 10. 검색어와 원하는 그림을 갈라낸다(2026-09-22 실측 사고) ----------------------------------
// 문장을 통째로 검색창에 넣어 1·5번 자리가 비었다. 사용자가 실제로 보낸 문장 그대로 시험한다.
{
  const cases: Array<[string, string]> = [
    ["SNL 주현영과 김원훈 으로 검색해서 나오는 투샷 이미지 넣어주세요.", "SNL 주현영과 김원훈"],
    ["주현영 김원훈 우연히 보자 검색해서 나오는 카카오톡 캡쳐 이미지 넣어주세요.", "주현영 김원훈 우연히 보자"],
    ["주현영 김원훈 연락공개 로 검색해서 나오는 주현영 유튜브 영상 캡쳐 이미지 넣어주세요.", "주현영 김원훈 연락공개"],
  ];
  for (const [text, expected] of cases) {
    const got = splitSearchInstruction(text);
    assert(got.query === expected, `검색어를 뽑아야 한다\n     "${text}"\n     받은 값: "${got.query}"\n     기대값: "${expected}"`);
    assert(got.want.length > 0 && got.want !== text, `원하는 그림도 남아야 한다 (${got.want})`);
  }

  // "검색"이라는 말이 없으면 못 가른다 - 호출부가 기존 검색어를 쓴다.
  assert(splitSearchInstruction("더 큰 사진으로").query === "", "검색 지시가 없으면 검색어를 비운다");
  assert(splitSearchInstruction("검색해서 나오는 투샷").query === "", "앞이 비면 검색어를 못 뽑은 것이다");
  console.log("✅ 검색어 추출 - 문장이 아니라 검색어만 검색창에 넣는다");
}

// --- 11. URL 안의 숫자를 자리 번호로 읽지 않는다(2026-09-22 실측 사고) ------------------------
// "https://share.google/JWMMbSFb4Q674jD0H"의 4·67·0을 자리 번호로 읽어서, 요청하지도 않은
// 4번 자리를 비우고 5번의 요구사항은 URL 중간에서 잘렸다.
{
  const got = parseImageEditReply("5번 이미지 https://share.google/JWMMbSFb4Q674jD0H 이걸로 교체", 6);
  assert(got.length === 1, `요청한 한 자리만 나와야 한다 (${JSON.stringify(got.map((g) => g.index))})`);
  assert(got[0].index === 5, "5번이어야 한다");
  assert(got[0].url === "https://share.google/JWMMbSFb4Q674jD0H", `링크가 온전해야 한다 (${got[0].url})`);
  assert(got[0].requirement.includes("이미지"), `"5번 이미지"의 '이'를 조사로 먹으면 안 된다 (${got[0].requirement})`);

  const second = parseImageEditReply("1번 검색어 정채연으로 나오는 프로필 사진 넣어줘 https://share.google/iyNVcgHSStLG6Ig5s", 6);
  assert(second.length === 1 && second[0].index === 1, `1번만 나와야 한다 (${JSON.stringify(second.map((g) => g.index))})`);
  assert(second[0].requirement.includes("정채연"), "요구사항이 온전해야 한다");
  // 두 자리 + 링크 두 개를 한 번에 보낸 경우 - 링크가 제 자리에 붙어야 한다.
  const two = parseImageEditReply(
    "1번 이미지 교체 https://a.example.com/one.png\n\n5번 이미지 교체 https://b.example.com/two.png",
    6
  );
  assert(two.length === 2, `두 자리만 나와야 한다 (${JSON.stringify(two.map((t) => t.index))})`);
  assert(two[0].url?.includes("one.png"), `1번에 첫 링크가 붙어야 한다 (${two[0].url})`);
  assert(two[1].url?.includes("two.png"), `5번에 둘째 링크가 붙어야 한다 (${two[1].url})`);
  console.log("✅ URL 안 숫자를 자리 번호로 읽지 않는다 / 링크가 제 자리에 붙는다");
}

// --- 12. 쓸 수 없는 링크를 걸러 알려준다 --------------------------------------------------------
// 구글 이미지 검색의 "공유" 링크는 이미지가 아니라 검색 페이지(text/html)로 연결된다.
{
  assert(!isLikelyImageUrl("https://share.google/JWMMbSFb4Q674jD0H"), "구글 공유 링크는 이미지가 아니다");
  assert(!isLikelyImageUrl("https://www.google.com/search?q=x&udm=2"), "검색 결과 페이지도 아니다");
  // 구글 썸네일은 이미지처럼 보이지만 브라우저 밖에서는 404 + 43바이트 GIF가 온다(2026-09-22 실측).
  assert(!isLikelyImageUrl("https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRgyv&s=10"), "구글 썸네일은 못 받는다");
  assert(isLikelyImageUrl("https://images.khan.co.kr/article/2023/06/28/news-p.v1.x_P1.png"), "언론사 원본은 통과");
  assert(isLikelyImageUrl("https://img-cdn.theqoo.net/QvKRjF.webp"), "이미지 주소는 통과");
  assert(isLikelyImageUrl("https://imgnews.naver.net/image/108/2025/06/27/x_002.jpg"), "뉴스 이미지도 통과");

  const applied = applyImageEditRequest(
    [{ index: 5, description: "d", prompt: null, url: "https://old/5.png", provider: "web", fileName: "05.png" } as never],
    [{ index: 5, requirement: "이걸로 교체", url: "https://share.google/JWMMbSFb4Q674jD0H" }]
  );
  assert(applied.unusableUrls.includes(5), "못 쓰는 링크를 알려야 한다");
  assert(!applied.patch.imageDirectUrls, "못 쓰는 링크는 저장하지 않는다");

  const usable = applyImageEditRequest(
    [{ index: 2, description: "d", prompt: null, url: null, provider: null, fileName: null } as never],
    [{ index: 2, requirement: "이걸로", url: "https://img-cdn.theqoo.net/QvKRjF.webp" }]
  );
  assert(usable.unusableUrls.length === 0, "이미지 주소는 문제없다");
  assert((usable.patch.imageDirectUrls as Record<string, string>)["2"].includes("theqoo"), "이미지 주소는 저장한다");
  console.log("✅ 쓸 수 없는 링크 구분 - 검색 페이지는 거르고 이미지 주소는 저장");
}

console.log("\n🎉 이미지 수정 답장 파싱 테스트 통과");
