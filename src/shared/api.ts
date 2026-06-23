import type { Task, RecurRule } from './types'

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
  recur?: RecurRule       // 有则是周期提醒，时间由规则算（忽略上面的 event/lead）
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
  /** 上报猫在桌宠窗内的中心(client 坐标)，供主进程跟随转头计算方向。 */
  petCatPos(cx: number, cy: number): void
  /** 上报"猫(+可见气泡)"的可点区域(client 矩形)，主进程据此用全局光标切换覆盖窗穿透点击。 */
  petHitRect(x: number, y: number, w: number, h: number): void
  petSay(text: string): void
  onPetBubble(cb: (text: string) => void): void
  voiceStart(): void
  voicePcm(pcm: ArrayBuffer): void
  voiceStop(): void
  onCatAudio(cb: (base64Pcm24k: string) => void): void
  onCatText(cb: (text: string) => void): void
  /** 用户开口打断猫说话：立刻掐掉正在播的回话音频。 */
  onCatStopAudio(cb: () => void): void
  onVoiceError(cb: (msg: string) => void): void
  onNoteRefresh(cb: () => void): void
  /** 主进程按鼠标方向推来的头部帧号（0..191）；-1 表示不跟随、回到待机动画。 */
  onPetLook(cb: (frame: number) => void): void
  /** 非 macOS 兜底：主进程让渲染层用浏览器 TTS 念一段话。 */
  onPetSpeak(cb: (text: string) => void): void
}
