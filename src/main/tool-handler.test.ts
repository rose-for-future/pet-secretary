// TZ 必须在 import 前设好，chrono 的绝对时间解析才确定。
process.env.TZ = 'Asia/Shanghai'

import { describe, it, expect } from 'vitest'
import { handleTool, formatTodoList, type ToolCtx } from './tool-handler'
import { TaskService } from './task-service'
import type { Task, MemoryItem, Settings } from '../shared/types'

const settings: Settings = { defaultLeadMinutes: 0, snoozeMinutes: 10, soundEnabled: true, muted: false, omniVoice: 'Sunny' }
const NOW = Date.UTC(2026, 5, 20, 2, 0, 0) // 2026-06-20 10:00 CST

function mk(tasks: Task[] = [], memories: MemoryItem[] = []): { ctx: ToolCtx; service: TaskService; memories: MemoryItem[] } {
  let n = 0
  const service = new TaskService(tasks, { now: () => NOW, uuid: () => `t${++n}`, timezone: 'Asia/Shanghai', getSettings: () => settings })
  const ctx: ToolCtx = {
    service, memories, tz: 'Asia/Shanghai', now: () => NOW, uuid: () => `m${++n}`,
    onTasksChanged: () => {}, onMemoriesChanged: () => {}
  }
  return { ctx, service, memories }
}
const call = (ctx: ToolCtx, name: string, args: Record<string, unknown> = {}): Promise<string> => handleTool(name, args, ctx)

describe('create_reminder', () => {
  it('一次性：建一条带时间的待办', async () => {
    const { ctx, service } = mk()
    const msg = await call(ctx, 'create_reminder', { title: '开会', when: '明天下午3点' })
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0].reminderTimeUtc).toBe(Date.UTC(2026, 5, 21, 7, 0, 0)) // 6/21 15:00 CST
    expect(msg).toContain('已创建提醒')
  })
  it('周期：每天晚上8点 → recur.time=20:00', async () => {
    const { ctx, service } = mk()
    const msg = await call(ctx, 'create_reminder', { title: '吃药', when: '晚上8点', repeat: 'daily' })
    expect(service.list()[0].recur).toMatchObject({ freq: 'daily', time: '20:00' })
    expect(msg).toContain('每天 20:00')
  })
  it('裸钟点（每天11点半）分不清上午晚上 → 反问、不建', async () => {
    const { ctx, service } = mk()
    const msg = await call(ctx, 'create_reminder', { title: '吃药', when: '11点半', repeat: 'daily' })
    expect(service.list()).toHaveLength(0) // 没建
    expect(msg).toMatch(/上午.*还是.*晚上/)
  })
})

describe('act_on_tasks（通用删除/完成）', () => {
  const seed = (): Task[] => {
    const svc = new TaskService([], { now: () => NOW, uuid: () => Math.random().toString(36), timezone: 'Asia/Shanghai', getSettings: () => settings })
    svc.add({ title: 'A', eventLocalDate: '2026-06-20', eventLocalTime: '11:00' })
    svc.add({ title: 'B', eventLocalDate: '2026-06-20', eventLocalTime: '12:00' })
    svc.add({ title: 'C', eventLocalDate: '2026-06-20', eventLocalTime: '13:00' })
    return svc.list()
  }
  it('all:true 删除 → 清空', async () => {
    const { ctx, service } = mk(seed())
    const msg = await call(ctx, 'act_on_tasks', { action: 'delete', all: true })
    expect(service.list()).toHaveLength(0)
    expect(msg).toContain('已删除全部 3 条')
  })
  it('按序号删多条', async () => {
    const { ctx, service } = mk(seed())
    await call(ctx, 'act_on_tasks', { action: 'delete', indices: [1, 3] }) // 删 A、C（按提醒时间排序）
    expect(service.list().map((t) => t.title)).toEqual(['B'])
  })
  it('按序号标记完成', async () => {
    const { ctx, service } = mk(seed())
    await call(ctx, 'act_on_tasks', { action: 'complete', indices: [2] })
    expect(service.list().find((t) => t.title === 'B')!.status).toBe('done')
  })
})

describe('同名区分（删错 bug 的回归测试）', () => {
  const sameName = (): Task[] => {
    const svc = new TaskService([], { now: () => NOW, uuid: () => Math.random().toString(36), timezone: 'Asia/Shanghai', getSettings: () => settings })
    svc.add({ title: '小红书', recur: { freq: 'daily', interval: 1, time: '20:00', until: null } }) // 每天
    svc.add({ title: '小红书', eventLocalDate: '2026-06-20', eventLocalTime: '09:00' })             // 一次性
    return svc.list()
  }
  it('清单把周期显示成"每天"、一次性显示日期（分得开）', () => {
    const { service } = mk(sameName())
    const list = formatTodoList(service, 'Asia/Shanghai')
    expect(list).toContain('每天 20:00')
    expect(list).toContain('06-20 09:00')
  })
  it('删一次性那条（序号2），周期那条还在', async () => {
    const { ctx, service } = mk(sameName())
    // 序号按提醒时间排序：09:00 的一次性更早=第1条，每天20:00=第2条
    const list = formatTodoList(service, 'Asia/Shanghai')
    const oneTimeIdx = list.indexOf('06-20 09:00') < list.indexOf('每天 20:00') ? 1 : 2
    await call(ctx, 'act_on_tasks', { action: 'delete', indices: [oneTimeIdx] })
    const left = service.list()
    expect(left).toHaveLength(1)
    expect(left[0].recur).not.toBeNull() // 留下的是每天那条
  })
})

describe('update_reminder', () => {
  it('只改提醒时间，事件时间不动', async () => {
    const { ctx, service } = mk()
    await call(ctx, 'create_reminder', { title: '开会', when: '明天下午3点' })
    const before = service.list()[0]
    const ev = before.eventTimeUtc
    await call(ctx, 'update_reminder', { index: 1, new_reminder_when: '明天下午2点' })
    const after = service.list()[0]
    expect(after.eventTimeUtc).toBe(ev) // 事件没动
    expect(after.reminderTimeUtc).toBe(Date.UTC(2026, 5, 21, 6, 0, 0)) // 提醒改到 6/21 14:00
  })
  it('改周期提醒的时间 → recur.time 真的变了（modify bug 回归）', async () => {
    const { ctx, service } = mk()
    await call(ctx, 'create_reminder', { title: '发小红书', when: '晚上8点', repeat: 'daily' })
    expect(service.list()[0].recur!.time).toBe('20:00')
    const msg = await call(ctx, 'update_reminder', { index: 1, new_when: '晚上11点' })
    expect(service.list()[0].recur!.time).toBe('23:00') // 规则时段改了，不是只挪下一次
    expect(msg).toContain('每天 23:00')
  })
  it('只改标题', async () => {
    const { ctx, service } = mk()
    await call(ctx, 'create_reminder', { title: '开会', when: '明天下午3点' })
    await call(ctx, 'update_reminder', { index: 1, new_title: '喝水' })
    expect(service.list()[0].title).toBe('喝水')
  })

  it('把一次性改成每天 → 是修改、不是新增（变重复 bug 回归）', async () => {
    const { ctx, service } = mk()
    await call(ctx, 'create_reminder', { title: '写快照', when: '晚上11点55分' }) // 一次性 23:55
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0].recur).toBeNull()
    const msg = await call(ctx, 'update_reminder', { index: 1, repeat: 'daily' }) // 没给时间 → 沿用 23:55
    expect(service.list()).toHaveLength(1) // 还是 1 条，没多出来
    expect(service.list()[0].recur).toMatchObject({ freq: 'daily', time: '23:55' })
    expect(msg).toContain('每天 23:55')
  })

  it('取消重复：每天 → 只剩一次', async () => {
    const { ctx, service } = mk()
    await call(ctx, 'create_reminder', { title: '吃药', when: '晚上8点', repeat: 'daily' })
    await call(ctx, 'update_reminder', { index: 1, repeat: 'none' })
    expect(service.list()[0].recur).toBeNull()
  })
})

describe('记忆', () => {
  it('remember → list → forget', async () => {
    const { ctx, memories } = mk()
    await call(ctx, 'remember', { text: '开会习惯提前15分钟', kind: 'preference' })
    expect(memories).toHaveLength(1)
    expect(await call(ctx, 'list_memory')).toContain('开会习惯提前15分钟')
    await call(ctx, 'forget', { index: 1 })
    expect(memories).toHaveLength(0)
  })
})

describe('未知操作', () => {
  it('返回"还不会"而不是假装', async () => {
    const { ctx } = mk()
    expect(await call(ctx, 'send_email', {})).toContain('还不会')
  })
})
