import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Store } from './store'
import type { Task } from '../shared/types'

function sampleTask(id: string): Task {
  return {
    id, title: '开会', note: '带合同',
    eventTimeUtc: 1000000, timezone: 'Asia/Shanghai', leadMinutes: 10,
    reminderTimeUtc: 400000, recur: null, kind: 'single', seriesId: null,
    nextEventTimeUtc: null, status: 'pending', snoozeUntilUtc: null,
    source: 'keyboard', nagCount: 0, lastFiredAtUtc: null,
    createdAt: '2026-06-18T00:00:00.000Z', updatedAt: '2026-06-18T00:00:00.000Z'
  }
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pet-store-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('Store', () => {
  test('文件不存在时 loadTasks 返回空数组', async () => {
    const s = new Store(dir)
    expect(await s.loadTasks()).toEqual([])
  })

  test('saveTasks 后 loadTasks 往返一致', async () => {
    const s = new Store(dir)
    const tasks = [sampleTask('a'), sampleTask('b')]
    await s.saveTasks(tasks)
    expect(await s.loadTasks()).toEqual(tasks)
  })

  test('第二次保存后生成 .bak 备份', async () => {
    const s = new Store(dir)
    await s.saveTasks([sampleTask('a')])
    await s.saveTasks([sampleTask('a'), sampleTask('b')])
    await expect(access(join(dir, 'tasks.json.bak'))).resolves.toBeUndefined()
  })

  test('主文件损坏时从 .bak 回退', async () => {
    const s = new Store(dir)
    await s.saveTasks([sampleTask('a')])           // 写入有效内容
    await s.saveTasks([sampleTask('a')])           // 再写一次 → .bak 也是有效内容
    await writeFile(join(dir, 'tasks.json'), '{ 坏掉的 json', 'utf8') // 弄坏主文件
    expect(await s.loadTasks()).toEqual([sampleTask('a')])
  })

  test('memories 不存在时返回空，保存后往返一致', async () => {
    const s = new Store(dir)
    expect(await s.loadMemories()).toEqual([])
    const mems = [
      { id: 'm1', text: '开会习惯提前15分钟提醒', kind: 'preference' as const, createdAt: '2026-06-19T00:00:00.000Z' },
      { id: 'm2', text: '称呼用户为小李', kind: 'fact' as const, createdAt: '2026-06-19T00:00:00.000Z' }
    ]
    await s.saveMemories(mems)
    expect(await s.loadMemories()).toEqual(mems)
  })

  test('settings 默认值与往返', async () => {
    const s = new Store(dir)
    const def = await s.loadSettings()
    expect(def.defaultLeadMinutes).toBe(0)
    await s.saveSettings({ defaultLeadMinutes: 20, snoozeMinutes: 5, soundEnabled: false, muted: true, omniVoice: 'Ethan' })
    expect(await s.loadSettings()).toEqual({ defaultLeadMinutes: 20, snoozeMinutes: 5, soundEnabled: false, muted: true, omniVoice: 'Ethan' })
  })
})
