import { describe, it, expect, beforeEach } from 'vitest'
import { getPersona, setOmniVoice, OMNI_VOICES, setPersona } from './persona'

describe('persona omniVoice 切换', () => {
  beforeEach(() => {
    setPersona('cat')        // 复位到默认 persona
    setOmniVoice('Sunny')    // 复位默认音色
  })

  it('OMNI_VOICES 含 5 个音色且都有 id/label', () => {
    expect(OMNI_VOICES.length).toBe(5)
    expect(OMNI_VOICES.map((v) => v.id)).toContain('Sunny')
    expect(OMNI_VOICES.every((v) => v.id && v.label)).toBe(true)
  })

  it('setOmniVoice 合法音色：改当前 persona 的 omniVoice', () => {
    expect(setOmniVoice('Ethan')).toBe(true)
    expect(getPersona().omniVoice).toBe('Ethan')
  })

  it('setOmniVoice 非法音色：返回 false 且不改动', () => {
    expect(setOmniVoice('NotARealVoice')).toBe(false)
    expect(getPersona().omniVoice).toBe('Sunny')
  })
})
