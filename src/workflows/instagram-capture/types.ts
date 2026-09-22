// "인스타 포스팅 변환기" 파이프라인 공용 타입.
// 흐름: 텔레그램 수신(큐 적재) -> (사람이 부를 때) 브라우저 캡처 -> article_jobs 생성 -> 기존 조사/집필.

/** 텔레그램에서 받은 원문 그대로. 큐 파일(JSONL) 한 줄 = 이 타입 하나. */
export type InstagramQueueEntry = {
  /** 큐 안에서 유일한 식별자(telegram update_id 기반). */
  id: string;
  instagramUrl: string;
  /** URL을 뺀 나머지 메시지 텍스트(캡션을 사람이 붙여넣은 경우). 없으면 빈 문자열. */
  rawCaption: string;
  telegramChatId: string;
  telegramMessageId: number;
  receivedAt: string;
  /** 처리 완료 후에도 파일에서 바로 지우지 않고 상태만 바꾼다(재처리 방지 + 이력 확인용). */
  status: "pending" | "done" | "skipped";
  /** done/skipped로 바뀐 뒤 생성된 article_jobs.id. */
  jobId?: string;
};

/**
 * 브라우저 캡처 단계(사람 = Claude가 직접 수행)의 산출물.
 * 이 타입 자체를 만드는 코드는 없다 - 캡처를 수행하는 세션이 이 모양대로 채워서
 * createInstagramJob에 넘긴다.
 */
export type InstagramCaptureResult = {
  queueEntryId: string;
  instagramUrl: string;
  /** 사람이 붙여넣었거나, 캡처 중 화면에서 옮겨적은 캡션 원문. */
  caption: string;
  /** 캐러셀 이미지에 번인된 텍스트(정보 슬라이드 등). 없으면 빈 배열. */
  burnedInText: string[];
  /** 리서치 시드로 쓸 짧은 키워드(캡션/번인텍스트에서 판단해서 뽑는다). */
  searchKeyword: string;
  category: string | null;
  /** 원고 후보 이미지. 같은 slideIndex 안에서 kind별로 A/B 비교 후보가 된다. */
  images: InstagramCandidateImage[];
  /** 승인 단계에서 "프로필 임베드 필요"로 표시했을 때만 채운다. */
  profileEmbedUrl?: string | null;
};

export type InstagramCandidateImage = {
  /** 캐러셀 슬라이드 순서(1부터). 원고의 [IMAGE: ] 마커 순서와는 무관 - 별도로 매핑한다. */
  slideIndex: number;
  kind: "instagram_capture" | "web_alternative";
  /** 로컬에 저장된 파일 경로(업로드 전). */
  localPath: string;
  /** web_alternative일 때 찾은 곳. */
  sourcePage?: string | null;
  /** 재사용 근거 메모(사람이 최종 판단하지만 참고용으로 남긴다). */
  note?: string | null;
};
