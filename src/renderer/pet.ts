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

// 拖动 vs 点击：移动很小算点击（切换语音），否则算拖动
let downX = 0
let downY = 0
let dragging = false
cat.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  downX = e.screenX
  downY = e.screenY
  dragging = false
  api.petDragStart()
  const onMove = (ev: MouseEvent): void => {
    if (Math.abs(ev.screenX - downX) > 4 || Math.abs(ev.screenY - downY) > 4) dragging = true
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
api.onReminder((p: ReminderPayload) => {
  const text = `${p.title}${p.note ? '，' + p.note : ''}`
  bubbleText.textContent = text
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 10000)
  localSpeak('提醒你：' + text)
})
api.onPetBubble((text: string) => {
  bubbleText.textContent = text
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 8000)
})

// ── Click-to-talk (Omni end-to-end) ──────────────────────────────────────────
let audioCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let processor: ScriptProcessorNode | null = null
let capturing = false

function downsampleTo16k(input: Float32Array, inRate: number): Int16Array {
  const ratio = inRate / 16000
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const s = input[Math.floor(i * ratio)]
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff
  }
  return out
}

// —— 播放 Omni 返回的 24kHz PCM16 ——
let playCtx: AudioContext | null = null
let playHead = 0
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
  } catch { /* noop */ }
}

async function startListening(): Promise<void> {
  if (capturing) return
  capturing = true
  bubbleText.textContent = '在听…（再点我一下结束对话）'
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  ensurePlayCtx() // 趁点猫这次手势把播放上下文 resume，回话才出得了声
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    audioCtx = new AudioContext()
    const sourceNode = audioCtx.createMediaStreamSource(micStream)
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    const inRate = audioCtx.sampleRate
    api.voiceStart()
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      const pcm = downsampleTo16k(e.inputBuffer.getChannelData(0), inRate)
      api.voicePcm(pcm.buffer.slice(0) as ArrayBuffer)
    }
    sourceNode.connect(processor)
    processor.connect(audioCtx.destination)
  } catch (e) {
    capturing = false
    bubbleText.textContent = '打不开麦克风喵…'
  }
}

function stopListening(): void {
  if (!capturing) return
  capturing = false
  try { processor?.disconnect() } catch { /* noop */ }
  try { micStream?.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
  try { audioCtx?.close() } catch { /* noop */ }
  api.voiceStop()
  bubble.classList.add('hidden')
}

api.onCatAudio((b64) => playPcm24k(b64))
api.onCatText((t) => {
  bubbleText.textContent = t
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 8000)
})
api.onVoiceError((m) => {
  bubbleText.textContent = '语音出错喵：' + m
  bubble.classList.remove('hidden')
})
