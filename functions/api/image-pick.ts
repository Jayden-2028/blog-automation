// Cloudflare Pages Function - POST /api/image-pick (원고 뷰어 후보 이미지 클릭 교체, 2026-10-07).
// manuscript-edit.ts와 같은 구조 - 로직은 cloudflare/manuscripts-pages/imagePickApi.ts에 있다.
import { handleImagePickRequest } from "../../cloudflare/manuscripts-pages/imagePickApi";
import type { EditApiEnv } from "../../cloudflare/manuscripts-pages/editApi";

export const onRequest = (context: { request: Request; env: EditApiEnv }): Promise<Response> =>
  handleImagePickRequest(context.request, context.env);
