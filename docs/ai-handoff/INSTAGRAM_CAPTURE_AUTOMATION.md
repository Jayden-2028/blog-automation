# 캡처 세션 자동화 — 설계 (2026-09-22)

> 사용자 요구: **텔레그램으로 URL+캡션을 보낸 뒤부터 원고 초안이 도착할 때까지 사람 개입이
> 없어야 한다**(맥이 켜져 있다는 전제). 그 뒤(승인 → 최종본 → 발행)는 기존 루트 그대로.

## 어디가 끊겨 있었나

기존 파이프라인은 이미 조사부터 끝까지 자동이다 - 2026-09-15에 조사 체크포인트를 폐지해
`job:research`가 끝나면 `job:write`를 스스로 발화한다(`runResearchStageCli.ts`).

```
큐 적재 ──①── 캡처 세션 ──②── job:research ──자동── job:write ──자동──> 초안 알림
                                                                          ↓
                                              승인 → 최종본 → 🚀 발행 (기존 루트)
```

- **고리 ②**(캡처 완료 → 조사): 2026-09-22 해결. `ig:create-job`이 `triggerResearchForJob`을
  부른다. 분기는 `runResearchStageCli.ts`의 `triggerWriting`과 같다(GH Actions면 DB 큐, 맥이면
  detached 자식).
- **고리 ①**(큐 적재 → 캡처): 이 문서가 다루는 것.

## 승인된 결정 (2026-09-22 사용자)

| 항목 | 결정 |
|---|---|
| 캡처 세션 자동 시작 | **한다.** 예전 "사람 요청이 있어야 시작" 규칙을 대체한다 |
| 유료 API | **여전히 금지.** Google Vision 등을 새로 붙이지 않는다 - 비용 증가 0 |
| 인스타 로그인 | 맥에 Playwright 전용 프로필을 고정한다(`IG_BROWSER_PROFILE`) |
| 이미지 최종 판단 | **그대로 사람이 승인 단계에서** 한다. 이 단계는 후보만 준비 |

"사람 판단이 필요하다"는 원래 근거는 훼손되지 않는다 - 판단 시점이 캡처 때에서 승인 때로 옮겨질
뿐이고, 그건 원래 정책(`INSTAGRAM_POSTING_CONVERTER.md` 이미지 소싱 정책 4번)에 이미 그렇게
적혀 있다.

## 구조 — Node가 브라우저, Claude가 판단

**`collectWebImages`와 같은 분업을 그대로 쓴다.** 거기서도 Node가 후보를 모으고
`defaultChooseImage`(헤드리스 Claude)가 고른다. 브라우저 DOM·로그인처럼 깨지기 쉬운 것은
결정적인 코드가 맡고, 판단처럼 규칙으로 못 쓰는 것만 모델에 넘긴다.

"헤드리스 Claude에게 브라우저를 통째로 맡기는" 안은 기각했다 - 인스타 DOM이 바뀔 때마다
프롬프트를 고쳐야 하고, 실패해도 무엇이 틀렸는지 로그에 안 남는다.

```
job:ig-capture-poll (launchd 60초)
  1. 텔레그램 폴링 → 큐 적재                        [기존]
  2. 대기 항목마다 runCaptureSession()              [신규]
       a. captureInstagramCarousel()  - Playwright, 로그인 프로필
            게시물을 열고 캐러셀을 끝까지 넘기며 슬라이드마다 스크린샷 + 캡션 텍스트
       b. judgeCarouselSlides()       - 헤드리스 claude -p
            슬라이드 이미지를 Read로 열어 보고 판정:
            워터마크/로고/번인 텍스트가 있나 · 번인 텍스트는 무엇인가 ·
            주제어(searchKeyword) · 카테고리
       c. 워터마크 있는 슬라이드 → findCleanAlternative()
            같은 사진의 깨끗한 원본을 찾는다(무료 경로만)
       d. parseCaptureFile()로 검증 → createInstagramJob() → triggerResearchForJob()
  3. 실패하면 항목을 pending으로 두고 텔레그램 알림   [사람이 나중에 수동 처리 가능]
```

### 왜 단계마다 실패해도 멈추지 않는가

한 게시물이 막혀 폴러 전체가 죽으면 나머지 대기 항목도 같이 선다. 각 항목은 독립이고, 실패는
그 항목만 `pending`으로 되돌린다(`markEntry`). 재시도는 다음 폴링이 알아서 한다 - 다만 같은
항목이 영원히 재시도되지 않도록 `attempts`를 세고 3회를 넘으면 `skipped`로 내리고 알린다.

## 이미지 소싱 - 자동화해도 정책은 그대로

`INSTAGRAM_POSTING_CONVERTER.md`의 판단 순서를 코드가 그대로 따른다.

1. 워터마크·로고·번인 텍스트 **없음**(플랫한 단컷) → 그 슬라이드를 그대로 후보로
   (`kind: "instagram_capture"`).
2. **있음**(대부분) → 직접 쓰지 않고 같은 사진의 깨끗한 원본을 찾는다
   (`kind: "web_alternative"`, `sourcePage` 기록).
3. 번인 텍스트는 이미지를 못 쓰더라도 **항상** 기록한다 - `buildResearchPrompt.ts`가 1차 근거로
   주입한다.
4. 최종 사용 여부는 사람이 승인 단계에서 판단한다.

### 2-a단계(지금): 텍스트 검색 폴백

`searchImagesMerged`(네이버 + Serper)로 주제어 + 슬라이드 설명을 검색한다. **"같은 사진"이
아니라 "같은 주제 사진"이라 정확도가 떨어진다** - 원 정책도 이것을 차선책으로 적어 뒀다.
Serper는 이미 쓰고 있는 경로라 새 비용이 아니다.

### 2-b단계(나중): 진짜 리버스 이미지 검색

Playwright로 `lens.google.com`에 슬라이드를 업로드해 같은 사진의 출처를 찾는다. 무료이고
정확하지만 DOM 의존이 크다. **2-a를 먼저 돌려 보고 실제로 부족할 때** 붙인다 - 안 그러면
검증되지 않은 취약점을 미리 들이는 셈이다.

## 새 환경변수

```
IG_BROWSER_PROFILE=      Playwright 로그인 프로필 경로(맥). 없으면 캡처를 건너뛰고 알린다
IG_CAPTURE_AUTO=         기본 false. true여야 폴러가 캡처까지 이어서 한다
IG_CAPTURE_MAX_SLIDES=   기본 10. 캐러셀이 길 때 상한
```

`IG_CAPTURE_AUTO`를 기본 false로 두는 이유: 로그인 프로필이 준비되기 전에 켜지면 매 분 실패
알림이 온다. 프로필을 만들고 한 건 수동으로 확인한 뒤 켠다.

## 맥에서 처음 켜는 순서

```bash
npm run ig:install-browser          # Playwright 크로미움 내려받기(최초 1회)
# .env에 IG_BROWSER_PROFILE=/Users/<사용자>/.ig-profile 추가
npm run ig:login                    # 창이 열리면 인스타 로그인 -> 터미널에서 Enter
npm run ig-capture:status           # 대기열 확인
# .env에 IG_CAPTURE_AUTO=true 추가 -> 이때부터 폴러가 캡처까지 이어서 한다
```

`ig:login`은 `captureInstagramCarousel`과 **같은 함수·같은 인자**로 프로필을 만든다(headless만
끈다). `npx playwright` 한 줄로 만들면 인자가 어긋나 "로그인은 했는데 캡처는 로그인 안 된 상태"가
되기 쉬워서 전용 명령을 뒀다. 로그인이 실제로 됐는지도 확인하고 끝난다 - 창만 닫고 넘어가면
캡처가 매 분 실패한다.

세션이 풀리면 `ig:login`을 다시 돌린다(같은 디렉터리에 덮어쓴다).

## 알려진 위험

- **로그인 세션 만료.** 티스토리를 접은 것과 같은 구조다. 다만 실패해도 큐에 남고 알림만 가므로
  치명적이지 않다(티스토리는 발행 자체가 막혔다). 세션이 풀리면 프로필을 다시 만든다.
- **인스타 DOM 변경.** 캐러셀 넘기기 셀렉터가 바뀌면 캡처가 0장이 된다. 0장이면 job을 만들지
  않고 실패로 처리한다 - 이미지 없는 원고가 자동으로 나가는 것보다 낫다.
- **2-a의 대체 이미지 정확도.** 위 참고. 승인 단계에서 사람이 거른다.

## 절대 하지 말 것

- 유료 이미지/비전 API를 새로 붙이지 않는다(승인된 결정 아님).
- 인스타 **탐색**(이슈 페이지 훑기)으로 범위를 넓히지 않는다 - 기각된 설계다
  (`INSTAGRAM_KEYWORD_SOURCE.md`). 사용자가 지목한 URL 하나만 연다.
- 캡처 실패를 이미지 없는 job 생성으로 때우지 않는다.
