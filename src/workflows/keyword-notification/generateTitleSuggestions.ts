// 키워드별 "추천 블로그 제목 3개" placeholder 생성기.
//
// 지금은 실제 문장 생성(LLM 등)을 쓰지 않는다 — canonical keyword를 몇 가지 고정 템플릿에 끼워 넣는
// 규칙 기반 자리표시자일 뿐이며, 그대로 포스팅 제목으로 쓸 만한 품질은 아니다. 알림 메시지에 "이 자리에
// 나중에 실제 추천 제목이 들어간다"는 구조를 보여주기 위한 것으로, 실제 제목 생성 로직(LLM 프롬프트 등)은
// 이후 별도 작업으로 대체할 자리다.

const TITLE_TEMPLATES: ((keyword: string) => string)[] = [
  (keyword) => `${keyword}, 지금 꼭 알아야 할 이유`,
  (keyword) => `${keyword} 총정리 (최신 업데이트)`,
  (keyword) => `${keyword} 신청 방법과 주의할 점`,
];

export function generateTitleSuggestions(keyword: string): string[] {
  return TITLE_TEMPLATES.map((template) => `[placeholder] ${template(keyword)}`);
}
