// 발행된 사용설명서 이미지가 아직 살아 있는지 분류하고 알림 문구를 만든다. 순수 함수만 둔다(외부 호출 없음).
//
// 왜 필요한가: Pages 배포가 사이트 전체 스냅샷이라 동시 발행이 겹치면 앞 글의 이미지가 사라진다
// (`services/images/rehostImagesToPages.ts` 머리말). 2026-10-15과 10-31, **두 번 다 사용자가 블로그 관리
// 화면에서 눈으로 발견했다** - 그때까지 아무도 몰랐다. 되살리는 길은 Supabase 원본으로 재배포하는 것뿐인데
// `storage-cleanup`이 발행 14일 뒤 그 원본을 지우므로 **늦게 알면 영구 손실**이다.
//
// 그래서 깨진 장수를 세는 데서 멈추지 않고 **지금 되살릴 수 있는지**까지 같이 본다. 알림을 받은 사람이
// 알아야 할 것은 "몇 장 깨졌나"가 아니라 "지금 손쓰면 되는가"다.
//
// 모르는 상태를 고장으로 치지 않는다(classifyIndexHealth.ts와 같은 원칙). 404·410만 "사라졌다"로 보고
// 네트워크 실패·5xx는 **검사 실패**로 따로 센다 - 매일 오는 알림이라 거짓 경보 한 번이면 다음부터 안 읽힌다.

/** HEAD 한 번의 결과. status 0은 요청 자체가 실패한 것(타임아웃·네트워크). */
export type ImageProbe = { url: string; status: number };

export type ProbeVerdict = "ok" | "gone" | "unreachable";

export function verdictOf(status: number): ProbeVerdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "gone";
  return "unreachable";
}

export type JobImageProbes = {
  jobId: string;
  /** 사람이 알아볼 이름(원고 키워드·주제). */
  keyword: string;
  /** 발행 HTML이 가리키는 Pages URL과 그 상태. */
  pages: ImageProbe[];
  /**
   * 사라진 자리의 Supabase 원본 상태. 사라진 자리가 없으면 비어 있다 - 멀쩡한 글의 원본까지
   * 묻지 않는다(발행본 53편이면 300장이 넘어 그만큼이 헛걸음이다).
   */
  origins: ImageProbe[];
};

export type BrokenJob = {
  jobId: string;
  keyword: string;
  /** 사라진 장수 / 그 글의 전체 장수. */
  gone: number;
  total: number;
  /** 사라진 자리의 원본이 전부 살아 있는가. false면 재배포로 되살릴 수 없다. */
  recoverable: boolean;
};

export type ImageHealthReport = {
  jobs: number;
  images: number;
  /** 사라진 글이 있는 글 목록(사라진 장수 많은 순). */
  broken: BrokenJob[];
  goneImages: number;
  /** 상태를 확인하지 못한 장수(타임아웃·5xx). 고장과 구분한다. */
  unreachable: number;
};

export function buildImageHealthReport(probes: readonly JobImageProbes[]): ImageHealthReport {
  const report: ImageHealthReport = { jobs: probes.length, images: 0, broken: [], goneImages: 0, unreachable: 0 };

  for (const job of probes) {
    report.images += job.pages.length;
    const gone = job.pages.filter((probe) => verdictOf(probe.status) === "gone");
    report.unreachable += job.pages.filter((probe) => verdictOf(probe.status) === "unreachable").length;
    if (gone.length === 0) continue;

    report.goneImages += gone.length;
    // 원본을 확인하지 못했으면 복구 가능하다고 말하지 않는다 - 되살릴 수 있다고 안심시키는 쪽이 더 위험하다.
    const recoverable = job.origins.length > 0 && job.origins.every((probe) => verdictOf(probe.status) === "ok");
    report.broken.push({ jobId: job.jobId, keyword: job.keyword, gone: gone.length, total: job.pages.length, recoverable });
  }

  report.broken.sort((a, b) => b.gone - a.gone || a.jobId.localeCompare(b.jobId));
  return report;
}

/** 텔레그램 HTML 파싱을 깨뜨리지 않게 최소 이스케이프. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 알림·로그에서 글을 가리키는 짧은 이름. 복구 명령에 넣는 접두사와 같은 8자다. */
export function shortJobId(jobId: string): string {
  return jobId.replace(/-/g, "").slice(0, 8);
}

/** 알림을 보낼 만한가. 매일 돌지만 **고장이 있을 때만 말한다** - 조용한 날 알림은 다음 고장을 묻는다. */
export function shouldNotify(report: ImageHealthReport): boolean {
  return report.broken.length > 0 || report.unreachable > 0;
}

/**
 * 알림 문구. 사라진 글이 있으면 **복구 명령을 그대로 붙여넣을 수 있게** 싣는다 - 사고 때 사람이
 * 알아야 할 것은 경위가 아니라 다음에 누를 것이다.
 */
export function buildImageHealthMessage(report: ImageHealthReport, projectName: string): string {
  const lines: string[] = [];

  if (report.broken.length === 0) {
    lines.push("🖼 <b>발행 이미지 점검</b>");
    lines.push("");
    lines.push(`${report.jobs}편 ${report.images}장 모두 정상입니다.`);
    if (report.unreachable > 0) {
      lines.push("");
      lines.push(`확인 못 한 ${report.unreachable}장이 있습니다(타임아웃·5xx) - 내일 다시 봅니다.`);
    }
    return lines.join("\n");
  }

  const unrecoverable = report.broken.filter((job) => !job.recoverable);
  lines.push(`🚨 <b>발행 이미지 ${report.goneImages}장이 사라졌습니다</b>`);
  lines.push("");
  lines.push(`${report.jobs}편 ${report.images}장 중 ${report.broken.length}편이 깨졌습니다.`);
  lines.push("");

  // 많으면 메시지가 잘린다 - 앞의 몇 건만 펴고 나머지는 수만 알린다. 복구 명령에는 전부 넣는다.
  for (const job of report.broken.slice(0, 8)) {
    const mark = job.recoverable ? "복구 가능" : "⚠️ 원본도 없음";
    lines.push(`· <b>${escapeHtml(job.keyword)}</b> (${shortJobId(job.jobId)}) ${job.gone}/${job.total}장 · ${mark}`);
  }
  if (report.broken.length > 8) lines.push(`· 외 ${report.broken.length - 8}편`);

  const recoverable = report.broken.filter((job) => job.recoverable);
  if (recoverable.length > 0) {
    lines.push("");
    lines.push("<b>복구</b>(같은 URL로 돌아옵니다 - 블로그 본문은 건드리지 않습니다)");
    lines.push(
      `<code>npm run images:repair-pages -- ${recoverable.map((job) => shortJobId(job.jobId)).join(" ")} --project=${escapeHtml(projectName)} --apply</code>`
    );
  }

  if (unrecoverable.length > 0) {
    lines.push("");
    lines.push(
      `⚠️ ${unrecoverable.length}편은 Supabase 원본도 사라져 재배포로 되살릴 수 없습니다 - 이미지를 다시 모아야 합니다.`
    );
  }

  if (report.unreachable > 0) {
    lines.push("");
    lines.push(`확인 못 한 ${report.unreachable}장은 따로 있습니다(타임아웃·5xx).`);
  }

  return lines.join("\n");
}
