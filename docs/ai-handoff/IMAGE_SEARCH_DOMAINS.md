# 구글 이미지 검색 - 등록할 사이트 목록

> 2026-09-21 작성. Programmable Search Engine의 **검색할 사이트**(최대 50개)에 넣는 목록이다.
> 구글이 2026-01-20부로 신규 엔진의 "전체 웹 검색"을 지원 중단해서, 도메인을 직접 지정하는
> 방식만 남았다(`support.google.com/programmable-search/answer/12397162`).

## 왜 이 목록인가

두 가지를 합쳤다.

1. **실측** - 지금까지 우리 파이프라인이 실제로 채택한 이미지의 기사 페이지 도메인
   (`article_jobs.metadata.images[].sourcePage` 집계). CDN 호스트(`imgnews.naver.net`,
   `cdn.mania.kr`, `pstatic.net` 등)는 **뺐다** - 사이트 제한은 이미지가 올려진 CDN이 아니라
   **그 이미지가 실린 기사 페이지** 도메인으로 걸린다.
2. **반려 사례가 필요로 한 매체** - 지창욱(연예), 이현중(스포츠) 같은 인물 사진은 연예·스포츠
   전문지에 몰려 있다. 실측 목록에 없어도 넣었다.

**우선순위는 연예·스포츠 전문지다.** 사용자가 반려한 사례가 전부 그쪽이었고, 기업 공식 페이지나
공공기관 자료는 네이버 검색과 Claude 에이전트가 이미 곧잘 찾아왔다(코스트코·권익위·CGV 실측).

## 등록 형식

`*.example.com` 형태로 넣으면 하위 도메인까지 포함된다(`osen.mt.co.kr`을 덮으려면 `*.mt.co.kr`).
`*.co.kr` 같은 공개 서픽스 패턴은 구글이 거부한다.

## 목록 (46개)

```
*.yna.co.kr
*.newsis.com
*.news1.kr
*.newspim.com
*.chosun.com
*.joongang.co.kr
*.donga.com
*.hani.co.kr
*.khan.co.kr
*.seoul.co.kr
*.segye.com
*.munhwa.com
*.kmib.co.kr
*.hankookilbo.com
*.hankooki.com
*.hankyung.com
*.mk.co.kr
*.mt.co.kr
*.edaily.co.kr
*.asiae.co.kr
*.heraldcorp.com
*.fnnews.com
*.sedaily.com
*.koreaherald.com
*.kbs.co.kr
*.imbc.com
*.sbs.co.kr
*.jtbc.co.kr
*.ytn.co.kr
*.mbn.co.kr
*.tvchosun.com
*.sportschosun.com
*.sportsseoul.com
*.sportsworldi.com
*.sportsdonga.com
*.mksports.co.kr
*.xportsnews.com
*.mydaily.co.kr
*.newsen.com
*.tvdaily.co.kr
*.topstarnews.net
*.starnewskorea.com
*.spotvnews.co.kr
*.isplus.com
*.ize.co.kr
*.insight.co.kr
```

## 남은 4칸을 무엇으로 채울까

50개 중 46개를 썼다. 남은 자리는 **운영하며 비는 주제를 보고** 채운다. 후보:

- `*.dispatch.co.kr` - 연예 단독 사진이 많다
- `*.tenasia.hankyung.com` - hankyung 하위라 이미 덮임(중복)
- `*.dailian.co.kr`, `*.nocutnews.co.kr` - 종합
- `*.interfootball.co.kr`, `*.footballist.co.kr` - 축구 전문(스포츠 비중이 커지면)
- `*.korea.kr` - 정책브리핑. 공공누리라 라이선스가 가장 안전하다(정책 원고가 늘면 1순위)

## 주의

이 목록은 **구글 콘솔에 사람이 직접 넣는 값**이고 코드에는 없다. 저장소에 문서로 두는 이유는
나중에 "왜 이 매체들인가"를 되짚고, 목록을 고칠 때 근거를 잃지 않기 위해서다.

⚠️ **2026-09-21 현재 구글 Custom Search JSON API 자체가 403이라 등록해도 확인할 수 없다.**
API·키·프로젝트·제한이 전부 정상인데 프로젝트 단위로 거부된다(일반 웹 검색도 동일). 403이
풀린 뒤에 등록하고 테스트하는 것이 순서다.
