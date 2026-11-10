// koreaplain:reimage CLI 인자 해석. 부작용 있는 import(dotenv·Supabase 클라이언트)가 없어 테스트가 그대로 가져다 쓴다.

export const USAGE =
  "사용법: npm run koreaplain:reimage -- [--job=<jobId 접두사>] [--limit=N] [--apply]\n        npm run koreaplain:reimage -- --job=<jobId 접두사> --restore [--apply]";

export type Args = { apply: boolean; jobPrefix: string | null; limit: number | null; restore: boolean };

/** 인자 해석(테스트가 직접 부른다). 오류면 사유 문자열. */
export function parseArgs(argv: string[]): Args | string {
  const args: Args = { apply: false, jobPrefix: null, limit: null, restore: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--restore") args.restore = true;
    else if (arg.startsWith("--job=")) args.jobPrefix = arg.slice("--job=".length).trim().toLowerCase() || null;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(n) || n <= 0) return `--limit은 1 이상의 정수여야 합니다: ${arg}`;
      args.limit = n;
    } else return `알 수 없는 인자: ${arg}`;
  }
  // 되돌리기는 한 글만이다 - 전체를 실수로 되돌리는 일이 없도록 --job 없이는 거부한다.
  if (args.restore && !args.jobPrefix) return "--restore는 --job=<jobId 접두사>와 함께만 쓸 수 있습니다";
  if (args.restore && args.limit !== null) return "--restore에는 --limit을 쓸 수 없습니다";
  return args;
}

