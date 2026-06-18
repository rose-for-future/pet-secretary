import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, screen, session } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Store } from './store'
import { TaskService } from './task-service'
import { ReminderEngine } from './reminder-engine'
import type { AddTaskInput, ReminderPayload } from '../shared/api'
import type { Task } from '../shared/types'
import { OmniSession } from './omni'
import { parseWhen } from '../shared/datetime-parse'
import { utcToLocalParts } from '../shared/time'
import { matchByTitle } from '../shared/title-match'

// 1x1 透明 PNG，仅占位；Windows 后续需替换为真实托盘图标
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let dragTimer: ReturnType<typeof setInterval> | null = null
let tray: Tray | null = null

const store = new Store(app.getPath('userData'))
let service: TaskService
let engine: ReminderEngine

// 串行化持久化：避免并发 saveTasks 争用同一 .tmp 文件导致写坏或抛未捕获异常。
// 链上每段都带 .catch，故返回的 Promise 永不 reject —— await 与 void 调用都安全。
let persistChain: Promise<void> = Promise.resolve()
function persist(): Promise<void> {
  const next = persistChain
    .then(() => store.saveTasks(service.list()))
    .catch((err) => {
      console.error('保存任务失败:', err)
    })
  persistChain = next
  return next
}

/** 由 标题/自然语言时间/提前量 组装 service.add 的输入；语音建提醒与手动＋共用同一套解析。 */
function buildAddInput(
  title: string,
  when: string | undefined,
  leadMinutes: number | undefined,
  tz: string
): AddTaskInput {
  const input: AddTaskInput = { title }
  if (when && String(when).trim()) {
    const parsed = parseWhen(String(when), Date.now(), tz)
    if (parsed) {
      const parts = utcToLocalParts(parsed.eventTimeUtc, tz)
      input.eventLocalDate = parts.date
      input.eventLocalTime = parts.time
      input.leadMinutes = leadMinutes ?? parsed.leadMinutes
    }
  } else if (typeof leadMinutes === 'number') {
    input.leadMinutes = leadMinutes
  }
  return input
}

/** 规范的"活动待办"列表：过滤已完成、按提醒时间排序。
 *  语音里说的「第N条」= 这个列表的第 N 项；list_reminders 与删除/完成按序号都用它，保证序号一致。 */
function activeTasksSorted(): Task[] {
  return service
    .list()
    .filter((t) => t.status !== 'done')
    .sort((a, b) => (a.reminderTimeUtc ?? Infinity) - (b.reminderTimeUtc ?? Infinity))
}

function whenLabel(t: Task, tz: string): string {
  return t.reminderTimeUtc != null ? utcToLocalParts(t.reminderTimeUtc, tz).label : '无时间'
}

/** 把若干待办念成带序号的串，序号取它们在活动列表里的真实位置（从 1 开始）。 */
function numberedLines(tasks: Task[], active: Task[], tz: string): string {
  return tasks.map((t) => `第${active.indexOf(t) + 1}条「${t.title}」（${whenLabel(t, tz)}）`).join('；')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 600,
    show: false,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  tray = new Tray(icon)
  if (process.platform === 'darwin') tray.setTitle('🐾')
  tray.setToolTip('宠物秘书')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示/隐藏',
        click: () => {
          if (!mainWindow) return createWindow()
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
}

function createPetWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  petWindow = new BrowserWindow({
    width: 220,
    height: 260,
    x: width - 240,
    y: height - 280,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    petWindow.loadFile(join(__dirname, '../renderer/pet.html'))
  }
  petWindow.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '查看待办清单', click: () => {
        if (!mainWindow) return
        if (mainWindow.isVisible()) mainWindow.hide()
        else { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('note:refresh') }
      } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]).popup({ window: petWindow! })
  })
}


function fireReminder(taskTitle: string, note: string | undefined, payload: ReminderPayload): void {
  const settings = currentSettings
  if (!settings.muted) {
    new Notification({ title: '⏰ ' + taskTitle, body: note ?? '该做这件事啦～' }).show()
  }
  mainWindow?.webContents.send('reminder:fire', payload)
  petWindow?.webContents.send('reminder:fire', payload)
}

let currentSettings = { defaultLeadMinutes: 10, snoozeMinutes: 10, soundEnabled: true, muted: false }
let omniSession: OmniSession | null = null

function registerIpc(): void {
  ipcMain.handle('tasks:list', () => service.list())
  ipcMain.handle('tasks:add', async (_e, input: AddTaskInput) => {
    const t = service.add(input)
    await persist()
    return t
  })
  // 手动「＋」：标题 + 可选自然语言时间，走与语音建提醒同一套解析。
  ipcMain.handle('tasks:quickAdd', async (_e, payload: { title: string; when?: string }) => {
    const title = String(payload?.title ?? '').trim()
    if (!title) return null
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const t = service.add(buildAddInput(title, payload?.when, undefined, tz))
    await persist()
    mainWindow?.webContents.send('note:refresh')
    return t
  })
  ipcMain.handle('tasks:update', async (_e, id: string, input: AddTaskInput) => {
    const t = service.update(id, input)
    await persist()
    return t
  })
  ipcMain.handle('tasks:complete', async (_e, id: string) => {
    service.complete(id)
    await persist()
  })
  ipcMain.handle('tasks:snooze', async (_e, id: string) => {
    service.snooze(id)
    await persist()
  })
  ipcMain.handle('tasks:delete', async (_e, id: string) => {
    service.remove(id)
    await persist()
  })
  ipcMain.on('pet:open-note', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) mainWindow.hide()
    else { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('note:refresh') }
  })
ipcMain.on('pet:say', (_e, text: string) => {
    petWindow?.webContents.send('pet:bubble', text)
  })
  ipcMain.on('pet:drag-start', () => {
    if (!petWindow || dragTimer) return
    const start = screen.getCursorScreenPoint()
    const [wx, wy] = petWindow.getPosition()
    const offX = start.x - wx
    const offY = start.y - wy
    dragTimer = setInterval(() => {
      if (!petWindow) return
      const p = screen.getCursorScreenPoint()
      petWindow.setPosition(p.x - offX, p.y - offY)
    }, 16)
  })
  ipcMain.on('pet:drag-end', () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  })
  ipcMain.on('voice:start', async () => {
    try {
      omniSession = new OmniSession(app.getPath('userData'), {
        onAudio: (b64) => petWindow?.webContents.send('cat:audio', b64),
        onCatText: (t) => petWindow?.webContents.send('cat:text', t),
        onUserText: () => { /* 可选：暂不展示用户话 */ },
        onError: (m) => petWindow?.webContents.send('voice:error', m),
        onToolCall: async (name, args): Promise<string> => {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

          if (name === 'create_reminder') {
            const a = args as { title: string; when?: string; lead_minutes?: number }
            const input = buildAddInput(a.title, a.when, a.lead_minutes, tz)
            const task = service.add(input)
            await persist()
            mainWindow?.webContents.send('note:refresh')
            if (task.reminderTimeUtc != null) {
              return `已创建提醒：「${task.title}」，将在 ${utcToLocalParts(task.reminderTimeUtc, tz).label} 提醒。`
            }
            return `已记下待办：「${task.title}」（没有具体时间）。`
          }

          if (name === 'list_reminders') {
            const active = activeTasksSorted()
            if (active.length === 0) return '现在没有待办。'
            return `当前待办共 ${active.length} 条：` + numberedLines(active, active, tz) + '。'
          }

          if (name === 'delete_reminder' || name === 'complete_reminder') {
            const a = args as { title?: string; index?: number }
            const active = activeTasksSorted()
            if (active.length === 0) return '现在没有待办，没什么可操作的。'
            const verb = name === 'delete_reminder' ? '删除' : '完成'

            const apply = async (t: Task): Promise<string> => {
              if (name === 'delete_reminder') service.remove(t.id)
              else service.complete(t.id)
              await persist()
              mainWindow?.webContents.send('note:refresh')
              return name === 'delete_reminder' ? `已删除：「${t.title}」。` : `已完成：「${t.title}」。`
            }

            // ① 序号优先：用户说「第2条/第二个」→ 模型传 index，按规范列表定位，同名也分得清。
            const idx = typeof a.index === 'number' ? Math.floor(a.index) : NaN
            if (Number.isFinite(idx)) {
              if (idx >= 1 && idx <= active.length) {
                console.log('[tool]', name, 'index=', idx, '->', active[idx - 1].title)
                return apply(active[idx - 1])
              }
              return `序号 ${idx} 超出范围，现在只有 ${active.length} 条待办。要${verb}哪一条？` + numberedLines(active, active, tz) + '。'
            }

            const q = String(a.title ?? '').trim()
            // ② 没给标题也没给序号：只有一条就直接操作，多条让用户报序号。
            if (!q) {
              if (active.length === 1) return apply(active[0])
              return `有 ${active.length} 条待办，要${verb}哪一条？` + numberedLines(active, active, tz) + '。请说第几条。'
            }

            // ③ 标题匹配
            const matches = matchByTitle(active, q)
            console.log('[tool]', name, 'q=', q, 'matched=', matches.map((t) => t.title))
            if (matches.length === 0) {
              return `没找到叫「${q}」的待办。当前待办：` + numberedLines(active, active, tz) + '。要操作哪条？直接说第几条也行。'
            }
            if (matches.length === 1) return apply(matches[0])
            // 同名/相近多条：带序号+时间念出来，让用户报序号（下一轮模型用 index 调用）。
            return `有 ${matches.length} 条都符合：` + numberedLines(matches, active, tz) + `。你要${verb}第几条？`
          }

          return '我还不会这个操作喵。'
        }
      })
      await omniSession.start()
    } catch (e) {
      omniSession = null
      petWindow?.webContents.send('voice:error', (e as Error).message)
    }
  })
  ipcMain.on('voice:pcm', (_e, pcm: ArrayBuffer) => omniSession?.appendAudio(Buffer.from(pcm)))
  ipcMain.on('voice:stop', () => { omniSession?.close(); omniSession = null })
}

app.whenReady().then(async () => {
  const tasks = await store.loadTasks()
  currentSettings = await store.loadSettings()

  service = new TaskService(tasks, {
    now: () => Date.now(),
    uuid: () => randomUUID(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    getSettings: () => currentSettings
  })

  engine = new ReminderEngine(
    () => service.list(),
    (t) => fireReminder(t.title, t.note, { id: t.id, title: t.title, note: t.note }),
    (id, at) => {
      service.markFired(id, at)
      void persist()
    },
    () => Date.now()
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // 'audioCapture' is valid at runtime in Electron but not in the TS union — cast via any
    callback(permission === 'media' || (permission as string) === 'audioCapture')
  })

  registerIpc()
  createWindow()
  createPetWindow()
  createTray()
  engine.start(30000) // 30 秒心跳

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
})
