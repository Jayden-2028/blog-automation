// Cloudflare Pages Function - POST /api/publish-request (원고 뷰어 "🟠 티스토리 발행", 2026-10-06).
// manuscript-edit.ts와 같은 구조 - 로직은 cloudflare/manuscripts-pages/publishApi.ts에 있다.
import { handlePublishRequest } from "../../cloudflare/manuscripts-pages/publishApi";
import type { EditApiEnv } from "../../cloudflare/manuscripts-pages/editApi";

export const onRequest = (context: { request: Request; env: EditApiEnv }): Promise<Response> =>
  handlePublishRequest(context.request, context.env);
