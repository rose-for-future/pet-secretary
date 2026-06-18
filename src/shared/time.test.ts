import { describe, test, expect } from 'vitest'
import { computeReminderTimeUtc, localWallTimeToUtc, utcToLocalParts, isDue } from './time'

describe('computeReminderTimeUtc', () => {
  test('提醒时间 = 事件时间 − 提前分钟', () => {
    const event = Date.UTC(2026, 5, 18, 7, 0, 0)
    expect(computeReminderTimeUtc(event, 30)).toBe(event - 30 * 60000)
  })
  test('提前量为 0 时等于事件时间', () => {
    const event = Date.UTC(2026, 5, 18, 7, 0, 0)
    expect(computeReminderTimeUtc(event, 0)).toBe(event)
  })
})

describe('localWallTimeToUtc', () => {
  test('上海 15:00 = 当日 07:00 UTC（UTC+8，无 DST）', () => {
    expect(localWallTimeToUtc('2026-06-18', '15:00', 'Asia/Shanghai'))
      .toBe(Date.UTC(2026, 5, 18, 7, 0, 0))
  })
  test('纽约冬令时 12:00 = 17:00 UTC（EST，UTC−5）', () => {
    expect(localWallTimeToUtc('2026-01-01', '12:00', 'America/New_York'))
      .toBe(Date.UTC(2026, 0, 1, 17, 0, 0))
  })
  test('纽约夏令时 12:00 = 16:00 UTC（EDT，UTC−4）', () => {
    expect(localWallTimeToUtc('2026-07-01', '12:00', 'America/New_York'))
      .toBe(Date.UTC(2026, 6, 1, 16, 0, 0))
  })
})

describe('utcToLocalParts', () => {
  test('07:00 UTC 在上海展示为 2026-06-18 15:00', () => {
    const parts = utcToLocalParts(Date.UTC(2026, 5, 18, 7, 0, 0), 'Asia/Shanghai')
    expect(parts.date).toBe('2026-06-18')
    expect(parts.time).toBe('15:00')
    expect(parts.label).toBe('2026-06-18 15:00')
  })
  test('与 localWallTimeToUtc 往返一致', () => {
    const utc = localWallTimeToUtc('2026-03-09', '08:30', 'Asia/Shanghai')
    const parts = utcToLocalParts(utc, 'Asia/Shanghai')
    expect(parts.date).toBe('2026-03-09')
    expect(parts.time).toBe('08:30')
  })
})

describe('isDue', () => {
  test('提醒时间 <= now 为到期', () => {
    expect(isDue(1000, 1000)).toBe(true)
    expect(isDue(1000, 2000)).toBe(true)
  })
  test('提醒时间 > now 未到期', () => {
    expect(isDue(2000, 1000)).toBe(false)
  })
})
