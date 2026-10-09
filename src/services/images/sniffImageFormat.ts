// 이미지 **실제 바이트**로 형식을 판별한다(2026-10-08).
//
// 왜: 웹에서 받은 이미지는 서버가 알려 준 content-type·확장자를 믿을 수 없다. 실측(우크라 러 석유 글):
// 네이버 뉴스 CDN이 준 AVIF가 Storage에 `2-web.png`라는 이름으로 올라갔고, 티스토리 에디터가 그 파일에서
// 꼬여 뒤의 정상 이미지 4장까지 연쇄로 실패했다. 이름·content-type·바이트 셋이 일치해야 한다.
//
// 처음에는 TistoryPublisher 안에 있었다(발행 직전 방어). 수집·업로드 쪽에서도 같은 판별이 필요해 옮겼고,
// TistoryPublisher는 여기서 다시 내보낸다(`export { sniffImageFormat }`) - 기존 import가 깨지지 않는다.

export type SniffedImageFormat = "jpg" | "png" | "gif" | "webp" | "avif";

export function sniffImageFormat(buffer: Buffer): SniffedImageFormat | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  // ISO BMFF: [4바이트 크기]["ftyp"][브랜드]. avif(정지)·avis(시퀀스) 둘 다 AVIF다.
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "avif";
  }
  return null;
}

export const MIME_BY_FORMAT: Record<SniffedImageFormat, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};
