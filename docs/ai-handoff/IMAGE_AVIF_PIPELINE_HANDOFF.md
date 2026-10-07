# 인수인계: 웹 수집 이미지의 AVIF가 `.png` 이름으로 저장되는 문제

작성: 2026-10-08 (티스토리 자동 발행 세션). 발행 쪽 방어는 끝났고, **수집 쪽 근본 수정**이 남아
이미지 파이프라인 담당 세션에 넘긴다.

## 무슨 일이 있었나 (2026-10-08 새벽 실측)

사회 트랙 "우크라 러 석유" 글(job `e5bc2087`)의 티스토리 자동 발행에서 이미지 5장 중 4장이
유실됐다. 시작점은 2번 이미지:

- Storage 경로 `article-images/e5bc2087-…/2-web.png` - 이름은 png인데 **실제 바이트는 AVIF**
  (`file` 판정: ISO Media, AVIF Image. 14.9KB, 1920×1050). 서빙 content-type도 `image/avif`.
- 티스토리 에디터는 이 파일을 받다 업로드 위젯이 꼬였고, **그 뒤의 정상 jpg·webp까지 연쇄로**
  업로드가 안 됐다(40초 대기 타임아웃 4연속). webp 자체는 무죄 - 같은 날 다른 글에서 여러 장 정상.

## 근본 원인 (세 지점이 겹친다)

1. `src/workflows/images/collectWebImages.ts` `extensionFor()` - 네이버 뉴스 CDN 등이 avif를
   주므로 **의도적으로 avif를 받는다**(주석: "브라우저·Storage 모두 받으므로 저장한다"). 수집
   자체는 문제가 아니다.
2. `src/services/images/optimizeImage.ts` - `OPTIMIZABLE`에 avif가 **없어서** WebP 변환을
   건너뛴다("대상 형식이 아님"). 변환기는 Chromium canvas라 avif 디코드가 **가능한데도** 목록에서
   빠져 있다. 추가로 150KB 미만은 어차피 건너뛰므로(`MIN_BYTES_TO_OPTIMIZE`) 이번 14.9KB짜리는
   목록에 있었어도 통과했을 것이다.
3. `src/services/supabase/storage/uploadArticleImage.ts` `extensionFor()` - jpeg/webp 외 전부
   `"png"`로 떨어뜨린다. 그래서 avif 버퍼가 `2-web.png`라는 **거짓 이름**으로 올라갔다
   (contentType은 `image/avif`로 정직하게 올라가서 이름과 내용물이 어긋난다).

## 이미 해 둔 것 (발행 쪽 방어, 커밋 `b6a9c9b`)

- `TistoryPublisher.ts`: 업로드 전 **실제 바이트로 형식 판별** 후 AVIF는 macOS `sips`로 JPEG
  변환(맥미니 실물 검증 완료), 변환 실패 시 그 한 장만 건너뜀. 업로드 미확인 시 Escape로 에디터
  상태를 털어 연쇄 실패 차단. 해당 글은 재발행해서 5장 전부 들어간 것 확인.
- 재사용 가능: `sniffImageFormat(buffer)` (jpg/png/gif/webp/avif 판별, `TistoryPublisher.ts`에서
  export, 테스트 `npm run test:tistory-image`). 수집 쪽에서 쓰려면 공용 모듈로 옮겨도 된다.

## 남은 과제 (이 문서의 요청 사항)

발행 쪽 방어는 티스토리뿐이다. **네이버 발행·뷰어·보관함도 같은 avif 파일을 받는다** - 네이버
에디터가 avif를 어떻게 받는지는 미확인 위험으로 남아 있다. 수집 단계에서 고치면 전부 해결된다.

제안(택1 또는 조합):

- **A. optimizeImage가 avif를 변환하게**: `OPTIMIZABLE`에 `image/avif` 추가(Chromium은 디코드
  가능). 단 150KB 미만 스킵 규칙 때문에 작은 avif가 남는다 - avif만은 크기와 무관하게 변환하는
  분기가 필요하다(목적이 용량 절감이 아니라 **형식 정규화**이므로).
- **B. uploadArticleImage에서 이름을 정직하게**: `extensionFor()`에 avif → `"avif"` 추가. 최소
  수정이지만 avif가 그대로 퍼지므로 발행기들(네이버 포함)이 각자 감당해야 한다. A와 병행 권장
  (A가 실패하는 best-effort 경로의 안전망).

주의: 파일명 자리는 고정(`{index}-web.{ext}`)이고 주소에 내용 해시 `?v=`가 붙는 구조라, 확장자가
바뀌면 **주소가 바뀐다**. 이미 발행된 글이 참조 중인 기존 Storage 파일은 건드리지 말 것.

## 검증 방법

1. avif를 주는 출처로 수집 테스트(실측 사례: 네이버 뉴스 CDN, 이 건의 원본도 그 경로로 추정).
2. 업로드된 파일의 확장자·contentType·실제 바이트 삼자가 일치하는지:
   `curl -sI <url>`의 content-type과 `file <다운로드 파일>` 비교.
3. 티스토리 쪽 회귀는 신경 쓸 것 없음(발행기가 자체 방어) - 네이버 발행 1회 실측 권장.

## 참고

- 증상·타임라인 상세: 이 세션 로그(2026-10-08 00~02시, 맥미니
  `~/Library/Logs/blog-automation-tistory-poll.log`의 "이미지 업로드가 확인되지 않았습니다" 4건).
- 티스토리 방어 설계: `docs/ai-handoff/TISTORY_AUTO_PUBLISH_DESIGN.md`.
