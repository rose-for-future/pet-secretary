import { promises as fs } from 'fs'
import { join } from 'path'

// 文字"大脑"：把语音听写出来的文字交给可靠的 Qwen 文字模型做工具调用。
// 背景：实时语音模型在纯语音对话里经常"嘴上答应、不调工具"；同一句话给文字模型则稳定调用。
// 故把"听/说"留给 Omni，把"判断增删并执行"交给这里。成本极低（文字 token，远小于语音计费）。
const BRAIN_MODEL = 'qwen-plus'
const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

async function getKey(userDataDir: string): Promise<string> {
  const raw = await fs.readFile(join(userDataDir, 'secrets.json'), 'utf8')
  const k = (JSON.parse(raw) as { dashscopeApiKey?: string }).dashscopeApiKey
  if (!k) throw new Error('secrets.json 里没有 dashscopeApiKey')
  return k
}

// OpenAI 兼容格式的工具定义（DashScope compatible-mode 用 OpenAI 格式）
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: '用户要你提醒他、或要你记一件事/记备忘时调用，创建一条提醒。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '只填要做的事情本身，不要带时间词。例如"两分钟后叫我开会"，title 只填"开会"' },
          when: { type: 'string', description: '必须原样填用户说的时间词，如「一分钟后」「明天8点半」「下午三点」「下周一上午十点」。绝对不要自己换算成日期或 ISO 时间——换算由系统完成。用户没说时间就传空字符串' },
          lead_minutes: { type: 'integer', description: '要提前多少分钟提醒。提前20分钟填20、提前半小时填30；没说填0' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: { name: 'list_reminders', description: '用户问有哪些待办/日程、或让你念待办时调用。', parameters: { type: 'object', properties: {} } }
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: '用户要删除/取消某条待办时调用。优先用序号 index 定位；同名待办（如两条「开会」）必须靠 index 区分。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '要删除的待办的事项关键词，如 开会' },
          index: { type: 'integer', description: '该待办在当前清单里的序号（第几条，从 1 开始）。用户说「第2条/第二个/8点那条」时用序号填这里' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'complete_reminder',
      description: '用户说某件事做完了/已完成/搞定了时调用，把对应待办标记完成。优先用序号 index 定位。',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, index: { type: 'integer', description: '该待办在清单里的序号，从 1 开始' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_reminder',
      description: '用户要修改某条已有待办时调用。先用 index 或 title 定位要改哪条；每条待办有"事件时间"(事情几点发生)和"提醒时间"(几点叫他)，可以分别改。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '要修改的那条待办现在的事项关键词（用来定位），如 开会' },
          index: { type: 'integer', description: '要修改的那条待办在清单里的序号（第几条，从 1 开始），同名时必须用它定位' },
          new_when: { type: 'string', description: '泛指改时间时填这里（如「把开会改到明天9点」「改成下午三点」）——表示事件时间，提醒会按原提前量一起走。原样填时间词不要换算；不改时间就省略' },
          new_reminder_when: { type: 'string', description: '当用户明确说改"提醒/叫我"的时间、且不动事件本身时填这里（如「提醒时间改到8点」「提早点、8点叫我就行」）。原样填时间词；否则省略' },
          new_lead_minutes: { type: 'integer', description: '当用户说"提前X分钟提醒/提前半小时"时填这里（提前20分钟填20、半小时填30）；否则省略' },
          new_title: { type: 'string', description: '改成的新事项内容；不改内容就省略' }
        }
      }
    }
  }
]

export interface BrainOutput {
  /** 命中了某个待办操作就给出工具名+参数；纯闲聊则为 null。 */
  tool: { name: string; args: Record<string, unknown> } | null
  /** 闲聊时模型的文字回复（命中工具时为空）。 */
  reply: string
}

/** 把一句话交给文字大脑：返回要执行的工具，或闲聊回复。 */
export async function think(
  userDataDir: string,
  transcript: string,
  ctx: { now: string; todoList: string }
): Promise<BrainOutput> {
  const key = await getKey(userDataDir)
  const system =
    '你是桌面助手"喵秘书"的理解大脑。任务：判断用户这句话是不是要操作待办，并据此调用工具；不是就当闲聊。' +
    `\n当前时间：${ctx.now}。` +
    `\n用户现在的待办清单（按序号）：${ctx.todoList}` +
    '\n规则：用户要加提醒/记事/记备忘 → 调 create_reminder；问有哪些待办/让你念待办 → 调 list_reminders；要删除/取消某条 → 调 delete_reminder；说某事做完了/搞定了 → 调 complete_reminder；要改某条的时间或内容 → 调 update_reminder（先用 index/title 定位，再给 new_when/new_title）。' +
    '\n【修改要敢调 update_reminder】只要用户在纠正或改动某条已有待办，都算修改，例如：「把开会改到明天9点」「第2条改成下午三点」「时间应该是X」「那条主题是Y不是Z」「不对，是Y」「改回去」「把它的内容换成Y」。结合上面的待办清单定位是哪条（同名/不确定就用 index）。改时间分三种、按用户说法选填：泛泛"改到X点"→ new_when；明确"提醒/叫我的时间改成X、事件不动"→ new_reminder_when；"提前X分钟提醒"→ new_lead_minutes；改内容→ new_title。只改哪个就只给哪个，时间一律用原话时间词、不要换算。不要把这种纠正当成闲聊。' +
    '\n删除/完成优先用序号 index 定位（同名待办必须靠 index 区分）。create_reminder 的 when 必须填用户原话的时间词（如「一分钟后」「明天8点半」），绝对不要自己换算成具体日期/时刻（换算由系统负责）；lead_minutes 填提前分钟数（没说填0）。' +
    '\n【title 只填真正要做的事】「待办」「待办清单」「备忘」「提醒」「记一下」这些是动作/容器词，不是事项内容，绝不能当 title。例如「做一个待办清单、零点三十五写小红书」→ title 是「写小红书」不是「做待办清单」；「记一下买牛奶」→ title 是「买牛奶」。title 也不要带时间词。' +
    '\n如果只是问候、闲聊、跟待办完全无关，就不要调用任何工具，直接用一句可爱简短的中文回应。'

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: BRAIN_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: transcript }],
      tools: TOOLS,
      tool_choice: 'auto'
    })
  })
  if (!resp.ok) throw new Error(`brain HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name: string; arguments: string } }> } }>
  }
  const msg = data?.choices?.[0]?.message
  const tc = msg?.tool_calls?.[0]
  if (tc?.function) {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = {} }
    return { tool: { name: tc.function.name, args }, reply: '' }
  }
  return { tool: null, reply: msg?.content ?? '' }
}
