import type { Task } from './types'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AddTaskInput {
  title: string
  note?: string
  eventLocalDate?: string // 'YYYY-MM-DD'，缺省=无时间待办
  eventLocalTime?: string // 'HH:mm'，缺省=无时间待办
  leadMinutes?: number    // 缺省取 settings.defaultLeadMinutes
}

export interface ReminderPayload {
  id: string
  title: string
  note?: string
}

export interface Api {
  listTasks(): Promise<Task[]>
  addTask(input: AddTaskInput): Promise<Task>
  quickAdd(payload: { title: string; when?: string }): Promise<Task | null>
  updateTask(id: string, input: AddTaskInput): Promise<Task | null>
  completeTask(id: string): Promise<void>
  snoozeTask(id: string): Promise<void>
  deleteTask(id: string): Promise<void>
  onReminder(cb: (payload: ReminderPayload) => void): void
  openNote(): void
  petDragStart(): void
  petDragEnd(): void
  petSay(text: string): void
  onPetBubble(cb: (text: string) => void): void
  voiceStart(): void
  voicePcm(pcm: ArrayBuffer): void
  voiceStop(): void
  onCatAudio(cb: (base64Pcm24k: string) => void): void
  onCatText(cb: (text: string) => void): void
  onVoiceError(cb: (msg: string) => void): void
  onNoteRefresh(cb: () => void): void
}
