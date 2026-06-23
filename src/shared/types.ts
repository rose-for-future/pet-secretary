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

/** 一条关于用户的长期记忆（偏好/事实/习惯），自然语言存储，读时整体注入大脑。 */
export interface MemoryItem {
  id: string
  text: string
  kind: 'preference' | 'fact' | 'habit'
  createdAt: string
}

// P1 仅用到这几项，后续阶段再扩展
export interface Settings {
  defaultLeadMinutes: number
  snoozeMinutes: number
  soundEnabled: boolean
  muted: boolean
  /** Omni 语音对话音色（右键猫切换，见 persona.OMNI_VOICES）。 */
  omniVoice: string
}

export const DEFAULT_SETTINGS: Settings = {
  defaultLeadMinutes: 0,
  snoozeMinutes: 10,
  soundEnabled: true,
  muted: false,
  omniVoice: 'Sunny'
}
