/**
 * 大脑 eval（不在 npm test 里跑；用 `npm run eval` 手动跑）。
 * 真打 Qwen API，验证"听懂的文字 → 调对工具"。非确定性 + 花一点点 token，
 * 所以是按需自测、不进 CI。每次改完大脑/提示词，我先跑这个，绿了再给你测语音。
 * 需要 ~/Library/Application Support/pet-secretary/secrets.json 里的 dashscopeApiKey。
 */
import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { think } from './brain'

const userDataDir = join(homedir(), 'Library', 'Application Support', 'pet-secretary')
const now = '2026年6月20日 星期五 22:00'
const base = { now, memory: '（暂无）', history: [] as { role: 'user' | 'assistant'; content: string }[] }
const LIST = '第1条「开会」（明天 14:00）；第2条「买菜」（无时间）；第3条「写小红书」（每天 20:00）'

async function tool(transcript: string, todoList = '（当前没有待办）'): Promise<{ name: string | null; args: Record<string, unknown> }> {
  const out = await think(userDataDir, transcript, { ...base, todoList })
  return { name: out.tool?.name ?? null, args: out.tool?.args ?? {} }
}

describe('大脑 eval：意图 → 工具（真 API，非确定性）', () => {
  it('加提醒 → create_reminder', async () => {
    expect((await tool('提醒我明天下午3点开会')).name).toBe('create_reminder')
  }, 20000)

  it('每天X点 → create_reminder + repeat daily', async () => {
    const r = await tool('每天晚上8点提醒我吃药')
    expect(r.name).toBe('create_reminder')
    expect(r.args.repeat).toBe('daily')
  }, 20000)

  it('全部删除 → act_on_tasks all', async () => {
    const r = await tool('把待办全部删掉', LIST)
    expect(r.name).toBe('act_on_tasks')
    expect(r.args.action).toBe('delete')
    expect(r.args.all).toBe(true)
  }, 20000)

  it('删第2条 → act_on_tasks indices 含 2', async () => {
    const r = await tool('删第二条', LIST)
    expect(r.name).toBe('act_on_tasks')
    expect((r.args.indices as number[]) ?? []).toContain(2)
  }, 20000)

  it('问待办 → list_reminders', async () => {
    expect((await tool('我有哪些待办', LIST)).name).toBe('list_reminders')
  }, 20000)

  it('改时间 → update_reminder', async () => {
    expect((await tool('把开会改到明天上午十点', LIST)).name).toBe('update_reminder')
  }, 20000)

  it('记偏好 → remember', async () => {
    expect((await tool('记住我开会都提前15分钟提醒')).name).toBe('remember')
  }, 20000)

  it('闲聊 → 不调工具', async () => {
    expect((await tool('哈喽呀今天天气不错')).name).toBeNull()
  }, 20000)

  it('做不到的事（发邮件）→ 不调工具（应老实拒绝，不假装）', async () => {
    expect((await tool('帮我发一封邮件给老板', LIST)).name).toBeNull()
  }, 20000)
})
