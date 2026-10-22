// Google Cloud 청구액을 BigQuery 결제 내보내기에서 읽어 api_usage에 적재한다(2026-10-15).
//
// 왜 필요한가: api_usage는 우리가 호출 시점에 직접 계측한 값(cost_source='metered')만 갖고 있어
// 지금 openai만 잡힌다. Gemini 등 구글 쪽 지출은 어디에도 안 보인다. 스키마에 열어만 두었던
// cost_source='reported'(공급자 청구액) 자리를 여기서 채운다.
//
// 왜 하루치가 아니라 최근 며칠인가: 구글은 크레딧·조정분을 며칠 뒤 반영해 **같은 날짜의 금액을
// 다시 쓴다**. 하루치만 읽으면 그 정정이 영영 반영되지 않는다. 기본 5일치를 다시 읽어 덮어쓴다.
//
// 덮어쓰는 방법(삭제 후 삽입인 이유): 중복 방지용 유니크 인덱스가 부분 인덱스라
// (uq_api_usage_reported_daily, where cost_source='reported') supabase-js의 upsert가 쓰는
// ON CONFLICT로는 그 인덱스를 지정할 수 없다. 그래서 같은 창(provider='google',
// cost_source='reported', 기간)만 정확히 지우고 다시 넣는다. metered 행과 다른 공급자 행은
// 조건에서 제외되므로 건드리지 않는다.
//
// 안전장치: 기본은 **미리보기**다. 실제로 쓰려면 --apply를 붙인다(analytics-ga4와 같은 방식).

import { BigQueryClient } from "../../services/bigquery/BigQueryClient.js";
import { supabase } from "../../services/supabase/client.js";

type BillingRow = {
  usageDate: string;   // YYYY-MM-DD (Asia/Seoul)
  service: string;
  sku: string;
  currency: string;
  grossCost: number;
  credits: number;     // 보통 음수
  netCost: number;
};

const TABLE_PREFIX = "gcp_billing_export_v1_";

function parseArgs(argv: string[]): { probe: boolean; apply: boolean; days: number } {
  const probe = argv.includes("--probe");
  const apply = argv.includes("--apply");
  const daysArg = argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Math.max(1, Math.min(60, Number(daysArg.split("=")[1]) || 5)) : 5;
  return { probe, apply, days };
}

/** 표준 사용량 비용 내보내기 기준. 중첩 필드를 여기서 전부 평탄화해 스칼라만 돌려받는다. */
function buildSql(projectId: string, dataset: string, table: string, days: number): string {
  const fq = `\`${projectId}.${dataset}.${table}\``;
  return [
    "select",
    "  format_date('%Y-%m-%d', date(usage_start_time, 'Asia/Seoul')) as usage_date,",
    "  ifnull(service.description, '(unknown service)') as service,",
    "  ifnull(sku.description, '(unknown sku)') as sku,",
    "  ifnull(currency, 'USD') as currency,",
    "  sum(cost) as gross_cost,",
    "  sum(ifnull((select sum(c.amount) from unnest(credits) c), 0)) as credits",
    `from ${fq}`,
    `where date(usage_start_time, 'Asia/Seoul') >= date_sub(current_date('Asia/Seoul'), interval ${days} day)`,
    "group by 1, 2, 3, 4",
    "having abs(gross_cost) > 0 or abs(credits) > 0",
    "order by 1 desc, 5 desc",
  ].join("\n");
}

/**
 * probe 전용 진단. 본 조회가 "0행"을 돌려줄 때 원인이 둘로 갈리는데(테이블이 비었거나,
 * 행은 있지만 전부 무료 등급이라 청구액이 0이거나) 날짜·비용 필터를 모두 뺀 이 조회로 가른다.
 */
function buildProbeSql(projectId: string, dataset: string, table: string): string {
  const fq = `\`${projectId}.${dataset}.${table}\``;
  return [
    "select",
    "  count(*) as total_rows,",
    "  format_date('%Y-%m-%d', min(date(usage_start_time, 'Asia/Seoul'))) as first_day,",
    "  format_date('%Y-%m-%d', max(date(usage_start_time, 'Asia/Seoul'))) as last_day,",
    "  sum(cost) as all_gross_cost",
    `from ${fq}`,
  ].join("\n");
}

function toRows(raw: Array<Record<string, string | null>>): BillingRow[] {
  return raw.map((r) => {
    const grossCost = Number(r.gross_cost ?? 0);
    const credits = Number(r.credits ?? 0);
    return {
      usageDate: String(r.usage_date ?? ""),
      service: String(r.service ?? "(unknown service)"),
      sku: String(r.sku ?? "(unknown sku)"),
      currency: String(r.currency ?? "USD"),
      grossCost: Number.isFinite(grossCost) ? grossCost : 0,
      credits: Number.isFinite(credits) ? credits : 0,
      netCost: (Number.isFinite(grossCost) ? grossCost : 0) + (Number.isFinite(credits) ? credits : 0),
    };
  }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.usageDate));
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  const { probe, apply, days } = parseArgs(process.argv.slice(2));
  const projectId = process.env.GCP_BILLING_PROJECT ?? "";
  const dataset = process.env.GCP_BILLING_DATASET ?? "";
  const tableEnv = process.env.GCP_BILLING_TABLE ?? "";

  if (!projectId || !dataset) {
    console.error("GCP_BILLING_PROJECT / GCP_BILLING_DATASET 환경변수가 필요합니다.");
    process.exit(1);
  }

  const client = new BigQueryClient();
  const configError = client.missingConfig();
  if (configError) {
    console.error(configError);
    process.exit(1);
  }

  // 테이블 이름을 사람이 찾아 넣지 않아도 되게 데이터셋에서 직접 고른다.
  const tables = await client.listTables(projectId, dataset);
  if (!tables.ok) {
    console.error(`[${tables.stage}] ${tables.error}`);
    process.exit(1);
  }
  console.log(`데이터셋 ${projectId}.${dataset} 테이블 ${tables.data.length}개: ${tables.data.join(", ") || "(없음)"}`);

  const table = tableEnv || tables.data.find((t) => t.startsWith(TABLE_PREFIX)) || "";
  if (!table) {
    console.error(`결제 내보내기 테이블(${TABLE_PREFIX}…)을 찾지 못했습니다. 내보내기를 켠 뒤 데이터가 쌓이기까지 최대 5일 걸립니다.`);
    process.exit(1);
  }
  console.log(`사용할 테이블: ${table}`);

  const result = await client.query(projectId, buildSql(projectId, dataset, table, days));
  if (!result.ok) {
    console.error(`[${result.stage}] ${result.error}`);
    process.exit(1);
  }

  const rows = toRows(result.data);
  const total = rows.reduce((sum, r) => sum + r.netCost, 0);
  const currencies = Array.from(new Set(rows.map((r) => r.currency)));
  console.log(`최근 ${days}일: ${rows.length}행, 순비용 합계 ${usd(total)} [통화 ${currencies.join(", ") || "USD"}]`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.usageDate}  ${usd(r.netCost)}  ${r.service} / ${r.sku}`);
  }
  if (rows.length > 20) console.log(`  … 외 ${rows.length - 20}행`);

  if (probe) {
    const diag = await client.query(projectId, buildProbeSql(projectId, dataset, table));
    if (!diag.ok) {
      console.error(`[${diag.stage}] ${diag.error}`);
      process.exit(1);
    }
    const d = diag.data[0] ?? {};
    const totalRows = Number(d.total_rows ?? 0);
    const allCost = Number(d.all_gross_cost ?? 0);
    console.log(
      `테이블 전체: ${totalRows}행, 사용일 ${d.first_day ?? "-"} ~ ${d.last_day ?? "-"}, 총 청구액 ${usd(Number.isFinite(allCost) ? allCost : 0)}`
    );
    if (totalRows === 0) {
      console.log("→ 테이블이 비어 있습니다. 내보내기를 켠 직후라면 구글이 채울 때까지 하루 정도 더 걸립니다.");
    } else if (!Number.isFinite(allCost) || allCost === 0) {
      console.log("→ 행은 있는데 청구액이 전부 0입니다(무료 등급 범위). 유료 사용이 생기는 날부터 잡힙니다.");
    } else {
      console.log("→ 청구액이 있는 테이블입니다. 최근 창에 0행이면 그 기간에만 지출이 없었던 것입니다.");
    }
    console.log("probe 모드 - DB에 아무것도 쓰지 않았습니다.");
    return;
  }
  if (!apply) {
    console.log("미리보기 모드 - DB에 쓰지 않았습니다. 실제 적재는 --apply 를 붙이세요.");
    return;
  }
  if (rows.length === 0) {
    console.log("적재할 행이 없습니다.");
    return;
  }

  // api_usage.cost_usd는 이름 그대로 USD 칸이다. 청구 통화가 USD가 아니면(한국 계정은 KRW인 경우가
  // 있다) 숫자를 그대로 넣는 순간 대시보드가 원화를 달러로 읽어 1,000배 넘게 부풀린다. 막는다.
  const nonUsd = currencies.filter((c) => c !== "USD");
  if (nonUsd.length > 0) {
    console.error(`청구 통화가 ${nonUsd.join(", ")}입니다. cost_usd 칸에 그대로 넣으면 금액이 왜곡되므로 적재를 멈춥니다. 환산 규칙을 정한 뒤 다시 실행하세요.`);
    process.exit(1);
  }

  // 같은 창을 지우고 다시 넣는다(파일 상단 주석 참고). 범위를 벗어난 행은 건드리지 않는다.
  const oldest = rows.reduce((min, r) => (r.usageDate < min ? r.usageDate : min), rows[0].usageDate);
  const from = `${oldest}T00:00:00+09:00`;
  const { error: deleteError } = await supabase
    .from("api_usage")
    .delete()
    .eq("provider", "google")
    .eq("cost_source", "reported")
    .gte("occurred_at", from);
  if (deleteError) throw deleteError;

  const payload = rows.map((r) => ({
    provider: "google",
    model: r.service,
    operation: r.sku,
    occurred_at: `${r.usageDate}T00:00:00+09:00`,
    quantity: 1,
    cost_usd: Number(r.netCost.toFixed(6)),
    cost_source: "reported" as const,
    metadata: {
      source: "bigquery-billing-export",
      table,
      currency: r.currency,
      gross_cost: Number(r.grossCost.toFixed(6)),
      credits: Number(r.credits.toFixed(6)),
    },
  }));

  const { error: insertError } = await supabase.from("api_usage").insert(payload);
  if (insertError) throw insertError;
  console.log(`적재 완료: ${payload.length}행(${from} 이후 재작성), 순비용 ${usd(total)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
