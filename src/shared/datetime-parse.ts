/**
 * Offline Chinese natural-language date/time parser.
 *
 * Uses chrono-node's Chinese (zh) parser for offline, zero-API parsing.
 *
 * Timezone assumption: the `timezone` parameter is accepted for API consistency
 * with other shared modules, but the offline parser relies on the Node.js
 * runtime timezone (process.env.TZ or OS default) to interpret absolute times
 * like "明天下午三点". Callers should ensure the runtime TZ matches the user's
 * timezone. This is the same single-tz assumption used in P1.
 */

import * as chrono from 'chrono-node'

export interface ParsedWhen {
  /** The parsed event time in UTC milliseconds */
  eventTimeUtc: number
  /** Lead time extracted from phrases like "提前X分钟", default 0 */
  leadMinutes: number
}

/**
 * Lead phrase patterns (matched and stripped before chrono parsing):
 *   提前半(个)?小时       → 30 minutes
 *   提前(\d+)(个)?小时    → N * 60 minutes
 *   提前(\d+)分钟?        → N minutes
 */
const LEAD_PATTERNS: Array<{ re: RegExp; extract: (m: RegExpMatchArray) => number }> = [
  {
    // 提前半小时 / 提前半个小时
    re: /提前半(个)?小时/,
    extract: () => 30
  },
  {
    // 提前N个小时 / 提前N小时
    re: /提前(\d+)(个)?小时/,
    extract: (m) => parseInt(m[1], 10) * 60
  },
  {
    // 提前N分钟 / 提前N分
    re: /提前(\d+)分钟?/,
    extract: (m) => parseInt(m[1], 10)
  }
]

/**
 * Parse a Chinese natural-language string for a date/time and optional lead.
 *
 * @param text      - User input (e.g. "明天下午三点开会，提前半小时")
 * @param nowMs     - Current time as UTC milliseconds (reference for relative times)
 * @param timezone  - User's IANA timezone (e.g. "Asia/Shanghai"). See module-level
 *                    note: this is stored for API consistency; the runtime TZ is
 *                    what actually governs absolute-time parsing by chrono-node.
 * @returns ParsedWhen with eventTimeUtc and leadMinutes, or null if no date/time found.
 */
/**
 * 归一化 chrono 处理不好的午夜说法：
 *  - 「24点 / 二十四点」表示当天结束 = 次日零点（chrono 直接返回 null）
 *  - 「晚上/今晚/半夜 12点」表示午夜零点（chrono 会误判成中午 12:00）
 * 统一改写成 chrono 认得、且日期正确的「0点 / 明天0点」。
 */
function normalizeMidnight(s: string): string {
  // 24点：带「今天/今晚」前缀的 = 明天0点；裸「24点」靠 forwardDate 落到下一个 0 点（即明天）
  s = s.replace(/(今天|今晚|今夜|今)?(二十四|二四|24)点/g, (_m, day) => (day ? '明天0点' : '0点'))
  // 夜间 12 点 = 午夜，等于（今晚的）明天 0 点
  s = s.replace(/(今天晚上|今晚|晚上|半夜|夜里)(十二|12)点/g, '明天0点')
  return s
}

export function parseWhen(text: string, nowMs: number, timezone: string): ParsedWhen | null {
  // Suppress unused-param lint while keeping the param for API consistency.
  void timezone

  let leadMinutes = 0
  let stripped = normalizeMidnight(text)

  // Try each lead pattern; use first match found.
  for (const { re, extract } of LEAD_PATTERNS) {
    const match = stripped.match(re)
    if (match) {
      leadMinutes = extract(match)
      stripped = stripped.replace(match[0], '').trim()
      break
    }
  }

  const refDate = new Date(nowMs)
  const parsed = chrono.zh.parseDate(stripped, refDate, { forwardDate: true })

  if (!parsed) {
    return null
  }

  return {
    eventTimeUtc: parsed.getTime(),
    leadMinutes
  }
}
