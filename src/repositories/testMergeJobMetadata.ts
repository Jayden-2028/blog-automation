// article_jobs.metadata **원자 병합** 테스트(2026-11-16 외부 감사 F4). 실행: npm run test:merge-metadata
// DB·네트워크를 쓰지 않는다 - rpc 하나만 있는 가짜 클라이언트를 주입한다.
//
// 지켜야 할 것:
//  ① DB 함수 한 번 호출로 끝난다(읽기 없음) - 인자는 p_id·p_patch다.
//  ② setof를 돌려주므로 응답은 배열이다. 없는 id면 0행 -> null(옛 구현의 findById -> null과 같다).
//  ③ 함수가 없으면(42883·PGRST202, migration 미적용) **던지지 않고** unavailable - 호출부가 옛 경로로 떨어진다.
//  ④ 그 밖의 오류는 삼키지 않고 던진다(조용한 실패 금지).
//  ⑤ undefined 값은 키를 지우지 못한다 - 경고로 드러낸다(옛 경로에서는 지워졌다).
//  ⑥ migration이 security definer가 아니고 service_role에만 열려 있다.
//  ⑦ 워크플로의 「진행 중 표식 선기록」이 읽고-통째로-PATCH 하지 않는다(같은 lost update였다).
import { readFileSync } from "node:fs";

import {
  MERGE_METADATA_FN,
  isMergeFunctionMissing,
  mergeMetadataAtomic,
  warnUndefinedPatchKeys,
} from "./ArticleJobRepository.js";
import type { MetadataMergeClient } from "./ArticleJobRepository.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

const JOB_ID = "054bfe0b-1234-4abc-8def-0123456789ab";

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(result: { data: unknown; error: { code?: string | null; message?: string | null } | null }): {
  client: MetadataMergeClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return result;
      },
    },
  };
}

async function main(): Promise<void> {
  console.log("① 함수 한 번 호출 - 읽기 없음, 인자는 p_id·p_patch");
  {
    const row = { id: JOB_ID, metadata: { a: 1, b: 2 } };
    const { client, calls } = fakeClient({ data: [row], error: null });
    const result = await mergeMetadataAtomic(client, JOB_ID, { b: 2 });

    assert(calls.length === 1, `호출 1회여야 한다(실제 ${calls.length})`);
    assert(calls[0].fn === MERGE_METADATA_FN, `함수 이름 ${MERGE_METADATA_FN}`);
    assert(calls[0].args.p_id === JOB_ID, "p_id가 jobId");
    assert(JSON.stringify(calls[0].args.p_patch) === JSON.stringify({ b: 2 }), "p_patch가 patch 그대로");
    assert(result.status === "merged" && result.row?.metadata.a === 1, "병합된 행을 돌려준다");
  }

  console.log("② 응답 모양 - 배열 / 단일 객체 / 0행");
  {
    const single = await mergeMetadataAtomic(fakeClient({ data: { id: JOB_ID, metadata: {} }, error: null }).client, JOB_ID, {});
    assert(single.status === "merged" && single.row?.id === JOB_ID, "단일 객체도 받는다");

    const none = await mergeMetadataAtomic(fakeClient({ data: [], error: null }).client, JOB_ID, { x: 1 });
    assert(none.status === "merged" && none.row === null, "없는 id는 null(던지지 않는다)");

    const nothing = await mergeMetadataAtomic(fakeClient({ data: null, error: null }).client, JOB_ID, { x: 1 });
    assert(nothing.status === "merged" && nothing.row === null, "data null도 null");
  }

  console.log("③ 함수 없음(migration 미적용) - 던지지 않고 unavailable");
  {
    for (const error of [
      { code: "42883", message: 'function public.merge_article_job_metadata(uuid, jsonb) does not exist' },
      { code: "PGRST202", message: "Could not find the function public.merge_article_job_metadata" },
      { code: null, message: "Could not find the function public.merge_article_job_metadata(p_id, p_patch) in the schema cache" },
    ]) {
      assert(isMergeFunctionMissing(error), `함수 없음 판정: ${error.code ?? error.message}`);
      const result = await mergeMetadataAtomic(fakeClient({ data: null, error }).client, JOB_ID, { x: 1 });
      assert(result.status === "unavailable", "unavailable을 돌려준다(옛 경로로 떨어질 수 있게)");
    }
    assert(!isMergeFunctionMissing(null) && !isMergeFunctionMissing(undefined), "오류 없음은 함수 없음이 아니다");
    assert(!isMergeFunctionMissing({ code: "42P01", message: "relation does not exist" }), "테이블 없음은 함수 없음이 아니다");
  }

  console.log("④ 그 밖의 오류는 던진다");
  {
    let threw = false;
    try {
      await mergeMetadataAtomic(fakeClient({ data: null, error: { code: "42501", message: "permission denied" } }).client, JOB_ID, { x: 1 });
    } catch {
      threw = true;
    }
    assert(threw, "권한 오류 등은 삼키지 않는다");
  }

  console.log("⑤ undefined 값은 키를 지우지 못한다");
  {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => void warned.push(String(message));
    try {
      const keys = warnUndefinedPatchKeys(JOB_ID, { a: undefined, b: null, c: 1 });
      assert(JSON.stringify(keys) === JSON.stringify(["a"]), "undefined 키만 집는다(null은 정상 삭제 수단)");
      assert(warned.length === 1 && warned[0].includes("null"), "경고에 대안(null)을 적는다");
      assert(warnUndefinedPatchKeys(JOB_ID, { b: null }).length === 0, "undefined가 없으면 조용하다");
    } finally {
      console.warn = original;
    }
  }

  console.log("⑥ migration - security definer 아님, service_role만");
  {
    const sql = readFileSync("supabase/migrations/20261116120000_merge_article_job_metadata.sql", "utf8");
    assert(sql.includes("security invoker"), "security invoker를 명시한다");
    assert(!/security\s+definer/i.test(sql), "definer면 anon 키로도 metadata를 고칠 수 있다");
    assert(/metadata\s*=\s*coalesce\(metadata[^)]*\)\s*\|\|/.test(sql), "UPDATE 한 문장 안에서 jsonb ||로 합친다");
    assert(sql.includes("revoke all on function") && sql.includes("from public"), "PUBLIC 기본 execute를 회수한다");
    assert(/grant execute on function[^;]*to service_role/.test(sql), "service_role에만 execute");
    assert(sql.includes("set search_path = public"), "search_path 고정");
  }

  console.log("⑦ 워크플로 진행 중 표식 - 읽고 통째로 PATCH 하지 않는다");
  {
    for (const file of [".github/workflows/image-pick.yml", ".github/workflows/manuscript-edit.yml"]) {
      const yml = readFileSync(file, "utf8");
      assert(yml.includes(`/rest/v1/rpc/${MERGE_METADATA_FN}`), `${file}: 병합 함수를 부른다`);
      assert(!yml.includes("-X PATCH"), `${file}: metadata 통째 PATCH가 남아 있지 않다`);
      assert(!yml.includes("select=metadata"), `${file}: 쓰기 전에 metadata를 읽지 않는다`);
      assert(yml.includes("-o /dev/null"), `${file}: 응답(metadata 전체)을 로그에 찍지 않는다`);
    }
  }

  console.log("\n✅ metadata 원자 병합 테스트 통과");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
