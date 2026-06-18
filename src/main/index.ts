import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, screen, session } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Store } from './store'
import { TaskService } from './task-service'
import { ReminderEngine } from './reminder-engine'
import type { AddTaskInput, ReminderPayload } from '../shared/api'
import type { Task } from '../shared/types'
import { OmniSession } from './omni'
import { think } from './brain'
import { parseWhen } from '../shared/datetime-parse'
import { utcToLocalParts } from '../shared/time'
import { matchByTitle } from '../shared/title-match'

// 1x1 透明 PNG，仅占位；Windows 后续需替换为真实托盘图标
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let dragTimer: ReturnType<typeof setInterval> | null = null
let lookTimer: ReturnType<typeof setInterval> | null = null
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

/** 给文字大脑看的当前待办清单（带序号），让它能用 index 精准定位、同名也分得清。 */
function formatTodoListForBrain(tz: string): string {
  const active = activeTasksSorted()
  return active.length === 0 ? '（当前没有待办）' : numberedLines(active, active, tz)
}

/** 在活动列表里按 序号(index) 或 标题(title) 定位一条待办。
 *  定位到唯一一条返回 {task}；为空/超界/多条/找不到 返回 {ask}（一句让用户澄清的话）。删/完成/改共用。 */
function locateTask(
  active: Task[],
  a: { title?: string; index?: number },
  verb: string,
  tz: string
): { task: Task } | { ask: string } {
  const idx = typeof a.index === 'number' ? Math.floor(a.index) : NaN
  if (Number.isFinite(idx)) {
    if (idx >= 1 && idx <= active.length) return { task: active[idx - 1] }
    return { ask: `序号 ${idx} 超出范围，现在只有 ${active.length} 条待办。要${verb}哪一条？` + numberedLines(active, active, tz) + '。' }
  }
  const q = String(a.title ?? '').trim()
  if (!q) {
    if (active.length === 1) return { task: active[0] }
    return { ask: `有 ${active.length} 条待办，要${verb}哪一条？` + numberedLines(active, active, tz) + '。请说第几条。' }
  }
  const matches = matchByTitle(active, q)
  if (matches.length === 0) return { ask: `没找到叫「${q}」的待办。当前待办：` + numberedLines(active, active, tz) + '。要操作哪条？直接说第几条也行。' }
  if (matches.length === 1) return { task: matches[0] }
  return { ask: `有 ${matches.length} 条都符合：` + numberedLines(matches, active, tz) + `。你要${verb}第几条？` }
}

/** 执行一个待办操作（增/查/删/完成/改），返回一句给用户听的话。增删改的本地兜底逻辑都在这里。 */
async function handleTool(name: string, args: Record<string, unknown>, tz: string): Promise<string> {
  if (name === 'create_reminder') {
    const a = args as { title?: string; when?: string; lead_minutes?: number }
    const title = String(a.title ?? '').trim()
    if (!title) return '没听清要记什么事喵，再说一次？'
    const whenStr = String(a.when ?? '').trim()
    const task = service.add(buildAddInput(title, a.when, a.lead_minutes, tz))
    await persist()
    mainWindow?.webContents.send('note:refresh')
    if (task.reminderTimeUtc != null) return `已创建提醒：「${task.title}」，将在 ${utcToLocalParts(task.reminderTimeUtc, tz).label} 提醒。`
    // 给了时间却没解析出来：别闷声变成无时间，明确告诉用户并指路怎么补。
    if (whenStr) return `记下了「${task.title}」，不过没太听懂「${whenStr}」是什么时间，你可以说「把${task.title}改到几点」来补上。`
    return `已记下待办：「${task.title}」（没有具体时间）。`
  }

  if (name === 'list_reminders') {
    const active = activeTasksSorted()
    if (active.length === 0) return '现在没有待办。'
    return `当前待办共 ${active.length} 条：` + numberedLines(active, active, tz) + '。'
  }

  if (name === 'delete_reminder' || name === 'complete_reminder') {
    const active = activeTasksSorted()
    if (active.length === 0) return '现在没有待办，没什么可操作的。'
    const verb = name === 'delete_reminder' ? '删除' : '完成'
    const loc = locateTask(active, args as { title?: string; index?: number }, verb, tz)
    if ('ask' in loc) return loc.ask
    const t = loc.task
    if (name === 'delete_reminder') service.remove(t.id)
    else service.complete(t.id)
    await persist()
    mainWindow?.webContents.send('note:refresh')
    console.log('[tool]', name, '->', t.title)
    return name === 'delete_reminder' ? `已删除：「${t.title}」。` : `已完成：「${t.title}」。`
  }

  if (name === 'update_reminder') {
    const a = args as {
      title?: string; index?: number
      new_when?: string; new_reminder_when?: string; new_lead_minutes?: number; new_title?: string
    }
    const active = activeTasksSorted()
    if (active.length === 0) return '现在没有待办，没什么可改的。'
    const loc = locateTask(active, a, '修改', tz)
    if ('ask' in loc) return loc.ask
    const t = loc.task

    const patch: { title?: string; eventTimeUtc?: number | null; reminderTimeUtc?: number | null; leadMinutes?: number } = {}
    const changed: string[] = []
    let timeMissed: string | null = null

    const newTitle = String(a.new_title ?? '').trim()
    if (newTitle && newTitle !== t.title) { patch.title = newTitle; changed.push('内容') }

    // ① 泛指"改到X点"：改事件时间，提醒按原提前量跟着走（常见、直觉）
    const w = String(a.new_when ?? '').trim()
    if (w) {
      const parsed = parseWhen(w, Date.now(), tz)
      if (parsed) {
        const lead = parsed.leadMinutes || t.leadMinutes || 0
        patch.eventTimeUtc = parsed.eventTimeUtc
        patch.leadMinutes = lead
        patch.reminderTimeUtc = parsed.eventTimeUtc - lead * 60000
        changed.push('时间')
      } else timeMissed = w
    }
    // ② 提前量：提醒 = 事件 − X 分钟（事件不变）
    if (typeof a.new_lead_minutes === 'number') {
      const baseEvent = patch.eventTimeUtc ?? t.eventTimeUtc
      if (baseEvent != null) {
        const lead = Math.max(0, Math.floor(a.new_lead_minutes))
        patch.leadMinutes = lead
        patch.reminderTimeUtc = baseEvent - lead * 60000
        changed.push('提前量')
      }
    }
    // ③ 只改"提醒/叫我"的时间：事件不动（这就是"分别改"的关键能力）
    const rw = String(a.new_reminder_when ?? '').trim()
    if (rw) {
      const parsed = parseWhen(rw, Date.now(), tz)
      if (parsed) {
        patch.reminderTimeUtc = parsed.eventTimeUtc
        const baseEvent = patch.eventTimeUtc ?? t.eventTimeUtc
        if (baseEvent != null) patch.leadMinutes = Math.max(0, Math.round((baseEvent - parsed.eventTimeUtc) / 60000))
        changed.push('提醒时间')
      } else timeMissed = rw
    }

    if (changed.length === 0) {
      if (timeMissed) return `没太听懂「${timeMissed}」是什么时间，「${t.title}」没动，换个说法再说一次？`
      return `没听清要把「${t.title}」改成什么，再说一次？`
    }

    const updated = service.patch(t.id, patch)!
    await persist()
    mainWindow?.webContents.send('note:refresh')
    console.log('[tool] update_reminder ->', t.title, JSON.stringify(patch))

    const ev = updated.eventTimeUtc != null ? utcToLocalParts(updated.eventTimeUtc, tz).label : null
    const rem = updated.reminderTimeUtc != null ? utcToLocalParts(updated.reminderTimeUtc, tz).label : null
    let msg = `已修改：「${updated.title}」`
    if (changed.some((c) => c !== '内容')) {
      if (rem && ev && rem !== ev) msg += `，事件 ${ev}、提醒 ${rem}`
      else if (rem) msg += `，提醒时间 ${rem}`
      else if (ev) msg += `，时间 ${ev}`
    }
    msg += '。'
    if (timeMissed) msg += `（不过「${timeMissed}」这个时间没听懂，那部分没改）`
    return msg
  }

  return '我还不会这个操作喵。'
}

/** 语音主驱动：拿到用户这句听写文字 → 判断/执行待办 → 让猫说出真实结果；闲聊则自然回应。 */
async function handleUserUtterance(transcript: string): Promise<void> {
  const sess = omniSession
  if (!sess) return
  const text = transcript.trim()
  // 每一句都交给大脑判断（它擅长理解，不会把"开一个/改回去"这类挡在门外）；空话才直接回应。
  // 大脑判成闲聊就只是自然回话，判成命令才执行 —— 可靠性优先于省那一点点文字调用的钱。
  if (!text) { sess.respondNatural(); return }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const now = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' })
    const out = await think(app.getPath('userData'), text, { now, todoList: formatTodoListForBrain(tz) })
    if (out.tool) {
      console.log('[brain]', text, '->', out.tool.name, JSON.stringify(out.tool.args))
      const result = await handleTool(out.tool.name, out.tool.args, tz)
      console.log('[brain] result', result)
      sess.say(result)
    } else {
      console.log('[brain]', text, '-> chat')
      sess.respondNatural()
    }
  } catch (e) {
    console.error('[brain] error', e)
    omniSession?.say('呜，网络好像不太顺，刚才那条没弄成，再说一次试试喵？')
  }
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
  if (process.platform === 'darwin') tray.setTitle('喵')
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
      { type: 'checkbox', label: '跟随鼠标看', checked: followEnabled, click: (item) => { followEnabled = item.checked } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]).popup({ window: petWindow! })
  })
  startLookTracking()
}

// 让猫的头跟着鼠标看：轮询全局鼠标位置，算出相对桌宠的方向 → 映射成 head360 的帧号推给桌宠窗。
// head360 是头部绕一圈：右=第0帧、上=48、左=96、下=144（实测的 quarter 点），即逆时针线性一圈。
const LOOK_RADIUS = 700      // 鼠标超出这个半径就不跟随，回到舔脚待机
const IDLE_AFTER_MS = 2500   // 鼠标静止超过这么久 → 回去舔脚（这样两个动画会自然来回切）
let followEnabled = true     // 右键菜单可手动关闭跟随
let lastCursor = { x: -1, y: -1 }
let lastMoveAt = 0
function startLookTracking(): void {
  if (lookTimer) return
  lookTimer = setInterval(() => {
    if (!petWindow || dragTimer) return // 拖动中不转头
    const p = screen.getCursorScreenPoint()
    if (Math.abs(p.x - lastCursor.x) > 2 || Math.abs(p.y - lastCursor.y) > 2) {
      lastMoveAt = Date.now()
      lastCursor = { x: p.x, y: p.y }
    }
    const moving = Date.now() - lastMoveAt < IDLE_AFTER_MS
    const [wx, wy] = petWindow.getPosition()
    const [ww, wh] = petWindow.getSize()
    const cx = wx + ww / 2
    const cy = wy + wh / 2
    const dx = p.x - cx
    const dy = p.y - cy
    const dist = Math.hypot(dx, dy)
    // 不跟随的情形 → 回去舔脚待机：手动关了 / 鼠标走远 / 鼠标静止太久
    if (!followEnabled || dist > LOOK_RADIUS || !moving) { petWindow.webContents.send('pet:look', -1); return }
    if (dist < 40) return // 鼠标基本在猫身上 → 保持当前朝向，别乱转
    // 左右做镜像（-dx）：实测之前左右是反的；上下保持（-dy）。
    let a = (Math.atan2(-dy, -dx) * 180) / Math.PI
    if (a < 0) a += 360
    const frame = Math.round((a / 360) * 192) % 192
    petWindow.webContents.send('pet:look', frame)
  }, 80)
}


function fireReminder(taskTitle: string, note: string | undefined, payload: ReminderPayload): void {
  const settings = currentSettings
  if (!settings.muted) {
    new Notification({ title: taskTitle, body: note ?? '该做这件事啦～' }).show()
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
        onError: (m) => petWindow?.webContents.send('voice:error', m),
        // 主驱动：每说完一句，交给文字大脑判断/执行，再让猫说出真实结果。
        onUserText: (transcript) => { void handleUserUtterance(transcript) }
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
