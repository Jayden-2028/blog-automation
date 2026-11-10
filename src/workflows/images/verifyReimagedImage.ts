// 생성한 삽화가 캡션대로인지 보는 검증기(reimageKoreaplain의 `verifyImage` 실구현, 2026-11-10).
//
// 계기: 결혼식장 축의금 접수대(캡션)를 요청했고 프롬프트에도 `Korean wedding hall entrance`라고 적었는데, 나온 그림은
// 누가 봐도 장례식장(검은 정장 일색·흰 국화·남색 테이블보)이었다. 글자가 없어서 "글자·숫자가 정보인 자리 skip" 방어막에
// 안 걸린다 - 상황 자체를 잘못 그린 실패라서 **그림을 눈으로 봐야** 잡힌다.
//
// 방법: 이미지 바이트를 임시 디렉터리에 파일로 쓰고, `claude -p`를 Read 도구만 허용한 채 그 디렉터리에서 돌려 파일을 읽고
// 판정하게 한다(새 API 키·단가 등록 불필요). 임시 파일은 판정 뒤 지운다.
//
// 에러 규약: **판정이 "틀렸다"면 `{ok:false}`를 돌려주고, 판정을 못 돌렸으면(다운로드·claude 실행 실패, 해석 불가 응답) 던진다.**
// 호출자(reimageJob)는 던진 쪽을 "검증 불가"로 보고 재생성 없이 그 자리를 원본으로 둔다 - 로그인 만료 같은 인프라 문제로
// 모든 자리를 헛되이 다시 그려 돈을 쓰지 않기 위해서다. 애매한 그림은 `{ok:false}`다(원본이 남는 쪽이 안전하다).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadlessClaude } from "../../services/llm/runHeadlessClaude.js";
import type { RunHeadlessClaudeOptions, RunHeadlessClaudeResult } from "../../services/llm/runHeadlessClaude.js";
import type { VerifyInput, VerifyResult } from "./reimageKoreaplain.js";

/** 이미지 한 장 판정 한도. Read로 그림 하나를 보는 일이라 짧다. */
export const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;
/** 이보다 큰 응답은 이미지가 아니라고 본다(우리 생성물은 수백 KB). */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function buildVerifyPrompt(input: { fileName: string; caption: string; prompt: string }): string {
  return [
    "영문 블로그(Korea Plain - 한국 생활 안내)에 실을 AI 생성 삽화 한 장을 검수한다.",
    `현재 디렉터리의 \`${input.fileName}\` 파일을 Read 도구로 열어 그림을 직접 보고 판정하라. 다른 파일은 읽지 않는다.`,
    "",
    `- 캡션(독자가 그림 밑에서 읽을 문장): ${input.caption}`,
    `- 생성에 쓴 프롬프트(참고용 - 연출 지시이지 판정 기준이 아니다): ${input.prompt}`,
    "",
    "## 무엇을 기준으로 보는가",
    "**판정 기준은 캡션이다.** 독자는 프롬프트를 읽지 않는다 - 그림과 캡션만 본다. 그림이 캡션의 설명으로",
    "정직하게 통하면 통과다. 프롬프트가 적어 둔 **연출 세부**(인물 수, 손동작, 장소가 현관이냐 식탁이냐,",
    "상자가 열렸냐 닫혔냐 같은 것)가 그림과 달라도, 캡션이 말하는 것을 보여주고 있으면 **그것만으로 통과다.**",
    "프롬프트와 한 글자씩 대조하지 마라 - 멀쩡한 그림을 떨어뜨리면 그 자리에는 저작권 위험이 있는 원래",
    "사진이 그대로 남는다. 아래 기준에 걸릴 때만 실패다.",
    "",
    "## 판정 기준 - 하나라도 걸리면 실패다",
    "1. **그림이 캡션이 말하는 그 장면인가.** 한국의 의례·장소·상황을 혼동했으면 실패다.",
    "   실제로 난 실패: 결혼식장 축의금 접수대를 요청했는데 **장례식장**(검은 정장 일색, 흰 국화 조화, 조문 분위기)을 그렸다.",
    "   결혼식↔장례식, 명절↔제사, 식당↔카페, 지하철↔기차처럼 **한국인이 보면 바로 다른 자리인 것**을 헷갈려도 실패다.",
    "   (분위기·복장·꽃·색감까지 본다: 결혼식은 밝은 홀과 알록달록한 예복, 장례식은 어두운 정장과 흰 국화다.)",
    "2. **글자·숫자가 읽히면 실패다.** `no text, no letters`를 요구했는데 간판·표지판·화면·옷·물건에 글자나 숫자가 그려졌다.",
    "3. **알아볼 수 있는 실존 인물의 얼굴, 읽히는 로고·상표**가 있으면 실패다.",
    "4. **한눈에 이상한 해부학적 오류**(손가락 개수, 팔다리 접합, 뭉개진 얼굴 등)가 있으면 실패다.",
    "",
    "**애매하면 실패다.** 실패한 자리는 원래 사진이 그대로 남는 것이고, 그게 안전한 쪽이다. 틀린 그림이 발행되는 것보다 낫다.",
    "다만 \"애매하다\"는 **위 1~4에 걸리는지 애매할 때**를 말한다. 프롬프트의 연출과 다른 것은 애매한 것이 아니라 통과다.",
    "",
    "## 출력",
    "JSON 객체 하나로만 답한다. 설명·머리말·코드펜스를 붙이지 않는다.",
    '통과: {"ok": true}',
    '실패: {"ok": false, "reason": "<영어 한 줄: 무엇이 그려졌고(what is shown) 무엇이어야 하는지(what it must show)>"}',
    '  예) {"ok": false, "reason": "Shows a funeral hall (black suits, white chrysanthemums); must be a bright wedding hall with guests in colorful formal wear."}',
    "reason은 그림을 다시 그릴 때 프롬프트에 그대로 붙으므로 **영어**로, 한 줄로 쓴다.",
  ].join("\n");
}

/** 응답에서 첫 `{`부터 마지막 `}`까지 JSON으로 읽는다. 해석할 수 없으면 null(호출자가 던진다). */
export function parseVerifyVerdict(raw: string): VerifyResult | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { ok, reason } = parsed as Record<string, unknown>;
  if (ok === true) return { ok: true };
  if (ok === false) return { ok: false, reason: typeof reason === "string" && reason.trim() ? reason.replace(/\s+/g, " ").trim() : "reason not given" };
  return null;
}

function extensionOf(url: string, contentType: string | null): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("webp")) return "webp";
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  const fromUrl = /\.(webp|png|jpe?g|gif)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return fromUrl === "jpeg" ? "jpg" : (fromUrl ?? "webp");
}

export type VerifyDeps = {
  fetchImage: (url: string) => Promise<{ bytes: Uint8Array; contentType: string | null }>;
  runClaude: (options: RunHeadlessClaudeOptions) => Promise<RunHeadlessClaudeResult>;
  /** 임시 디렉터리 만들기/지우기 - 테스트가 경로를 가로채 정리 여부를 본다. */
  makeTempDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
};

export function defaultVerifyDeps(): VerifyDeps {
  return {
    fetchImage: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`이미지 다운로드 실패(HTTP ${response.status}): ${url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`이미지 크기가 이상합니다(${bytes.byteLength}바이트): ${url}`);
      return { bytes, contentType: response.headers.get("content-type") };
    },
    runClaude: runHeadlessClaude,
    makeTempDir: () => mkdtemp(join(tmpdir(), "reimage-verify-")),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    writeFile: (path, bytes) => writeFile(path, bytes),
  };
}

/**
 * `ReimageDeps.verifyImage`의 실구현. Supabase URL에서 바이트를 받아 임시 파일로 쓰고, Read만 허용한 claude가 그 파일을 보고 판정한다.
 * 임시 디렉터리는 성공·실패와 무관하게 지운다.
 */
export async function verifyImageWithClaude(input: VerifyInput, deps: VerifyDeps = defaultVerifyDeps()): Promise<VerifyResult> {
  const dir = await deps.makeTempDir();
  try {
    const { bytes, contentType } = await deps.fetchImage(input.imageUrl);
    const fileName = `slot-${input.index}.${extensionOf(input.imageUrl, contentType)}`;
    await deps.writeFile(join(dir, fileName), bytes);

    const result = await deps.runClaude({
      prompt: buildVerifyPrompt({ fileName, caption: input.caption, prompt: input.prompt }),
      timeoutMs: VERIFY_TIMEOUT_MS,
      allowedTools: ["Read"],
      cwd: dir,
    });
    if (!result.ok) throw new Error(result.error);
    const verdict = parseVerifyVerdict(result.output);
    if (!verdict) throw new Error(`판정 응답을 해석하지 못했습니다: ${result.output.slice(0, 200)}`);
    return verdict;
  } finally {
    await deps.removeDir(dir).catch(() => undefined);
  }
}
