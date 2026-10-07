// RSS 제목 매칭 테스트(실제 주소 복원 - 슬러그가 다듬어져 404가 나던 2026-10-07 실측). 실행: npm run test:tistory-url
import { matchRssLink } from "./TistoryPublisher.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const RSS = `<rss><channel>
<item><title>어린이집聯 보육예산 정상화, 27억 빠진 추경에 2,000명 모였다</title><link>https://wooahpapa.tistory.com/entry/real-1</link></item>
<item><title>국방부 예술체육요원 병역특례 감축&middot;폐지 추진, 국방개혁 기본계획에 반영</title><link>https://wooahpapa.tistory.com/entry/real-2</link></item>
<item><title><![CDATA[노웨딩 예식장 줄폐업, 결혼식 대신 '빚 없는 시작' 고른 청년들]]></title><link>https://wooahpapa.tistory.com/entry/real-3</link></item>
</channel></rss>`;

// 聯은 한글·영숫자 밖이라 정규화에서 빠진다 - 그래도 나머지 글자로 유일하게 매칭돼야 한다.
const r1 = matchRssLink(RSS, "어린이집聯 보육예산 정상화, 27억 빠진 추경에 2000명 모였다");
assert(r1 === "https://wooahpapa.tistory.com/entry/real-1", `쉼표·한자 차이를 무시하고 매칭 (${r1})`);
const r2 = matchRssLink(RSS, "국방부 예술체육요원 병역특례 감축·폐지 추진, 국방개혁 기본계획에 반영");
assert(r2 === "https://wooahpapa.tistory.com/entry/real-2", `&middot; 엔티티 매칭 (${r2})`);
const r3 = matchRssLink(RSS, "노웨딩 예식장 줄폐업, 결혼식 대신 '빚 없는 시작' 고른 청년들");
assert(r3 === "https://wooahpapa.tistory.com/entry/real-3", `CDATA 매칭 (${r3})`);
assert(matchRssLink(RSS, "없는 글 제목") === null, "없으면 null");
console.log("✅ matchRssLink - 엔티티·CDATA·특수문자 차이 흡수");
console.log("\n✅ testTistoryPublishedUrl 전체 통과");
