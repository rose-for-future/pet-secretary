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
