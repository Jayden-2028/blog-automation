// 스케줄 실행을 감싸는 최소 인터페이스.
// 실제 "몇 시에 실행할지" 판단은 이 인터페이스가 하지 않는다 — 이 프로젝트는 OS crontab/launchd가
// 하루 1회 프로세스를 실행시키는 방식(외부 스케줄링)을 쓰기로 결정했으므로, Scheduler/구현체는
// "트리거된 job을 실행하고 시작/종료/실패를 구조적으로 기록"하는 얇은 실행 래퍼 역할만 한다.
// 이렇게 분리해두면 나중에 실제로 상시 프로세스 기반 스케줄러(예: node-cron 내장, 클라우드 스케줄러
// 트리거)로 교체하고 싶을 때 SchedulerJob을 건드리지 않고 구현체(Scheduler)만 바꿀 수 있다.

export type SchedulerJob = {
  name: string;
  execute: () => Promise<void>;
};

export interface Scheduler {
  run(job: SchedulerJob): Promise<void>;
}
