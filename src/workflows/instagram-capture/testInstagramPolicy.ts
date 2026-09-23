// 캡션 정제와 카테고리별 이미지 정책. 둘 다 순수 함수라 가짜가 필요 없다.

import { strict as assert } from "node:assert";

import { cleanCaption } from "./cleanCaption.js";
import { describeImagePolicy, instagramImageConfig } from "./instagramImagePolicy.js";

const tests: Array<[string, () => void]> = [
  [
    "og:description 앞머리(좋아요·댓글·계정·날짜)와 바깥 따옴표를 벗긴다",
    () => {
      // 2026-09-23 실측한 두 형식.
      assert.equal(
        cleanCaption('1,032 likes, 7 comments - wpedia.magazine - September 7, 2026: "이나영 신작 출연"'),
        "이나영 신작 출연"
      );
      assert.equal(cleanCaption('focuspic.kr - September 9, 2026: "허진호 감독의 영화"'), "허진호 감독의 영화");
    },
  ],
  [
    "닫는 따옴표 뒤에 마침표가 붙어도 벗긴다",
    () => {
      // 2026-09-23 실측(넷플릭스 <스캔들> 게시물): 따옴표 뒤 마침표 때문에 따옴표째 저장됐다.
      assert.equal(
        cleanCaption('netflixkr - September 23, 2026: "아직 공개하지 않았던 장면들 #스캔들".'),
        "아직 공개하지 않았던 장면들 #스캔들"
      );
      assert.equal(cleanCaption('acc - January 1, 2026: "본문", '), "본문");
    },
  ],
  [
    "본문 안의 따옴표는 건드리지 않는다",
    () => {
      const out = cleanCaption('focuspic.kr - September 9, 2026: "팬들은 "역대급"이라고 반응했다"');
      assert.ok(out.includes('"역대급"'), `안쪽 따옴표가 살아 있어야 한다: ${out}`);
    },
  ],
  [
    "벗길 게 없으면 원문 그대로 - 형식이 바뀌어도 캡션을 잃지 않는다",
    () => {
      assert.equal(cleanCaption("그냥 캡션입니다"), "그냥 캡션입니다");
      assert.equal(cleanCaption("  앞뒤 공백  "), "앞뒤 공백");
    },
  ],
  [
    "빈 값은 빈 문자열",
    () => {
      assert.equal(cleanCaption(null), "");
      assert.equal(cleanCaption(undefined), "");
      assert.equal(cleanCaption("   "), "");
    },
  ],
  [
    "줄바꿈은 살리되 빈 줄이 겹치면 하나로 줄인다",
    () => {
      assert.equal(cleanCaption("첫 줄\n\n\n\n둘째 줄"), "첫 줄\n\n둘째 줄");
    },
  ],
  [
    "연예·OTT는 웹 검색만 - 실물 사진이 필요하다",
    () => {
      for (const category of ["entertainment", "ott"]) {
        const config = instagramImageConfig({ source: "instagram_manual", category });
        assert.ok(config, `${category}: 인스타 job이면 정책이 나와야 한다`);
        assert.equal(config?.enabled, false, `${category}: AI가 그린 인물을 연예 기사에 붙이면 안 된다`);
      }
    },
  ],
  [
    "그 외 주제는 AI 생성으로 빈 자리를 메운다",
    () => {
      for (const category of ["incident", "parenting", "living", "community"]) {
        const config = instagramImageConfig({ source: "instagram_manual", category });
        assert.equal(config?.enabled, true, `${category}: 빈 자리보다 AI 이미지가 낫다`);
      }
    },
  ],
  [
    "category가 null이면 켜지 않는다 - 판정 실패 건에 유료 생성을 태우지 않는다",
    () => {
      assert.equal(instagramImageConfig({ source: "instagram_manual", category: null })?.enabled, false);
    },
  ],
  [
    "인스타 job이 아니면 아무것도 바꾸지 않는다",
    () => {
      // null을 돌려줘야 호출부가 전역 설정을 그대로 쓴다. 여기서 true를 돌려주면 같은 저장소의
      // 일반 키워드 job까지 유료 생성이 돈다.
      assert.equal(instagramImageConfig({ source: undefined, category: "living" }), null);
      assert.equal(instagramImageConfig({ source: "keyword_pipeline", category: "living" }), null);
      assert.equal(describeImagePolicy({ source: undefined, category: "living" }), null);
    },
  ],
  [
    "정책 설명은 왜 그랬는지를 남긴다",
    () => {
      const on = describeImagePolicy({ source: "instagram_manual", category: "living" });
      assert.ok(on?.includes("AI 생성"), on ?? "");
      const off = describeImagePolicy({ source: "instagram_manual", category: "ott" });
      assert.ok(off?.includes("웹 검색만"), off ?? "");
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${error instanceof Error ? error.message : error}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log("\n🎉 캡션 정제 + 이미지 정책 테스트 통과");
