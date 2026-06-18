/**
 * 语音「删除/完成某条待办」的标题匹配。
 *
 * 背景：语音删除时好时坏，主因之一是 STT 把用户的话听出多余空格/标点，
 * 或模型传来的关键词与存量标题大小写/标点不一致，原先的裸 substring 匹配就落空。
 * 这里先做归一化（去空白与常见中英标点、转小写），再优先取完全相等
 * （避免「开会」误中「开会前准备」），无完全相等才退回双向子串。
 */

/** 归一化：去空白与常见中英标点、转小写。 */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s，。、！？!?.,~～·\-—…""'']/g, '')
}

/** 按标题匹配候选项；先完全相等，再双向子串。 */
export function matchByTitle<T extends { title: string }>(items: T[], query: string): T[] {
  const q = normalizeTitle(query)
  if (!q) return []
  const exact = items.filter((t) => normalizeTitle(t.title) === q)
  if (exact.length) return exact
  return items.filter((t) => {
    const nt = normalizeTitle(t.title)
    return nt.includes(q) || q.includes(nt)
  })
}
