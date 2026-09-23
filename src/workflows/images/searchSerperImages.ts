// 구글 이미지 검색 결과를 Serper를 통해 받아온다(2026-09-21).
//
// 왜 구글 공식 API가 아닌가: 구글 Custom Search JSON API는 **신규 고객에게 더 이상 열리지
// 않는다**. 프로젝트를 새로 파도 403 "This project does not have the access to Custom Search
// JSON API"로 막힌다. 게다가 2027-01-01에 완전 종료 예정이라, 설령 뚫었어도 곧 다시 만들
// 일이었다. Serper는 구글 검색 결과를 그대로 중계하므로 **우리가 원한 건 구글 색인**이라는
// 요구는 그대로 지켜진다.
//
// 왜 네이버만으로 부족한가(사용자 지적): 네이버 이미지 검색은 한국 색인이라 스포츠 현장 사진처럼
// 구글에는 수십 장 있는 것도 후보가 안 나온다. 실측 반려 사례가 전부 "구글에서 검색하면 충분히
// 나오는데 자리가 비었다"였다(이현중 슛, 지창욱 톰포드 화보). 검색어를 아무리 다듬어도 **색인에
// 없는 사진은 못 찾는다** - 그래서 색인을 하나 더 붙인다.
//
// 네이버보다 나은 점이 하나 더 있다: `link`로 **그 사진이 실린 페이지**를 같이 준다. 네이버는
// 제목만 줘서 출처를 짐작해야 했다. "얼굴로 인물을 특정하지 말고 출처 페이지로 판단하라"는
// 검증 규칙(2026-09-21)이 쓰는 근거가 여기서 나온다.
//
// 요금: 가입 시 2,500건 무료, 이후 1,000건당 $1(10건 이하 조회는 1크레딧). 키가 없거나 한도를
// 넘으면 **조용히 빈 배열**을 돌려준다 - 네이버 후보만으로 계속 돈다.

import type { ImageCandidate } from "./searchNaverImages.js";

const ENDPOINT = "https://google.serper.dev/images";
/** 한 번에 받을 후보 수. 10을 넘기면 크레딧이 2배로 나간다. */
const DISPLAY = 10;

type SerperImageItem = {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  thumbnailUrl?: string;
  /** 그 사진이 실린 페이지. 네이버에는 없는 값이다. */
  link?: string;
};

export function serperSearchConfigured(): boolean {
  return Boolean(process.env.SERPER_API_KEY);
}

/**
 * 구글 색인이 멈춘 사실. 실패해도 수집은 네이버 후보만으로 **조용히** 계속 도는데, 그게 위험하다 -
 * 무료 크레딧이 소진돼도 아무도 모른 채 이미지 품질만 슬그머니 떨어진다(2026-09-21 사용자 요청).
 *
 * 소진 시 어떤 상태 코드가 오는지는 문서화돼 있지 않아 맞히려 들지 않는다. **실패 사유를 그대로**
 * 실어 보내면 크레딧 소진이든 키 오류든 한도 초과든 사람이 보고 판단할 수 있다.
 *
 * 한 번 실행에 자리마다 실패해도 알림은 한 번이면 된다 - 처음 것만 남긴다.
 */
export type SerperOutage = { status: number; message: string; query: string };

let outage: SerperOutage | null = null;

/** 기록된 장애를 가져가면서 비운다(알림을 보낸 쪽이 호출한다). */
export function takeSerperOutage(): SerperOutage | null {
  const taken = outage;
  outage = null;
  return taken;
}

/** 테스트용 - 실행 간 상태가 새지 않게 한다. */
export function resetSerperOutage(): void {
  outage = null;
}

/**
 * Serper는 **초당 5건**까지만 받는다(2026-09-24 실측 429).
 *
 * 왜 제한이 필요해졌나: 서치풀을 붙이면서 자리당 질의가 8개가 됐고, 자리 3개가 동시에 도니
 * 한꺼번에 24건이 나갔다. 전부 429로 떨어지면 그 자리의 후보가 통째로 사라진다 - 실측에서
 * 키노라이츠 질의가 이렇게 죽어 기사 사진이 대신 들어갔다.
 *
 * 4건/초로 잡는다(상한 5에서 한 칸 여유). 호출을 **줄 세워** 간격을 벌린다.
 */
const MIN_INTERVAL_MS = 250;
let nextSlotAt = 0;

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextSlotAt);
  nextSlotAt = startAt + MIN_INTERVAL_MS;
  const delay = startAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/** 테스트용 - 실행 간 대기열이 새지 않게 한다. */
export function resetSerperRateLimit(): void {
  nextSlotAt = 0;
}

/** 429는 **일시적**이다. 크레딧 소진(402·403)과 달리 잠깐 쉬면 풀린다. */
export function isRateLimited(status: number): boolean {
  return status === 429;
}

export async function searchSerperImages(
  query: string,
  options: { fetchImpl?: typeof fetch; retries?: number } = {}
): Promise<ImageCandidate[]> {
  const apiKey = process.env.SERPER_API_KEY;
  const trimmed = query.trim();
  if (!apiKey || !trimmed) return [];

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.retries ?? 2;

  let res: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await waitForSlot();
    try {
      res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        // 한국 독자용 블로그다 - 한국 결과를 우선한다(네이버와 겹치되 색인이 달라 후보가 넓어진다).
        body: JSON.stringify({ q: trimmed, gl: "kr", hl: "ko", num: DISPLAY }),
      });
    } catch {
      // 네트워크 실패로 수집 전체를 멈추지 않는다 - 네이버 후보로 계속 간다.
      return [];
    }

    // 429는 잠깐 쉬고 다시 던진다. 한 번 걸렸다고 그 자리를 포기할 이유가 없다.
    if (res.status === 429 && attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (!res) return [];

  if (!res.ok) {
    // 크레딧 소진·키 오류·한도 초과가 전부 여기로 온다. 수집은 네이버 후보만으로 계속 가되,
    // 조용히 넘어가지는 않는다 - 장애를 기록해 두면 publish-poll이 끝날 때 한 번 알린다.
    const message = (await res.text().catch(() => "")).trim().slice(0, 200);
    outage ??= { status: res.status, message, query: trimmed };
    console.warn(`⚠️ 구글 이미지 검색 실패(${res.status}) - 네이버 후보만 사용합니다: "${trimmed}"`);
    return [];
  }

  const json = (await res.json().catch(() => ({}))) as { images?: SerperImageItem[] };
  return (json.images ?? [])
    .filter((item): item is SerperImageItem & { imageUrl: string } => typeof item.imageUrl === "string")
    .map((item) => ({
      title: item.title ?? "",
      link: item.imageUrl,
      thumbnail: item.thumbnailUrl ?? "",
      width: item.imageWidth ?? null,
      height: item.imageHeight ?? null,
      sourcePage: item.link ?? null,
    }));
}
