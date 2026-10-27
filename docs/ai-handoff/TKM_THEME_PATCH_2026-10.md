# Korea Plain(구 The Korea Manual) 테마·UI 패치 (2026-10-27)

> 현재 이름: **Korea Plain**(2026-10-28 리브랜딩, `KOREA_PLAIN_REBRAND_2026-10.md`). 아래 본문은 작성 당시 기록이다.

작성: TKM 구조 보강 세션(B). 적용: 팀장이 Blogger UI에서. **이 문서의 항목은 코드로 할 수 없는 것만** 모았다 -
Blogger API v3에는 테마 편집·레이아웃 위젯·글별 검색 설명 필드가 없다.

## 0. 코드로 이미 끝난 것 (테마 작업 불필요)

| 항목 | 결과 |
|---|---|
| 소제목 `<h2>` | 38편 전부 h2 6~10개(옛 굵은 소제목 265개 변환). 신규 글은 변환기가 h2로 낸다 |
| 내부 링크 | 글마다 "Related Guides" 블록 - 비슷한 글 3 + 이전 글 1 + All Guides 1(가장 오래된 1편은 4개) |
| All Guides 허브 | https://thekoreamanual.blogspot.com/p/all-guides.html - 라벨별·최신순·발행일, 38편. **kscene 공개 발행 직후 자동 재생성** |
| JSON-LD | **본문 `<script type="application/ld+json">`(BlogPosting)를 Blogger가 보존한다** - 1편 실험 후 38편 적용, 38/38 공개 페이지에서 확인. 테마 쪽 JSON-LD 패치는 **필요 없다** |
| "관련 글" 위젯 | 본문 블록으로 대체돼 **필요 없다** |

## 1. [필수·가장 효과 큼] 홈에서 All Guides로 가는 링크 (레이아웃, 코드 아님)

홈은 최신 12편만 보이고, "Older posts"·라벨 페이지·아카이브 다음 페이지는 robots.txt `Disallow: /search`라
크롤되지 않는다. **홈 → All Guides → 모든 글**(2클릭)을 만들려면 홈에 All Guides 링크가 있어야 한다.

- Blogger > 레이아웃 > 상단 링크 목록 가젯(현재 About/Contact/Disclaimer/Editorial Policy/Privacy Policy가 있는
  `LinkList1`) > 수정 > 새 항목: 이름 `All Guides`, URL `https://thekoreamanual.blogspot.com/p/all-guides.html` > 저장.
  (적용 시 확인: 위 페이지들이 `LinkList1`이 아니라 "페이지" 가젯이면 그 가젯에서 All Guides 페이지를 체크하면 된다.)
- 확인: `curl -s https://thekoreamanual.blogspot.com/ | grep -c 'p/all-guides.html'` 가 1 이상.

## 2. [권장] 글별 meta description

현재 글 페이지에는 `<meta name="description">`이 **아예 없고** `og:description`은 블로그 공통 문구다
(실측: 홈에는 description이 있고 글 페이지에는 없다). 방법은 둘이다.

**A안(권장, 공식 경로)** - 테마 수정 없음:
1. 설정 > 메타태그 > "검색 설명 사용" 켜기(블로그 설명은 지금 문구 그대로).
2. 각 글 편집 > 오른쪽 "검색 설명"에 아래 부록 표의 문장을 붙여 넣고 업데이트. 38편(10~15분).
   신규 글은 원고 뷰어가 검색 설명을 보여준다(기존 운영과 같음 - API로는 넣을 수 없다, `BloggerClient.ts` 주석 참고).
3. 확인: `curl -s <글 URL> | grep -o "<meta content='[^']*' name='description'/>"`.

**B안(테마, 자동)** - 검색 설명을 비워 둔 글에도 본문 앞부분을 description으로 낸다. 테마 > HTML 편집에서 `<head>`
안 `<b:include data='blog' name='all-head-content'/>` **바로 아래**에 넣는다. ⚠️ 적용 시 확인: 이 테마(`version-1-3-3`,
body class `container item-view`)의 head에서 `data:view.description`이 글 페이지에서 블로그 설명으로 떨어지는 것은
실측(og:description)으로 확인했지만, `data:view.isSingleItem`/`snippet()` 동작은 미리보기로 확인할 것.

```xml
<b:if cond='data:view.isPost and data:view.description == data:blog.metaDescription'>
  <meta expr:content='snippet(data:view.title, {length: 60}) + " - " + data:blog.metaDescription' name='description'/>
</b:if>
```

B안은 본문 요약이 아니라 "제목 + 블로그 설명" 수준이라 A안보다 약하다. **A안을 먼저** 하고, B안은 신규 글 검색 설명을
빠뜨리는 일이 잦을 때만 검토한다.

## 3. [선택] 글 제목을 `<h1>`로

글 페이지에서 `<h1>`은 블로그 이름(헤더)이고 글 제목은 `<h3 class='post-title entry-title'>`이다. 본문 h2와 위계가 어긋난다.
구글은 위계를 엄격히 보지 않으므로 색인 문제의 원인은 아니다 - 여유 있을 때만.

테마 > HTML 편집 > `Blog1` 위젯의 `postTitle` includable에서 (적용 시 확인: 이름이 `postTitle`인지, 같은 h3가 목록 화면에도 쓰이는지)

```xml
<!-- 전 -->
<h3 class='post-title entry-title'> ... </h3>
<!-- 후: 글 페이지에서만 h1 -->
<b:tag class='post-title entry-title' expr:name='data:view.isSingleItem ? "h1" : "h3"'> ... </b:tag>
```

같이 `Header1` 위젯의 블로그 이름 `<h1>`을 글 페이지에서는 `<p>`로(`expr:name='data:view.isHomepage ? "h1" : "p"'`).
적용 후 글 페이지 `grep -c '<h1'` = 1이고 그 안이 글 제목인지 확인.

## 4. 보류

- **라벨 페이지 크롤 개방**(robots.txt의 `/search` 차단 해제)은 선택지였으나 **보류**(2026-10-27 팀장 결정 - 라벨 페이지는 얇아 여는 이득이 없음, 허브 페이지로 대체).

## 부록. 글별 검색 설명 (A안 붙여넣기용, 번역 산출물 `channelMeta.blogspot.searchDescription`)

| 글 경로 | 검색 설명 |
|---|---|
| /2026/10/korean-gift-giving-etiquette-how-to.html | In Korea, give and receive gifts with both hands and don't open them on the spot. Gifts to avoid, holiday, housewarming, and wedding gifts, and cash amounts. |
| /2026/10/korean-dating-culture-rules-100-day.html | How 100-day anniversaries, small couple items, and no-dating rules in hobby clubs work in Korean dating culture. |
| /2026/10/korean-honorifics-explained-oppa-unni.html | Meanings of oppa, unni, hyung, noona, sunbae, ssi and nim, plus verb honorifics, three speech levels, and the safest way to address someone new. |
| /2026/10/korean-etiquette-for-tourists-greetings.html | Korean etiquette comes down to bowing, shoes off, two hands, elders first, and a low voice. Rules for restaurants, subways, palaces, and Bukchon. |
| /2026/10/korea-alien-registration-card-arc-how.html | Who needs a Korean ARC, what documents to bring, how to book a HiKorea visit, processing time, and the deadlines for reporting changes. |
| /2026/10/korean-food-spice-levels-where-to-start.html | Korean food spice levels vary by region and restaurant. Learn how tteokbokki differs by city, ramen Scoville numbers, how to read menus, and how to order milder. |
| /2026/10/cost-of-living-in-korea-vs-us-rent-food.html | Korea's cost of living vs the US: rent, food, transport, and phone prices, the 7.19% health insurance rate for foreigners, and monthly budgets in Seoul and Busan. |
| /2026/10/korean-age-system-explained-korean-year.html | Learn how Korea's three age systems work, what changed on June 28, 2023, and where exceptions remain for alcohol, tobacco, military service, and school entry. |
| /2026/10/how-to-open-bank-account-in-korea-as.html | How foreigners open a Korean bank account: ARC and passport, mobile ARC, bank apps, common rejection reasons, and limited-account caps. |
| /2026/10/korean-dining-etiquette-3-key-rules-for.html | Korean dining etiquette comes down to three rules: elders eat first, pour and receive drinks with two hands, and keep your rice bowl on the table. |
| /2026/10/k-eta-cost-official-fee-is-10000-per.html | The official K-ETA fee is ₩10,000 per person, plus a 3% card fee. Learn about third-party site prices, when to apply, validity, and exemptions. |
| /2026/10/korean-wedding-guest-etiquette-dress.html | Korean wedding guest etiquette: what to wear, how much money to give, how to prepare the envelope, where to check in, and what to do if you can't attend. |
| /2026/10/korean-food-delivery-apps-for.html | Order Korean food delivery without a Korean phone number: how SHUTTLE works, Baemin at Han River parks, delivery zones, and how to enter your address. |
| /2026/10/korean-dating-superstitions-deoksugung.html | Korean love superstitions explained: the Deoksugung stone wall walk, giving shoes as gifts, the chicken wing myth, and couple days like White Day and Pepero Day. |
| /2026/10/why-you-shouldnt-write-names-in-red-ink.html | Why Koreans avoid writing a living person's name in red ink, where the superstition comes from, the dojang stamp exception, and what to use on cards and forms. |
| /2026/10/is-tipping-customary-in-korea-what-to.html | Tipping is not customary in Korea because service charges are already in the price. Learn what to do at restaurants, in taxis, hotels, and spas, and with tip jars. |
| /2026/10/korea-intercity-bus-schedule-how-to.html | Check Korean bus times on Kobus, TxBus, and Bustago. Covers Seoul's four terminals, Seoul–Busan fares, foreign card payment, and boarding. |
| /2026/10/how-cold-is-korea-in-winter.html | Korea's winter (December to February) average temperatures, cold-wave lows, snow in Seoul vs. the mountains, plus ski resorts and ice festivals. |
| /2026/10/seoul-day-trip-to-dmz-tour-types-and.html | A Seoul day trip to the DMZ takes 5–8 hours on a standard tour. Tour types, costs, booking requirements, and the DMZ train. |
| /2026/10/how-to-drink-soju-in-korea-pouring.html | Soju etiquette comes down to four rules: elders first, two hands, turn away to drink, and let others fill your glass. Also covers toasts, anju, somaek, and declining politely. |
| /2026/10/how-to-dispose-of-food-waste-in-korea-3.html | Korea's food waste rules vary by area and building: apartment RFID bins, sticker-tagged containers, or bags. Learn what counts as general waste, plus fees. |
| /2026/10/how-to-get-internet-in-south-korea-sim.html | Where to get a USIM, eSIM or Wi-Fi egg on arrival, and what long-term residents need for a phone plan and home internet with an ARC. |
| /2026/10/bowing-in-korea-vs-japan-angles.html | Korean and Japanese bows share the same 15, 30, and 45 degree angles. Learn how deep to bow in Korea for each person and when a handshake comes with it. |
| /2026/10/how-to-use-karrot-daangn-app-in-korea.html | Karrot (Daangn) is a neighborhood secondhand app foreigners can use in English. Covers ARC phone number, neighborhood verification, trade steps, and scam signs. |
| /2026/10/how-to-get-taxi-in-korea-apps-seoul.html | How foreigners can take a taxi in Korea: k.ride, TABA and Uber apps, Seoul standard taxi fares and surcharges, and how to check an English receipt. |
| /2026/10/where-to-buy-t-money-card-in-korea.html | Buy a T-money card at convenience stores or Seoul subway station service centers for ₩3,000–5,000 and top it up with cash. Covers where to buy, top-up, foreign cards, and refunds. |
| /2026/10/how-to-ride-seoul-bus-tap-in-ring-bell.html | Board Seoul buses by the front door, tap your card, press the bell, and tap again at the back door. Fares, bus colors, transfers, and Namsan routes. |
| /2026/10/korea-phone-plans-for-foreigners-how-to.html | Your phone plan in Korea depends on whether you stay 90 days or less. Compare eSIM and SIM prices, ARC rules, MVNO plans, and where to activate. |
| /2026/10/how-to-use-naver-map-in-english.html | Naver Map can be switched to English in the app settings. Learn the language path, what stays in Korean, how it differs from Kakao Map, and how to use it without a Korean number. |
| /2026/10/national-pension-refund-in-korea-how.html | Who can get a National Pension lump-sum refund when leaving Korea: 24 agreement countries, 26 reciprocity countries, E-8, E-9, H-2, payout, documents, Incheon Airport, deadlines. |
| /2026/10/how-to-get-tax-refund-at-olive-young-in.html | How foreign visitors get a tax refund at Olive Young: immediate refund vs. airport refund, minimums, limits, steps, and refund-eligible stores. |
| /2026/10/emergency-numbers-in-korea-ambulance.html | In Korea, call 119 for an ambulance and 112 for police. Learn how 1330 connects you to 119 if English fails, how to report, and why 1345 is not an emergency line. |
| /2026/10/what-is-korean-nunchi-how-to-read-room.html | Nunchi is the Korean skill of reading unspoken moods. Learn its meaning, spelling, how it works at drinks, meals and work, and how to build it. |
| /2026/10/korea-music-festivals-2026-dates.html | Dates, lineups, ticket sellers, prices, and sale timing for seven Korean music festivals in 2026: four are over, and three run through November. |
| /2026/10/do-you-need-to-press-crosswalk-button.html | Some Korean crosswalks change only after you press the button; others don't. Learn how push-button signals, walk times, flashing green, and right-turning cars work. |
| /2026/10/how-to-order-korean-bbq-chicken-at.html | "Korean BBQ chicken" is not a fixed Korean menu name. Learn the words for ordering at a chicken shop, how to use delivery apps, and what it costs. |
| /2026/10/what-taxi-app-does-korea-use-kakao-t-vs.html | Kakao T is Korea's main taxi app. Foreign visitors can use k.ride or TABA with an overseas card. Seoul fares, late-night surcharges, payment, and Incheon Airport taxi stands. |
| /2026/10/korea-stock-market-trading-hours-krx.html | Korea's regular KRX session runs 9:00–15:30 KST; with Nextrade, trading spans 8:00–20:00. Covers after-market, holidays, foreign accounts, and order types. |
