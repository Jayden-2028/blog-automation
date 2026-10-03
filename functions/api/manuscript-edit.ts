// Cloudflare Pages Function - POST /api/manuscript-edit (원고 뷰어 "📤 수정본 반영", 2026-10-03).
//
// wrangler pages deploy는 **실행 위치(cwd)의 functions/ 폴더**를 함께 묶어 올린다. 원고 페이지 배포
// (deployManuscriptsPage.ts)는 저장소 루트(PIPELINE_ROOT)에서 돌므로 이 폴더가 저장소 루트에 있어야 한다.
// 로직은 cloudflare/manuscripts-pages/editApi.ts에 있다(테스트: npm run test:viewer-edit-api).
import { handleEditRequest } from "../../cloudflare/manuscripts-pages/editApi";
import type { EditApiEnv } from "../../cloudflare/manuscripts-pages/editApi";

export const onRequest = (context: { request: Request; env: EditApiEnv }): Promise<Response> =>
  handleEditRequest(context.request, context.env);
