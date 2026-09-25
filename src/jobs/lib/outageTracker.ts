// 무인 job이 **얼마나 오래 멈춰 있었는지** 기록하고, 복구했을 때 한 번 알린다(2026-09-25).
//
// 왜 필요한가(실측): 인스타 폴러가 맥의 네트워크 장애로 **39시간** 멈췄는데 아무도 몰랐다.
// 로그에는 150번의 `getaddrinfo ENOTFOUND`가 쌓였지만 stdout을 보는 사람이 없고, 텔레그램으로
// 알리려 해도 그 순간엔 네트워크가 없어서 못 보낸다.
//
// 그래서 **실패는 로컬 파일에 적고, 성공했을 때 알린다.** 네트워크가 돌아온 시점이 곧 알릴 수
// 있는 시점이다. 파일에 쓰는 이유도 같다 - 장애 중에는 원격 저장소에 못 쓴다.
//
// 텔레그램의 미확인 업데이트 보관 한도가 24시간이라, 그보다 오래 멈추면 링크가 **사라진다.**
// 그 경계를 넘겼는지도 함께 알린다.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 텔레그램이 미확인 업데이트를 보관하는 시간. 이걸 넘기면 유실을 의심해야 한다. */
export const TELEGRAM_RETENTION_HOURS = 24;

export type OutageState = {
  /** 처음 실패한 시각(ISO). */
  firstFailedAt: string;
  /** 마지막 실패 시각(ISO). */
  lastFailedAt: string;
  /** 연속 실패 횟수. */
  failures: number;
  /** 마지막 실패 사유(짧게). */
  reason: string;
};

export type OutageRecovery = {
  /** 멈춰 있던 시간(시간 단위, 소수 첫째 자리). */
  hours: number;
  failures: number;
  firstFailedAt: string;
  reason: string;
  /** 텔레그램 보관 한도를 넘겼나 - 넘겼으면 유실 가능성을 알려야 한다. */
  mayHaveLostUpdates: boolean;
};

function read(path: string): OutageState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OutageState>;
    if (!parsed.firstFailedAt || !parsed.lastFailedAt) return null;
    return {
      firstFailedAt: parsed.firstFailedAt,
      lastFailedAt: parsed.lastFailedAt,
      failures: typeof parsed.failures === "number" ? parsed.failures : 1,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    // 파일이 깨졌으면 없는 것으로 본다 - 기록 때문에 job이 멈추면 안 된다.
    return null;
  }
}

/** 실패를 기록한다. 첫 실패면 시작 시각을 남기고, 이어지는 실패는 횟수만 늘린다. */
export function recordFailure(path: string, reason: string, now: Date = new Date()): OutageState {
  const previous = read(path);
  const state: OutageState = {
    firstFailedAt: previous?.firstFailedAt ?? now.toISOString(),
    lastFailedAt: now.toISOString(),
    failures: (previous?.failures ?? 0) + 1,
    reason: reason.slice(0, 200),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    // 기록에 실패해도 job은 계속 간다.
  }
  return state;
}

/**
 * 성공했을 때 부른다. 직전에 멈춰 있었으면 그 내역을 돌려주고 기록을 지운다.
 * 멈춘 적이 없으면 null - 알릴 것이 없다.
 */
export function takeRecovery(path: string, now: Date = new Date()): OutageRecovery | null {
  const state = read(path);
  if (!state) return null;

  try {
    rmSync(path, { force: true });
  } catch {
    // 못 지워도 다음 실행에서 다시 시도한다.
  }

  const hours = (now.getTime() - new Date(state.firstFailedAt).getTime()) / 3_600_000;
  return {
    hours: Math.round(hours * 10) / 10,
    failures: state.failures,
    firstFailedAt: state.firstFailedAt,
    reason: state.reason,
    mayHaveLostUpdates: hours >= TELEGRAM_RETENTION_HOURS,
  };
}

/** 사람이 읽을 알림 문구. 유실 가능성이 있으면 그것부터 말한다. */
export function describeRecovery(recovery: OutageRecovery, jobLabel: string): string {
  const lines = [
    recovery.mayHaveLostUpdates
      ? `⚠️ <b>${jobLabel}가 ${recovery.hours}시간 멈춰 있었습니다</b>`
      : `✅ <b>${jobLabel}가 ${recovery.hours}시간 만에 복구됐습니다</b>`,
    "",
  ];

  if (recovery.mayHaveLostUpdates) {
    lines.push(
      `텔레그램은 받지 못한 메시지를 <b>${TELEGRAM_RETENTION_HOURS}시간</b>만 보관합니다.`,
      "그 사이에 보내신 링크가 있다면 <b>사라졌을 수 있습니다</b> - 다시 보내주세요.",
      ""
    );
  }

  lines.push(`실패 ${recovery.failures}회 · 시작 ${recovery.firstFailedAt.replace("T", " ").slice(0, 16)}`);
  if (recovery.reason) lines.push(`<code>${recovery.reason}</code>`);
  return lines.join("\n");
}
