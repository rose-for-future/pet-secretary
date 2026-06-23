// 绕开本机 DNS 劫持拿域名真实 IP，并在多个真实 IP 间挑能连通的那个。
// 背景：企业零信任/安全客户端（如腾讯 Marvis）会在系统层用 TUN + fake-ip 接管全部流量，
// 把 dashscope 解析成 198.19.x 假地址并 reset 掉这条路径 → app 连不上。
// 实测：直连阿里云真实 IP（SNI/Host=域名）可连通且证书校验通过，但 dashscope 有多个真实 IP，
// 其中部分（如北京 39.96.x）会被 Marvis 稳定 reset、另一些（杭州 8.x）放行。
// 故：① 用 DoH 拿到全部真实 IP；② 调用方逐个试到连通为止；③ 记住连通的那个，下次优先用。

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { ips: string[]; at: number }>()
const goodIp = new Map<string, string>() // 上次连通的 IP，优先排前

// DoH 也取不到时的兜底真实 IP（2026-06 实测，IP 轮换时由 DoH 覆盖）。
const FALLBACK: Record<string, string[]> = {
  'dashscope.aliyuncs.com': ['8.152.159.24', '8.140.217.18', '39.96.198.249', '39.96.213.166']
}

async function queryDoH(host: string): Promise<string[]> {
  // AliDNS DoH（JSON 格式）。直接连 IP 223.5.5.5，不经本机 DNS；JSON 载荷不会被 fake-ip 改写。
  const url = `https://223.5.5.5/resolve?name=${encodeURIComponent(host)}&type=A`
  const resp = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
  if (!resp.ok) throw new Error(`DoH HTTP ${resp.status}`)
  const data = (await resp.json()) as { Answer?: Array<{ type: number; data: string }> }
  // type=1 即 A 记录；过滤掉 CNAME(5) 等。
  return (data.Answer ?? []).filter((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)).map((a) => a.data)
}

/** 拿域名的全部候选真实 IP（缓存→DoH→内置兜底），已连通过的排最前。全失败才抛错。 */
export async function realIps(host: string): Promise<string[]> {
  let ips: string[] | undefined
  const c = cache.get(host)
  if (c && Date.now() - c.at < TTL_MS && c.ips.length) {
    ips = c.ips
  } else {
    try {
      const q = await queryDoH(host)
      if (q.length) {
        cache.set(host, { ips: q, at: Date.now() })
        ips = q
      }
    } catch {
      /* DoH 不可用：落到旧缓存或兜底 */
    }
    if (!ips) ips = c?.ips?.length ? c.ips : FALLBACK[host]
  }
  if (!ips || !ips.length) throw new Error(`无法解析 ${host} 的真实 IP`)
  const good = goodIp.get(host)
  if (good && ips.includes(good)) return [good, ...ips.filter((i) => i !== good)]
  return ips
}

/** 标记某 IP 连通成功（下次优先用）。 */
export function markGood(host: string, ip: string): void {
  goodIp.set(host, ip)
}

/** 标记某 IP 连不上（若它正是当前优先 IP 则取消优先，让下次换别的）。 */
export function markBad(host: string, ip: string): void {
  if (goodIp.get(host) === ip) goodIp.delete(host)
}

/** 清空某域名的解析缓存与连通记录（强制下次重新 DoH 解析；测试也用）。 */
export function invalidate(host: string): void {
  cache.delete(host)
  goodIp.delete(host)
}

/**
 * 启动时预热：并行 TLS 探一遍候选真实 IP，把最先连上的标为 good。
 * 这样用户第一次说话时 omni/brain 直接用通的 IP，省掉首连撞坏 IP（如北京 39.96.x 要 ~6s 才 reset）的延迟。
 */
export async function prewarm(host: string): Promise<void> {
  let ips: string[]
  try { ips = await realIps(host) } catch { return }
  if (!ips.length) return
  const { connect } = await import('tls')
  await new Promise<void>((resolve) => {
    const socks: import('tls').TLSSocket[] = []
    let settled = false
    let pending = ips.length
    const finish = (): void => {
      if (settled) return
      settled = true
      for (const s of socks) { try { s.destroy() } catch { /* noop */ } }
      resolve()
    }
    for (const ip of ips) {
      const sock = connect({ host: ip, servername: host, port: 443 }, () => { markGood(host, ip); finish() })
      socks.push(sock)
      sock.setTimeout(5000, () => sock.destroy())
      sock.on('error', () => { if (--pending <= 0) finish() })
    }
  })
}
