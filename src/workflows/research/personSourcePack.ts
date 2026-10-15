// 인물 백과 자료조사용 "소스팩" - 네이버 인물DB·나무위키 원문을 맥에서 받아 텍스트로 만든다(2026-10-15, B-1).
//
// 왜 맥인가: GitHub Actions 러너(클라우드 IP 대역)에서는 search.naver.com 인물 검색과 namu.wiki가 크롬 UA를 달아도
// 403이다(probe-research-sources run 38689188722 실측). 맥에서는 UA 없이도 둘 다 200이다. 그래서 맥이 재료만 받아
// `job.metadata.researchSourcePack`에 넣고, 클라우드 러너는 그것을 프롬프트에 주입한다(위키백과는 클라우드에서 열려 대상 아님).
//
// 로그인·Playwright 없이 plain fetch로 충분하다. 실패는 비치명이다 - errors에 남기고 빈 문자열로 둔다.
import { parse } from "node-html-parser";

/** 항목(personDb / namuwiki)당 UTF-8 바이트 상한. 프롬프트는 stdin으로 넘어가 argv 제한은 없지만 조사 에이전트의 읽기 비용이 있다. */
export const PERSON_SOURCE_PACK_MAX_BYTES = 40 * 1024;

export type PersonSourcePack = {
  /** 네이버 인물 검색 결과의 인물DB 카드(프로필·소속사·수상·필모·동명이인). 카드가 없으면 빈 문자열. */
  personDb: string;
  /** 나무위키 문서 본문(편집 UI·각주·둘러보기 제외). 실패하면 빈 문자열. */
  namuwiki: string;
  fetchedAt: string;
  /** 항목별 실패·누락 사유. 비어 있으면 둘 다 받았다. */
  errors: string[];
};

export const SOURCE_PACK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** 문자 경계를 지키며 UTF-8 바이트 상한으로 자른다. 잘렸으면 끝에 표시를 남긴다. */
export function capUtf8(text: string, maxBytes: number = PERSON_SOURCE_PACK_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n…(분량 상한으로 이하 생략)";
  const budget = maxBytes - Buffer.byteLength(marker, "utf8");
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + marker;
}

function parseBody(html: string) {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll("script,style,noscript,svg,iframe,link,meta,head").forEach((n) => n.remove());
  return root;
}

function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 네이버 검색 결과 HTML에서 인물DB 카드만 뽑는다. 카드는 "<이름> 펴고 접기"로 시작해 "같은 이름 다른 인물"(동명이인)
 * 다음의 "동명이인 노출기준"에서 끝난다(2026-10-15 실측 - 차정원·김지원). 카드가 없으면 빈 문자열이다 -
 * 페이지 나머지(뉴스·블로그 스니펫)는 이미 baseline 검색이 맡고 있어 싣지 않는다.
 */
export function extractNaverPersonDb(html: string, keyword: string): string {
  const text = parseBody(html).structuredText;
  const start = text.indexOf(`${keyword} 펴고 접기`);
  if (start < 0) return "";
  const tail = text.slice(start);
  const endCandidates = ["동명이인 노출기준", "AI 브리핑"].map((m) => tail.indexOf(m)).filter((i) => i > 0);
  const card = endCandidates.length > 0 ? tail.slice(0, Math.min(...endCandidates)) : tail.slice(0, 8000);
  const cleaned = card
    // 버튼·레이어 고정 문구는 줄 어디에 붙어 있어도 뺀다(인라인 요소는 앞 문장과 한 줄로 합쳐진다).
    .replace(/문서 저장하기|Keep에 저장\s*Keep 바로가기\s*공유하기|정보확인 레이어 닫기|정보확인 내용 열고 닫기|동영상 바로재생( 버튼)?/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^(이전 다음|더보기|인물정보 고객센터)$/.test(line) &&
        !/^본 인물정보는 일반에 공개된/.test(line) &&
        !/^본인참여 수정신청/.test(line)
    )
    .join("\n");
  return tidy(cleaned);
}

/** 나무위키에서 재료가 아닌 절(둘러보기·각주·외부 링크 등). */
const NAMU_NOISE_SECTION = /(둘러보기|각주|외부\s*링크|관련\s*문서|참고\s*문헌|같이\s*보기|분류)/;

/**
 * 나무위키 문서 HTML -> 본문 텍스트. 편집 링크·각주 번호를 지우고 절(## 제목)로 나눠 노이즈 절을 뺀다.
 * 첫 "1. 개요"류 절 앞의 사이트 머리글은 버린다. 절 제목이 하나도 없으면 전체 텍스트를 쓴다.
 */
export function extractNamuwikiText(html: string, maxBytes: number = PERSON_SOURCE_PACK_MAX_BYTES): string {
  const root = parseBody(html);
  // 표는 셀마다 줄이 나뉘어 분량을 크게 부풀린다(필모그래피 한 줄이 5줄). 행 하나를 한 줄로 합친다.
  for (const row of root.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("th,td").map((cell) => cell.text.replace(/\s+/g, " ").trim()).filter(Boolean);
    row.set_content(`${cells.join(" | ")}\n`);
  }
  for (const heading of root.querySelectorAll("h2,h3,h4")) {
    const title = heading.text.replace(/\[편집\]/g, "").replace(/\s+/g, " ").trim();
    heading.set_content(`\n\n${heading.tagName === "H2" ? "##" : "###"} ${title}\n`);
  }
  const text = tidy(root.structuredText.replace(/\[편집\]/g, "").replace(/\[\d{1,3}\]/g, ""));
  const lines = text.split("\n");
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  if (firstSection < 0) return text;

  // 머리글(편집 UI·로그인 안내)은 버리되 문서 수정 시각과 인포박스(본명·출생·소속사 등, "분류" 이후)는 남긴다.
  const modified = lines.slice(0, 15).find((line) => line.startsWith("최근 수정 시각"));
  const categoryAt = lines.slice(0, firstSection).lastIndexOf("분류");
  // 틀(navbox) "[ 소속 아티스트 ]"류는 인물 사실이 아니라 같은 소속 인물 목록이라 뺀다.
  const intro = (categoryAt >= 0 ? lines.slice(categoryAt, firstSection) : []).filter((line) => !/^\[ .+ \]/.test(line));

  const sections = lines.slice(firstSection).join("\n").split(/^(?=## )/m);
  const kept = sections.filter((section) => !NAMU_NOISE_SECTION.test(section.split("\n", 1)[0] ?? ""));
  const head = tidy([modified, ...intro].filter((part): part is string => part !== undefined).join("\n"));
  return fitSections([head, ...kept.map((section) => tidy(section))].filter(Boolean), maxBytes);
}

/**
 * 절 단위로 분량을 맞춘다. 앞에서부터 자르면 뒤쪽 `기타`(여담·인터뷰)와 수상이 통째로 사라진다(김지원 문서는 약 71KB) -
 * 그래서 절마다 같은 상한을 두고(큰 절부터 줄이는 워터필링) 줄 경계에서 자른다. 작은 절은 그대로 남는다.
 */
export function fitSections(sections: string[], maxBytes: number): string {
  const joiner = "\n\n";
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const total = (list: string[]) => list.reduce((sum, text) => sum + bytes(text), 0) + (list.length - 1) * joiner.length;
  if (total(sections) <= maxBytes) return sections.join(joiner);

  const cutTo = (text: string, limit: number): string => {
    if (bytes(text) <= limit) return text;
    const marker = "\n…(절 분량 상한으로 이하 생략)";
    let out = "";
    let used = 0;
    for (const line of text.split("\n")) {
      const size = bytes(line) + 1;
      if (used + size > limit - bytes(marker)) break;
      out += `${out ? "\n" : ""}${line}`;
      used += size;
    }
    return out + marker;
  };
  // 절당 상한 C를 이분 탐색한다(합이 maxBytes 이하가 되는 가장 큰 C).
  let lo = 200;
  let hi = maxBytes;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (total(sections.map((text) => cutTo(text, mid))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return sections.map((text) => cutTo(text, lo)).join(joiner);
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type FetchPersonSourcePackOptions = {
  fetchImpl?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
};

async function fetchHtml(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": SOURCE_PACK_USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 인물 이름 하나의 소스팩을 만든다. 어떤 실패도 던지지 않고 errors에 담는다(비치명). */
export async function fetchPersonSourcePack(
  keyword: string,
  options: FetchPersonSourcePackOptions = {}
): Promise<PersonSourcePack> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? PERSON_SOURCE_PACK_MAX_BYTES;
  const errors: string[] = [];
  const name = keyword.trim();
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  let personDb = "";
  try {
    const html = await fetchHtml(`https://search.naver.com/search.naver?query=${encodeURIComponent(name)}`, fetchImpl, timeoutMs);
    personDb = capUtf8(extractNaverPersonDb(html, name), maxBytes);
    if (!personDb) errors.push("personDb: 인물DB 카드 없음(등재 안 된 이름이거나 페이지 구조 변경)");
  } catch (error) {
    errors.push(`personDb: ${message(error)}`);
  }

  let namuwiki = "";
  try {
    const html = await fetchHtml(`https://namu.wiki/w/${encodeURIComponent(name)}`, fetchImpl, timeoutMs);
    namuwiki = capUtf8(extractNamuwikiText(html, maxBytes), maxBytes);
    if (!namuwiki) errors.push("namuwiki: 본문 비어 있음");
  } catch (error) {
    errors.push(`namuwiki: ${message(error)}`);
  }

  return { personDb, namuwiki, fetchedAt: (options.now ?? (() => new Date()))().toISOString(), errors };
}

/** metadata에서 소스팩을 읽는다. 수집 시도 흔적(fetchedAt)이 있어야 "채워짐"이다 - 실패 팩도 채워진 것으로 본다. */
export function readPersonSourcePack(metadata: Record<string, unknown> | null | undefined): PersonSourcePack | null {
  const raw = metadata?.researchSourcePack;
  if (!raw || typeof raw !== "object") return null;
  const pack = raw as Record<string, unknown>;
  if (typeof pack.fetchedAt !== "string") return null;
  return {
    personDb: typeof pack.personDb === "string" ? pack.personDb : "",
    namuwiki: typeof pack.namuwiki === "string" ? pack.namuwiki : "",
    fetchedAt: pack.fetchedAt,
    errors: Array.isArray(pack.errors) ? pack.errors.filter((e): e is string => typeof e === "string") : [],
  };
}
