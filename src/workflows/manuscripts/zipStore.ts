// ZIP(무압축 store) 한 덩어리를 만든다. 원고 뷰어의 "이미지 저장" 버튼이 브라우저에서 쓴다.
//
// 왜 여기에 따로 두는가: renderManuscriptPage.ts의 페이지 스크립트는 문자열 템플릿이라 타입
// 검사도 테스트도 받지 않는다. 이 함수만은 실제 모듈로 두고 `zipStore.toString()`으로 페이지에
// 인라인한다 - 그러면 브라우저에서 도는 것과 **똑같은 코드**를 Node에서 테스트할 수 있다
// (testZipStore.ts가 만든 zip을 `unzip -t`로 검증한다).
//
// 그래서 이 함수는 **자기 완결**이어야 한다. 바깥 변수를 참조하면 toString으로 떼어낸 순간
// 브라우저에서 ReferenceError가 난다 - import도, 모듈 상수도 쓰지 않는다.
//
// ⚠️ **중첩 함수를 만들지 않는다.** tsx(esbuild)가 이름 보존용으로 `__name(fn, "fn")` 호출을
// 끼워 넣는데, 그 헬퍼는 모듈 바깥에 있어 페이지에 따라오지 않는다 - 브라우저에서만
// `__name is not defined`로 죽는다(2026-09-29 실제로 밟았다). crc32를 루프 안에 펼쳐 둔 것이
// 그 때문이다. testZipStore.ts가 인라인된 사본에 `__name`이 없는지 검사한다.
//
// 왜 압축하지 않는가(store): 담는 것이 jpg/png뿐이라 이미 압축돼 있어 줄지 않고, 압축을 하려면
// CompressionStream 분기가 붙어 코드가 커진다. 파일을 한 폴더로 묶는 것이 목적이지 용량이 아니다.

export type ZipEntry = { name: string; data: Uint8Array };

export function zipStore(files: ReadonlyArray<ZipEntry>): Uint8Array {
  const encoder = new TextEncoder();

  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  // 로컬 헤더 + 데이터를 순서대로, 그리고 central directory를 따로 모아 마지막에 붙인다.
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const size = file.data.length;

    // CRC를 함수로 빼지 않고 여기서 계산하는 이유는 아래 "중첩 함수 금지" 주석 참고.
    let running = -1;
    for (let i = 0; i < size; i += 1) running = (running >>> 8) ^ crcTable[(running ^ file.data[i]) & 0xff];
    const crc = (running ^ -1) >>> 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // 압축 해제에 필요한 버전 2.0
    lv.setUint16(6, 0x0800, true); // 파일명이 UTF-8임을 알리는 플래그(비트 11) - 한글 파일명에 필요하다
    lv.setUint16(8, 0, true); // 0 = store
    lv.setUint16(10, 0, true); // 수정 시각 00:00
    lv.setUint16(12, 0x0021, true); // 수정 날짜 1980-01-01(0은 유효한 날짜가 아니라 경고를 낸다)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field 없음
    local.set(nameBytes, 30);

    parts.push(local, file.data);

    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // 만든 버전
    cv.setUint16(6, 20, true); // 필요한 버전
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field 없음
    cv.setUint16(32, 0, true); // 주석 없음
    cv.setUint16(34, 0, true); // 디스크 번호
    cv.setUint16(36, 0, true); // 내부 속성
    cv.setUint32(38, 0, true); // 외부 속성
    cv.setUint32(42, offset, true); // 이 항목의 로컬 헤더 위치
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory 시작 위치
  ev.setUint16(20, 0, true); // 주석 없음

  const all = parts.concat(central, [end]);
  const total = all.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
