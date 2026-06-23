/**
 * 角色（persona）配置：把"它是猫/狗/别的"这些跟形象绑定的东西收在一处，
 * 以后换形象只改这里 / 调 setPersona，不用动散落各处的代码。
 */
export interface Persona {
  id: string
  /** 称呼，如「喵秘书」 */
  name: string
  /** 帧动画目录：public/pet/<frameBase>/（idle、head360…）。换形象时指到对应目录。 */
  frameBase: string
  /** macOS `say` 的音色（到点提醒用本地 TTS 念） */
  sayVoice: string
  /** Omni 实时语音音色（语音对话用） */
  omniVoice: string
  /** 到点提醒念的话（角色口吻） */
  announceReminder: (title: string, note?: string) => string
}

export const PERSONAS: Record<string, Persona> = {
  cat: {
    id: 'cat',
    name: '喵秘书',
    frameBase: 'cat_british',
    sayVoice: 'Tingting',
    omniVoice: 'Sunny',
    announceReminder: (title, note) => `喵～主人，该${title}啦${note ? '，' + note : ''}！`
  }
  // 以后加狗（等狗帧接好后启用）：
  // dog: {
  //   id: 'dog', name: '汪秘书', frameBase: 'dog_generated',
  //   sayVoice: 'Tingting', omniVoice: 'Ethan',
  //   announceReminder: (title, note) => `汪汪！主人，该${title}咯${note ? '，' + note : ''}！`
  // }
}

// Omni 实时语音可选音色（右键猫的「音色」菜单用这个列表）。label 只标名字+性别，
// 具体音色得听了才知道，不瞎描述；换/加音色改这里即可。
export const OMNI_VOICES: Array<{ id: string; label: string }> = [
  { id: 'Sunny', label: 'Sunny（女·默认）' },
  { id: 'Serena', label: 'Serena（女）' },
  { id: 'Kiki', label: 'Kiki（女）' },
  { id: 'Ethan', label: 'Ethan（男）' },
  { id: 'Dylan', label: 'Dylan（男）' }
]

let _current: Persona = PERSONAS.cat
export function getPersona(): Persona { return _current }
export function setPersona(id: string): boolean {
  if (!PERSONAS[id]) return false
  _current = PERSONAS[id]
  return true
}

/** 切换当前 persona 的 Omni 语音音色（只接受 OMNI_VOICES 里的）。不改 PERSONAS 模板本身。 */
export function setOmniVoice(voice: string): boolean {
  if (!OMNI_VOICES.some((v) => v.id === voice)) return false
  _current = { ..._current, omniVoice: voice }
  return true
}
