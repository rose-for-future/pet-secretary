import { promises as fs } from 'fs'
import { join } from 'path'
import https from 'https'
import { realIps, markGood, markBad } from './doh'

// 文字"大脑"：把语音听写出来的文字交给可靠的 Qwen 文字模型做工具调用。
// 背景：实时语音模型在纯语音对话里经常"嘴上答应、不调工具"；同一句话给文字模型则稳定调用。
// 故把"听/说"留给 Omni，把"判断增删并执行"交给这里。成本极低（文字 token，远小于语音计费）。
// 模型选 qwen-turbo：实测比 qwen-plus 快 ~3x（命令 1.4s vs 4s），仍能正确调工具且跟得住复杂规则；
// 更快的 qwen-flash 在"分上午/晚上、改 vs 新建"等细节上不够稳，故不用。
const BRAIN_MODEL = 'qwen-turbo'
const HOST = 'dashscope.aliyuncs.com'
const PATH = '/compatible-mode/v1/chat/completions'
// 复用 TLS 连接：每句话省掉一次握手（~300-500ms）。
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 })

// 标记为"API 返回的错误"（如 401/429），换 IP 也没用，应直接抛；连接级错误(ECONNRESET/超时)才换 IP。
function httpErr(msg: string): Error {
  return Object.assign(new Error(msg), { httpError: true })
}

// 向单个真实 IP 发一次请求（SNI/Host 用域名），返回解析后的 JSON。
function postChatTo(ip: string, key: string, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        servername: HOST,
        port: 443,
        path: PATH,
        method: 'POST',
        agent,
        headers: {
          Host: HOST,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (r) => {
        let buf = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (buf += c))
        r.on('end', () => {
          const code = r.statusCode ?? 0
          if (code >= 200 && code < 300) {
            try { resolve(JSON.parse(buf)) } catch { reject(httpErr('brain 返回非 JSON: ' + buf.slice(0, 200))) }
          } else {
            reject(httpErr(`brain HTTP ${code}: ${buf.slice(0, 300)}`))
          }
        })
      }
    )
    req.on('error', reject) // 连接级错误（ECONNRESET 等），带 code
    req.setTimeout(20000, () => req.destroy(Object.assign(new Error('brain 连接超时'), { code: 'ETIMEDOUT' })))
    req.end(body)
  })
}

// 直连真实 IP（绕开本机 DNS 劫持，见 doh.ts）。dashscope 部分真实 IP 会被本机网关 reset，
// 逐个试到连通为止，记住连通的那个；真·API 错误(httpError)不换 IP 直接抛。
async function postChat(key: string, payload: unknown): Promise<unknown> {
  const ips = await realIps(HOST)
  const body = JSON.stringify(payload)
  let lastErr: unknown
  for (const ip of ips) {
    try {
      const data = await postChatTo(ip, key, body)
      markGood(HOST, ip)
      return data
    } catch (e) {
      lastErr = e
      if ((e as { httpError?: boolean })?.httpError) throw e
      markBad(HOST, ip) // 连接被掐 → 换下一个真实 IP
    }
  }
  throw lastErr ?? new Error('brain 所有真实 IP 均连接失败')
}

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
          when: { type: 'string', description: '必须原样填用户说的时间词，如「一分钟后」「明天8点半」「下午三点」。周期提醒也要填时段+钟点（如「晚上8点」）。绝对不要自己换算成日期或 ISO 时间——换算由系统完成。用户没说时间就传空字符串' },
          lead_minutes: { type: 'integer', description: '要提前多少分钟提醒。提前20分钟填20、提前半小时填30；没说填0' },
          repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'weekdays', 'monthly'], description: '是否重复：不重复填 none 或省略；每天 daily；每周某天 weekly（同时填 repeat_weekday）；工作日/每个工作日 weekdays；每月某号 monthly（同时填 repeat_monthday）' },
          repeat_weekday: { type: 'integer', description: 'repeat=weekly 时填星期几：周一=1、周二=2…周六=6、周日=7' },
          repeat_monthday: { type: 'integer', description: 'repeat=monthly 时填几号（1-31）' }
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
      name: 'act_on_tasks',
      description:
        '对待办做"删除"或"标记完成"。通用接口：你自己从上面带序号的清单里，挑出用户指的那些待办的序号放进 indices——一条、多条、按任意条件（如"所有小红书""明天的""每天那条"）都行；"全部/清空/都删了"则用 all:true。action 填 delete（删除）或 complete（完成）。' +
        '只有当你确实分不清用户指哪条（如多条同名又没说清）时，才不要调它，而是用文字反问让用户说清，绝不要乱猜序号、更不要假装做了。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['delete', 'complete'], description: 'delete=删除，complete=标记完成' },
          indices: { type: 'array', items: { type: 'integer' }, description: '要操作的待办在清单里的序号（从1开始），可多个' },
          all: { type: 'boolean', description: '操作全部待办时填 true（清空/全部删了/全部完成）' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '当用户明确要你记住某事、或说出一个长期偏好/习惯/称呼/事实时调用，如「记住我开会都提前15分钟」「叫我小李」「我每晚写小红书」「我对花生过敏」。注意：一次性的待办/提醒用 create_reminder，不要用 remember。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要长期记住的事，一句话，简洁完整（如「开会习惯提前15分钟提醒」「称呼用户为小李」）' },
          kind: { type: 'string', enum: ['preference', 'fact', 'habit'], description: '偏好/事实/习惯' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: { name: 'list_memory', description: '用户问"你记得我什么/你都知道我啥"时调用。', parameters: { type: 'object', properties: {} } }
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: '用户要你忘掉某条记忆时调用。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '要忘掉的记忆关键词' }, index: { type: 'integer', description: '记忆清单里的序号' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_reminder',
      description: '用户要修改某条已有待办时调用（改时间/内容/重复方式都用它，绝不要为"修改"去新建）。先用 index 或 title 定位要改哪条。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '要修改的那条待办现在的事项关键词（用来定位），如 开会' },
          index: { type: 'integer', description: '要修改的那条待办在清单里的序号（第几条，从 1 开始），同名时必须用它定位' },
          new_when: { type: 'string', description: '泛指改时间时填这里（如「把开会改到明天9点」「改成下午三点」）。原样填时间词不要换算；不改时间就省略' },
          new_reminder_when: { type: 'string', description: '当用户明确说改"提醒/叫我"的时间、且不动事件本身时填这里。原样填时间词；否则省略' },
          new_lead_minutes: { type: 'integer', description: '当用户说"提前X分钟提醒"时填这里；否则省略' },
          new_title: { type: 'string', description: '改成的新事项内容；不改内容就省略' },
          repeat: { type: 'string', enum: ['daily', 'weekly', 'weekdays', 'monthly', 'none'], description: '改重复方式时填：把现有这条改成每天=daily、每周某天=weekly(配 repeat_weekday)、工作日=weekdays、每月某号=monthly(配 repeat_monthday)、取消重复只剩一次=none。不改重复就省略' },
          repeat_weekday: { type: 'integer', description: 'repeat=weekly 时填星期几（周一=1…周日=7）' },
          repeat_monthday: { type: 'integer', description: 'repeat=monthly 时填几号（1-31）' }
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

export interface ConvoTurn { role: 'user' | 'assistant'; content: string }

/** 把一句话（带最近对话上下文）交给文字大脑：返回要执行的工具，或要说的话。 */
export async function think(
  userDataDir: string,
  transcript: string,
  ctx: { now: string; todoList: string; memory: string; history: ConvoTurn[] }
): Promise<BrainOutput> {
  const key = await getKey(userDataDir)
  const system =
    '你是桌面宠物助手"喵秘书"，一只元气可爱的小猫。判断用户这句话是不是要操作待办/记忆并调用对应工具；只是闲聊就用可爱、简短的中文口语回一两句（偶尔卖个萌）。' +
    `\n当前时间：${ctx.now}。` +
    `\n用户现在的待办清单（按序号）：${ctx.todoList}` +
    `\n关于用户你已经记住的事（长期记忆）：${ctx.memory}` +
    '\n【善用记忆】判断和填参数时要用上这些记忆。例如已知"开会习惯提前15分钟"，用户只说"提醒我开会"时，create_reminder 就自动带 lead_minutes:15；已知称呼就用上。' +
    '\n【真话底线·最高优先级】你绝对不能凭空说「已删除/已清空/清完啦/已完成/已加好/已改好/已记住」这类"做完了"的话——这些只能由工具执行后、用系统返回给你的结果来说。要做就调工具；做不到、没有对应工具能做的事，就老实说「这个我还做不到喵」，绝不准假装做了。' +
    '\n【记忆规则】只有用户明确要你记住、或说出长期偏好/习惯/称呼/事实时，才调 remember；一次性的待办用 create_reminder，绝不要 remember。用户问"你记得我什么"→list_memory；让你"忘掉X"→forget。' +
    '\n规则：用户要加提醒/记事/记备忘 → 调 create_reminder；问有哪些待办/让你念待办 → 调 list_reminders；要改某条的时间或内容 → 调 update_reminder；要删除/取消/标记完成/清空（一条、多条、按条件、全部）→ 调 act_on_tasks。' +
    '\n【act_on_tasks 用法】这是删除和完成的通用接口：上面的带序号清单已经给你了，要删/完成时直接从中挑序号放进 indices（"所有小红书""明天的""第2条"都由你自己看清单选好，不用再先 list_reminders），"全部/清空/都删了"用 all:true；action 填 delete 或 complete。挑不准是哪条（多条同名又没说清）才反问，别乱选、别假装。' +
    '\n【修改要敢调 update_reminder】只要用户在纠正或改动某条已有待办，都算修改，例如：「把开会改到明天9点」「第2条改成下午三点」「时间应该是X」「那条主题是Y不是Z」「不对，是Y」「改回去」「把它的内容换成Y」。结合上面的待办清单定位是哪条（同名/不确定就用 index）。改时间分三种、按用户说法选填：泛泛"改到X点"→ new_when；明确"提醒/叫我的时间改成X、事件不动"→ new_reminder_when；"提前X分钟提醒"→ new_lead_minutes；改内容→ new_title。只改哪个就只给哪个，时间一律用原话时间词、不要换算。不要把这种纠正当成闲聊。' +
    '\n【改重复方式也是 update，别新建】用户把"已有的某条"改成每天/每周X/工作日/每月X号、或取消重复，一律用 update_reminder 的 repeat 字段（daily/weekly+repeat_weekday/weekdays/monthly+repeat_monthday/none），定位用 index/title。绝对不要为了"改成每天"去 create_reminder 新建一条——那会变成多出一条。例：清单里已有「写快照(今天23:55)」，用户说"把它改成每天" → update_reminder{index:那条, repeat:"daily"}（不给时间就沿用它原来的点）。' +
    '\ncreate_reminder 的 when 必须填用户原话的时间词（如「一分钟后」「明天8点半」），绝对不要自己换算成具体日期/时刻（换算由系统负责）；lead_minutes 填提前分钟数（没说填0）。' +
    '\n【重复/周期提醒】用户说"每天/每周X/工作日/每月X号"这类要重复的，用 create_reminder 并填 repeat（每天=daily、每周几=weekly+repeat_weekday、工作日=weekdays、每月几号=monthly+repeat_monthday），when 仍填时段+钟点。重复提醒不用问"哪天"（它本来就天天/每周repeat），但若钟点分不清上午晚上仍要按上面规则反问。不重复的就别填 repeat。' +
    '\n【title 只填真正要做的事】「待办」「待办清单」「备忘」「提醒」「记一下」这些是动作/容器词，不是事项内容，绝不能当 title。例如「做一个待办清单、零点三十五写小红书」→ title 是「写小红书」不是「做待办清单」；「记一下买牛奶」→ title 是「买牛奶」。title 也不要带时间词。' +
    '\n【只在分不清上午/晚上时才反问】如果钟点是 1~12 点、又没有 上午/下午/晚上/早上/中午/凌晨/傍晚 这类时段词、也不是 13 点以上的24小时制（如「11点」「7点」「9点半」就分不清上午晚上），先反问一句「上午还是晚上呀？」，这时不调工具；答清楚后再调 create_reminder。' +
    '\n【没说哪一天：不要问，直接建】用户只说了钟点没说哪天（如「晚上11点」「0点40」「下午3点」），不要追问"今天还是明天"——直接调 create_reminder，when 原样填用户说的（系统会自动定到"下一个最近的那次"并把具体日期算好、念给用户听）。带时段的、24小时制的、相对时间（「十分钟后」）都直接建。' +
    '\n【结合最近对话】下面可能给你最近几轮对话作上下文。只对用户最新这句话做反应、不要重复执行已经做过的操作；但如果你上一句正好在问日期/在追问，而用户这句回答了，就把它和上文合起来调用对应工具。' +
    '\n如果只是问候、闲聊、跟待办完全无关，就不要调用任何工具，直接用一句可爱简短的中文回应。'

  const data = (await postChat(key, {
    model: BRAIN_MODEL,
    messages: [{ role: 'system', content: system }, ...ctx.history, { role: 'user', content: transcript }],
    tools: TOOLS,
    tool_choice: 'auto'
  })) as {
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
