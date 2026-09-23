// "인스타 포스팅 변환기" 파이프라인 공용 타입.
// 흐름: 텔레그램 수신(링크만) -> 로그인 브라우저로 캡션·번인 텍스트 읽기 -> article_jobs 생성
// -> 기존 조사/집필 -> 기존 이미지 파이프라인.
//
// 2026-09-23 재설계: 게시물 **이미지는 쓰지 않는다**. 글자(캡션 + 번인 텍스트)만 자료로 가져오고,
// 원고 이미지는 주제가 정해진 뒤 기존 파이프라인이 검색·생성한다. 저작권 판단이 통째로 빠진다.

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
  /**
   * 처리 완료 후에도 파일에서 바로 지우지 않고 상태만 바꾼다(재처리 방지 + 이력 확인용).
   *
   * needs_topic(2026-09-23): 게시물에서 읽어낸 자료가 0이라(캡션도 번인 텍스트도 없음) 사용자에게
   * 주제를 물어보고 답을 기다리는 상태. 답장이 오면 pending으로 돌아가되 재캡처는 하지 않는다
   * - 같은 게시물을 다시 열어도 또 비어 있을 것이기 때문이다.
   */
  status: "pending" | "needs_topic" | "done" | "skipped";
  /** done/skipped로 바뀐 뒤 생성된 article_jobs.id. */
  jobId?: string;
  /**
   * 캡처 자동화가 실패한 횟수(2026-09-22). 같은 항목이 매 분 영원히 재시도되지 않도록
   * MAX_CAPTURE_ATTEMPTS를 넘으면 skipped로 내리고 알린다 - 사람이 수동으로 처리하면 된다.
   */
  attempts?: number;
  /** 마지막 실패 사유. 사람이 대기열을 볼 때 무엇이 막혔는지 알 수 있게 남긴다. */
  lastError?: string;
  /**
   * "어떤 주제로 쓸까요?" 질문 메시지의 telegram message_id(2026-09-23).
   *
   * 사용자가 그 메시지에 **답장**하면 어느 항목에 대한 답인지 이걸로 짚는다. 답장이 아니어도
   * needs_topic이 하나뿐이면 받아주지만, 여럿일 때는 이 값이 유일한 단서다.
   */
  askedMessageId?: number;
  /** 사용자가 답으로 준 주제. 캡션도 번인 텍스트도 없을 때의 유일한 자료다. */
  userTopic?: string;
};

/** 게시물 1건에서 읽어낸 것. 이미지는 쓰지 않는다 - 글자만 가져온다(2026-09-23 재설계). */
export type InstagramCaptureResult = {
  queueEntryId: string;
  instagramUrl: string;
  /** 게시물 캡션(og:description에서 뽑아 군더더기를 벗긴 것). 못 읽으면 빈 문자열. */
  caption: string;
  /** 슬라이드 이미지에 박힌 글자. 캡션과 함께 자료조사의 1차 근거가 된다. 없으면 빈 배열. */
  burnedInText: string[];
  /** 자료조사·원고 제목의 씨앗. 캡션과 번인 텍스트에서 뽑는다. */
  searchKeyword: string;
  category: string | null;
};
