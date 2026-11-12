/**
 * 该不该提醒备份
 *
 * 为什么需要这一层：小程序的数据只在微信给它分的沙箱里（键值 10MB + 本地文件
 * 200MB）。用户在微信里删掉小程序、清理微信存储、换手机，这些数据会被一起
 * 回收，开发者也拿不到、恢复不了。唯一的跨设备通路是「导出成文件 → 发给文件
 * 传输助手 → 到新设备导入」，而这条通路必须用户自己走，所以只能在合适的时机
 * 提一句，不能等他丢了才说。
 *
 * 为什么要克制：这是安全提示，不是运营推送。三条规矩——
 *   1. 少于 MIN_COUNT 条不提（丢了几条能重记，先别烦人）；
 *   2. 两次之间至少隔 GAP_DAYS 天，且必须有新增才提（没新东西可备就别提）；
 *   3. 点过"以后再说"就安静 SNOOZE_DAYS 天。
 * 判断做成纯函数，边界交给测试钉住，页面只负责显示。
 */
const date = require('./date')

const DAY = 86400000
/** 攒到这么多条才值得提醒一次 */
const MIN_COUNT = 10
/** 距上次备份多少天后可以再提 */
const GAP_DAYS = 7
/** 点"以后再说"后安静多少天 */
const SNOOZE_DAYS = 7

const i18n = require('./i18n')

/** 导出给页面兜底；渲染时以 of() 返回的当前语言文案为准 */
const LABEL_ONLY = i18n.t('backup:only_local')

/**
 * @param {{total:number}} stats store.stats() 的返回值（total 含归档）
 * @param {{at?:number, total?:number, snoozeAt?:number}} meta store.backupInfo()
 * @param {{now?:number, filtering?:boolean, selecting?:boolean}} opts
 * @returns {{kind:string, total:number, days:number, text:string, tip:string}|null}
 */
function of(stats, meta, opts) {
  const s = stats || {}
  const m = meta || {}
  const o = opts || {}

  // 筛选、多选时这一条不属于它们，收掉
  if (o.filtering || o.selecting) return null

  const total = s.total || 0
  if (total < MIN_COUNT) return null

  const now = o.now || Date.now()

  // snoozeAt 在未来（用户改过手机时间）也当作冷却中，不催
  if (m.snoozeAt && now - m.snoozeAt < SNOOZE_DAYS * DAY) return null

  if (m.at) {
    const days = date.dayDiff(m.at, now)
    if (days < GAP_DAYS) return null
    // 上次备份之后没有新增：备份过的东西还是那些，没必要再催一遍
    if (total <= (m.total || 0)) return null
    return {
      kind: 'later',
      total: total,
      days: days,
      text: i18n.t('backup:again', { n: days }),
      tip: i18n.t('backup:again_tip')
    }
  }

  return {
    kind: 'first',
    total: total,
    days: -1,
    text: i18n.t('backup:first', { n: total, s: i18n.t('backup:only_local') }),
    tip: i18n.t('backup:first_tip')
  }
}

module.exports = {
  of,
  MIN_COUNT,
  GAP_DAYS,
  SNOOZE_DAYS,
  DAY
}
