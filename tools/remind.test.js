/**
 * 提醒功能的可见性与文案（9 条断言）
 * 用法：node tools/remind.test.js
 *
 * 验的是"发布版里未完成的能力不出现在用户面前"这条规则本身，
 * 而不是某个页面的写法——所以直接驱动 utils/remind.js。
 */
const path = require('path')
const B = path.resolve(__dirname, '..', 'miniprogram')

const storePath = path.join(B, 'utils', 'store.js')
let prefs = { remindOn: false, remindHour: 21, remindMinute: 0 }
const fakeStore = {
  getPrefs: () => JSON.parse(JSON.stringify(prefs)),
  savePrefs(patch) {
    Object.assign(prefs, patch)
  }
}
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore, children: [], paths: [] }

let env = 'develop'
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }),
  requestSubscribeMessage: () => {}
}

const remind = require(path.join(B, 'utils', 'remind.js'))

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

console.log('1) 版本判断')
env = 'release'
ok('release → published', remind.status().published === true)
env = 'trial'
ok('体验版不算发布版', remind.status().published === false)
env = 'develop'
ok('开发版不算发布版', remind.status().published === false)

console.log('2) 没配模板时，发布版不出入口')
ok('TMPL_ID 为空 → configured=false', remind.configured() === false)

env = 'release'
ok('发布版 + 没接通 → 不显示', remind.visible() === false)
env = 'trial'
ok('体验版 + 没接通 → 仍显示（自己要看得到）', remind.visible() === true)
env = 'develop'
ok('开发版 + 没接通 → 仍显示', remind.visible() === true)

delete global.wx.getAccountInfoSync
ok('取不到版本时按开发版处理，不至于把自己挡在外面', remind.visible() === true)
global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: env } })

console.log('3) 关掉提醒只影响开关，不动记录与时间')
prefs = { remindOn: true, remindHour: 7, remindMinute: 30 }
remind.disable()
ok('disable 后 on=false，时间保留', remind.status().on === false && remind.status().timeText === '07:30')

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
