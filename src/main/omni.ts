import WebSocket from 'ws'
import { promises as fs } from 'fs'
import { join } from 'path'

// ⚠️ 可能需要现场微调的常量（连不上/报错时优先改这三个）
const MODEL = 'qwen3.5-omni-flash-realtime'      // flash 版：更快更便宜；备选 'qwen-omni-turbo-realtime'
const VOICE = 'Sunny'                            // 可用音色: Serena/Sunny/Kiki(女) Ethan/Dylan(男)
const INPUT_AUDIO_FORMAT = 'pcm16'               // 备选: 'pcm'
const WS_URL = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${MODEL}`

function buildInstructions(): string {
  const now = new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' })
  return (
    '你是一只元气活泼的小猫咪桌面助手，名字叫"喵秘书"。说话简短、可爱、有活力，偶尔卖个萌。用中文口语，回答简短自然。' +
    `\n当前时间：${now}。` +
    '\n【铁律·最高优先级】凡涉及待办的"增/删/改/查"，你必须先调用对应工具、拿到工具返回的真实结果，再开口说话：' +
    '\n· 用户让你提醒他 / 记一件事 / 记备忘 → 调 create_reminder' +
    '\n· 用户问有哪些待办/日程、或让你念待办 → 调 list_reminders（读真实数据，绝不编造或猜测）' +
    '\n· 用户要删除 / 取消 某条 → 调 delete_reminder' +
    '\n· 用户说某事做完了 / 搞定了 / 已完成 → 调 complete_reminder' +
    '\n【绝对禁止】在没有调用工具、没拿到工具结果之前，就说「好的，已经帮你删了/记下了/加好了/搞定了」这类话——那等于撒谎。哪怕你觉得刚刚已经做过，也要重新调用一次工具来确认。' +
    '\n【纠错】如果用户反复说「还没删掉/还在/没加上/没生效」，说明你上一次只是嘴上答应、并没有真的调工具——请立刻调用对应工具重试，不要再空口解释。' +
    '\n【同名/不确定要操作哪条】清单是带序号的（第1条、第2条…）。当有多条同名（如两条「开会」）或你不确定用户指哪条时，不要乱猜：先念出带序号和时间的候选问「要操作第几条」，用户报序号后，用 index 调用 delete_reminder / complete_reminder。用户直接说「删第2条」也用 index。' +
    '\n【create_reminder 调用规则】when 填事件发生的时间（按用户原话，如「明天8点半」「下午三点」「十分钟后」，用户没说时间就传空字符串）；' +
    'lead_minutes 填要提前几分钟（用户说「提前20分钟」填20、「提前半小时」填30，没说填0）；' +
    'title 只填事情本身、不要带时间词。最终提醒时间(事件减提前量)由系统计算，你不要自己算、也不要自己报时间。'
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
  onUserText: (text: string) => void
  onError: (msg: string) => void
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>
}

// 连接就绪前麦克风已在采集 —— 把这段音频缓存住，握手完成再补发，
// 否则"点猫立刻说话"的开头（常是动词，如"删掉…"）会被丢，STT 听不全→匹配失败。
const MAX_PENDING_BYTES = 16000 * 2 * 8 // 16k pcm16 ≈ 8 秒上限，超出丢最旧的

export class OmniSession {
  private ws: WebSocket | null = null
  private open = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  constructor(private userDataDir: string, private cb: OmniCallbacks) {}

  async start(): Promise<void> {
    const key = await getKey(this.userDataDir)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${key}` } })
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('Omni 连接超时')), 12000)
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              voice: VOICE,
              input_audio_format: INPUT_AUDIO_FORMAT,
              output_audio_format: 'pcm16',
              instructions: buildInstructions(),
              input_audio_transcription: { model: 'paraformer-realtime-v2' },
              turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
              tools: [
                {
                  type: 'function',
                  name: 'create_reminder',
                  description: '当用户要你提醒他、或要你记一件事/记备忘时调用，创建一条提醒。',
                  parameters: {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: '只填要做的事情本身，不要带时间词；例如用户说"两分钟后叫我开会"，title 只填"开会"' },
                      when: { type: 'string', description: '事件发生的时间，按用户原话填，如 明天8点半 / 下午三点 / 十分钟后 / 下周一上午十点；用户没说时间就传空字符串' },
                      lead_minutes: { type: 'integer', description: '要提前多少分钟提醒。提前20分钟填20，提前半小时填30；用户没说就填0' }
                    },
                    required: ['title']
                  }
                },
                {
                  type: 'function',
                  name: 'list_reminders',
                  description: '用户问有哪些待办/日程/提醒、或让你念出/查看待办时调用，返回当前真实的待办列表。必须用它看真实数据，不要凭空编。',
                  parameters: { type: 'object', properties: {} }
                },
                {
                  type: 'function',
                  name: 'delete_reminder',
                  description: '用户要删除/取消某条待办时调用。优先用序号定位：用户说「删第2条/第二个」就填 index；只说事项名就填 title；两个都说了就都填。同名待办（如两条「开会」）必须靠 index 区分。',
                  parameters: {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: '要删除的待办的事项关键词，如 开会' },
                      index: { type: 'integer', description: '要删除的待办在当前清单里的序号（第几条，从 1 开始）。用户说「第2条/第二个/8点那条」时，用清单里的序号填这里' }
                    }
                  }
                },
                {
                  type: 'function',
                  name: 'complete_reminder',
                  description: '用户说某件事做完了/已完成/搞定了时调用，把对应待办标记完成。优先用序号定位：用户说「第2条做完了」就填 index；只说事项名就填 title。同名待办必须靠 index 区分。',
                  parameters: {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: '已完成的待办的事项关键词' },
                      index: { type: 'integer', description: '已完成的待办在当前清单里的序号（第几条，从 1 开始）' }
                    }
                  }
                }
              ],
              tool_choice: 'auto'
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
          case 'response.audio.delta':
            if (ev.delta) this.cb.onAudio(ev.delta); break
          case 'response.audio_transcript.done':
            if (ev.transcript) { console.log('[omni] cat:', ev.transcript); this.cb.onCatText(ev.transcript) }
            break
          case 'conversation.item.input_audio_transcription.completed':
            // 诊断关键：STT 把用户说的话听成了什么。匹配失败时先看这里。
            if (ev.transcript) { console.log('[omni] user:', ev.transcript); this.cb.onUserText(ev.transcript) }
            break
          case 'error':
            console.error('[omni] error', JSON.stringify(ev.error || ev))
            this.cb.onError(ev.error?.message || JSON.stringify(ev.error || ev)); break
          case 'response.function_call_arguments.done': {
            let args: Record<string, unknown>
            try { args = JSON.parse(ev.arguments || '{}') } catch { args = {} }
            const callId = ev.call_id as string
            console.log('[omni] tool_call', ev.name, ev.arguments)
            const wsRef = this.ws!
            void (async (): Promise<void> => {
              try {
                const result = await this.cb.onToolCall(ev.name as string, args)
                console.log('[omni] tool_result', result)
                // 把工具执行结果回传，并触发模型口头确认
                wsRef.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: result } }))
                wsRef.send(JSON.stringify({ type: 'response.create' }))
              } catch (err) {
                this.cb.onError((err as Error).message || String(err))
              }
            })()
            break
          }
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
  }
}
