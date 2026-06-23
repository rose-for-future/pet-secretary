import { DateTime } from 'luxon'
import type { RecurRule } from './types'

/** 由大脑给的结构化字段拼出重复规则；拼不出（缺周几/几号）返回 null。 */
export function buildRecurRule(
  repeat: string,
  weekday: number | undefined,
  monthday: number | undefined,
  time: string
): RecurRule | null {
  if (repeat === 'daily') return { freq: 'daily', interval: 1, time, until: null }
  if (repeat === 'weekdays') return { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5], time, until: null }
  if (repeat === 'weekly' && typeof weekday === 'number' && weekday >= 1 && weekday <= 7) {
    return { freq: 'weekly', interval: 1, byWeekday: [weekday], time, until: null }
  }
  if (repeat === 'monthly' && typeof monthday === 'number' && monthday >= 1 && monthday <= 31) {
    return { freq: 'monthly', interval: 1, byMonthday: monthday, time, until: null }
  }
  return null
}

/** 算出从 fromMs 起、严格在未来的下一个匹配时刻（UTC 毫秒）。time 为本地「HH:mm」。 */
export function nextOccurrenceUtc(rule: RecurRule, fromMs: number, timezone: string): number {
  const [h, m] = rule.time.split(':').map(Number)
  const from = DateTime.fromMillis(fromMs, { zone: timezone })
  const at = (d: DateTime): DateTime => d.set({ hour: h, minute: m, second: 0, millisecond: 0 })

  if (rule.freq === 'daily') {
    let cand = at(from)
    if (cand.toMillis() <= fromMs) cand = cand.plus({ days: 1 })
    return cand.toMillis()
  }

  if (rule.freq === 'weekly') {
    const days = rule.byWeekday && rule.byWeekday.length ? rule.byWeekday : [from.weekday]
    for (let i = 0; i <= 7; i++) {
      const cand = at(from.plus({ days: i }))
      if (days.includes(cand.weekday) && cand.toMillis() > fromMs) return cand.toMillis()
    }
    return at(from.plus({ days: 7 })).toMillis() // 理论到不了
  }

  // monthly
  const md = rule.byMonthday ?? from.day
  for (let i = 0; i <= 12; i++) {
    const base = from.plus({ months: i })
    if (md > (base.daysInMonth ?? 31)) continue // 跳过没有这天的月份（如 31 号）
    const cand = at(base.set({ day: md }))
    if (cand.toMillis() > fromMs) return cand.toMillis()
  }
  return at(from.plus({ months: 1 })).toMillis()
}

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 人类可读的重复描述，用于清单显示与语音播报，如「每天 20:00」「工作日 09:00」「每月5号 10:00」。 */
export function recurLabel(rule: RecurRule): string {
  const t = rule.time
  if (rule.freq === 'daily') return `每天 ${t}`
  if (rule.freq === 'weekly') {
    const days = rule.byWeekday ?? []
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return `工作日 ${t}`
    if (days.length === 2 && days.includes(6) && days.includes(7)) return `每周末 ${t}`
    if (days.length) return '每' + days.map((d) => WEEKDAY_CN[d - 1]).join('、') + ` ${t}`
    return `每周 ${t}`
  }
  return `每月${rule.byMonthday}号 ${t}`
}
