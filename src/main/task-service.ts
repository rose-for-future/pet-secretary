import type { Task, Settings, RecurRule } from '../shared/types'
import type { AddTaskInput } from '../shared/api'
import { computeReminderTimeUtc, localWallTimeToUtc } from '../shared/time'
import { nextOccurrenceUtc } from '../shared/recur'

export interface TaskServiceDeps {
  now: () => number
  uuid: () => string
  timezone: string
  getSettings: () => Settings
}

/** 在内存任务数组上做增删改；时间计算委托 shared/time。持久化由调用方负责。 */
export class TaskService {
  constructor(private tasks: Task[], private deps: TaskServiceDeps) {}

  list(): Task[] {
    return this.tasks
  }

  /** 由输入算出事件/提醒时间。无日期或时间 → 无时间待办（均为 null）。
   *  有事件时，提前量被钳制为不超过"现在到事件"的分钟数，保证提醒不早于现在。 */
  private computeTimes(input: AddTaskInput): {
    eventTimeUtc: number | null
    reminderTimeUtc: number | null
    leadMinutes: number
  } {
    const requestedLead = input.leadMinutes ?? this.deps.getSettings().defaultLeadMinutes
    if (!input.eventLocalDate || !input.eventLocalTime) {
      return { eventTimeUtc: null, reminderTimeUtc: null, leadMinutes: requestedLead }
    }
    const eventTimeUtc = localWallTimeToUtc(input.eventLocalDate, input.eventLocalTime, this.deps.timezone)
    const maxLead = Math.max(0, Math.floor((eventTimeUtc - this.deps.now()) / 60000))
    const leadMinutes = Math.min(requestedLead, maxLead)
    const reminderTimeUtc = computeReminderTimeUtc(eventTimeUtc, leadMinutes)
    return { eventTimeUtc, reminderTimeUtc, leadMinutes }
  }

  add(input: AddTaskInput): Task {
    // 周期提醒：时间由重复规则算出下一次，忽略 event/lead
    let eventTimeUtc: number | null
    let reminderTimeUtc: number | null
    let leadMinutes: number
    if (input.recur) {
      const next = nextOccurrenceUtc(input.recur, this.deps.now(), this.deps.timezone)
      eventTimeUtc = next
      reminderTimeUtc = next
      leadMinutes = 0
    } else {
      ;({ eventTimeUtc, reminderTimeUtc, leadMinutes } = this.computeTimes(input))
    }
    const iso = new Date(this.deps.now()).toISOString()
    const task: Task = {
      id: this.deps.uuid(),
      title: input.title,
      note: input.note,
      eventTimeUtc,
      timezone: this.deps.timezone,
      leadMinutes,
      reminderTimeUtc,
      recur: input.recur ?? null,
      kind: input.recur ? 'series' : 'single',
      seriesId: null,
      nextEventTimeUtc: null,
      status: 'pending',
      snoozeUntilUtc: null,
      source: 'keyboard',
      nagCount: 0,
      lastFiredAtUtc: null,
      createdAt: iso,
      updatedAt: iso
    }
    this.tasks.push(task)
    return task
  }

  update(id: string, input: AddTaskInput): Task | null {
    const t = this.find(id)
    if (!t) return null
    const { eventTimeUtc, reminderTimeUtc, leadMinutes } = this.computeTimes(input)
    t.title = input.title
    t.note = input.note
    t.eventTimeUtc = eventTimeUtc
    t.timezone = this.deps.timezone
    t.leadMinutes = leadMinutes
    t.reminderTimeUtc = reminderTimeUtc
    t.status = 'pending'
    t.lastFiredAtUtc = null
    t.snoozeUntilUtc = null
    t.updatedAt = new Date(this.deps.now()).toISOString()
    return t
  }

  /** 按字段单独修改（语音"分别改事件/提醒时间"用）：只动传入的字段，其余保持不变。 */
  patch(
    id: string,
    p: { title?: string; eventTimeUtc?: number | null; reminderTimeUtc?: number | null; leadMinutes?: number; recur?: RecurRule | null }
  ): Task | null {
    const t = this.find(id)
    if (!t) return null
    if (p.title !== undefined) t.title = p.title
    if (p.eventTimeUtc !== undefined) t.eventTimeUtc = p.eventTimeUtc
    if (p.reminderTimeUtc !== undefined) t.reminderTimeUtc = p.reminderTimeUtc
    if (p.leadMinutes !== undefined) t.leadMinutes = p.leadMinutes
    if (p.recur !== undefined) t.recur = p.recur
    // 改过就重新进入待提醒状态，清掉已提醒/推迟标记
    t.status = 'pending'
    t.lastFiredAtUtc = null
    t.snoozeUntilUtc = null
    t.updatedAt = new Date(this.deps.now()).toISOString()
    return t
  }

  complete(id: string): void {
    const t = this.find(id)
    if (!t) return
    t.status = 'done'
    t.updatedAt = new Date(this.deps.now()).toISOString()
  }

  snooze(id: string): void {
    const t = this.find(id)
    if (!t) return
    const now = this.deps.now()
    const target = now + this.deps.getSettings().snoozeMinutes * 60000
    t.snoozeUntilUtc = target
    t.reminderTimeUtc = target
    t.lastFiredAtUtc = null
    t.status = 'pending'
    t.updatedAt = new Date(now).toISOString()
  }

  remove(id: string): void {
    const i = this.tasks.findIndex((t) => t.id === id)
    if (i >= 0) this.tasks.splice(i, 1)
  }

  /** 周期提醒响过之后：排到下一次、重新进入待提醒（不标记 done）。 */
  advanceRecur(id: string): void {
    const t = this.find(id)
    if (!t || !t.recur) return
    const next = nextOccurrenceUtc(t.recur, this.deps.now(), this.deps.timezone)
    t.eventTimeUtc = next
    t.reminderTimeUtc = next
    t.lastFiredAtUtc = null
    t.status = 'pending'
    t.snoozeUntilUtc = null
    t.updatedAt = new Date(this.deps.now()).toISOString()
  }

  markFired(id: string, firedAtUtc: number): void {
    const t = this.find(id)
    if (!t) return
    t.lastFiredAtUtc = firedAtUtc
    t.updatedAt = new Date(firedAtUtc).toISOString()
  }

  private find(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }
}
