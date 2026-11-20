# scenepick 이식 패키지 규격 (Codex 집필 세션 → 파이프라인)

Codex 쪽에서 준비 중인 "기존 원고 이식 패키지"를 파이프라인이 그대로 쓰도록 맞추는 규격이다.
패키지는 **맥미니 `~/blog-automation/scenepick-workspace/package/`** 에 둔다. 저장소가 공개
저장소라 발행 원고 전문은 **커밋하지 않는다** - 패키지는 맥미니 작업장에만 둔다.

## 넣을 것

```
package/
  STYLE.md          문체·구성 지침 (필수)
  examples/         발행본 예시 원고 3~8편 (권장)
    01-<짧은 이름>.md
  IMAGES.md         이미지 스타일 지침 (선택)
```

- `STYLE.md`: 이 블로그 글이 어떤 말투·구성·분량으로 쓰였는지. 제목 짓는 방식, 도입부·마무리 방식,
  소제목 수, 자주 쓰는 표현과 피할 표현, 카테고리별 차이가 있으면 그것까지.
  **납품 형식**(파일 이름, `[IMAGE: ...]` 표기, meta.json)은 적지 않아도 된다 - 상시 지침(AGENTS.md)이
  정하고, 둘이 다르면 납품 형식은 AGENTS.md를 따른다.
- `examples/*.md`: 실제 발행본 본문. 맨 위에 `제목:`과 `카테고리:` 두 줄, 빈 줄, 본문. 이미지가
  있던 자리는 `[IMAGE: 무엇이 있었는지]`로 바꿔 둔다.
- `IMAGES.md`: 대표 이미지 톤, 도해 스타일, 색감 등. 없으면 AGENTS.md의 이미지 규칙만 쓴다.

## 넣지 말 것

- 리서처·라이터 지침(researcher.md / writer.md) - 이 블로그는 쓰지 않기로 했다.
- 개인정보, 계정 정보, 토큰.

## 넣는 방법

맥미니에서(또는 맥북에서 rsync로):

```
mkdir -p ~/blog-automation/scenepick-workspace/package
# 준비된 파일을 그 폴더로 복사
```

패키지는 다음 발주부터 바로 쓰인다. 바꾸고 싶으면 파일만 교체하면 된다.

## 실제 반영 상태 (2026-11-21)

GPT 일상 주제 세션의 인수 자료(`~/DreamerN/deliverables/daily-topics-handoff-2026-11-21`, 맥북)를
리드(Claude)가 받아 맥미니 작업장에 이렇게 넣었다:

- `package/STYLE.md` - 인수 문서(CODEX-HANDOFF.md)와 예시 10편에서 뽑은 문체 요약
- `package/examples/01~10-*.md` - 발행본 10편의 본문(`viewer-body.md`, `[IMAGE: ...]` 마커 포함)
- `package/handoff/` - 인수 자료 원본 전체(legacy·네이버 커버 제외, 약 73MB). 과거 원고 10편을
  뷰어로 이식하는 작업은 하지 않았다 - 이미 네이버에 발행된 글이라 예시로만 쓴다.

인수 자료가 제안한 납품 계약(delivery.json·offline.html·SHA256·review.md)은 선택 산출물로 받아들이고,
필수 형식은 AGENTS.md의 manuscript.md + meta.json + images/로 둔다.
