import { describe, it, expect } from 'vitest'
import { normalizeTitle, matchByTitle } from './title-match'

const tasks = (...titles: string[]): { title: string }[] => titles.map((title) => ({ title }))

describe('normalizeTitle', () => {
  it('去空白与标点、转小写', () => {
    expect(normalizeTitle('  开 会 ')).toBe('开会')
    expect(normalizeTitle('开会！')).toBe('开会')
    expect(normalizeTitle('Buy Milk.')).toBe('buymilk')
  })
})

describe('matchByTitle', () => {
  it('完全相等优先，不被更长的标题抢走', () => {
    const r = matchByTitle(tasks('开会', '开会前准备'), '开会')
    expect(r.map((t) => t.title)).toEqual(['开会'])
  })

  it('吸收 STT 的空格/标点差异', () => {
    expect(matchByTitle(tasks('开会'), '开 会！')).toHaveLength(1)
  })

  it('关键词是标题子串也能命中', () => {
    const r = matchByTitle(tasks('去医院复诊'), '医院')
    expect(r.map((t) => t.title)).toEqual(['去医院复诊'])
  })

  it('标题是关键词子串也能命中（模型多说了字）', () => {
    const r = matchByTitle(tasks('开会'), '下午的开会')
    expect(r.map((t) => t.title)).toEqual(['开会'])
  })

  it('无匹配返回空', () => {
    expect(matchByTitle(tasks('开会', '买菜'), '健身')).toEqual([])
  })

  it('空关键词返回空', () => {
    expect(matchByTitle(tasks('开会'), '   ')).toEqual([])
  })

  it('多条子串匹配时全部返回（交由调用方提示更具体）', () => {
    const r = matchByTitle(tasks('买菜', '买菜谱'), '买菜')
    // 「买菜」完全相等优先，只返回它
    expect(r.map((t) => t.title)).toEqual(['买菜'])
  })

  it('无完全相等时返回多条子串候选', () => {
    const r = matchByTitle(tasks('上午开会', '下午开会'), '开会')
    expect(r).toHaveLength(2)
  })
})
