// 인물 글(category=person)의 **작품별 키노라이츠 공식 스틸 수집**(2026-11-19).
//
// 무엇이 고장이었나(실측): collectWebImages는 키노라이츠를 **원고당 한 번, job 키워드로** 불렀다
// (searchKinolightsStills.ts는 "키워드에 작품명이 들어 있다"는 전제로 og:title을 키워드 구간과 맞춘다).
// 인물 글의 키워드는 **인물 이름**이라 전제가 깨진다 - 문가영·한효주·신민아는 0장이었고, **수지는 이름이
// 같은 작품 「수지」(season/81768)** 가 og:title 검증을 통과해, 다른 배우의 스틸이 '안나' 공식 스틸이라는
// 캡션으로 발행됐다. 인물 글은 작품 6~8개를 다루고 **자리 하나가 작품 하나**다 - 자리의 작품명으로 찾아야 한다.
//
// 사용자가 손으로 하던 순서를 그대로 자동화한다.
//   1) `작품명 배우명 키노`로 검색 -> 작품 페이지
//   2) 미디어 탭 -> 더보기(스크롤)로 스틸 전체 목록(loadKinolightsMediaStills.ts, 브라우저)
//   3) 그중 **이 배우가 혼자 나오는 컷 2~3장**을 비전으로 고른다
//
// 검증이 둘이다. ① 미디어 페이지 og:title이 **작품명과** 맞아야 한다(인물명이 아니다) ② 작품 페이지의
// 출연진(JSON-LD)에 이 배우가 있어야 한다 - 동명 작품(건축학개론은 4개다)을 거른다. 출연진을 못 읽으면(페이지
// 구조 변경·받기 실패) ①만으로 쓰고 기록에 남긴다.
//
// 3단계는 **얼굴 인식이 아니다.** 비전에는 배우 이름·성별·배역 같은 맥락을 주고 "프레임에 한 명만 있고 그 맥락에
// 맞는 컷"을 고르게 하며, 애매하면 뺀다. 비전이 실패하면 **필터 없는 스틸을 넣지 않는다**(잘못된 인물 사진이 빈
// 자리보다 나쁘다).
//
// 어떤 실패도 예외로 나가지 않는다 - 이미지 때문에 원고가 막히면 안 된다. 사유는 failures의 `ℹ️` 줄로 남는다.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapWithConcurrency } from "../../services/mapWithConcurrency.js";
import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import { extractTrailingJson } from "../../services/llm/runHeadlessCodex.js";
import { personNameCandidates } from "../research/personNameFromKeyword.js";
import type { recordApiUsage } from "../../services/usage/recordApiUsage.js";
import { loadKinolightsMediaStills } from "./loadKinolightsMediaStills.js";
// 인용부호 추출은 한 벌만 둔다(2026-11-25) - 기획 작품명 전달과 같은 규칙이어야 한다(`〈〉`·`『』` 포함).
import { quotedTitles } from "./plannedWorkTitles.js";
import {
  defaultFetchPage,
  extractStills,
  normalize,
  readWorkTitle,
  REVIEW_URL,
  findWorkLinkInHtml,
  searchKinolightsLinks,
  titleMatchesKeyword,
  toMediaUrl,
} from "./searchKinolightsStills.js";
import type { KinolightsStill } from "./searchKinolightsStills.js";

/** 한 원고에서 찾아볼 작품 수 상한. **Serper 비용 가드**다(작품당 최대 4건 = 원고당 최악 32건, 플랫폼 언급이 없으면 24건). */
export const MAX_WORKS_PER_ARTICLE = 8;
/** 작품 하나에서 출연진까지 확인해 볼 후보 페이지 수(동명 작품 여럿을 출연진으로 가른다). */
const MAX_PAGES_PER_WORK = 4;
/** 작품 하나에서 따라가 볼 리뷰 페이지 수. */
const MAX_REVIEW_FOLLOWS = 2;
const PLATFORM_IN_TEXT = /넷플릭스|티빙|쿠팡플레이|디즈니\+|디즈니플러스|웨이브|왓챠|애플tv\+?|tvN|JTBC|KBS|MBC|SBS|ENA/i;

/** 자리 설명에 적힌 플랫폼·방송사(없으면 null). */
export function platformOf(descriptions: readonly string[]): string | null {
  for (const text of descriptions) {
    const m = text.match(PLATFORM_IN_TEXT);
    if (m) return m[0];
  }
  return null;
}

/** 작품 검색 질의 순서. 플랫폼이 설명에 있을 때만 세 번째가 낀다(최대 4건). */
export function workQueries(workTitle: string, personName: string, platform: string | null): string[] {
  return [
    `${workTitle} ${personName} 키노`,
    `키노라이츠 ${workTitle}`,
    ...(platform ? [`${workTitle} ${platform} 키노라이츠`] : []),
    `site:kinolights.com ${workTitle}`,
  ];
}
/** 비전에 보여 줄 스틸 상한. */
export const MAX_VISION_STILLS = 30;
/** 자리마다 앞에 세울 단독컷 상한. */
export const MAX_SOLO_PICKS = 3;
const WORK_CONCURRENCY = 2;
const VISION_TIMEOUT_MS = 180_000;
const THUMB_BASE = "https://file-dit.kinolights.com/fit-in/828x0/original/";

export type PersonSlot = {
  index: number;
  description: string;
  query: string | null;
  context?: string;
  broadcastCapture?: boolean;
};

// ─── 작품명·인물명 추출 ──────────────────────────────────────────────────────────

/** 키워드에서 기사 주인공의 이름을 뽑는다. 못 뽑으면 키워드 전체. */
export function personNameOf(keyword: string): string {
  return personNameCandidates(keyword)[0] ?? keyword.trim();
}

/**
 * 자리에서 **작품명**을 뽑는다. 설명 -> 검색어 순으로 인용부호 안의 말을 보고, 없으면 `인물명 작품명 스틸컷`
 * 꼴의 검색어만 받는다. **인물명과 같은 말은 작품명으로 쓰지 않는다** - 「수지」 사고가 정확히 그것이다.
 */
export function extractWorkTitle(slot: Pick<PersonSlot, "description" | "query">, personName: string): string | null {
  const person = normalize(personName);
  const acceptable = (title: string) => normalize(title).length >= 2 && normalize(title) !== person;

  const description = slot.description.replace(/\s*—\s*웹\s*검색\s*$/, "");
  for (const source of [description, slot.query ?? ""]) {
    const found = quotedTitles(source).find(acceptable);
    if (found) return found;
  }

  const query = (slot.query ?? "").trim();
  if (query && personName) {
    const escaped = personName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = query.match(new RegExp(`^${escaped}\\s+(.+?)\\s+(?:공식\\s*)?스틸(?:컷)?$`)) ?? query.match(new RegExp(`^(.+?)\\s+${escaped}\\s+(?:공식\\s*)?스틸(?:컷)?$`));
    if (m && acceptable(m[1].trim())) return m[1].trim();
  }
  return null;
}

/** 리서치·문맥에서 성별을 **분명할 때만** 추정한다. 비전에 주는 맥락일 뿐 단정하지 않는다. */
export function inferGender(text: string | null | undefined): "여성" | "남성" | null {
  if (!text) return null;
  const female = (text.match(/그녀|여배우|여성|여자 주인공|여주인공/g) ?? []).length;
  const male = (text.match(/남배우|남성|남자 주인공|남주인공/g) ?? []).length;
  if (female >= 2 && female >= male * 2) return "여성";
  if (male >= 2 && male >= female * 2) return "남성";
  return null;
}

// ─── 작품 페이지 찾기·검증 ───────────────────────────────────────────────────────

export type CastEntry = { name: string; character: string };

/** 작품 페이지 JSON-LD의 출연진. 못 읽으면 빈 배열. */
export function readCast(html: string): CastEntry[] {
  const out: CastEntry[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]) as { actor?: unknown };
      if (!Array.isArray(data.actor)) continue;
      for (const entry of data.actor as { actor?: { name?: unknown }; characterName?: unknown }[]) {
        const name = entry?.actor?.name;
        if (typeof name === "string") out.push({ name, character: typeof entry.characterName === "string" ? entry.characterName : "" });
      }
    } catch {
      // 다른 스크립트 블록이다.
    }
  }
  return out;
}

type ResolvedWork = {
  mediaUrl: string;
  /** 서버 렌더 HTML의 스틸(최대 20장). 브라우저 로딩이 안 될 때의 폴백. */
  serverStills: KinolightsStill[];
  /** 출연진에서 읽은 이 배우의 배역. */
  character: string;
  /** `verified`(출연진에서 확인) · `unchecked`(출연진을 못 읽어 og:title만으로 통과). */
  castCheck: "verified" | "unchecked";
};

type ResolveOutcome = { ok: true; work: ResolvedWork; note: string } | { ok: false; reason: string };

async function resolveWork(
  workTitle: string,
  personName: string,
  opts: { platform: string | null; wantsDirectorsCut: boolean },
  deps: { searchWorkUrls: (query: string) => Promise<string[]>; fetchPage: (url: string) => Promise<string | null> }
): Promise<ResolveOutcome> {
  const personKey = normalize(personName);
  const tried = new Set<string>();
  const why: string[] = [];
  let reviewFollows = 0;
  /** 감독판이라 미룬 통과 후보. 다른 통과 후보가 없을 때만 쓴다. */
  let deferred: ResolveOutcome | null = null;

  for (const query of workQueries(workTitle, personName, opts.platform)) {
    if (tried.size >= MAX_PAGES_PER_WORK) break;
    const results = await deps.searchWorkUrls(query).catch(() => [] as string[]);

    // 리뷰 페이지는 작품 주소로 되돌린다.
    const urls: string[] = [];
    for (const url of results) {
      if (REVIEW_URL.test(url) && !/\/(?:season|movie)\//.test(url)) {
        if (reviewFollows >= MAX_REVIEW_FOLLOWS) continue;
        reviewFollows += 1;
        const html = await deps.fetchPage(url).catch(() => null);
        const work = html ? findWorkLinkInHtml(html) : null;
        if (work) urls.push(work);
        else why.push(`${url} 리뷰에서 작품 주소를 못 찾음`);
      } else {
        urls.push(url);
      }
    }

    for (const url of urls) {
      const mediaUrl = toMediaUrl(url);
      if (!mediaUrl || tried.has(mediaUrl)) continue;
      if (tried.size >= MAX_PAGES_PER_WORK) break;
      tried.add(mediaUrl);

      const mediaHtml = await deps.fetchPage(mediaUrl).catch(() => null);
      if (!mediaHtml) {
        why.push(`${mediaUrl} 받기 실패`);
        continue;
      }
      // **작품명과** 맞춘다. 인물명과 같은 제목(「수지」)은 작품명이 달라 여기서 떨어진다.
      const ogTitle = readWorkTitle(mediaHtml);
      if (!ogTitle || !titleMatchesKeyword(ogTitle, workTitle) || normalize(ogTitle) === personKey) {
        why.push(`${mediaUrl} 제목 불일치(${ogTitle ?? "제목 없음"})`);
        continue;
      }

      // 동명 작품을 거른다 - 출연진에 이 배우가 있어야 한다.
      const seasonUrl = mediaUrl.replace(/\/media$/, "");
      const seasonHtml = await deps.fetchPage(seasonUrl).catch(() => null);
      const cast = seasonHtml ? readCast(seasonHtml) : [];
      let character = "";
      let castCheck: ResolvedWork["castCheck"] = "unchecked";
      if (cast.length > 0) {
        const hit = cast.find((c) => normalize(c.name) === personKey);
        if (!hit) {
          why.push(`${mediaUrl} 출연진에 ${personName} 없음`);
          continue;
        }
        character = hit.character;
        castCheck = "verified";
      }
      const outcome: ResolveOutcome = {
        ok: true,
        work: { mediaUrl, serverStills: extractStills(mediaHtml, mediaUrl), character, castCheck },
        note: castCheck === "verified" ? "출연진 확인" : "출연진을 읽지 못해 제목만으로 통과",
      };
      // 감독판은 설명이 감독판을 말할 때만 바로 쓴다. 아니면 일반판을 더 찾아보고, 없으면 이것을 쓴다.
      if (/감독판/.test(ogTitle) && !opts.wantsDirectorsCut) {
        deferred ??= outcome;
        continue;
      }
      return outcome;
    }
    if (deferred) break; // 일반판이 안 나온 채 후보가 소진되면 감독판을 쓴다.
  }
  if (deferred) return deferred;
  return { ok: false, reason: why.length > 0 ? `작품 페이지 후보 탈락(${why.join("; ")})` : "작품 페이지를 찾지 못함" };
}

// ─── 단독컷 고르기(비전) ──────────────────────────────────────────────────────────

export type PickSoloInput = {
  workTitle: string;
  personName: string;
  gender: "여성" | "남성" | null;
  /** 이 작품에서의 배역(출연진 또는 자리 설명). */
  role: string;
  slotDescriptions: string[];
  stills: KinolightsStill[];
};
export type PickSoloResult = { ok: true; picks: KinolightsStill[] } | { ok: false; error: string };

const STILL_PATH_TAIL = /original\/(content_still_cut\/.+)$/;

/** 비전 판정 프롬프트. **얼굴로 사람을 알아보게 하지 않는다.** */
export function buildSoloPrompt(input: Omit<PickSoloInput, "stills"> & { files: string[] }): string {
  return [
    `사진 ${input.files.length}장을 Read 도구로 **전부 열어 본다.** 한국 영상 작품 「${input.workTitle}」의 공식 스틸이다.`,
    "",
    "## 이 글의 주인공(맥락)",
    `- 이름: ${input.personName}${input.gender ? ` (${input.gender})` : ""}`,
    `- 이 작품에서: ${input.role || "배역 미상"}`,
    ...input.slotDescriptions.map((d) => `- 글에서 이 작품을 다루는 자리: ${d}`),
    "",
    "## 고르는 것",
    `**프레임에 사람이 정확히 한 명만 나오는 컷** 중에서, 위 맥락(성별·배역·작품 속 나이대와 복장)으로 볼 때 ${input.personName}의 배역일 가능성이 높은 것을 **최대 ${MAX_SOLO_PICKS}장** 고른다.`,
    "",
    "## 규칙",
    "- **얼굴로 누구인지 알아보지 않는다.** 얼굴을 보고 특정 배우를 지목하거나 이름을 붙이지 않는다. 판단 근거는 위 맥락과 장면(성별, 배역의 나이·직업·복장)뿐이다.",
    "- 두 명 이상이 한 프레임에 있으면 제외한다(뒤쪽 배경 인물까지 또렷하면 제외). 사람이 없거나 뒷모습·원경이라 누구인지 가늠이 안 되는 컷도 제외한다.",
    "- 한 명이 나와도 맥락(성별·배역)과 어긋나 보이면 제외한다.",
    "- **애매하면 뺀다.** 0장도 정답이다.",
    "- 흐리거나 크게 잘렸거나 자막·로고가 화면을 덮은 컷은 뺀다.",
    "",
    "## 사진 목록",
    ...input.files.map((file, i) => `${i + 1}. ${file}`),
    "",
    '마지막 줄에 JSON 한 줄만 답한다: {"picks": [3, 7]}  (목록의 번호, 가장 알맞은 것부터). 없으면 {"picks": []}.',
  ].join("\n");
}

async function downloadThumb(still: KinolightsStill, dest: string): Promise<boolean> {
  const tail = still.imageUrl.match(STILL_PATH_TAIL)?.[1];
  if (!tail) return false;
  try {
    const res = await fetch(`${THUMB_BASE}${tail}`, {
      headers: { Referer: "https://kinolights.com/" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/**
 * 비전에 넣을 스틸을 목록 전체에서 **고르게** 뽑는다(2026-11-19). 앞에서 잘라 쓰면 출연진이 많은 작품
 * (「무빙」 155장)에서 그 배우가 나오는 컷이 앞 30장 밖에 몰려 있을 때 하나도 못 본다.
 */
export function sampleEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor((i * items.length) / max)]);
  return out;
}

/** 기본 비전 고르기: 작은 버전을 임시 폴더에 받아 `claude -p`(Read)로 한 번에 판정한다. */
export async function defaultPickSoloStills(input: PickSoloInput): Promise<PickSoloResult> {
  const dir = await mkdtemp(join(tmpdir(), "kino-solo-"));
  try {
    const subset = sampleEvenly(input.stills, MAX_VISION_STILLS);
    const loaded: { still: KinolightsStill; file: string }[] = [];
    await mapWithConcurrency(subset, 6, async (still, i) => {
      const file = join(dir, `still-${String(i + 1).padStart(2, "0")}.jpg`);
      if (await downloadThumb(still, file)) loaded.push({ still, file });
    });
    // 병렬로 받으면 순서가 섞인다 - 번호는 파일명 순서를 따른다.
    loaded.sort((a, b) => a.file.localeCompare(b.file));
    if (loaded.length === 0) return { ok: false, error: "썸네일을 하나도 받지 못함" };

    const result = await runHeadlessClaude({
      prompt: buildSoloPrompt({ ...input, files: loaded.map((l) => l.file) }),
      allowedTools: ["Read"],
      permissionMode: "acceptEdits",
      timeoutMs: VISION_TIMEOUT_MS,
      cwd: dir,
    });
    if (!result.ok) return { ok: false, error: `비전 호출 실패: ${result.error}` };

    const parsed = extractTrailingJson(result.output) as { picks?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.picks)) return { ok: false, error: "비전 응답을 읽지 못함" };
    const picks: KinolightsStill[] = [];
    for (const n of parsed.picks) {
      if (typeof n !== "number" || !Number.isInteger(n)) continue;
      const hit = loaded[n - 1]?.still;
      if (hit && !picks.includes(hit)) picks.push(hit);
      if (picks.length >= MAX_SOLO_PICKS) break;
    }
    return { ok: true, picks };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── 진입점 ───────────────────────────────────────────────────────────────────────

export type PersonStillsDeps = {
  /** 질의 하나 -> 키노라이츠 작품 URL들. 기본은 Serper(비용 원장에 jobId로 기록). */
  searchWorkUrls?: (query: string) => Promise<string[]>;
  fetchPage?: (url: string) => Promise<string | null>;
  /** 미디어 탭의 스틸 전체. null이면 브라우저를 못 쓴 것이다(서버 렌더 20장으로 폴백). */
  loadFullStills?: (mediaUrl: string) => Promise<KinolightsStill[] | null>;
  pickSoloStills?: (input: PickSoloInput) => Promise<PickSoloResult>;
  maxWorks?: number;
};

export type PersonStillsInput = {
  keyword: string;
  slots: readonly PersonSlot[];
  researchText?: string | null;
  jobId?: string | null;
  record?: typeof recordApiUsage;
  /** 테스트·호출부가 인물명을 직접 줄 때. 기본은 키워드에서 뽑는다. */
  personName?: string;
};

export type PersonStillsResult = {
  /** 자리 번호 -> 그 자리 후보 앞에 세울 단독컷(공식 스틸). */
  bySlot: Map<number, KinolightsStill[]>;
  /** 작품명을 못 뽑은 자리. 호출부가 기존 경로로 처리한다. */
  titleless: number[];
  failures: string[];
};

/**
 * 자리마다 작품을 찾아 **그 배우의 단독컷**을 돌려준다. 같은 작품이 두 자리에 나오면 검색·받기·비전을 한 번만 한다.
 */
export async function collectPersonWorkStills(input: PersonStillsInput, deps: PersonStillsDeps = {}): Promise<PersonStillsResult> {
  const bySlot = new Map<number, KinolightsStill[]>();
  const titleless: number[] = [];
  const failures: string[] = [];
  try {
    const personName = input.personName ?? personNameOf(input.keyword);
    const searchWorkUrls =
      deps.searchWorkUrls ?? ((query: string) => searchKinolightsLinks(query, { jobId: input.jobId, record: input.record }));
    const fetchPage = deps.fetchPage ?? defaultFetchPage;
    const loadFullStills = deps.loadFullStills ?? ((mediaUrl: string) => loadKinolightsMediaStills(mediaUrl));
    const pickSolo = deps.pickSoloStills ?? defaultPickSoloStills;
    const maxWorks = deps.maxWorks ?? MAX_WORKS_PER_ARTICLE;
    const gender = inferGender(input.researchText);

    // 작품별로 자리를 묶는다(같은 작품은 한 번만 처리).
    type Group = { title: string; slots: PersonSlot[] };
    const groups = new Map<string, Group>();
    for (const slot of input.slots) {
      if (slot.broadcastCapture) continue;
      const title = extractWorkTitle(slot, personName);
      if (!title) {
        titleless.push(slot.index);
        continue;
      }
      const key = normalize(title);
      const group = groups.get(key) ?? { title, slots: [] };
      group.slots.push(slot);
      groups.set(key, group);
    }

    const all = [...groups.values()];
    const targets = all.slice(0, maxWorks);
    for (const skipped of all.slice(maxWorks)) {
      failures.push(`ℹ️ 키노라이츠 「${skipped.title}」: 작품 수 상한(${maxWorks})을 넘어 찾지 않았습니다(자리 ${skipped.slots.map((s) => s.index).join(", ")}).`);
    }

    await mapWithConcurrency(targets, WORK_CONCURRENCY, async (group) => {
      const label = `ℹ️ 키노라이츠 「${group.title}」(${personName})`;
      const slotList = group.slots.map((s) => s.index).join(", ");
      try {
        const resolved = await resolveWork(
          group.title,
          personName,
          {
            platform: platformOf(group.slots.map((x) => x.description)),
            wantsDirectorsCut: group.slots.some((x) => /감독판/.test(x.description)),
          },
          { searchWorkUrls, fetchPage }
        );
        if (!resolved.ok) {
          failures.push(`${label}: ${resolved.reason} - 자리 ${slotList}은 일반 검색으로 갑니다.`);
          return;
        }
        const { work } = resolved;

        const full = await loadFullStills(work.mediaUrl).catch(() => null);
        const stills = full && full.length > 0 ? full : work.serverStills;
        const source = full && full.length > 0 ? `브라우저 전체 목록 ${full.length}장` : `서버 렌더 ${work.serverStills.length}장(브라우저 로딩 불가·실패)`;
        if (stills.length === 0) {
          failures.push(`${label}: 작품 페이지는 찾았으나(${work.mediaUrl}) 스틸이 없습니다.`);
          return;
        }

        const verdict = await pickSolo({
          workTitle: group.title,
          personName,
          gender,
          role: [work.character, ...group.slots.map((s) => s.description)].filter(Boolean)[0] ?? "",
          slotDescriptions: group.slots.map((s) => s.description.replace(/\s*—\s*웹\s*검색\s*$/, "")),
          stills,
        }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));

        if (!verdict.ok) {
          // 필터 없는 스틸은 넣지 않는다 - 다른 사람 얼굴이 이 배우 캡션으로 나가는 것이 빈 자리보다 나쁘다.
          failures.push(`${label}: 스틸 ${stills.length}장(${source})을 받았으나 단독컷 선별에 실패해 넣지 않았습니다 - ${verdict.error}`);
          return;
        }
        if (verdict.picks.length === 0) {
          failures.push(`${label}: 스틸 ${stills.length}장(${source}) 중 ${personName} 단독컷으로 볼 만한 것이 없어 넣지 않았습니다.`);
          return;
        }
        for (const slot of group.slots) bySlot.set(slot.index, verdict.picks);
        failures.push(
          `${label}: ${work.mediaUrl} 스틸 ${stills.length}장(${source}, ${resolved.note}) 중 단독컷 ${verdict.picks.length}장을 자리 ${slotList} 후보 앞에 넣었습니다.`
        );
      } catch (error) {
        failures.push(`${label}: 수집 중 오류로 건너뜁니다 - ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    failures.push(`ℹ️ 키노라이츠 작품별 스틸 수집을 건너뜁니다 - ${error instanceof Error ? error.message : String(error)}`);
  }
  return { bySlot, titleless, failures };
}
