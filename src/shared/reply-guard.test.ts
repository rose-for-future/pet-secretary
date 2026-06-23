import { describe, it, expect } from 'vitest'
import { claimsCompletion } from './reply-guard'

describe('claimsCompletion（拦截"没做却说做完了"的假话）', () => {
  it('声称完成的话 → 拦', () => {
    for (const s of [
      '好哒，零点四十的闹钟已经帮你设好啦',
      '清完啦！现在清单空空的',
      '已经帮你删掉了',
      '好的，已删除',
      '提醒加好了喵',
      '已完成啦',
      '搞定了',
      '都清空了',
      '已经记下了'
    ]) {
      expect(claimsCompletion(s), s).toBe(true)
    }
  })

  it('正常的反问/闲聊 → 不拦', () => {
    for (const s of [
      '你是说今天还是明天呀？',
      '你想删哪一条呢？',
      '好呀，要几点提醒你？',
      '哈喽主人，今天想聊什么喵～',
      '你确定要清空全部吗？',
      '这个我还做不到喵'
    ]) {
      expect(claimsCompletion(s), s).toBe(false)
    }
  })
})
