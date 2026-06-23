import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, screen, session } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { getPersona, setOmniVoice, OMNI_VOICES } from '../shared/persona'
import { Store } from './store'
import { TaskService } from './task-service'
import { ReminderEngine } from './reminder-engine'
import type { AddTaskInput, ReminderPayload } from '../shared/api'
import type { Task, MemoryItem, RecurRule, Settings } from '../shared/types'
import { OmniSession } from './omni'
import { think } from './brain'
import { prewarm } from './doh'
import { handleTool, buildAddInput, formatTodoList, formatMemory, type ToolCtx } from './tool-handler'
import { claimsCompletion } from '../shared/reply-guard'
import { needsBrain } from '../shared/route'

// stdout/stderr 的读端被关掉时（以管道方式后台启动、父进程退出、打包后无终端等），一次 console.log
// 写失败会抛 EPIPE；在回调里没人接就变成 uncaughtException 崩掉主进程。给两个流挂兜底：写日志失败就静默忽略。
process.stdout.on('error', () => { /* 忽略 EPIPE 等写日志失败，绝不让日志搞崩 app */ })
process.stderr.on('error', () => { /* 同上 */ })

// 1x1 透明 PNG，仅占位；Windows 后续需替换为真实托盘图标
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let petDragging = false // 渲染层正在拖动猫 → 暂停跟随转头
let lookTimer: ReturnType<typeof setInterval> | null = null
let tray: Tray | null = null

const store = new Store(app.getPath('userData'))
let service: TaskService
let engine: ReminderEngine
let memories: MemoryItem[] = [] // 关于用户的长期记忆（偏好/事实/习惯）

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

let memoryChain: Promise<void> = Promise.resolve()
function persistMemories(): Promise<void> {
  const next = memoryChain.then(() => store.saveMemories(memories)).catch((err) => console.error('保存记忆失败:', err))
  memoryChain = next
  return next
}

/** 组装动作执行层（tool-handler）所需的依赖上下文：注入持久化与刷新副作用。 */
function toolCtx(): ToolCtx {
  return {
    service,
    memories,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: () => Date.now(),
    uuid: () => randomUUID(),
    onTasksChanged: async () => { await persist(); mainWindow?.webContents.send('note:refresh') },
    onMemoriesChanged: async () => { await persistMemories() }
  }
}

// 最近几轮对话（每次点猫开新会话时清空）——让大脑能"先问日期、你答了再接着办"这类多轮交互。
let convo: { role: 'user' | 'assistant'; content: string }[] = []
const CONVO_MAX = 8 // 只留最近 8 条，控制提示词长度
// 大脑刚抛出反问/澄清（如"上午还是晚上呀？"）、在等用户回答时为 true：
// 下一句即使没命中任务关键词也强制走大脑，否则像"晚上"这种答句会被误判成闲聊、把多轮交互打断。
let awaitingFollowup = false

/** 语音主驱动：拿到用户这句听写文字（带最近对话）→ 大脑判断 → 执行待办/记忆或说话。 */
async function handleUserUtterance(transcript: string): Promise<void> {
  const sess = omniSession
  if (!sess) return
  const text = transcript.trim()
  if (!text) return
  // 路由：纯闲聊（且大脑没在等澄清回答）→ Omni 端到端快聊，省掉一次文字大脑往返。
  // 含任务/记忆/时间信号、或正等澄清回答的，才走大脑（慢但能可靠执行）。
  if (!needsBrain(text) && !awaitingFollowup) {
    console.log('[route]', text, '-> 闲聊(端到端)')
    sess.respondNatural()
    return
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const now = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' })
    const t0 = Date.now()
    const out = await think(app.getPath('userData'), text, {
      now,
      todoList: formatTodoList(service, tz),
      memory: formatMemory(memories),
      history: convo.slice()
    })
    console.log('[latency] brain.think', Date.now() - t0, 'ms')
    let spoken: string
    if (out.tool) {
      console.log('[brain]', text, '->', out.tool.name, JSON.stringify(out.tool.args))
      spoken = await handleTool(out.tool.name, out.tool.args, toolCtx())
      console.log('[brain] result', spoken)
    } else {
      // 真话底线（代码强制）：没调工具却声称"已设好/已删/清完了"的，一律拦下，不让假话出口。
      spoken = out.reply || '喵？'
      if (claimsCompletion(spoken)) {
        console.warn('[brain] 拦截未执行却声称完成的回复:', spoken)
        spoken = '诶，这条我刚才没真弄成喵…你再说一遍，我立刻帮你做～'
      } else {
        console.log('[brain]', text, '-> chat/反问')
      }
    }
    sess.say(spoken)
    // 这句若是反问/澄清（含「？」），置位 → 下一句强制回大脑接上多轮；否则清掉、恢复正常路由。
    awaitingFollowup = spoken.includes('？') || spoken.includes('?')
    // 记进对话历史（含反问），下一句大脑才接得上
    convo.push({ role: 'user', content: text }, { role: 'assistant', content: spoken })
    if (convo.length > CONVO_MAX) convo = convo.slice(-CONVO_MAX)
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

// 创建一个配好回调的 Omni 会话（voice:start 与换音色热重连共用，避免回调重复）。
function newOmniSession(): OmniSession {
  return new OmniSession(app.getPath('userData'), {
    onAudio: (b64) => petWindow?.webContents.send('cat:audio', b64),
    onCatText: (t) => petWindow?.webContents.send('cat:text', t),
    onInterrupt: () => petWindow?.webContents.send('cat:stop-audio'),
    onError: (m) => petWindow?.webContents.send('voice:error', m),
    // 主驱动：每说完一句，交给文字大脑判断/执行，再让猫说出真实结果。
    onUserText: (transcript) => { void handleUserUtterance(transcript) }
  })
}

// 对话中换音色：Omni 音色在连接时锁定，故用新音色热重连一次。麦克风不停（在渲染端），
// 新会话会缓存 pre-roll 音频直到连上，几乎无缝；新声从下一句猫说话起生效。
async function restartVoiceForVoiceChange(): Promise<void> {
  if (!omniSession) return // 没在对话：不重连，下次点猫说话自然用新音色
  const old = omniSession
  const fresh = newOmniSession()
  omniSession = fresh // 立刻接管，新进来的 PCM 走它（未连上时自动缓存）
  try {
    await fresh.start()
  } catch (e) {
    if (omniSession === fresh) omniSession = null
    petWindow?.webContents.send('voice:error', (e as Error).message)
  }
  old.close()
}

// 右键菜单选了新音色：改 persona、存进 settings、给猫冒泡反馈；对话中则热重连立刻生效。
async function changeVoice(voice: string): Promise<void> {
  if (!setOmniVoice(voice)) return
  currentSettings = { ...currentSettings, omniVoice: voice }
  await store.saveSettings(currentSettings)
  const live = !!omniSession
  petWindow?.webContents.send('cat:text', `音色换成 ${voice} 啦喵～${live ? '' : '下次说话生效'}`)
  await restartVoiceForVoiceChange()
}

function createPetWindow(): void {
  const wa = screen.getPrimaryDisplay().workArea
  petWindow = new BrowserWindow({
    // 全屏透明覆盖窗：铺满工作区、永远不动；猫在窗内用 CSS 自由定位，可拖到任意角落（含最顶）。
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
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
  // 默认整窗穿透点击（forward:true 仍能收到 mousemove，渲染层据此在光标移到猫上时夺回点击）。
  petWindow.setIgnoreMouseEvents(true, { forward: true })
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
      { label: '音色', submenu: OMNI_VOICES.map((v) => ({
        type: 'radio' as const,
        label: v.label,
        checked: getPersona().omniVoice === v.id,
        click: () => { void changeVoice(v.id) }
      })) },
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
// 猫在桌宠窗内的中心（client 坐标，渲染层拖动时上报）；窗口铺满工作区，加窗口原点即得屏幕坐标。
let catClientCenter = { x: 0, y: 0 }
// 猫(+可见气泡)的可点区域（client 矩形，渲染层上报）；全局光标在其中 → 夺回点击，否则穿透。
let petHitRect = { x: 0, y: 0, w: 0, h: 0 }
let mouseIgnored = true // 当前覆盖窗是否处于穿透态（避免重复调用 setIgnoreMouseEvents）

// 按全局光标切换覆盖窗穿透点击（不依赖 forward 的 mousemove —— 那在 macOS 不可靠）。
function updateMouseCapture(p: { x: number; y: number }): void {
  if (!petWindow) return
  let want: boolean
  if (petDragging) {
    want = true // 拖动中始终可点，别中途丢失捕获
  } else {
    const [wx, wy] = petWindow.getPosition()
    const rx = wx + petHitRect.x
    const ry = wy + petHitRect.y
    want = p.x >= rx && p.x <= rx + petHitRect.w && p.y >= ry && p.y <= ry + petHitRect.h
  }
  const ignore = !want
  if (ignore !== mouseIgnored) {
    mouseIgnored = ignore
    try { petWindow.setIgnoreMouseEvents(ignore, { forward: true }) } catch { /* noop */ }
  }
}
function startLookTracking(): void {
  if (lookTimer) return
  lookTimer = setInterval(() => {
    if (!petWindow) return
    const p = screen.getCursorScreenPoint()
    updateMouseCapture(p) // 先按全局光标切换穿透点击（不受下面跟随/拖动早退影响）
    if (petDragging) return // 拖动中不转头（穿透已在上面保证为"可点"）
    if (Math.abs(p.x - lastCursor.x) > 2 || Math.abs(p.y - lastCursor.y) > 2) {
      lastMoveAt = Date.now()
      lastCursor = { x: p.x, y: p.y }
    }
    const moving = Date.now() - lastMoveAt < IDLE_AFTER_MS
    const [wx, wy] = petWindow.getPosition()
    // 猫中心 = 窗口原点 + 渲染层上报的猫 client 中心。
    const cx = wx + catClientCenter.x
    const cy = wy + catClientCenter.y
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


/** 用角色的口吻把提醒念出来。macOS 直接调系统 say（最可靠、断网也响）；其它平台退回渲染层 TTS。 */
function speakReminder(text: string): void {
  if (currentSettings.muted) return
  if (process.platform === 'darwin') {
    execFile('say', ['-v', getPersona().sayVoice, text], (err) => { if (err) console.error('[reminder] say 失败', err) })
  } else {
    petWindow?.webContents.send('pet:speak', text)
  }
}

function fireReminder(taskTitle: string, note: string | undefined, payload: ReminderPayload): void {
  console.log('[reminder] 触发:', taskTitle)
  // 先把可见提醒推给桌宠/清单窗（系统通知可能在 dev 版 macOS 弹不出，绝不能让它的失败挡住这步）
  mainWindow?.webContents.send('reminder:fire', payload)
  petWindow?.webContents.send('reminder:fire', payload)
  // 用猫的口吻念出来（系统 TTS，最可靠）
  speakReminder(getPersona().announceReminder(taskTitle, note))
  // 把桌宠提到最前 + 抖一下 Dock，确保抓到注意力（桌宠是自己的置顶窗，最可靠）
  try {
    if (petWindow) { petWindow.showInactive(); petWindow.moveTop() }
    if (process.platform === 'darwin') app.dock?.bounce('critical')
  } catch (e) { console.error('[reminder] 置顶失败', e) }
  // 系统通知：best-effort，包起来，失败不影响上面的提醒
  try {
    if (!currentSettings.muted && Notification.isSupported()) {
      new Notification({ title: taskTitle, body: note ?? '该做这件事啦～' }).show()
    }
  } catch (e) { console.error('[reminder] 系统通知失败', e) }
}

let currentSettings: Settings = { defaultLeadMinutes: 10, snoozeMinutes: 10, soundEnabled: true, muted: false, omniVoice: 'Sunny' }
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
    const t = service.add(buildAddInput(title, payload?.when, undefined, tz, Date.now()))
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
  // 拖动现在由渲染层移动"猫"本身（窗口铺满屏不动）；这里只记录拖动中以暂停跟随转头。
  ipcMain.on('pet:drag-start', () => { petDragging = true })
  ipcMain.on('pet:drag-end', () => { petDragging = false })
  // 渲染层上报猫当前中心（client 坐标），供跟随转头计算方向。
  ipcMain.on('pet:cat-pos', (_e, cx: number, cy: number) => { catClientCenter = { x: cx, y: cy } })
  // 渲染层上报可点区域（client 矩形）；穿透切换在跟随轮询里用全局光标判断（updateMouseCapture）。
  ipcMain.on('pet:hit-rect', (_e, x: number, y: number, w: number, h: number) => { petHitRect = { x, y, w, h } })
  ipcMain.on('voice:start', async () => {
    try {
      convo = [] // 新会话清空对话历史
      awaitingFollowup = false
      omniSession = newOmniSession()
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
  setOmniVoice(currentSettings.omniVoice) // 应用上次选的音色（非法/缺省则保持默认）
  memories = await store.loadMemories()
  void prewarm('dashscope.aliyuncs.com') // 后台预热好 IP，首句语音少等几秒

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
      const t = service.list().find((x) => x.id === id)
      if (t?.recur) service.advanceRecur(id) // 周期：排下一次、继续待提醒
      else service.markFired(id, at)          // 一次性：标记已提醒
      mainWindow?.webContents.send('note:refresh')
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
