export interface RecurRule {
  freq: 'daily' | 'weekly' | 'monthly'
  interval: number
  byWeekday?: number[]
  byMonthday?: number
  time: string
  until?: string | null
}

export interface Task {
  id: string
  title: string
  note?: string
  eventTimeUtc: number | null
  timezone: string
  leadMinutes: number
  reminderTimeUtc: number | null
  recur: RecurRule | null
  kind: 'single' | 'series' | 'occurrence'
  seriesId: string | null
  nextEventTimeUtc: number | null
  status: 'pending' | 'done' | 'snoozed' | 'expired'
  snoozeUntilUtc: number | null
  source: 'keyboard' | 'dictation' | 'voice' | 'api'
  nagCount: number
  lastFiredAtUtc: number | null
  createdAt: string
  updatedAt: string
}

// P1 仅用到这几项，后续阶段再扩展
export interface Settings {
  defaultLeadMinutes: number
  snoozeMinutes: number
  soundEnabled: boolean
  muted: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  defaultLeadMinutes: 0,
  snoozeMinutes: 10,
  soundEnabled: true,
  muted: false
}
