import { describe, test, expect } from 'vitest'
import { ReminderEngine } from './reminder-engine'
import type { Task } from '../shared/types'

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'x', title: 't', eventTimeUtc: 2000, timezone: 'Asia/Shanghai', leadMinutes: 0,
    reminderTimeUtc: 1000, recur: null, kind: 'single', seriesId: null, nextEventTimeUtc: null,
    status: 'pending', snoozeUntilUtc: null, source: 'keyboard', nagCount: 0,
    lastFiredAtUtc: null, createdAt: '', updatedAt: '', ...over
  }
}

describe('ReminderEngine.tick', () => {
  test('已到期且未触发过的 pending 任务会触发，并被标记', () => {
    const tasks = [makeTask({ id: 'a', reminderTimeUtc: 1000 })]
    const fired: string[] = []
    const engine = new ReminderEngine(
      () => tasks,
      (t) => fired.push(t.id),
      (id, at) => { tasks.find((x) => x.id === id)!.lastFiredAtUtc = at },
      () => 1500
    )
    engine.tick()
    expect(fired).toEqual(['a'])
    expect(tasks[0].lastFiredAtUtc).toBe(1500)
  })

  test('未到期任务不触发', () => {
    const tasks = [makeTask({ id: 'a', reminderTimeUtc: 5000 })]
    const fired: string[] = []
    const engine = new ReminderEngine(() => tasks, (t) => fired.push(t.id), () => {}, () => 1500)
    engine.tick()
    expect(fired).toEqual([])
  })

  test('已触发过（lastFiredAtUtc 非空）不重复触发', () => {
    const tasks = [makeTask({ id: 'a', reminderTimeUtc: 1000, lastFiredAtUtc: 1200 })]
    const fired: string[] = []
    const engine = new ReminderEngine(() => tasks, (t) => fired.push(t.id), () => {}, () => 1500)
    engine.tick()
    expect(fired).toEqual([])
  })

  test('非 pending（done）不触发', () => {
    const tasks = [makeTask({ id: 'a', reminderTimeUtc: 1000, status: 'done' })]
    const fired: string[] = []
    const engine = new ReminderEngine(() => tasks, (t) => fired.push(t.id), () => {}, () => 1500)
    engine.tick()
    expect(fired).toEqual([])
  })

  test('reminderTimeUtc 为 null（无时间待办）不触发', () => {
    const tasks = [makeTask({ id: 'a', reminderTimeUtc: null })]
    const fired: string[] = []
    const engine = new ReminderEngine(() => tasks, (t) => fired.push(t.id), () => {}, () => 1500)
    engine.tick()
    expect(fired).toEqual([])
  })
})
