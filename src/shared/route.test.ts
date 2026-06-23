import { describe, it, expect } from 'vitest'
import { needsBrain } from './route'

// 路由：判断一句话是否需要走"文字大脑"(qwen-plus，能调待办/记忆工具，慢但准)。
// false = 纯闲聊，走 Omni 端到端快聊。
// 偏向：宁可把含任务信号的句子送去大脑（大脑没工具可调时也会闲聊），
// 所以"漏判成闲聊"才是要防的——含明确任务/记忆/时间信号一律 true。
describe('needsBrain', () => {
  describe('纯闲聊 → 不走大脑 (false)', () => {
    const chitchat = [
      '你好呀',
      '喵秘书你在干嘛',
      '你叫什么名字',
      '今天心情不错',
      '我有点累了',
      '讲个笑话听听',
      '你喜欢吃鱼吗',
      '在吗',
      '哈哈你好可爱',
      '猫猫晚安'
    ]
    it.each(chitchat)('「%s」是闲聊', (text) => {
      expect(needsBrain(text)).toBe(false)
    })
  })

  describe('待办/记忆/时间 → 走大脑 (true)', () => {
    const taskish = [
      '提醒我明天8点半开会',
      '十分钟后叫我喝水',
      '记一下买牛奶',
      '我有哪些待办',
      '念一下我的日程',
      '把开会删了',
      '取消那条提醒',
      '清空全部待办',
      '第二条标记完成',
      '把开会改到下午三点',
      '推迟半小时',
      '每天晚上8点提醒我写日记',
      '工作日早上叫我起床',
      '记住我叫小李',
      '我对花生过敏，记一下',
      '你还记得我什么',
      '把叫我喝水那条忘掉'
    ]
    it.each(taskish)('「%s」需要大脑', (text) => {
      expect(needsBrain(text)).toBe(true)
    })
  })

  it('空字符串当闲聊处理', () => {
    expect(needsBrain('')).toBe(false)
    expect(needsBrain('   ')).toBe(false)
  })
})
