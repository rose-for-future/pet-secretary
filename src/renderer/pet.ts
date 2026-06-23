import type { Api, ReminderPayload } from '../shared/api'

declare global {
  interface Window {
    api: Api
  }
}

const api = window.api
const IDLE_COUNT = 121
const HEAD_COUNT = 192
const FPS = 24
const BASE = './pet/cat_british/idle/'
const HEAD_BASE = './pet/cat_british/head360/'

const cat = document.getElementById('cat') as HTMLImageElement
const bubble = document.getElementById('pet-bubble') as HTMLDivElement
const bubbleText = document.getElementById('pet-bubble-text') as HTMLSpanElement
const micDot = document.getElementById('mic-dot') as HTMLDivElement

const pad = (n: number): string => String(n).padStart(4, '0')

// 预加载帧，避免播放时闪烁
const frames: HTMLImageElement[] = []
for (let i = 0; i < IDLE_COUNT; i++) {
  const img = new Image()
  img.src = `${BASE}${pad(i)}.png`
  frames.push(img)
}
// head360：头朝各方向看的一圈帧，用于跟随鼠标
const headFrames: HTMLImageElement[] = []
for (let i = 0; i < HEAD_COUNT; i++) {
  const img = new Image()
  img.src = `${HEAD_BASE}${pad(i)}.png`
  headFrames.push(img)
}
cat.src = frames[0].src

// 跟随鼠标：主进程按鼠标方向推来目标头部帧号（-1=不跟随）。
let lookTarget = -1
let curHead = 0
api.onPetLook((f) => { lookTarget = f })

// 在 192 帧的环上从 cur 朝 target 走最短路径，每次最多 step 帧 → 转头平滑不突跳。
function stepToward(cur: number, target: number, step: number): number {
  let d = (target - cur + HEAD_COUNT) % HEAD_COUNT
  if (d > HEAD_COUNT / 2) d -= HEAD_COUNT
  const move = Math.max(-step, Math.min(step, d))
  return (cur + move + HEAD_COUNT) % HEAD_COUNT
}

let frame = 0
setInterval(() => {
  if (lookTarget >= 0 && lookTarget < HEAD_COUNT) {
    curHead = stepToward(curHead, lookTarget, 6)
    cat.src = headFrames[curHead].src
  } else {
    frame = (frame + 1) % IDLE_COUNT
    cat.src = frames[frame].src
  }
}, 1000 / FPS)

// —— 桌宠容器定位（窗口铺满整屏不动，移动的是猫容器本身）——
const petEl = document.getElementById('pet') as HTMLDivElement
const PET_SIZE = 200
let petX = 0
let petY = 0
let dragging = false
function reportCatPos(): void {
  // 猫贴容器底部、200×200 → 中心 client 坐标 = (左+宽/2, 上+高-100)
  api.petCatPos(petX + PET_SIZE / 2, petY + PET_SIZE - 100)
}
// 穿透点击：把"猫(+可见气泡)"的可点区域(client 矩形)上报给主进程，由主进程用【全局光标】判断光标是否
// 在区域内来切换穿透——不依赖 forward 的 mousemove（那在 macOS 不可靠，正是之前点不到猫的原因）。
function reportHitRect(): void {
  const c = cat.getBoundingClientRect()
  let x = c.left, y = c.top, right = c.right, bottom = c.bottom
  if (!bubble.classList.contains('hidden')) {
    const b = bubble.getBoundingClientRect()
    x = Math.min(x, b.left); y = Math.min(y, b.top); right = Math.max(right, b.right); bottom = Math.max(bottom, b.bottom)
  }
  api.petHitRect(x, y, right - x, bottom - y)
}
function placePet(x: number, y: number): void {
  petX = Math.max(0, Math.min(window.innerWidth - PET_SIZE, x))
  petY = Math.max(0, Math.min(window.innerHeight - PET_SIZE, y))
  petEl.style.left = `${petX}px`
  petEl.style.top = `${petY}px`
  reportCatPos()
  reportHitRect()
}
// 初始落在右下角
placePet(window.innerWidth - PET_SIZE - 20, window.innerHeight - PET_SIZE - 20)
window.addEventListener('resize', () => placePet(petX, petY))
// 周期上报可点区域，自动覆盖气泡显隐/猫移动带来的变化（轻量，120ms 一次）。
setInterval(reportHitRect, 120)

// 拖动 vs 点击：移动很小算点击（切换语音），否则算拖动（移动猫容器）。
cat.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  const startX = e.clientX
  const startY = e.clientY
  const baseX = petX
  const baseY = petY
  dragging = false
  api.petDragStart()
  const onMove = (ev: MouseEvent): void => {
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) dragging = true
    if (dragging) placePet(baseX + dx, baseY + dy)
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    api.petDragEnd()
    if (!dragging) {
      if (!capturing) void startListening()
      else stopListening()
    }
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
})

// —— 本地离线 TTS（不依赖 Omni 会话）——
function pickZhVoice(): SpeechSynthesisVoice | null {
  const vs = speechSynthesis.getVoices()
  return vs.find((v) => /zh(-|_)CN/i.test(v.lang) && /tingting|婷婷|meijia|美佳/i.test(v.name)) || vs.find((v) => /zh/i.test(v.lang)) || null
}
function localSpeak(text: string): void {
  try {
    const u = new SpeechSynthesisUtterance(text)
    const v = pickZhVoice(); if (v) u.voice = v
    u.lang = 'zh-CN'; u.rate = 1.05; u.pitch = 1.2
    speechSynthesis.cancel(); speechSynthesis.speak(u)
  } catch { /* noop */ }
}
// 预热语音列表（部分浏览器需先触发一次 getVoices() 才能异步加载）
speechSynthesis.getVoices()

let bubbleTimer: ReturnType<typeof setTimeout> | undefined

// 闹钟"叮叮"声（best-effort：音频上下文被浏览器挂起时可能不响，但视觉提醒一定在）
function alarmSound(): void {
  try {
    const ctx = ensurePlayCtx()
    const beep = (at: number): void => {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = 880
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.2, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.4)
      o.connect(g); g.connect(ctx.destination)
      o.start(at); o.stop(at + 0.42)
    }
    const t0 = ctx.currentTime
    beep(t0); beep(t0 + 0.5) // 叮、叮 两声
  } catch { /* noop */ }
}

api.onReminder((p: ReminderPayload) => {
  const text = `${p.title}${p.note ? '，' + p.note : ''}`
  bubbleText.textContent = '提醒：' + text
  bubble.classList.remove('hidden')
  bubble.classList.add('reminder')
  clearTimeout(bubbleTimer) // 提醒气泡常驻，不自动消失，点一下才关
  alarmSound()
  // 语音播报由主进程用系统 TTS（say）念，最可靠；这里只负责响铃+气泡
  setTimeout(() => alarmSound(), 3000) // 3 秒后再响一遍，避免错过
})
// 非 macOS 兜底：主进程念不了时让渲染层用浏览器 TTS 念
api.onPetSpeak((text: string) => localSpeak(text))
// 点气泡关掉提醒（提醒气泡是常驻的，需要手动关）
bubble.addEventListener('click', (e) => {
  e.stopPropagation()
  bubble.classList.add('hidden')
  bubble.classList.remove('reminder')
})

api.onPetBubble((text: string) => {
  bubble.classList.remove('reminder')
  bubbleText.textContent = text
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 8000)
})

// ── Click-to-talk (Omni end-to-end) ──────────────────────────────────────────
let audioCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let workletNode: AudioWorkletNode | null = null
let capturing = false

// —— 播放 Omni 返回的 24kHz PCM16 ——
let playCtx: AudioContext | null = null
let playHead = 0
let playSources: AudioBufferSourceNode[] = [] // 正在排队/播放的回话音频，打断时要全停掉
// 在用户手势（点猫）里就建好并 resume 播放上下文，否则自动播放策略会让它一直 suspended，
// 工具调用成功了却听不到声音，用户以为没成。
function ensurePlayCtx(): AudioContext {
  if (!playCtx) playCtx = new AudioContext({ sampleRate: 24000 })
  if (playCtx.state === 'suspended') void playCtx.resume()
  return playCtx
}
function playPcm24k(b64: string): void {
  try {
    const ctx = ensurePlayCtx()
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const i16 = new Int16Array(bytes.buffer)
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000
    const buf = ctx.createBuffer(1, f32.length, 24000)
    buf.getChannelData(0).set(f32)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const now = ctx.currentTime
    if (playHead < now) playHead = now
    src.start(playHead)
    playHead += buf.duration
    playSources.push(src)
    src.onended = (): void => { playSources = playSources.filter((s) => s !== src) }
  } catch { /* noop */ }
}

// 打断：立刻停掉所有排队/在播的回话音频（用户开口时主进程会触发）。
function stopPlayback(): void {
  for (const s of playSources) { try { s.stop() } catch { /* 可能还没真正开播 */ } }
  playSources = []
  playHead = 0
}

async function startListening(): Promise<void> {
  if (capturing) return
  capturing = true
  bubbleText.textContent = '在听…（再点我一下结束对话）'
  bubble.classList.remove('hidden')
  micDot.classList.remove('hidden') // 头顶亮起呼吸绿点，明确"正在听"
  clearTimeout(bubbleTimer)
  ensurePlayCtx() // 趁点猫这次手势把播放上下文 resume，回话才出得了声
  try {
    // 开回声消除/降噪：否则猫自己的声音会被麦克风听成"用户在说话"而误触发打断。
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    audioCtx = new AudioContext()
    // AudioWorklet：采集跑在专用音频线程，延迟更低、不被界面(帧动画/跟随鼠标)卡顿影响。
    await audioCtx.audioWorklet.addModule('./pcm-worklet.js')
    const sourceNode = audioCtx.createMediaStreamSource(micStream)
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-worklet', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    api.voiceStart()
    workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>): void => { api.voicePcm(e.data) }
    sourceNode.connect(workletNode)
    workletNode.connect(audioCtx.destination) // 接到输出以驱动 process()；worklet 不写输出=静音，无回授
  } catch (e) {
    capturing = false
    micDot.classList.add('hidden')
    bubbleText.textContent = '打不开麦克风喵…'
  }
}

function stopListening(): void {
  if (!capturing) return
  capturing = false
  try { workletNode?.disconnect() } catch { /* noop */ }
  workletNode = null
  try { micStream?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
  try { audioCtx?.close() } catch { /* noop */ }
  api.voiceStop()
  bubble.classList.add('hidden')
  micDot.classList.add('hidden')
}

api.onCatAudio((b64) => playPcm24k(b64))
api.onCatStopAudio(() => stopPlayback())
api.onCatText((t) => {
  bubble.classList.remove('reminder')
  bubbleText.textContent = t
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  // 长文字多停一会，够看完整段（短句 ~4.5s，长句最多 14s）。
  const ms = Math.min(14000, 4500 + t.length * 220)
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), ms)
})
api.onVoiceError((m) => {
  bubbleText.textContent = '语音出错喵：' + m
  bubble.classList.remove('hidden')
})
