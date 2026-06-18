import { DateTime } from 'luxon'

/** 提醒时间 = 事件时间 − 提前分钟（均为 UTC 毫秒） */
export function computeReminderTimeUtc(eventTimeUtc: number, leadMinutes: number): number {
  return eventTimeUtc - leadMinutes * 60000
}

/** 把指定时区的本地墙钟日期+时间转成 UTC 毫秒 */
export function localWallTimeToUtc(date: string, time: string, timezone: string): number {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: timezone })
  if (!dt.isValid) {
    throw new Error(`无法解析本地时间: ${date}T${time} @ ${timezone}`)
  }
  return dt.toMillis()
}

/** 把 UTC 毫秒在指定时区转成展示字段 */
export function utcToLocalParts(
  utcMs: number,
  timezone: string
): { date: string; time: string; label: string } {
  const dt = DateTime.fromMillis(utcMs, { zone: 'utc' }).setZone(timezone)
  return {
    date: dt.toFormat('yyyy-MM-dd'),
    time: dt.toFormat('HH:mm'),
    label: dt.toFormat('yyyy-MM-dd HH:mm')
  }
}

/** 提醒时间是否已到（<= now） */
export function isDue(reminderTimeUtc: number, nowMs: number): boolean {
  return reminderTimeUtc <= nowMs
}
