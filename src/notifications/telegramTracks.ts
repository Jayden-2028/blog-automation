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
