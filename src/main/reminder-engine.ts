import type { Task } from '../shared/types'

export type FireFn = (task: Task) => void
export type MarkFiredFn = (taskId: string, firedAtUtc: number) => void
export type NowFn = () => number

/**
 * 心跳提醒引擎：每次 tick 扫描所有任务，触发「已到期、pending、未触发过」的任务。
 * 不用超长 setTimeout（会漂移、睡眠不走）；用短周期心跳比对 reminderTimeUtc。
 * 本模块不联网、不调模型。
 */
export class ReminderEngine {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private getTasks: () => Task[],
    private onFire: FireFn,
    private markFired: MarkFiredFn,
    private now: NowFn = () => Date.now()
  ) {}

  tick(): void {
    const nowMs = this.now()
    for (const t of this.getTasks()) {
      if (t.status !== 'pending') continue
      if (t.reminderTimeUtc == null) continue
      if (t.reminderTimeUtc > nowMs) continue
      if (t.lastFiredAtUtc != null) continue
      this.onFire(t)
      this.markFired(t.id, nowMs)
    }
  }

  start(intervalMs = 30000): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
