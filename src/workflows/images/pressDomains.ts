// 언론사 기사 페이지 판별(2026-10-02 사용자 결정 - 기사 화면 캡처 폐지).
//
// 왜 막는가: 기사 캡처를 허용한 뒤 남발됐다. 오세훈 2심 원고는 6자리 중 4자리가 YTN·한국일보·
// 아시아투데이·아시아경제 기사 화면이었다. 사용자 결정: "언론사 기사 페이지 캡쳐는 더이상 쓰지
// 않겠습니다." 공공기관·공식 홈페이지·예매·순위 페이지 캡처는 그대로 쓴다 - 그쪽은 모범 사례다.
// **카테고리를 보지 않는다** - 작품·연예·행사·정책 원고에도 똑같이 막는다(2026-10-02 사용자 확인).
//
// 1차 방어선은 규격(리서처가 §11에 기사 URL을 적지 않는다, 기획이 기사 캡처를 고르지 않는다)이고
// 이 목록은 2차 방어선이다. 목록이 완전할 수 없어 호스트 이름 규칙(news·press)을 함께 쓴다.

/** 주요 언론사·포털 뉴스 도메인. 하위 도메인까지 막는다(`view.asiae.co.kr` → `asiae.co.kr`). */
const PRESS_DOMAINS = [
  // 통신·방송
  "yna.co.kr", "ytn.co.kr", "kbs.co.kr", "imbc.com", "sbs.co.kr", "jtbc.co.kr", "joins.com", "mbn.co.kr",
  "ichannela.com", "tvchosun.com", "obsnews.co.kr",
  // 종합·경제 일간지
  "chosun.com", "joongang.co.kr", "donga.com", "hani.co.kr", "khan.co.kr", "hankookilbo.com", "seoul.co.kr",
  "segye.com", "kmib.co.kr", "munhwa.com", "mk.co.kr", "hankyung.com", "sedaily.com", "mt.co.kr", "edaily.co.kr",
  "asiae.co.kr", "asiatoday.co.kr", "heraldcorp.com", "fnnews.com", "etnews.com", "ajunews.com", "dt.co.kr",
  "bizwatch.co.kr", "inews24.com", "zdnet.co.kr", "nocutnews.co.kr", "ohmynews.com", "pressian.com",
  "mediatoday.co.kr", "sisain.co.kr", "sisajournal.com", "kukinews.com", "newsis.com", "news1.kr",
  "newspim.com", "dailian.co.kr", "mediapen.com", "wikitree.co.kr", "insight.co.kr", "huffingtonpost.kr",
  // 연예·스포츠
  "dispatch.co.kr", "osen.co.kr", "starnewskorea.com", "xportsnews.com", "sportsseoul.com", "sportschosun.com",
  "spotvnews.co.kr", "tvreport.co.kr", "tenasia.co.kr", "topstarnews.net", "mydaily.co.kr", "isplus.com",
  "sportsworldi.com", "stoo.com", "enews.imbc.com",
  // 포털 뉴스
  "news.naver.com", "entertain.naver.com", "sports.naver.com", "news.daum.net", "v.daum.net", "news.nate.com",
  // 해외
  "bbc.com", "bbc.co.uk", "cnn.com", "nytimes.com", "reuters.com", "apnews.com", "bloomberg.com",
];

/** 정부·공공 도메인은 이름에 news가 있어도 기사로 보지 않는다(정책브리핑 등). */
const PUBLIC_SUFFIXES = [".go.kr", ".korea.kr", ".or.kr", ".gov"];

export function isPressUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // 판단할 수 없으면 막지 않는다(fail-open). 주소 오류는 호출부가 따로 잡는다.
  }
  if (host === "korea.kr" || PUBLIC_SUFFIXES.some((s) => host.endsWith(s))) return false;
  if (PRESS_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  // 목록 밖 언론사: 호스트 이름 토막에 news·press가 있으면 기사로 본다(`biz.newsxxx.com`, `xxpress.co.kr`).
  return host.split(".").some((label) => /news|press/.test(label));
}
