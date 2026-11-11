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

module.exports = {
  dayKey,
  dayLabel,
  dayDiff,
  relative,
  fullTime,
  clock,
  group
}
