// IMPORTANT: TZ must be set before any imports so chrono-node absolute-time
// parsing (e.g. "明天下午三点") is deterministic across environments.
process.env.TZ = 'Asia/Shanghai'

import { describe, it, expect } from 'vitest'
import { parseWhen } from './datetime-parse'

// Fixed reference: 2026-06-18 10:00:00 Asia/Shanghai = 2026-06-18T02:00:00.000Z
const now = Date.UTC(2026, 5, 18, 2, 0, 0)

// ─── Relative times (timezone-independent) ───────────────────────────────────

describe('relative time phrases', () => {
  it('10分钟后提醒我 → eventTimeUtc = now + 10min, leadMinutes = 0', () => {
    const result = parseWhen('10分钟后提醒我', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.eventTimeUtc).toBe(now + 10 * 60_000)
    expect(result!.leadMinutes).toBe(0)
  })

  it('2小时后 → eventTimeUtc = now + 2h, leadMinutes = 0', () => {
    const result = parseWhen('2小时后', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.eventTimeUtc).toBe(now + 2 * 3_600_000)
    expect(result!.leadMinutes).toBe(0)
  })

  it('十分钟后 (Chinese numeral) → eventTimeUtc = now + 10min', () => {
    // Confirmed via probe: chrono.zh DOES parse Chinese numerals like 十分钟后
    const result = parseWhen('十分钟后', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.eventTimeUtc).toBe(now + 10 * 60_000)
    expect(result!.leadMinutes).toBe(0)
  })
})

// ─── Absolute times (require TZ=Asia/Shanghai to be deterministic) ───────────

describe('absolute time phrases', () => {
  it('明天下午三点 → 2026-06-19T07:00:00.000Z (= 15:00 CST)', () => {
    // 2026-06-19 15:00:00 Asia/Shanghai = UTC+8 → 2026-06-19T07:00:00.000Z
    const expected = Date.UTC(2026, 5, 19, 7, 0, 0)
    const result = parseWhen('明天下午三点', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.eventTimeUtc).toBe(expected)
    expect(result!.leadMinutes).toBe(0)
  })

  it('下周一上午十点 → 2026-06-22T02:00:00.000Z (= 10:00 CST)', () => {
    // 2026-06-22 10:00:00 Asia/Shanghai = 2026-06-22T02:00:00.000Z
    const expected = Date.UTC(2026, 5, 22, 2, 0, 0)
    const result = parseWhen('下周一上午十点', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.eventTimeUtc).toBe(expected)
    expect(result!.leadMinutes).toBe(0)
  })
})

// ─── 午夜说法（chrono 处理不好，需归一化）─────────────────────────────────────
describe('午夜 / 24点 归一化', () => {
  // now = 2026-06-18 10:00 CST，次日零点 = 2026-06-19 00:00 CST = 2026-06-18T16:00:00Z
  const nextMidnight = Date.UTC(2026, 5, 18, 16, 0, 0)
  for (const phrase of ['今天二十四点', '二十四点', '24点', '今天24点', '晚上12点', '今晚12点', '今天晚上12点', '半夜12点']) {
    it(`${phrase} → 次日0点`, () => {
      const r = parseWhen(phrase, now, 'Asia/Shanghai')
      expect(r, phrase).not.toBeNull()
      expect(r!.eventTimeUtc, phrase).toBe(nextMidnight)
    })
  }
  it('中午12点 仍是当天中午（不要误判成午夜）', () => {
    // 2026-06-18 12:00 CST = 2026-06-18T04:00:00Z
    const r = parseWhen('中午12点', now, 'Asia/Shanghai')
    expect(r).not.toBeNull()
    expect(r!.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 4, 0, 0))
  })
})

describe('时段词 12 小时制换算', () => {
  // now = 2026-06-18 10:00 CST
  it('傍晚6点 → 当天 18:00（chrono 本来不认傍晚）', () => {
    // 2026-06-18 18:00 CST = 2026-06-18T10:00:00Z
    const r = parseWhen('傍晚6点', now, 'Asia/Shanghai')
    expect(r).not.toBeNull()
    expect(r!.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 10, 0, 0))
  })
  it('晚上11点 → 当天 23:00', () => {
    // 2026-06-18 23:00 CST = 2026-06-18T15:00:00Z
    const r = parseWhen('晚上11点', now, 'Asia/Shanghai')
    expect(r).not.toBeNull()
    expect(r!.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 15, 0, 0))
  })
  it('下午三点 → 当天 15:00', () => {
    const r = parseWhen('下午三点', now, 'Asia/Shanghai')
    expect(r).not.toBeNull()
    expect(r!.eventTimeUtc).toBe(Date.UTC(2026, 5, 18, 7, 0, 0))
  })
})

// ─── Lead extraction ──────────────────────────────────────────────────────────

describe('lead extraction', () => {
  it('提前N分钟 → leadMinutes = N', () => {
    const result = parseWhen('明天下午三点开会提前20分钟', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.leadMinutes).toBe(20)
    // Event time: 2026-06-19 15:00 CST
    expect(result!.eventTimeUtc).toBe(Date.UTC(2026, 5, 19, 7, 0, 0))
  })

  it('提前N分钟 variant with 分 (no 钟) → leadMinutes = N', () => {
    const result = parseWhen('明天下午三点提前5分', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.leadMinutes).toBe(5)
  })

  it('提前半小时 → leadMinutes = 30', () => {
    const result = parseWhen('明天下午三点开会，提前半小时', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.leadMinutes).toBe(30)
    // Event time should still be 明天下午三点 = 2026-06-19 15:00 CST
    expect(result!.eventTimeUtc).toBe(Date.UTC(2026, 5, 19, 7, 0, 0))
  })

  it('提前N个小时 → leadMinutes = N * 60', () => {
    const result = parseWhen('明天下午三点开会提前1个小时', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.leadMinutes).toBe(60)
  })

  it('提前N小时 (no 个) → leadMinutes = N * 60', () => {
    const result = parseWhen('明天下午三点提前2小时提醒我', now, 'Asia/Shanghai')
    expect(result).not.toBeNull()
    expect(result!.leadMinutes).toBe(120)
  })
})

// ─── Null cases ───────────────────────────────────────────────────────────────

describe('null cases', () => {
  it('no date/time in text → null', () => {
    expect(parseWhen('随便记一笔没有时间', now, 'Asia/Shanghai')).toBeNull()
  })

  it('empty string → null', () => {
    expect(parseWhen('', now, 'Asia/Shanghai')).toBeNull()
  })

  it('lead-only text (no event time) → null', () => {
    // After stripping "提前半小时", nothing dateable remains
    expect(parseWhen('提前半小时', now, 'Asia/Shanghai')).toBeNull()
  })
})
