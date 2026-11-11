/**
 * 时间展示规则（PRD 8.2 / 12.2）
 * 卡片右上角用相对时间：刚刚 / N 分钟前 / 今天 08:20 / 昨天 21:03 / 11月3日
 * 分组标题用自然日：今天 / 昨天 / 11月3日（跨年补年份）
 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 相差几个自然日（只看日期，不看时刻） */
function dayDiff(ts, base) {
  return Math.round((startOfDay(base || Date.now()) - startOfDay(ts)) / 86400000)
}

function dayKey(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function hhmm(ts) {
  const d = new Date(ts)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function monthDay(ts) {
  const d = new Date(ts)
  return d.getMonth() + 1 + '月' + d.getDate() + '日'
}

function sameYear(ts) {
  return new Date(ts).getFullYear() === new Date().getFullYear()
}

/** 卡片右下角的相对时间 */
function relative(ts) {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  const d = dayDiff(ts, now)
  if (d === 0) return '今天 ' + hhmm(ts)
  if (d === 1) return '昨天 ' + hhmm(ts)
  if (d < 7) return WEEK[new Date(ts).getDay()] + ' ' + hhmm(ts)
  return sameYear(ts) ? monthDay(ts) : new Date(ts).getFullYear() + '年' + monthDay(ts)
}

/** 分组标题 */
function dayLabel(ts) {
  const d = dayDiff(ts, Date.now())
  if (d === 0) return '今天'
  if (d === 1) return '昨天'
  if (d === 2) return '前天'
  return sameYear(ts) ? monthDay(ts) : new Date(ts).getFullYear() + '年' + monthDay(ts)
}

/** 详情页用完整时间 */
function fullTime(ts) {
  const d = new Date(ts)
  return (
    d.getFullYear() +
    '年' +
    (d.getMonth() + 1) +
    '月' +
    d.getDate() +
    '日 ' +
    hhmm(ts)
  )
}

/** 录音计时 00:12 */
function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0))
  return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60)
}

/* ---------------------- 周 / 月 / 年 时间桶 ---------------------- */

/** 所在自然周的周一 00:00（中国人习惯周一为一周之始） */
function startOfWeek(ts) {
  const d = new Date(startOfDay(ts))
  const offset = (d.getDay() + 6) % 7 // 周一 = 0，周日 = 6
  return d.getTime() - offset * 86400000
}

function monthKey(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1)
}

/**
 * 把一条记录归入时间桶。规则（自上而下，命中即止）：
 *   今天   —— 自然日差 ≤ 0（含手机时间超前产生的"未来"记录）
 *   本周   —— 与本机同一自然周（周一为起点），且不是今天
 *   本月   —— 同一自然月，且不在本周
 *   今年   —— 同一年，且不在本月
 *   往年   —— 按年份各成一组，如「2025年」
 * 桶内顺序沿用传入顺序（调用前必须已按时间倒序）
 */
function bucketOf(ts, now) {
  const base = now || Date.now()

  if (dayDiff(ts, base) <= 0) {
    return { key: 'today', label: '今天', kind: 'today' }
  }

  if (startOfWeek(ts) === startOfWeek(base)) {
    return { key: 'week:' + startOfWeek(ts), label: '本周', kind: 'week' }
  }

  const d = new Date(ts)
  const n = new Date(base)
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()) {
    return { key: 'month:' + monthKey(ts), label: '本月', kind: 'month' }
  }

  if (d.getFullYear() === n.getFullYear()) {
    return { key: 'year:' + d.getFullYear(), label: '今年', kind: 'year' }
  }

  return { key: 'year:' + d.getFullYear(), label: d.getFullYear() + '年', kind: 'past' }
}

/** 分桶：返回 [{key, label, kind, today, items, count}]，顺序即展示顺序 */
function groupBuckets(list, now) {
  const out = []
  const map = {}
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const b = bucketOf(item.createdAt, now)
    let g = map[b.key]
    if (!g) {
      g = { key: b.key, label: b.label, kind: b.kind, today: b.kind === 'today', items: [], count: 0 }
      map[b.key] = g
      out.push(g)
    }
    g.items.push(item)
    g.count++
  }
  return out
}

/** 按自然日分组，入参必须已按时间倒序 */
function group(list) {
  const out = []
  let current = null
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const key = dayKey(item.createdAt)
    if (!current || current.key !== key) {
      current = { key: key, label: dayLabel(item.createdAt), items: [] }
      out.push(current)
    }
    current.items.push(item)
  }
  return out
}

/* ------------------------- 回顾：那年今日 ------------------------- */

/**
 * 在历史记录里找"去年/前年同一天"的那一条。
 * 只取最近的一年，不一次抛一堆——回顾是惊喜，不是信息轰炸。
 * @returns {{item:object, yearsAgo:number, label:string}|null}
 */
function sameDayPast(list, now) {
  const base = new Date(now || Date.now())
  const month = base.getMonth() + 1
  const date = base.getDate()

  let best = null
  ;(list || []).forEach(item => {
    const d = new Date(item.createdAt)
    if (d.getMonth() + 1 !== month || d.getDate() !== date) return
    const diff = base.getFullYear() - d.getFullYear()
    if (diff < 1) return
    if (!best || diff < best.yearsAgo) best = { item: item, yearsAgo: diff }
  })

  if (!best) return null
  best.label = best.yearsAgo === 1 ? '去年的今天' : best.yearsAgo + ' 年前的今天'
  return best
}

/** 距今多少天：热力图和无记录提示共用 */
function daysSince(ts, now) {
  return dayDiff(ts, now)
}

module.exports = {
  dayKey,
  dayLabel,
  dayDiff,
  daysSince,
  relative,
  fullTime,
  clock,
  group,
  bucketOf,
  groupBuckets,
  startOfDay,
  startOfWeek,
  sameDayPast
}
