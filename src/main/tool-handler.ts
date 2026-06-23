import type { Task, MemoryItem, RecurRule } from '../shared/types'
import type { AddTaskInput } from '../shared/api'
import type { TaskService } from './task-service'
import { parseWhen } from '../shared/datetime-parse'
import { utcToLocalParts } from '../shared/time'
import { matchByTitle, normalizeTitle } from '../shared/title-match'
import { buildRecurRule, recurLabel, nextOccurrenceUtc } from '../shared/recur'

/**
 * 动作执行层：把"大脑给的工具调用"落到本地数据上，并返回一句给用户听的话。
 * 刻意不依赖 electron / 全局状态 —— 一切外部依赖通过 ToolCtx 注入，
 * 从而可以脱离 Electron 进程做确定性单测（见 tool-handler.test.ts）。
 */
export interface ToolCtx {
  service: TaskService
  memories: MemoryItem[]
  tz: string
  now: () => number
  uuid: () => string
  onTasksChanged: () => void | Promise<void>   // 持久化任务 + 刷新清单窗（测试里可为 no-op）
  onMemoriesChanged: () => void | Promise<void> // 持久化记忆
}

/** 由 标题/自然语言时间/提前量 组装 service.add 的输入；语音建提醒与手动＋共用。 */
export function buildAddInput(
  title: string,
  when: string | undefined,
  leadMinutes: number | undefined,
  tz: string,
  nowMs: number
): AddTaskInput {
  const input: AddTaskInput = { title }
  if (when && String(when).trim()) {
    const parsed = parseWhen(String(when), nowMs, tz)
    if (parsed) {
      const parts = utcToLocalParts(parsed.eventTimeUtc, tz)
      input.eventLocalDate = parts.date
      input.eventLocalTime = parts.time
      input.leadMinutes = leadMinutes ?? parsed.leadMinutes
    }
  } else if (typeof leadMinutes === 'number') {
    input.leadMinutes = leadMinutes
  }
  return input
}

/** 规范的"活动待办"列表：过滤已完成、按提醒时间排序。序号即语音里说的「第N条」。 */
export function activeTasksSorted(service: TaskService): Task[] {
  return service
    .list()
    .filter((t) => t.status !== 'done')
    .sort((a, b) => (a.reminderTimeUtc ?? Infinity) - (b.reminderTimeUtc ?? Infinity))
}

const AMPM_WORDS_RE = /上午|下午|晚上|早上|中午|凌晨|傍晚|夜里|半夜|今晚|今早|清晨|晌午|早晨|深夜/
/** 一个钟点是否分不清上午/晚上（裸钟点：1~12 点又没时段词、也不是相对时间）。 */
export function ambiguousAmPm(whenPhrase: string, hhmm: string): boolean {
  if (/后|马上|待会|稍后|过会|一会/.test(whenPhrase)) return false
  if (AMPM_WORDS_RE.test(whenPhrase)) return false
  const h = Number(hhmm.split(':')[0])
  return h >= 1 && h <= 12
}

function whenLabel(t: Task, tz: string): string {
  // 周期提醒显示重复规则（每天 20:00），不显示"下一次的具体日期"——否则跟同名一次性待办分不清、会删错。
  if (t.recur) return recurLabel(t.recur)
  return t.reminderTimeUtc != null ? utcToLocalParts(t.reminderTimeUtc, tz).label : '无时间'
}

function numberedLines(tasks: Task[], active: Task[], tz: string): string {
  return tasks.map((t) => `第${active.indexOf(t) + 1}条「${t.title}」（${whenLabel(t, tz)}）`).join('；')
}

/** 给文字大脑看的当前待办清单（带序号）。 */
export function formatTodoList(service: TaskService, tz: string): string {
  const active = activeTasksSorted(service)
  return active.length === 0 ? '（当前没有待办）' : numberedLines(active, active, tz)
}

/** 给文字大脑看的长期记忆（带序号）。 */
export function formatMemory(memories: MemoryItem[]): string {
  return memories.length === 0 ? '（暂无）' : memories.map((m, i) => `${i + 1}. ${m.text}`).join('；')
}

/** 按 序号(index) 或 标题(title) 定位一条待办；定位不到/多条返回澄清话术。 */
function locateTask(active: Task[], a: { title?: string; index?: number }, verb: string, tz: string): { task: Task } | { ask: string } {
  const idx = typeof a.index === 'number' ? Math.floor(a.index) : NaN
  if (Number.isFinite(idx)) {
    if (idx >= 1 && idx <= active.length) return { task: active[idx - 1] }
    return { ask: `序号 ${idx} 超出范围，现在只有 ${active.length} 条待办。要${verb}哪一条？` + numberedLines(active, active, tz) + '。' }
  }
  const q = String(a.title ?? '').trim()
  if (!q) {
    if (active.length === 1) return { task: active[0] }
    return { ask: `有 ${active.length} 条待办，要${verb}哪一条？` + numberedLines(active, active, tz) + '。请说第几条。' }
  }
  const matches = matchByTitle(active, q)
  if (matches.length === 0) return { ask: `没找到叫「${q}」的待办。当前待办：` + numberedLines(active, active, tz) + '。要操作哪条？直接说第几条也行。' }
  if (matches.length === 1) return { task: matches[0] }
  return { ask: `有 ${matches.length} 条都符合：` + numberedLines(matches, active, tz) + `。你要${verb}第几条？` }
}

/** 执行一个工具调用，返回给用户听的话。所有副作用通过 ctx 注入，可脱离 Electron 单测。 */
export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const { service, memories, tz } = ctx
  const nowMs = ctx.now()

  if (name === 'create_reminder') {
    const a = args as { title?: string; when?: string; lead_minutes?: number; repeat?: string; repeat_weekday?: number; repeat_monthday?: number }
    const title = String(a.title ?? '').trim()
    if (!title) return '没听清要记什么事喵，再说一次？'
    const whenStr = String(a.when ?? '').trim()
    const repeat = String(a.repeat ?? '').trim()

    if (repeat && repeat !== 'none') {
      const parsed = whenStr ? parseWhen(whenStr, nowMs, tz) : null
      if (!parsed) return `「${title}」要重复提醒的话，得告诉我几点呀，比如「每天晚上8点」。`
      const hhmm = utcToLocalParts(parsed.eventTimeUtc, tz).time
      if (ambiguousAmPm(whenStr, hhmm)) {
        const h12 = Number(hhmm.split(':')[0]); const mm = hhmm.split(':')[1]
        return `「${title}」是每天上午${h12}点${mm === '00' ? '' : mm}，还是晚上${h12}点${mm === '00' ? '' : mm}呀？`
      }
      const rule = buildRecurRule(repeat, a.repeat_weekday, a.repeat_monthday, hhmm)
      if (!rule) {
        if (repeat === 'weekly') return `「${title}」要每周几提醒呀？（比如每周一）`
        if (repeat === 'monthly') return `「${title}」要每月几号提醒呀？`
        return `这个重复方式我没听清，换个说法？比如「每天X点」「每周一X点」。`
      }
      const task = service.add({ title, recur: rule })
      await ctx.onTasksChanged()
      return `好，已设${recurLabel(rule)}的提醒：「${task.title}」。`
    }

    const task = service.add(buildAddInput(title, a.when, a.lead_minutes, tz, nowMs))
    await ctx.onTasksChanged()
    if (task.reminderTimeUtc != null) return `已创建提醒：「${task.title}」，将在 ${utcToLocalParts(task.reminderTimeUtc, tz).label} 提醒。`
    if (whenStr) return `记下了「${task.title}」，不过没太听懂「${whenStr}」是什么时间，你可以说「把${task.title}改到几点」来补上。`
    return `已记下待办：「${task.title}」（没有具体时间）。`
  }

  if (name === 'list_reminders') {
    const active = activeTasksSorted(service)
    if (active.length === 0) return '现在没有待办。'
    return `当前待办共 ${active.length} 条：` + numberedLines(active, active, tz) + '。'
  }

  if (name === 'act_on_tasks') {
    const a = args as { action?: string; indices?: number[]; all?: boolean }
    const action = a.action === 'complete' ? 'complete' : 'delete'
    const verb = action === 'delete' ? '删除' : '完成'
    const active = activeTasksSorted(service)
    if (active.length === 0) return '现在没有待办，没什么可操作的。'

    let targets: Task[]
    if (a.all) {
      targets = action === 'delete' ? service.list().slice() : active.slice()
    } else {
      const idxs = Array.isArray(a.indices) ? a.indices.map((n) => Math.floor(n)) : []
      const valid = [...new Set(idxs)].filter((n) => n >= 1 && n <= active.length)
      if (valid.length === 0) return `要${verb}哪条呀？说第几条、或说"全部"都行。当前待办：` + numberedLines(active, active, tz) + '。'
      targets = valid.map((n) => active[n - 1])
    }
    if (targets.length === 0) return `没有可${verb}的待办。`

    for (const t of targets) {
      if (action === 'delete') service.remove(t.id)
      else service.complete(t.id)
    }
    await ctx.onTasksChanged()
    if (a.all) return `已${verb}全部 ${targets.length} 条待办。`
    if (targets.length === 1) return `已${verb}：「${targets[0].title}」。`
    return `已${verb} ${targets.length} 条：${targets.map((t) => `「${t.title}」`).join('、')}。`
  }

  if (name === 'update_reminder') {
    const a = args as {
      title?: string; index?: number
      new_when?: string; new_reminder_when?: string; new_lead_minutes?: number; new_title?: string
      repeat?: string; repeat_weekday?: number; repeat_monthday?: number
    }
    const active = activeTasksSorted(service)
    if (active.length === 0) return '现在没有待办，没什么可改的。'
    const loc = locateTask(active, a, '修改', tz)
    if ('ask' in loc) return loc.ask
    const t = loc.task
    const newTitleConv = String(a.new_title ?? '').trim()
    const repeat = String(a.repeat ?? '').trim()

    // 把"一次性 ↔ 周期"互转（修改现有这条，绝不新建）
    if (repeat && repeat !== 'none') {
      const timePhrase = String(a.new_reminder_when ?? '').trim() || String(a.new_when ?? '').trim()
      let hhmm: string
      if (timePhrase) {
        const parsed = parseWhen(timePhrase, nowMs, tz)
        if (!parsed) return `没太听懂「${timePhrase}」是什么时间，换个说法？`
        hhmm = utcToLocalParts(parsed.eventTimeUtc, tz).time
        if (ambiguousAmPm(timePhrase, hhmm)) {
          const h12 = Number(hhmm.split(':')[0]); const mm = hhmm.split(':')[1]
          return `要改成每天上午${h12}点${mm === '00' ? '' : mm}，还是晚上${h12}点${mm === '00' ? '' : mm}呀？`
        }
      } else if (t.recur) {
        hhmm = t.recur.time // 已是周期、只改频率
      } else if (t.reminderTimeUtc != null) {
        hhmm = utcToLocalParts(t.reminderTimeUtc, tz).time // 一次性→周期：沿用它原本的时段
      } else {
        return `「${t.title}」要每天几点提醒呀？`
      }
      const rule = buildRecurRule(repeat, a.repeat_weekday, a.repeat_monthday, hhmm)
      if (!rule) {
        if (repeat === 'weekly') return `「${t.title}」要每周几提醒呀？`
        if (repeat === 'monthly') return `「${t.title}」要每月几号提醒呀？`
        return `这个重复方式我没听清，换个说法？`
      }
      const next = nextOccurrenceUtc(rule, nowMs, tz)
      const up = service.patch(t.id, { title: newTitleConv || undefined, recur: rule, eventTimeUtc: next, reminderTimeUtc: next })!
      await ctx.onTasksChanged()
      return `好，已把「${up.title}」改成 ${recurLabel(rule)}。`
    }
    // 取消重复：周期 → 只提醒下一次那一回
    if (repeat === 'none' && t.recur) {
      const up = service.patch(t.id, { title: newTitleConv || undefined, recur: null })!
      await ctx.onTasksChanged()
      const label = up.reminderTimeUtc != null ? utcToLocalParts(up.reminderTimeUtc, tz).label : '原时间'
      return `好，「${up.title}」改成只提醒一次（${label}），不再每天重复。`
    }

    // 周期提醒：改时间 = 改重复规则的时段（连下一次一起重算），不是只挪下一次
    if (t.recur) {
      const rp: { title?: string; recur?: RecurRule; eventTimeUtc?: number | null; reminderTimeUtc?: number | null } = {}
      const done: string[] = []
      const nt = String(a.new_title ?? '').trim()
      if (nt && nt !== t.title) { rp.title = nt; done.push('内容') }
      const timePhrase = String(a.new_reminder_when ?? '').trim() || String(a.new_when ?? '').trim()
      if (timePhrase) {
        const parsed = parseWhen(timePhrase, nowMs, tz)
        if (!parsed) {
          if (done.length === 0) return `没太听懂「${timePhrase}」是什么时间，「${t.title}」没动，换个说法？`
        } else {
          const hhmm = utcToLocalParts(parsed.eventTimeUtc, tz).time
          if (ambiguousAmPm(timePhrase, hhmm)) {
            const h12 = Number(hhmm.split(':')[0]); const mm = hhmm.split(':')[1]
            return `要改成每天上午${h12}点${mm === '00' ? '' : mm}，还是晚上${h12}点${mm === '00' ? '' : mm}呀？`
          }
          const newRule: RecurRule = { ...t.recur, time: hhmm }
          const next = nextOccurrenceUtc(newRule, nowMs, tz)
          rp.recur = newRule; rp.eventTimeUtc = next; rp.reminderTimeUtc = next
          done.push('时间')
        }
      }
      if (done.length === 0) return `没听清要把「${t.title}」改成什么，再说一次？`
      const up = service.patch(t.id, rp)!
      await ctx.onTasksChanged()
      return `好，已把「${up.title}」改成 ${recurLabel(up.recur!)}。`
    }

    const patch: { title?: string; eventTimeUtc?: number | null; reminderTimeUtc?: number | null; leadMinutes?: number } = {}
    const changed: string[] = []
    let timeMissed: string | null = null

    const newTitle = String(a.new_title ?? '').trim()
    if (newTitle && newTitle !== t.title) { patch.title = newTitle; changed.push('内容') }

    const w = String(a.new_when ?? '').trim()
    if (w) {
      const parsed = parseWhen(w, nowMs, tz)
      if (parsed) {
        const lead = parsed.leadMinutes || t.leadMinutes || 0
        patch.eventTimeUtc = parsed.eventTimeUtc
        patch.leadMinutes = lead
        patch.reminderTimeUtc = parsed.eventTimeUtc - lead * 60000
        changed.push('时间')
      } else timeMissed = w
    }
    if (typeof a.new_lead_minutes === 'number') {
      const baseEvent = patch.eventTimeUtc ?? t.eventTimeUtc
      if (baseEvent != null) {
        const lead = Math.max(0, Math.floor(a.new_lead_minutes))
        patch.leadMinutes = lead
        patch.reminderTimeUtc = baseEvent - lead * 60000
        changed.push('提前量')
      }
    }
    const rw = String(a.new_reminder_when ?? '').trim()
    if (rw) {
      const parsed = parseWhen(rw, nowMs, tz)
      if (parsed) {
        patch.reminderTimeUtc = parsed.eventTimeUtc
        const baseEvent = patch.eventTimeUtc ?? t.eventTimeUtc
        if (baseEvent != null) patch.leadMinutes = Math.max(0, Math.round((baseEvent - parsed.eventTimeUtc) / 60000))
        changed.push('提醒时间')
      } else timeMissed = rw
    }

    if (changed.length === 0) {
      if (timeMissed) return `没太听懂「${timeMissed}」是什么时间，「${t.title}」没动，换个说法再说一次？`
      return `没听清要把「${t.title}」改成什么，再说一次？`
    }

    const updated = service.patch(t.id, patch)!
    await ctx.onTasksChanged()
    const ev = updated.eventTimeUtc != null ? utcToLocalParts(updated.eventTimeUtc, tz).label : null
    const rem = updated.reminderTimeUtc != null ? utcToLocalParts(updated.reminderTimeUtc, tz).label : null
    let msg = `已修改：「${updated.title}」`
    if (changed.some((c) => c !== '内容')) {
      if (rem && ev && rem !== ev) msg += `，事件 ${ev}、提醒 ${rem}`
      else if (rem) msg += `，提醒时间 ${rem}`
      else if (ev) msg += `，时间 ${ev}`
    }
    msg += '。'
    if (timeMissed) msg += `（不过「${timeMissed}」这个时间没听懂，那部分没改）`
    return msg
  }

  if (name === 'remember') {
    const a = args as { text?: string; kind?: string }
    const text = String(a.text ?? '').trim()
    if (!text) return '没听清要记住什么喵，再说一次？'
    const dup = memories.find((m) => normalizeTitle(m.text) === normalizeTitle(text))
    if (dup) return `这个我已经记着啦：「${dup.text}」。`
    const kind = (['preference', 'fact', 'habit'] as const).includes(a.kind as MemoryItem['kind']) ? (a.kind as MemoryItem['kind']) : 'fact'
    memories.push({ id: ctx.uuid(), text, kind, createdAt: new Date(nowMs).toISOString() })
    await ctx.onMemoriesChanged()
    return `好的，记住啦：「${text}」。`
  }

  if (name === 'list_memory') {
    if (memories.length === 0) return '我还没记住关于你的事呢，你可以说「记住…」让我记。'
    return '关于你我记得：' + memories.map((m, i) => `第${i + 1}条 ${m.text}`).join('；') + '。'
  }

  if (name === 'forget') {
    const a = args as { text?: string; index?: number }
    if (memories.length === 0) return '我还没记住什么呢。'
    const idx = typeof a.index === 'number' ? Math.floor(a.index) : NaN
    if (Number.isFinite(idx)) {
      if (idx >= 1 && idx <= memories.length) {
        const m = memories.splice(idx - 1, 1)[0]
        await ctx.onMemoriesChanged()
        return `好，忘掉了：「${m.text}」。`
      }
      return `序号 ${idx} 超出范围，我现在记着 ${memories.length} 条。`
    }
    const q = normalizeTitle(String(a.text ?? ''))
    if (!q) return '要忘掉哪条？说个关键词或第几条都行。'
    const matches = memories.filter((m) => { const n = normalizeTitle(m.text); return n.includes(q) || q.includes(n) })
    if (matches.length === 0) return `没找到跟「${String(a.text)}」有关的记忆。`
    if (matches.length > 1) return `有好几条都沾边（${matches.map((m) => m.text).join('、')}），说得具体点或说第几条？`
    const m = matches[0]
    memories.splice(memories.indexOf(m), 1)
    await ctx.onMemoriesChanged()
    return `好，忘掉了：「${m.text}」。`
  }

  return '我还不会这个操作喵。'
}
