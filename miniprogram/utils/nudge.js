/**
 * 打开即提醒（替代发不出去的"每日提醒"）
 *
 * 为什么是这一条路：微信的订阅消息要走服务端下发，而且工具类小程序只能申请
 * 一次性订阅——一次授权只够发一条，"每天提醒"按字面做不到。而"打开小程序时
 * 告诉你今天还没记"不需要任何推送，也不会有到不了的承诺。
 *
 * 为什么是纯函数：这里只有一个判断（该不该催、催什么话），把它从页面里拎出来，
 * 文案调整和边界就都能直接被测试驱动，不用起整个 Page。
 */
const date = require('./date')
const i18n = require('./i18n')

/** 导出给页面兜底用；真正渲染时以 of() 返回的当前语言文案为准 */
const LABEL = i18n.t('nudge:label')
const TIP = i18n.t('nudge:tip')

/**
 * 今天还没记就说一句话。
 *
 * @param {{total:number, lastAt:number, streak:number}} stats store.stats() 的返回值
 * @param {{now?:number, filtering?:boolean, selecting?:boolean}} opts
 * @returns {{gap:number, label:string, tip:string, text:string}|null} 不用显示时返回 null
 */
function of(stats, opts) {
  const o = opts || {}
  const s = stats || {}

  // 筛选/搜索/多选的时候，这一栏本来就不属于它们
  if (o.filtering || o.selecting) return null
  // 一条都没记过：空状态正写着"想到什么，就说一句"，同一句话不说两遍
  if (!s.total) return null

  const now = o.now || Date.now()
  const gap = s.lastAt ? date.dayDiff(s.lastAt, now) : 0
  // gap ≤ 0 包含"今天已经记过"和"手机时钟超前写下的未来记录"，都不该催
  if (gap <= 0) return null

  let text = i18n.t('nudge:yesterday')
  if (s.streak >= 2 && gap === 1) {
    // 连续的日子里断在今天最可惜，先把这件事说出来——比"你该记了"有用
    text = i18n.t('nudge:keep', { n: s.streak })
  } else if (gap >= 7) {
    text = i18n.t('nudge:gap_long', { n: gap })
  } else if (gap > 1) {
    text = i18n.t('nudge:gap_short', { n: gap })
  }

  return {
    gap: gap,
    label: i18n.t('nudge:label'),
    tip: i18n.t('nudge:tip'),
    text: text
  }
}

module.exports = {
  of,
  LABEL,
  TIP
}
