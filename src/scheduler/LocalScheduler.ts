// Scheduler의 기본 구현체. 자체적으로 시간을 감시하지 않는다 — "언제" 실행할지는 외부 OS
// crontab/launchd가 이 프로세스를 하루 1회 실행시키는 방식으로 담당하고(jobs/dailyKeywordJob.ts 참고),
// LocalScheduler는 그 실행 1회를 감싸서 시작/완료/실패를 일관된 형태로 로그만 남긴다.

import type { Scheduler, SchedulerJob } from "./Scheduler.js";

export class LocalScheduler implements Scheduler {
  async run(job: SchedulerJob): Promise<void> {
    const startedAt = Date.now();
    console.log(`▶ [${job.name}] 시작 (${new Date(startedAt).toISOString()})`);

    try {
      await job.execute();
      console.log(`✅ [${job.name}] 완료 (${Date.now() - startedAt}ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ [${job.name}] 실패 (${Date.now() - startedAt}ms) -`, message);
      throw error;
    }
  }
}
