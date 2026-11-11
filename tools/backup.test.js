/**
 * 备份提醒（断言见末尾统计）
 * 用法：node tools/backup.test.js
 *
 * 为什么单独测这一层：
 * "该不该提醒备份"是产品里唯一一个"说错了会让人烦、说晚了会让人丢数据"的
 * 判断。它由三个时间量决定（上次备份、上次静默、记录条数），页面只会显示
 * 其中一种结果，肉眼没法把边界看全。所以判断抽成纯函数，在这里逐条钉住。
 *
 * 另外还钉了三件"退出登录也别忘了"的工程事实：
 *   1. 导出必须带归档（少这一步，换手机后归档内容会静默消失）；
 *   2. 用户取消导出不能记账（否则账本显示"已备份"，手里却什么都没有）；
 *   3. 首页横幅在「今天还没记」那一栏之前，且两条互不抢占。
 */
const path = require('path')
const fs = require('fs')
const B = path.resolve(__dirname, '..', 'miniprogram')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}

const read = p => fs.readFileSync(path.join(B, p), 'utf8')
const backup = require(path.join(B, 'utils', 'backup.js'))

/* 固定"现在"：2026-11-11 19:00 */
const NOW = new Date(2026, 10, 11, 19, 0, 0).getTime()
const DAY = 86400000

function ask(stats, meta, opts) {
  return backup.of(stats, meta, Object.assign({ now: NOW }, opts || {}))
}
const meta = (daysAgo, total, snoozeAgo) => {
  const m = { at: daysAgo === null ? 0 : NOW - daysAgo * DAY, total: total || 0, snoozeAt: 0 }
  if (snoozeAgo !== undefined && snoozeAgo !== null) m.snoozeAt = NOW - snoozeAgo * DAY
  return m
}

/* ---------- 1. 不该提的时候不提 ---------- */
console.log('1) 克制：不该提的场合一次都不提')
ok('一条都没有 → 不提', ask({ total: 0 }, {}) === null)
ok('9 条 → 不提（丢了几条能重记，先别烦人）', ask({ total: 9 }, {}) === null)
ok('10 条、从没备份过 → 提', ask({ total: 10 }, {}) !== null)
ok('刚备份过 2 天、又新记了 5 条 → 不提（攒够 7 天再说）', ask({ total: 30 }, meta(2, 25)) === null)
ok('7 天前备份、期间没有新增 → 不提（没新东西可备）', ask({ total: 25 }, meta(7, 25)) === null)
ok('7 天前备份、反而删少了 → 不提', ask({ total: 20 }, meta(7, 25)) === null)
ok('7 天前备份、新增了 → 提', ask({ total: 28 }, meta(7, 25)) !== null)
ok('筛选星标中 → 不出现', ask({ total: 30 }, {}, { filtering: true }) === null)
ok('多选中 → 不出现', ask({ total: 30 }, {}, { selecting: true }) === null)

/* ---------- 2. 静默与时钟 ---------- */
console.log('2) "以后再说"是真的安静 7 天')
ok('昨天点过 × → 不提', ask({ total: 30 }, meta(30, 10, 1)) === null)
ok('6 天前点过 × → 仍不提', ask({ total: 30 }, meta(30, 10, 6)) === null)
ok('8 天前点过 ×、且已超上次备份 7 天 → 提', ask({ total: 30 }, meta(9, 25, 8)) !== null)
ok('snoozeAt 在未来（手机时钟超前）→ 不提', ask({ total: 30 }, { at: 0, total: 0, snoozeAt: NOW + 3 * DAY }) === null)
ok('账本字段缺失/为 0 → 当作从没备份过，照常首提', ask({ total: 12 }, { at: 0, total: 0, snoozeAt: 0 }) !== null)

/* ---------- 3. 说什么 ---------- */
console.log('3) 两种提法，说的是"现在能做什么"')
const first = ask({ total: 12 }, {})
ok('首次：报出条数', /12/.test(first.text), first.text)
ok('首次：点明"只在这台手机上"', /只在这台手机上/.test(first.text), first.text)
ok('首次：右侧动作是"备份一份"', /备份一份/.test(first.tip), first.tip)
const later = ask({ total: 28 }, meta(9, 25))
ok('再次：说清上次是几天前', /9 天前/.test(later.text), later.text)
ok('再次：动作是"再备一份"', /再备一份/.test(later.tip), later.tip)
ok('两种文案都不催、不说教（不含 应该/必须/一定要）', ![first.text, later.text, first.tip, later.tip].some(s => /应该|必须|一定要/.test(s)))
ok('kind 分得开，页面可以按它做不同处理', first.kind === 'first' && later.kind === 'later', [first.kind, later.kind])

/* ---------- 4. 导出链路的三件事 ---------- */
console.log('4) 导出链路：带上归档、取消不记账、入口共用一条路')
const transfer = read('utils/transfer.js')
const store = read('utils/store.js')
const meJs = read('pages/me/me.js')
ok('导出带归档（includeArchived: true）', /store\.list\(\{ includeArchived: true \}\)/.test(transfer))
ok('导出范围写了为什么必须带归档', /归档只是"收起来"，不是"不要了"/.test(transfer))
ok('记账只在非 cancel 时发生', /if \(res\.mode !== 'cancel'\) store\.markBackup\(records\.length\)/.test(transfer))
ok('导出失败码表只有一份（transfer 导出、me 引用）', /EXPORT_ERR,\s*\n\s*exportBackup/.test(transfer) && /transfer\.EXPORT_ERR\[err\.code\]/.test(meJs))
ok('me.js 不再自己定义一份 EXPORT_ERR', !/const EXPORT_ERR = \{/.test(meJs))

/* ---------- 5. 首页横幅 ---------- */
console.log('5) 首页横幅：位置、接线、不抢回顾位')
const idxWxml = read('pages/index/index.wxml')
const idxJs = read('pages/index/index.js')
ok('横幅挂在 backup 上，点了就走 onBackup', /class="bk"[^>]*wx:if="\{\{backup\}\}"[^>]*catchtap="onBackup"/.test(idxWxml))
ok('× 单独一个 catchtap，不会连带触发导出', /catchtap="onBackupClose"/.test(idxWxml))
ok('横幅在「今天还没记 / 那年今日」那一栏之前', idxWxml.indexOf('class="bk"') < idxWxml.indexOf('class="anni nudge"'))
ok('首页把筛选/多选状态交给 backup.of 判断', /backup\.of\(stats \|\| store\.stats\(\), store\.backupInfo\(\), \{/.test(idxJs))
ok('刷新时一并重算', /backup: this\.computeBackup\(stats\)/.test(idxJs))
ok('备份走的是和「我的」页同一条链路', /transfer\s*\n?\s*\.exportBackup\(\)/.test(idxJs) || /transfer\.exportBackup\(\)/.test(idxJs))
ok('导出成功后横幅立即撤掉', /store\.markBackup|setData\(\{ backup: null \}\)/.test(idxJs))
ok('点 × 会写静默时间', /onBackupClose\(\)[\s\S]{0,120}store\.snoozeBackup\(\)/.test(idxJs))

/* ---------- 6. 我的页 ---------- */
console.log('6) 我的页：把"什么时候备过"摆在换手机分区里')
const meWxml = read('pages/me/me.wxml')
ok('有一行"上次备份"', /上次备份/.test(meWxml))
ok('值可能是橙色警示（backupWarn）', /row-v \{\{backupWarn \? 'warn' : ''\}\}/.test(meWxml))
ok('这一行在"导出到文件"之前（先看状态再动手）', meWxml.indexOf('上次备份') < meWxml.indexOf('导出到文件'))
ok('说明里讲清了删除小程序会清空本机记录', /删掉小程序、清理微信存储或换手机，本机记录会一起被清掉/.test(meWxml))
ok('store 暴露了账本三个方法', /backupInfo,[\s\S]{0,40}markBackup,[\s\S]{0,40}snoozeBackup/.test(store))
ok('账本用独立 key，不会被 touchMeta 整份覆盖', /KEY_BACKUP = 'lg\.backup\.v1'/.test(store))

console.log('')
console.log('结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
