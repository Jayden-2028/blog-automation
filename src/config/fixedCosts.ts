// 호출 단위로 계측할 수 없는 비용. 대시보드가 "모든 솔루션"을 말하려면 이쪽도 같이 떠야 한다.
//
// 왜 계측이 안 되는가:
// - Claude: 집필·자료조사는 헤드리스 `claude -p`(Max 구독)로 돈다. 구독은 정액제라 호출 1건의
//   금액이라는 게 **원리상 존재하지 않는다**. 토큰을 세도 청구액이 그만큼 늘지 않는다.
// - Supabase/Cloudflare/GitHub Actions/Telegram/NAVER/Blogger: 현재 전부 무료 구간이다.
//   유료로 올라가면 여기 금액을 채운다.
//
// 금액을 코드에 안 박는 이유: 사용자가 실제로 얼마를 내는지는 저장소가 알 수 없고, 추정치를 박아
// 두면 대시보드가 그럴듯한 거짓말을 한다. 환경변수로만 받고, 없으면 "미입력"으로 그대로 보여준다.

export type FixedCostEntry = {
  name: string;
  /** 요금제 이름 또는 현재 상태. */
  plan: string;
  /** 월 USD. null이면 대시보드에 "미입력"으로 뜨고 합계에 넣지 않는다. */
  monthlyUsd: number | null;
  /** 이 값을 채우는 환경변수 이름(대시보드 각주에 그대로 노출해 어디를 고치면 되는지 알린다). */
  envVar: string;
  note: string;
};

function usdFromEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function listFixedCosts(): FixedCostEntry[] {
  return [
    {
      name: "Claude (Max 구독)",
      plan: "정액 구독",
      monthlyUsd: usdFromEnv("FIXED_COST_CLAUDE_USD"),
      envVar: "FIXED_COST_CLAUDE_USD",
      note: "자료조사·집필·배리에이션(헤드리스 claude -p). 정액제라 호출당 금액이 존재하지 않는다.",
    },
    {
      name: "Supabase",
      plan: "무료 구간",
      monthlyUsd: usdFromEnv("FIXED_COST_SUPABASE_USD"),
      envVar: "FIXED_COST_SUPABASE_USD",
      note: "DB + Storage(article-images). Pro로 올리면 금액을 채운다.",
    },
    {
      name: "Cloudflare",
      plan: "무료 구간",
      monthlyUsd: usdFromEnv("FIXED_COST_CLOUDFLARE_USD"),
      envVar: "FIXED_COST_CLOUDFLARE_USD",
      note: "원고 뷰어(Pages) + 텔레그램 릴레이(Workers).",
    },
    {
      name: "GitHub Actions",
      plan: "무료 구간",
      monthlyUsd: usdFromEnv("FIXED_COST_GITHUB_USD"),
      envVar: "FIXED_COST_GITHUB_USD",
      note: "파이프라인 전 단계 실행. billing API가 0을 반환하는 사례가 보고돼 자동 조회는 붙이지 않았다.",
    },
    {
      name: "Telegram / NAVER / Blogger",
      plan: "무료",
      monthlyUsd: 0,
      envVar: "-",
      note: "승인 알림, 키워드 조회, 발행. 과금 없음.",
    },
  ];
}
