import { describe, it, expect, vi, beforeEach } from 'vitest'
import { realIps, markGood, markBad, invalidate } from './doh'

const DASH = 'dashscope.aliyuncs.com'

function mockFetch(answer: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => answer })))
}

describe('doh realIps', () => {
  beforeEach(() => {
    // 清掉解析缓存 + sticky good IP，避免用例间互相影响
    invalidate(DASH)
    invalidate('unknown.example.com')
    vi.unstubAllGlobals()
  })

  it('DoH 成功时返回全部 A 记录，过滤掉非 A 记录', async () => {
    mockFetch({ Answer: [{ type: 5, data: 'cname.x' }, { type: 1, data: '1.2.3.4' }, { type: 1, data: '5.6.7.8' }] })
    expect(await realIps(DASH)).toEqual(['1.2.3.4', '5.6.7.8'])
  })

  it('命中缓存时不再发起 DoH 请求', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ Answer: [{ type: 1, data: '1.2.3.4' }] }) }))
    vi.stubGlobal('fetch', f)
    await realIps(DASH)
    await realIps(DASH)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('markGood 后把连通过的 IP 排到最前', async () => {
    mockFetch({ Answer: [{ type: 1, data: '1.2.3.4' }, { type: 1, data: '5.6.7.8' }] })
    await realIps(DASH)
    markGood(DASH, '5.6.7.8')
    expect((await realIps(DASH))[0]).toBe('5.6.7.8')
  })

  it('markBad 取消优先：被标坏的 IP 不再排最前', async () => {
    mockFetch({ Answer: [{ type: 1, data: '1.2.3.4' }, { type: 1, data: '5.6.7.8' }] })
    await realIps(DASH)
    markGood(DASH, '5.6.7.8')
    markBad(DASH, '5.6.7.8')
    expect((await realIps(DASH))[0]).toBe('1.2.3.4')
  })

  it('DoH 失败时回退到内置真实 IP 列表', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    const ips = await realIps(DASH)
    expect(ips).toContain('8.152.159.24')
    expect(ips.length).toBeGreaterThan(1)
  })

  it('未知域名且 DoH 失败时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    await expect(realIps('unknown.example.com')).rejects.toThrow()
  })
})
