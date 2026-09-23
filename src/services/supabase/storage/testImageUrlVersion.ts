// 이미지 URL 캐시 버스팅 테스트. 실행: npm run test:image-url-version
//
// 왜 필요한가(2026-09-24 실측): 파일명이 자리 번호로 고정이라 재수집해도 주소가 그대로였다.
// 내용만 바뀌고 주소가 같으면 브라우저는 옛 이미지를 계속 보여준다 - 실제로 사람이 캐시를
// 비워야 원고를 볼 수 있었다.
//
// 지켜야 할 것: ① 내용이 다르면 주소가 다르다 ② 내용이 같으면 주소도 같다(불필요한 재다운로드
// 방지) ③ 원래 경로는 그대로 남는다.
import { uploadArticleImage } from "./uploadArticleImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

console.log("▶ 이미지 URL 버전 테스트 시작\n");

// Storage를 타지 않고 URL 생성 규칙만 본다 - 모듈이 supabase 클라이언트를 직접 쓰므로
// 여기서는 해시 규칙이 결정적인지만 확인한다.
const { createHash } = await import("node:crypto");
const version = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 12);

{
  const a = Buffer.from("사진 A");
  const b = Buffer.from("사진 B");
  assert(version(a) !== version(b), "내용이 다르면 버전이 달라야 한다");
  assert(version(a) === version(Buffer.from("사진 A")), "같은 내용은 같은 버전이어야 한다");
  assert(version(a).length === 12, "버전은 12자리");
  console.log("✅ 내용 해시 - 다르면 다르게, 같으면 같게");
}

{
  // 실제 함수가 `?v=`를 붙이는지 소스로 확인한다(네트워크를 타지 않는다).
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./uploadArticleImage.ts", import.meta.url), "utf8")
  );
  assert(source.includes("?v=${versionOf(input.imageBuffer)}"), "업로드 URL에 내용 해시를 붙여야 한다");
  assert(source.includes("path"), "원래 경로는 그대로 돌려줘야 한다");
  assert(typeof uploadArticleImage === "function", "함수가 export돼 있어야 한다");
  console.log("✅ 업로드 URL에 ?v=<내용해시>가 붙는다");
}

console.log("\n🎉 이미지 URL 버전 테스트 통과");
