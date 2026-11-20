// 멀티봇 공통 레이어(RESTRUCTURE-PLAN-2026-10.md §3.1). 트랙(track) 하나가 텔레그램 봇 하나에 대응한다.
// 파이프라인(수집→알림→research→write→승인)은 트랙과 무관하게 하나를 공유하고, "어느 봇으로 말하는가"만
// 여기서 정한다. 사용설명서 트랙(koreaplain, 개편3)도 이 표에 이미 들어 있다 - 봇 C는 토큰·채팅 ID만 채우면 된다.
//
// 트랙을 따라다니는 방법 두 가지:
//   · 수신: Worker가 webhook 경로(/webhook/<track>)로 봇을 구분해 dispatch payload에 `track`을 싣는다.
//     runTelegramUpdateCli가 이 값으로 그 봇의 TelegramBot을 만든다.
//   · 발송: job을 다루는 알림은 `job.metadata.track`으로 봇을 고른다(trackOfJob). 전용 컬럼을 만들지 않는
//     이유 - migration 없이(운영 DB 변경 없이) 쓰려는 것이고, 값이 없으면 엔터(메인봇)다. 개편 전에 만든
//     job은 전부 엔터로 읽히므로 하위 호환이 깨지지 않는다.
//
// credential은 절대 로그로 출력하지 않는다.

// scenepick(2026-11-21 사용자 결정): 네이버 블로그 "scenepick"(몽상가N의 쓸데없는 궁금증들) 원고 트랙. **봇은 사회 봇을 같이 쓴다**
// (환경변수 키가 social과 같다) - 사용자가 사회 봇에 주제를 보내면 맥미니 Codex가 원고·이미지를 만들고 scenepick.html에 올린다
// (workflows/scenepick). 봇이 같으므로 webhook도 /webhook/social 하나다 - Worker에 scenepick 경로를 만들지 않는다.
export const TRACKS = ["entertainment", "social", "kscene", "scenepick"] as const;
export type Track = (typeof TRACKS)[number];

/** 메인봇. 개편 전 모든 동작이 이 트랙이다. */
export const DEFAULT_TRACK: Track = "entertainment";

type TrackEnvKeys = { botToken: string; chatId: string };

export const TRACK_ENV_KEYS: Readonly<Record<Track, TrackEnvKeys>> = {
  entertainment: { botToken: "TELEGRAM_BOT_TOKEN", chatId: "TELEGRAM_CHAT_ID" },
  social: { botToken: "SOCIAL_TELEGRAM_BOT_TOKEN", chatId: "SOCIAL_TELEGRAM_CHAT_ID" },
  // 환경변수 이름은 옛 코드명 그대로다(GitHub 시크릿에 등록된 이름이라 바꾸면 발행이 끊긴다).
  kscene: { botToken: "KSCENE_TELEGRAM_BOT_TOKEN", chatId: "KSCENE_TELEGRAM_CHAT_ID" },
  // 사회 봇과 같은 봇·같은 채팅(2026-11-21). 새 봇을 만들지 않은 이유: 사용자가 이미 쓰는 사회 봇 채팅에 주제를 보내면 되고,
  // 티스토리 운영 중단으로 사회 봇이 할 일이 비었다.
  scenepick: { botToken: "SOCIAL_TELEGRAM_BOT_TOKEN", chatId: "SOCIAL_TELEGRAM_CHAT_ID" },
};

/** 알림 문구에 쓰는 사람이 읽는 이름. */
export const TRACK_LABEL: Readonly<Record<Track, string>> = {
  entertainment: "엔터",
  social: "사회 이슈",
  kscene: "사용설명서",
  scenepick: "씬픽(네이버)",
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
    const raw = (metadata as Record<string, unknown>).track;
    // scenepick도 TRACKS에 있으므로 parseTrack이 그대로 잡는다(metadata.track === "scenepick" -> scenepick).
    const track = parseTrack(raw);
    if (track) return track;
    // 종합 키워드 입력 툴의 일상(living)·테크(tech) 트랙(2026-10-19 사용자 결정): 알림·뷰어는 **사회**로 간다.
    // 발행 버튼은 isManualPublishOnly가 먼저 걸러서(뷰어 복붙 전용) 사회 트랙의 티스토리 버튼이 붙지 않는다.
    if (raw === "living" || raw === "tech") return "social";
  }
  return DEFAULT_TRACK;
}

export type PublishChannel = "blogspot" | "naver" | "tistory";

/**
 * 트랙별 발행 채널(개편2.5 B-2). 엔터=네이버, 사회=티스토리. Blogspot은 엔터·사회에서 쓰지 않는다
 * (콜백 처리 코드는 남아 있고 koreaplain 트랙의 K-Scene 블로그가 쓴다 - 개편3).
 */
export const TRACK_PUBLISH_CHANNELS: Readonly<Record<Track, readonly PublishChannel[]>> = {
  entertainment: ["naver"],
  // 2026-11-21 사용자 결정: 티스토리 운영 중단(블로그는 남긴다). 사회 원고에는 발행 버튼이 붙지 않는다 - 뷰어에서 복사한다.
  // 되살리기 = ["tistory"] 복원(아래 TRACK_ALLOWED_CHANNELS도 함께).
  social: [],
  kscene: ["blogspot"],
  // 네이버 scenepick은 수동 발행뿐이다(사용자가 뷰어에서 본문 복사 + 이미지 받기). 버튼이 가리킬 곳이 없다.
  scenepick: [],
};

/**
 * 서버가 받아 주는 채널. 버튼 구성(위)보다 한 칸 넓다 - 엔터의 Blogspot은 버튼만 뺐고 처리 코드는 남아 있다
 * (2026-10-05 개편). 사회는 티스토리뿐이다(네이버·Blogspot 거부).
 */
const TRACK_ALLOWED_CHANNELS: Readonly<Record<Track, readonly PublishChannel[]>> = {
  entertainment: ["naver", "blogspot"],
  // 2026-11-21 티스토리 운영 중단: 옛 알림에 남은 🟠 버튼·뷰어 요청도 받지 않는다. 받아 주면 큐에 쌓이기만 하고(맥미니
  // tistory-poll을 내린다) 아무도 처리하지 않는다 - 조용히 묵히는 것보다 거절 안내가 낫다.
  social: [],
  kscene: ["blogspot"],
  scenepick: [],
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
