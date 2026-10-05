// 멀티봇 공통 레이어(RESTRUCTURE-PLAN-2026-10.md §3.1). 트랙(track) 하나가 텔레그램 봇 하나에 대응한다.
// 파이프라인(수집→알림→research→write→승인)은 트랙과 무관하게 하나를 공유하고, "어느 봇으로 말하는가"만
// 여기서 정한다. 사용설명서 트랙(kscene, 개편3)도 이 표에 이미 들어 있다 - 봇 C는 토큰·채팅 ID만 채우면 된다.
//
// 트랙을 따라다니는 방법 두 가지:
//   · 수신: Worker가 webhook 경로(/webhook/<track>)로 봇을 구분해 dispatch payload에 `track`을 싣는다.
//     runTelegramUpdateCli가 이 값으로 그 봇의 TelegramBot을 만든다.
//   · 발송: job을 다루는 알림은 `job.metadata.track`으로 봇을 고른다(trackOfJob). 전용 컬럼을 만들지 않는
//     이유 - migration 없이(운영 DB 변경 없이) 쓰려는 것이고, 값이 없으면 엔터(메인봇)다. 개편 전에 만든
//     job은 전부 엔터로 읽히므로 하위 호환이 깨지지 않는다.
//
// credential은 절대 로그로 출력하지 않는다.

export const TRACKS = ["entertainment", "social", "kscene"] as const;
export type Track = (typeof TRACKS)[number];

/** 메인봇. 개편 전 모든 동작이 이 트랙이다. */
export const DEFAULT_TRACK: Track = "entertainment";

type TrackEnvKeys = { botToken: string; chatId: string };

export const TRACK_ENV_KEYS: Readonly<Record<Track, TrackEnvKeys>> = {
  entertainment: { botToken: "TELEGRAM_BOT_TOKEN", chatId: "TELEGRAM_CHAT_ID" },
  social: { botToken: "SOCIAL_TELEGRAM_BOT_TOKEN", chatId: "SOCIAL_TELEGRAM_CHAT_ID" },
  kscene: { botToken: "KSCENE_TELEGRAM_BOT_TOKEN", chatId: "KSCENE_TELEGRAM_CHAT_ID" },
};

/** 알림 문구에 쓰는 사람이 읽는 이름. */
export const TRACK_LABEL: Readonly<Record<Track, string>> = {
  entertainment: "엔터",
  social: "사회 이슈",
  kscene: "사용설명서",
};

export function isTrack(value: unknown): value is Track {
  return typeof value === "string" && (TRACKS as readonly string[]).includes(value);
}

/** 알 수 없는 값은 null. 호출자가 기본 트랙으로 폴백할지 던질지 정한다. */
export function parseTrack(value: unknown): Track | null {
  return isTrack(value) ? value : null;
}

/**
 * job이 속한 트랙. metadata.track이 없거나 모르는 값이면 엔터다(개편 전 job 포함).
 * 모르는 값을 던지지 않는 이유: 알림 하나 때문에 원고 파이프라인이 멈추면 안 된다 - 메인봇으로 가면
 * 적어도 사용자는 받는다.
 */
export function trackOfJob(job: { metadata?: unknown } | null | undefined): Track {
  const metadata = job?.metadata;
  if (metadata && typeof metadata === "object") {
    const track = parseTrack((metadata as Record<string, unknown>).track);
    if (track) return track;
  }
  return DEFAULT_TRACK;
}

export type PublishChannel = "blogspot" | "naver" | "tistory";

/**
 * 트랙별 발행 채널(개편2.5 B-2). 엔터=네이버, 사회=티스토리. Blogspot은 엔터·사회에서 쓰지 않는다
 * (콜백 처리 코드는 남아 있고 kscene 트랙의 K-Scene 블로그가 쓴다 - 개편3).
 */
export const TRACK_PUBLISH_CHANNELS: Readonly<Record<Track, readonly PublishChannel[]>> = {
  entertainment: ["naver"],
  social: ["tistory"],
  kscene: ["blogspot"],
};

/**
 * 서버가 받아 주는 채널. 버튼 구성(위)보다 한 칸 넓다 - 엔터의 Blogspot은 버튼만 뺐고 처리 코드는 남아 있다
 * (2026-10-05 개편). 사회는 티스토리뿐이다(네이버·Blogspot 거부).
 */
const TRACK_ALLOWED_CHANNELS: Readonly<Record<Track, readonly PublishChannel[]>> = {
  entertainment: ["naver", "blogspot"],
  social: ["tistory"],
  kscene: ["blogspot"],
};

/** 요청 채널이 job 트랙에 맞는가. 서버 측 검증(텔레그램 콜백·publishRequestCli)이 쓴다. */
export function isChannelAllowedForTrack(track: Track, channel: string): boolean {
  return (TRACK_ALLOWED_CHANNELS[track] as readonly string[]).includes(channel);
}

/** 발행 알림 키보드의 동작 구성(줄 단위). 원본 키보드를 잃어 다시 세울 때 쓴다. */
export function publishActionRowsForTrack(track: Track): ("images" | "export" | PublishChannel)[][] {
  return [["images", "export"], [...TRACK_PUBLISH_CHANNELS[track]]];
}

/**
 * 답장 매칭용: message_id가 같은 job이 여럿(트랙별)일 때 그 트랙의 것만 고른다. rows는 최신순.
 * track이 없으면 예전처럼 첫 job(트랙을 가리지 않는다).
 */
export function pickJobForTrack<T extends { metadata?: unknown }>(rows: readonly T[], track?: Track): T | null {
  if (!track) return rows[0] ?? null;
  return rows.find((row) => trackOfJob(row) === track) ?? null;
}

/**
 * 이 트랙에서 만드는 job의 metadata 조각. 엔터는 비어 있다(값이 없으면 엔터로 읽힌다 - trackOfJob).
 * 봇이 Go 버튼으로 job을 만들 때 쓴다.
 */
export function trackJobMetadata(track: Track): Record<string, unknown> {
  return track === DEFAULT_TRACK ? {} : { track };
}

export type TrackCredentials = { botToken: string; chatId: string };

/**
 * 트랙의 봇 토큰·채팅 ID를 환경변수에서 읽는다. 하나라도 비어 있으면 던진다.
 *
 * **다른 트랙의 값으로 대신하지 않는다.** 사회 봇 토큰이 없다고 메인봇으로 보내면 사회 키워드가 엔터
 * 채널에 섞여 들어간다 - 조용한 오배송보다 시끄러운 실패가 낫다.
 */
export function resolveTrackCredentials(
  track: Track = DEFAULT_TRACK,
  env: Record<string, string | undefined> = process.env
): TrackCredentials {
  const keys = TRACK_ENV_KEYS[track];
  const botToken = env[keys.botToken];
  const chatId = env[keys.chatId];

  if (!botToken || !chatId) {
    throw new Error(
      `Missing ${keys.botToken} or ${keys.chatId} (track=${track}). ` +
        `.env 또는 GitHub secrets에 해당 트랙의 텔레그램 봇 자격증명을 채워주세요.`
    );
  }
  return { botToken, chatId };
}
