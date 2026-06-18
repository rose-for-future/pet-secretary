import { describe, test, expect } from 'vitest'
import { TaskService, type TaskServiceDeps } from './task-service'
import type { Task, Settings } from '../shared/types'

const settings: Settings = { defaultLeadMinutes: 10, snoozeMinutes: 10, soundEnabled: true, muted: false }

function deps(now: number): TaskServiceDeps {
  return { now: () => now, uuid: () => 'fixed-id', timezone: 'Asia/Shanghai', getSettings: () => settings }
}

describe('TaskService.add', () => {
  test('从本地墙钟算出 eventTimeUtc 和 reminderTimeUtc（默认提前量）', () => {
    const tasks: Task[] = []
    const svc = new TaskService(tasks, deps(Date.UTC(2026, 5, 18, 0, 0, 0)))
    const t = svc.add({ title: '开会', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    expect(t.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 7, 0, 0))     // 15:00 CST = 07:00 UTC
    expect(t.reminderTimeUtc).toBe(Date.UTC(2026, 5, 18, 7, 0, 0) - 10 * 60000)
    expect(t.leadMinutes).toBe(10)
    expect(t.status).toBe('pending')
    expect(t.timezone).toBe('Asia/Shanghai')
    expect(tasks).toHaveLength(1)
  })

  test('显式 leadMinutes 覆盖默认值', () => {
    const svc = new TaskService([], deps(Date.UTC(2026, 5, 18, 0, 0, 0)))
    const t = svc.add({ title: '开会', eventLocalDate: '2026-06-18', eventLocalTime: '15:00', leadMinutes: 30 })
    expect(t.reminderTimeUtc).toBe(Date.UTC(2026, 5, 18, 7, 0, 0) - 30 * 60000)
  })
})

describe('TaskService.patch（分别改事件/提醒时间）', () => {
  const mk = (): { svc: TaskService; id: string } => {
    const svc = new TaskService([], deps(Date.UTC(2026, 5, 18, 0, 0, 0)))
    const t = svc.add({ title: '开会', eventLocalDate: '2026-06-18', eventLocalTime: '15:00', leadMinutes: 10 })
    return { svc, id: t.id }
  }

  test('只改提醒时间，事件时间不动', () => {
    const { svc, id } = mk()
    const eventBefore = svc.list()[0].eventTimeUtc
    svc.patch(id, { reminderTimeUtc: Date.UTC(2026, 5, 18, 6, 0, 0) })
    const t = svc.list()[0]
    expect(t.reminderTimeUtc).toBe(Date.UTC(2026, 5, 18, 6, 0, 0))
    expect(t.eventTimeUtc).toBe(eventBefore) // 事件时间保持
  })

  test('只改事件时间，提醒时间不动', () => {
    const { svc, id } = mk()
    const reminderBefore = svc.list()[0].reminderTimeUtc
    svc.patch(id, { eventTimeUtc: Date.UTC(2026, 5, 18, 9, 0, 0) })
    const t = svc.list()[0]
    expect(t.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 9, 0, 0))
    expect(t.reminderTimeUtc).toBe(reminderBefore) // 提醒时间保持
  })

  test('只改标题，两个时间都不动', () => {
    const { svc, id } = mk()
    const { eventTimeUtc, reminderTimeUtc } = svc.list()[0]
    svc.patch(id, { title: '喝水' })
    const t = svc.list()[0]
    expect(t.title).toBe('喝水')
    expect(t.eventTimeUtc).toBe(eventTimeUtc)
    expect(t.reminderTimeUtc).toBe(reminderTimeUtc)
  })

  test('patch 后重新进入待提醒（清掉已提醒标记）', () => {
    const { svc, id } = mk()
    svc.markFired(id, Date.UTC(2026, 5, 18, 1, 0, 0))
    svc.patch(id, { title: 'x' })
    expect(svc.list()[0].lastFiredAtUtc).toBeNull()
    expect(svc.list()[0].status).toBe('pending')
  })
})

describe('TaskService 状态变更', () => {
  test('complete 把状态置为 done', () => {
    const svc = new TaskService([], deps(0))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    svc.complete(t.id)
    expect(svc.list()[0].status).toBe('done')
  })

  test('snooze 把提醒时间顺延 snoozeMinutes 并清空 lastFiredAtUtc', () => {
    const now = Date.UTC(2026, 5, 18, 8, 0, 0)
    const svc = new TaskService([], deps(now))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    svc.markFired(t.id, now)
    svc.snooze(t.id)
    const after = svc.list()[0]
    expect(after.reminderTimeUtc).toBe(now + 10 * 60000)
    expect(after.snoozeUntilUtc).toBe(now + 10 * 60000)
    expect(after.lastFiredAtUtc).toBeNull()
    expect(after.status).toBe('pending')
  })

  test('remove 删除任务', () => {
    const svc = new TaskService([], deps(0))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    svc.remove(t.id)
    expect(svc.list()).toHaveLength(0)
  })

  test('markFired 写入 lastFiredAtUtc', () => {
    const svc = new TaskService([], deps(0))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    svc.markFired(t.id, 12345)
    expect(svc.list()[0].lastFiredAtUtc).toBe(12345)
  })

  test('update 重算时间、回到待办并清空 lastFiredAtUtc', () => {
    const svc = new TaskService([], deps(Date.UTC(2026, 5, 18, 0, 0, 0)))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    svc.markFired(t.id, 1)
    const updated = svc.update(t.id, { title: 'y', eventLocalDate: '2026-06-18', eventLocalTime: '16:00', leadMinutes: 5 })
    expect(updated).not.toBeNull()
    expect(updated!.title).toBe('y')
    expect(updated!.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 8, 0, 0)) // 16:00 CST = 08:00 UTC
    expect(updated!.reminderTimeUtc).toBe(Date.UTC(2026, 5, 18, 8, 0, 0) - 5 * 60000)
    expect(updated!.status).toBe('pending')
    expect(updated!.lastFiredAtUtc).toBeNull()
    expect(updated!.id).toBe(t.id) // id 不变
  })

  test('update 不存在的 id 返回 null', () => {
    const svc = new TaskService([], deps(0))
    expect(svc.update('nope', { title: 'y', eventLocalDate: '2026-06-18', eventLocalTime: '16:00' })).toBeNull()
  })

  test('update 把 timezone 同步为当前时区', () => {
    const svc = new TaskService([], deps(0))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    t.timezone = 'America/New_York' // 模拟旧任务时区与当前系统不同
    const updated = svc.update(t.id, { title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    expect(updated!.timezone).toBe('Asia/Shanghai') // deps.timezone
  })
})

describe('TaskService 可空时间与提前量校验', () => {
  test('无日期或时间 → 无时间待办（eventTimeUtc/reminderTimeUtc 为 null）', () => {
    const svc = new TaskService([], deps(0))
    const t = svc.add({ title: '买牛奶' })
    expect(t.eventTimeUtc).toBeNull()
    expect(t.reminderTimeUtc).toBeNull()
    expect(t.status).toBe('pending')
  })

  test('提前量不能超过"现在到事件"的时长，超出则钳制', () => {
    const now = Date.UTC(2026, 5, 18, 2, 0, 0) // 10:00 CST
    const svc = new TaskService([], deps(now))
    // 事件 10:10 CST = 02:10 UTC，距现在 10 分钟；请求提前 16 分钟
    const t = svc.add({ title: '十分钟后提醒我', eventLocalDate: '2026-06-18', eventLocalTime: '10:10', leadMinutes: 16 })
    expect(t.leadMinutes).toBe(10)      // 被钳制到 10
    expect(t.reminderTimeUtc).toBe(now) // 提醒不早于现在
  })

  test('正常提前量不被钳制', () => {
    const now = Date.UTC(2026, 5, 18, 2, 0, 0)
    const svc = new TaskService([], deps(now))
    const t = svc.add({ title: '开会', eventLocalDate: '2026-06-18', eventLocalTime: '11:00', leadMinutes: 10 })
    expect(t.leadMinutes).toBe(10)
    expect(t.reminderTimeUtc).toBe(Date.UTC(2026, 5, 18, 2, 50, 0)) // 11:00 CST − 10min = 02:50 UTC
  })

  test('update 成无时间待办', () => {
    const svc = new TaskService([], deps(0))
    const t = svc.add({ title: 'x', eventLocalDate: '2026-06-18', eventLocalTime: '15:00' })
    const u = svc.update(t.id, { title: 'x' })
    expect(u!.eventTimeUtc).toBeNull()
    expect(u!.reminderTimeUtc).toBeNull()
  })
})
