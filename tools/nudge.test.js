/**
 * 打开即提醒 + 关于小程序（33 条断言）
 * 用法：node tools/nudge.test.js
 *
 * 为什么单独测这一层：
 * "该不该催"是个时间边界问题（今天 / 昨天 / 隔几天 / 手机时钟超前），
 * 而"催什么话"是产品文案。两者都不能靠肉眼看首页确认——首页只会显示其中一种。
 * 所以判断逻辑抽到 utils/nudge.js 做成纯函数，在这里把每一种输入钉住。
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
const nudge = require(path.join(B, 'utils', 'nudge.js'))

/* 固定"现在"：2026-11-11 19:00，避免跨天导致断言随机失败 */
const NOW = new Date(2026, 10, 11, 19, 0, 0).getTime()
const DAY = 86400000

/** 造一份 stats，lastAt 用"几天前的这个点" */
function stats(daysAgo, total, streak) {
  const s = { total: total === undefined ? 5 : total, streak: streak || 0 }
  if (daysAgo !== null) s.lastAt = NOW - daysAgo * DAY
  return s
}

function ask(s, opts) {
  return nudge.of(s, Object.assign({ now: NOW }, opts || {}))
}

/* ---------- 1. 什么时候不催 ---------- */
console.log('1) 不该出现的时候确实不出现')
ok('一条都没记过 → 不催（空状态已经在说同一句话）', ask(stats(3, 0)) === null)
ok('今天已经记过 → 不催', ask(stats(0, 5)) === null, ask(stats(0, 5)))
ok('一小时前刚记过 → 不催', ask({ total: 5, lastAt: NOW - 3600000, streak: 1 }) === null)
ok('手机时钟超前写下的"未来记录" → 不催', ask({ total: 5, lastAt: NOW + DAY, streak: 0 }) === null)
ok('正在筛选星标 → 不出现', ask(stats(2), { filtering: true }) === null)
ok('正在多选 → 不出现', ask(stats(2), { selecting: true }) === null)
ok('数据异常（total>0 但没有 lastAt）→ 不催', ask({ total: 3, lastAt: 0, streak: 0 }) === null)

/* ---------- 2. 催的时候说什么 ---------- */
console.log('2) 隔了多久，说不同的话')
const yesterday = ask(stats(1, 5, 0))
ok('昨天记过、连续没成串 → 说"昨天那句还热着"', /昨天那句还热着/.test(yesterday.text), yesterday.text)
ok('连续 ≥2 天 → 先说"连续 N 天"，比"你该记了"有用', /连续 4 天了，今天补一句就不断/.test(ask(stats(1, 5, 4)).text), ask(stats(1, 5, 4)).text)
ok('连 2 天也算连续（不用熬到 3 天）', /连续 2 天/.test(ask(stats(1, 5, 2)).text))
ok('连续 1 天不说"连续"（昨天刚开始，谈不上"不断"）', !/连续/.test(ask(stats(1, 5, 1)).text), ask(stats(1, 5, 1)).text)
ok('隔 2 天 → 报出天数', /隔了 2 天，随手一句就能接上/.test(ask(stats(2, 5, 0)).text), ask(stats(2, 5, 0)).text)
ok('隔 6 天仍算"随手能接上"', /随手一句就能接上/.test(ask(stats(6, 5, 0)).text))
ok('隔 7 天换口吻（问一句"现在想点什么"）', /隔了 7 天，现在想点什么？/.test(ask(stats(7, 5, 0)).text), ask(stats(7, 5, 0)).text)
ok('隔 40 天照旧给天数，不吓唬人', /隔了 40 天/.test(ask(stats(40, 5, 0)).text))
ok('文案里不出现"应该""必须""又"这类催促词', !/应该|必须|又没|坚持/.test(ask(stats(9, 5, 0)).text), ask(stats(9, 5, 0)).text)

/* ---------- 3. 结构与字段 ---------- */
console.log('3) 返回值结构')
const one = ask(stats(3, 5, 0))
ok('带 gap（隔了几天），页面不用再算一遍', one.gap === 3, one.gap)
ok('标签固定为「今天还没记一句」', one.label === '今天还没记一句', one.label)
ok('右侧提示是动作「记一句 ›」，不是描述', one.tip === '记一句 ›', one.tip)

/* ---------- 4. 首页是这一栏的唯一出口 ---------- */
console.log('4) 首页模板与页面接线')
const homeWxml = read('pages/index/index.wxml')
const homeJs = read('pages/index/index.js')
ok('首页挂了提醒位并指向 onNudge', /class="anni nudge" wx:if="\{\{nudge\}\}" catchtap="onNudge"/.test(homeWxml))
ok('提醒排在「那年今日」之前（记完一条会自己让位）', homeWxml.indexOf('class="anni nudge"') < homeWxml.indexOf('catchtap="openAnniversary"'))
ok('三档共用一个 wx:if / elif 链，不会同时出两个', /wx:elif="\{\{anniversary\}\}"/.test(homeWxml) && !/wx:if="\{\{anniversary\}\}"/.test(homeWxml))
ok('点提醒直接进记录页（复用 goText，不另开一条链路）', /onNudge\(\)\s*\{\s*this\.goText\(\)/.test(homeJs))
ok('页面把"是否在筛选"交给 nudge.of 判断', /nudge\.of\(/.test(homeJs) && /filtering:/.test(homeJs))
ok('多选开始时提醒位一并收掉（不留一个悬着的卡片）', /selectMode: true, openSwipeId: '', anniversary: null, nudge: null/.test(homeJs))

/* ---------- 5. 提醒模块已下掉，没留半截 ---------- */
console.log('5) 发不出去的"每日提醒"已整体下掉')
ok('utils/remind.js 已删除（不给后来者留一个能配却发不出的开关）', !fs.existsSync(path.join(B, 'utils', 'remind.js')))
ok('没有页面再 require 它', !/utils\/remind/.test(homeJs) && !/utils\/remind/.test(read('pages/me/me.js')))

/* ---------- 6. 关于小程序 ---------- */
console.log('6) 关于：作者与联系方式')
const meJs = read('pages/me/me.js')
ok('标题是「关于小程序」', /title: '关于小程序'/.test(meJs))
ok('写明了作者 zhouguoxiang', /const AUTHOR = 'zhouguoxiang'/.test(meJs))
ok('写明了微信号', /const WECHAT = '不卷的迭代老爸'/.test(meJs))
ok('写明了联系邮箱', /const EMAIL = '77111904@qq\.com'/.test(meJs))
ok('「关于」不再是一句"知道了"的死弹窗：第二个按钮是复制', /confirmText: '复制联系方式'/.test(meJs) && /setClipboardData/.test(meJs))
ok('复制的内容就是弹窗里那三行（同一份常量，不会改漏）', /const CONTACT = '作者：' \+ AUTHOR/.test(meJs), meJs.match(/const CONTACT[^\n]*/))

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
