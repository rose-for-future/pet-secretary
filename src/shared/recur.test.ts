import { describe, it, expect } from 'vitest'
import { buildRecurRule, nextOccurrenceUtc, recurLabel } from './recur'
import type { RecurRule } from './types'

const TZ = 'Asia/Shanghai'
// 参考时刻：2026-06-19(周五) 10:00 CST = 2026-06-19T02:00:00Z
const now = Date.UTC(2026, 5, 19, 2, 0, 0)

describe('buildRecurRule', () => {
  it('daily', () => expect(buildRecurRule('daily', undefined, undefined, '20:00')).toEqual({ freq: 'daily', interval: 1, time: '20:00', until: null }))
  it('weekly 需要 weekday', () => {
    expect(buildRecurRule('weekly', 1, undefined, '09:00')).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1], time: '09:00', until: null })
    expect(buildRecurRule('weekly', undefined, undefined, '09:00')).toBeNull()
  })
  it('weekdays → 周一到周五', () => expect(buildRecurRule('weekdays', undefined, undefined, '09:00')!.byWeekday).toEqual([1, 2, 3, 4, 5]))
  it('monthly 需要 monthday', () => {
    expect(buildRecurRule('monthly', undefined, 5, '10:00')!.byMonthday).toBe(5)
    expect(buildRecurRule('monthly', undefined, undefined, '10:00')).toBeNull()
  })
})

describe('nextOccurrenceUtc', () => {
  it('每天：当天时间未过 → 今天', () => {
    const r: RecurRule = { freq: 'daily', interval: 1, time: '20:00', until: null }
    expect(nextOccurrenceUtc(r, now, TZ)).toBe(Date.UTC(2026, 5, 19, 12, 0, 0)) // 今天 20:00 CST
  })
  it('每天：当天时间已过 → 明天', () => {
    const r: RecurRule = { freq: 'daily', interval: 1, time: '08:00', until: null }
    expect(nextOccurrenceUtc(r, now, TZ)).toBe(Date.UTC(2026, 5, 20, 0, 0, 0)) // 明天 08:00 CST
  })
  it('每周一：从周五看 → 下周一', () => {
    const r: RecurRule = { freq: 'weekly', interval: 1, byWeekday: [1], time: '09:00', until: null }
    expect(nextOccurrenceUtc(r, now, TZ)).toBe(Date.UTC(2026, 5, 22, 1, 0, 0)) // 6/22 周一 09:00 CST
  })
  it('每月5号：本月5号已过 → 下月5号', () => {
    const r: RecurRule = { freq: 'monthly', interval: 1, byMonthday: 5, time: '10:00', until: null }
    expect(nextOccurrenceUtc(r, now, TZ)).toBe(Date.UTC(2026, 6, 5, 2, 0, 0)) // 7/5 10:00 CST
  })
})

describe('recurLabel', () => {
  it('每天/工作日/每周一/每月', () => {
    expect(recurLabel({ freq: 'daily', interval: 1, time: '20:00', until: null })).toBe('每天 20:00')
    expect(recurLabel({ freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5], time: '09:00', until: null })).toBe('工作日 09:00')
    expect(recurLabel({ freq: 'weekly', interval: 1, byWeekday: [1], time: '09:00', until: null })).toBe('每周一 09:00')
    expect(recurLabel({ freq: 'monthly', interval: 1, byMonthday: 5, time: '10:00', until: null })).toBe('每月5号 10:00')
  })
})
