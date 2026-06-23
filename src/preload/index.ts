import { contextBridge, ipcRenderer } from 'electron'
import type { Api, AddTaskInput, ReminderPayload } from '../shared/api'
import type { Task } from '../shared/types'

const api: Api = {
  listTasks: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
  addTask: (input: AddTaskInput): Promise<Task> => ipcRenderer.invoke('tasks:add', input),
  quickAdd: (payload: { title: string; when?: string }): Promise<Task | null> => ipcRenderer.invoke('tasks:quickAdd', payload),
  updateTask: (id: string, input: AddTaskInput): Promise<Task | null> => ipcRenderer.invoke('tasks:update', id, input),
  completeTask: (id: string): Promise<void> => ipcRenderer.invoke('tasks:complete', id),
  snoozeTask: (id: string): Promise<void> => ipcRenderer.invoke('tasks:snooze', id),
  deleteTask: (id: string): Promise<void> => ipcRenderer.invoke('tasks:delete', id),
  onReminder: (cb: (payload: ReminderPayload) => void): void => {
    ipcRenderer.on('reminder:fire', (_event, payload: ReminderPayload) => cb(payload))
  },
  openNote: (): void => ipcRenderer.send('pet:open-note'),
  petDragStart: (): void => ipcRenderer.send('pet:drag-start'),
  petDragEnd: (): void => ipcRenderer.send('pet:drag-end'),
  petCatPos: (cx: number, cy: number): void => ipcRenderer.send('pet:cat-pos', cx, cy),
  petHitRect: (x: number, y: number, w: number, h: number): void => ipcRenderer.send('pet:hit-rect', x, y, w, h),
  petSay: (text: string): void => ipcRenderer.send('pet:say', text),
  onPetBubble: (cb: (text: string) => void): void => {
    ipcRenderer.on('pet:bubble', (_e, text: string) => cb(text))
  },
  voiceStart: (): void => ipcRenderer.send('voice:start'),
  voicePcm: (pcm: ArrayBuffer): void => ipcRenderer.send('voice:pcm', pcm),
  voiceStop: (): void => ipcRenderer.send('voice:stop'),
  onCatAudio: (cb: (b64: string) => void): void => { ipcRenderer.on('cat:audio', (_e, b64: string) => cb(b64)) },
  onCatText: (cb: (text: string) => void): void => { ipcRenderer.on('cat:text', (_e, t: string) => cb(t)) },
  onCatStopAudio: (cb: () => void): void => { ipcRenderer.on('cat:stop-audio', () => cb()) },
  onVoiceError: (cb: (msg: string) => void): void => { ipcRenderer.on('voice:error', (_e, m: string) => cb(m)) },
  onNoteRefresh: (cb: () => void): void => { ipcRenderer.on('note:refresh', () => cb()) },
  onPetLook: (cb: (frame: number) => void): void => { ipcRenderer.on('pet:look', (_e, frame: number) => cb(frame)) },
  onPetSpeak: (cb: (text: string) => void): void => { ipcRenderer.on('pet:speak', (_e, text: string) => cb(text)) }
}

contextBridge.exposeInMainWorld('api', api)
