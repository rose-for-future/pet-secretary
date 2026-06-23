import WebSocket from 'ws'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getPersona } from '../shared/persona'
import { realIps, markGood, markBad } from './doh'

// 注意：可能需要现场微调的常量（连不上/报错时优先改这三个）
const MODEL = 'qwen3.5-omni-flash-realtime'      // flash 版：更快更便宜；备选 'qwen-omni-turbo-realtime'
// 音色由当前角色(persona)决定（可用: Serena/Sunny/Kiki 女, Ethan/Dylan 男）
const INPUT_AUDIO_FORMAT = 'pcm16'               // 备选: 'pcm'
// 直连真实 IP（绕开本机 DNS 劫持），SNI/Host 仍用域名 —— 见 doh.ts。
const HOST = 'dashscope.aliyuncs.com'
const WS_PATH = `/api-ws/v1/realtime?model=${MODEL}`

function buildInstructions(): string {
  const now = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' })
  // Omni 只负责"听 + 说 + 卖萌"。增删查待办由系统(文字大脑)处理后，把要说的话交给你照念。
  return (
    '你是一只元气活泼的小猫咪桌面助手，名字叫"喵秘书"。说话简短、可爱、有活力，偶尔卖个萌。用中文口语，一两句话，自然亲切。' +
    `\n当前时间：${now}。` +
    '\n关于待办：用户让你记/删/查待办这类事，系统会在后台处理，并把你该说的话直接给你，你照着可爱地说出来即可，不要自己编时间或编待办内容。其他闲聊就自然地陪用户聊。'
  )
}

async function getKey(userDataDir: string): Promise<string> {
  const raw = await fs.readFile(join(userDataDir, 'secrets.json'), 'utf8')
  const k = (JSON.parse(raw) as { dashscopeApiKey?: string }).dashscopeApiKey
  if (!k) throw new Error('secrets.json 里没有 dashscopeApiKey')
  return k
}

export interface OmniCallbacks {
  onAudio: (base64Pcm24k: string) => void
  onCatText: (text: string) => void
  /** 用户说完一句话的听写结果。这是主驱动：上层据此决定执行待办操作或闲聊回应。 */
  onUserText: (text: string) => void
  /** 用户开口打断猫说话：上层应立刻停掉正在播的回话音频。 */
  onInterrupt: () => void
  onError: (msg: string) => void
}

// 连接就绪前麦克风已在采集 —— 把这段音频缓存住，握手完成再补发，
// 否则"点猫立刻说话"的开头（常是动词，如"删掉…"）会被丢，STT 听不全→匹配失败。
const MAX_PENDING_BYTES = 16000 * 2 * 8 // 16k pcm16 ≈ 8 秒上限，超出丢最旧的

export class OmniSession {
  private ws: WebSocket | null = null
  private open = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  // 一次只能有一个进行中的回话：进行中再发 response.create 会被服务端拒（"already has an active response"）。
  // 故串行化——进行中时把新请求排队（新的覆盖旧的），收到 response.done 再发。
  private responseActive = false
  private pendingResponse: (() => void) | null = null
  private responseTimer: ReturnType<typeof setTimeout> | null = null
  private cancelling = false // 打断后到 response.done 之间，丢弃这条已取消回话的剩余音频
  constructor(private userDataDir: string, private cb: OmniCallbacks) {}

  async start(): Promise<void> {
    const key = await getKey(this.userDataDir)
    const ips = await realIps(HOST)
    // dashscope 有多个真实 IP，部分会被本机网关(如 Marvis)稳定 reset；逐个试到连通为止，记住连通的那个。
    let lastErr: unknown
    for (const ip of ips) {
      try {
        await this.connectTo(ip, key)
        markGood(HOST, ip)
        return
      } catch (e) {
        markBad(HOST, ip)
        try { this.ws?.close() } catch { /* noop */ }
        this.ws = null
        lastErr = e
      }
    }
    throw lastErr ?? new Error('Omni 所有真实 IP 均连接失败')
  }

  private connectTo(ip: string, key: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 连真实 IP，但 servername(SNI) 与 Host 头仍用域名，证书才校验得过、服务端也能正确路由。
      const ws = new WebSocket(`wss://${ip}${WS_PATH}`, {
        servername: HOST,
        headers: { Authorization: `Bearer ${key}`, Host: HOST }
      } as WebSocket.ClientOptions)
      this.ws = ws
      const timer = setTimeout(() => { try { ws.close() } catch { /* noop */ }; reject(new Error('Omni 连接超时')) }, 12000)
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              voice: getPersona().omniVoice,
              input_audio_format: INPUT_AUDIO_FORMAT,
              output_audio_format: 'pcm16',
              instructions: buildInstructions(),
              input_audio_transcription: { model: 'paraformer-realtime-v2' },
              // create_response:false → 服务器只做听写、不自动抢答；由上层(文字大脑判完)再决定让猫说什么。
              turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 300, create_response: false }
            }
          })
        )
        // 同一连接按序处理：session.update 已先发出，再补发缓存音频即可。
        this.open = true
        this.flushPending()
      })
      ws.on('message', (data: WebSocket.RawData) => {
        let ev: any
        try { ev = JSON.parse(data.toString()) } catch { return }
        // 调试用：把事件类型打到主进程日志
        if (ev?.type) console.log('[omni]', ev.type)
        switch (ev.type) {
          case 'session.created':
          case 'session.updated':
            clearTimeout(timer); resolve(); break
          case 'input_audio_buffer.speech_started':
            // 用户开口：若猫正在说话，就地打断（取消当前回话 + 让渲染端停播）
            this.bargeIn(); break
          case 'response.audio.delta':
            if (ev.delta && !this.cancelling) this.cb.onAudio(ev.delta); break
          case 'response.audio_transcript.done':
            if (ev.transcript && !this.cancelling) { console.log('[omni] cat:', ev.transcript); this.cb.onCatText(ev.transcript) }
            break
          case 'response.done':
            // 当前回话结束 → 清打断标记、放行排队中的下一条
            this.cancelling = false; this.finishResponse(); break
          case 'conversation.item.input_audio_transcription.completed':
            // 诊断关键：STT 把用户说的话听成了什么。匹配失败时先看这里。
            if (ev.transcript) { console.log('[omni] user:', ev.transcript); this.cb.onUserText(ev.transcript) }
            break
          case 'error':
            console.error('[omni] error', JSON.stringify(ev.error || ev))
            this.cb.onError(ev.error?.message || JSON.stringify(ev.error || ev)); break
        }
      })
      ws.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
      ws.on('close', () => { /* noop */ })
    })
  }

  appendAudio(pcm16k: Buffer): void {
    if (this.open && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16k.toString('base64') }))
      return
    }
    // 还没握手完：先缓存，open 后由 flushPending 补发，避免丢开头。
    this.pending.push(pcm16k)
    this.pendingBytes += pcm16k.length
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift()!.length
    }
  }

  /** 让猫用自己可爱的语气把指定内容说出来（系统算好的真实结果走这里）。 */
  say(text: string): void {
    this.requestResponse(() => {
      this.ws!.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `请用你可爱、简短的语气，把下面这句话自然地说给用户听，不要加别的解释：${text}` }] }
      }))
      this.ws!.send(JSON.stringify({ type: 'response.create' }))
    })
  }

  /** 让猫自然回应它刚听到的话（用于纯闲聊，没有待办操作时）。 */
  respondNatural(): void {
    this.requestResponse(() => {
      this.ws!.send(JSON.stringify({ type: 'response.create' }))
    })
  }

  // 用户开口打断：通知渲染端停播 + 若服务端还在生成则取消。
  // 关键：音频常已整段缓冲在客户端、服务端 response 早已 done，所以【不能】用 responseActive 判断——
  // 那样几乎永远 bail。一律让渲染端去停（在播才停、没播是空操作）；服务端真在生成才额外 cancel。
  private bargeIn(): void {
    this.cb.onInterrupt()            // 渲染端立刻停掉正在播/已缓冲的回话音频
    if (this.responseActive) {       // 服务端还在生成 → 取消，且丢弃排队回话、抑制后续音频
      this.cancelling = true
      this.pendingResponse = null
      try { this.ws?.send(JSON.stringify({ type: 'response.cancel' })) } catch { /* noop */ }
    }
  }

  // 串行化 response.create：进行中则排队（新的覆盖旧的），结束后再发。
  private requestResponse(send: () => void): void {
    if (this.responseActive) { this.pendingResponse = send; return }
    this.beginResponse(send)
  }
  private beginResponse(send: () => void): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.responseActive = true
    send()
    // 兜底：万一 response.done 没回来，20s 后强制放行，避免永久卡住
    if (this.responseTimer) clearTimeout(this.responseTimer)
    this.responseTimer = setTimeout(() => this.finishResponse(), 20000)
  }
  private finishResponse(): void {
    if (this.responseTimer) { clearTimeout(this.responseTimer); this.responseTimer = null }
    this.responseActive = false
    const next = this.pendingResponse
    this.pendingResponse = null
    if (next) this.beginResponse(next)
  }

  private flushPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    for (const buf of this.pending) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }))
    }
    if (this.pending.length) console.log('[omni] flushed pre-roll audio chunks:', this.pending.length)
    this.pending = []
    this.pendingBytes = 0
  }

  close(): void {
    try { this.ws?.close() } catch { /* noop */ }
    this.ws = null
    this.open = false
    this.pending = []
    this.pendingBytes = 0
    if (this.responseTimer) { clearTimeout(this.responseTimer); this.responseTimer = null }
    this.responseActive = false
    this.pendingResponse = null
    this.cancelling = false
  }
}
