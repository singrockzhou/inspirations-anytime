/**
 * 媒体行为测试（31 条断言）
 * 用法：node tools/media.test.js
 * 覆盖：播放器暂停/续播/进度回调、缩略图按张数分列与折叠。
 * 用 stub 顶掉 wx / Component，不需要开发者工具。
 */
const path = require('path')
const B = path.resolve(__dirname, '..', 'miniprogram')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  -> ' + JSON.stringify(extra) : ''))
  }
}

/* ---------- audio：暂停 / 续播 / 进度回调 ---------- */
const stub = {
  src: '',
  currentTime: 0,
  duration: 0,
  _ended: null,
  _time: null,
  _err: null,
  playCount: 0,
  pauseCount: 0,
  stopCount: 0,
  play() {
    this.playCount++
  },
  pause() {
    this.pauseCount++
  },
  stop() {
    this.stopCount++
  },
  destroy() {},
  onEnded(f) {
    this._ended = f
  },
  onTimeUpdate(f) {
    this._time = f
  },
  onError(f) {
    this._err = f
  }
}
global.wx = { createInnerAudioContext: () => stub }

const audio = require(path.join(B, 'utils', 'audio.js'))

console.log('1) 播放 / 暂停 / 续播')
let ended = 0
let clock = null
audio.play('a.mp3', { end: () => ended++, time: t => (clock = t) })
ok('play 调用一次', stub.playCount === 1)
ok('未暂停', audio.isPaused() === false)
audio.pause()
ok('pause 后 isPaused=true', audio.isPaused() === true && stub.pauseCount === 1)
audio.resume()
ok('resume 后回到播放', audio.isPaused() === false && stub.playCount === 2)
stub.currentTime = 3.4
stub.duration = 19
stub._time()
ok('进度回调带 currentTime / duration', !!clock && clock.currentTime === 3.4 && clock.duration === 19)
stub._ended()
ok('播完回调且重置暂停态', ended === 1 && audio.isPaused() === false)
audio.play('b.mp3', { end: () => {} })
audio.stop()
ok('stop 后 isPaused=false', audio.isPaused() === false && stub.stopCount >= 1)

/* ---------- photo-grid：按张数分列 ---------- */
console.log('2) 缩略图分列规则')
let def = null
global.Component = d => {
  def = d
}
global.wx.previewImage = () => {}
require(path.join(B, 'components', 'photo-grid', 'photo-grid.js'))

function inst() {
  return Object.assign(
    {
      data: { cols: 1, list: [], more: 0, paths: [] },
      setData(p) {
        Object.assign(this.data, p)
      }
    },
    def.methods
  )
}

const cases = [
  [0, 1],
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 2],
  [5, 3],
  [9, 3],
  [12, 3]
]
cases.forEach(pair => {
  const n = pair[0]
  const cols = pair[1]
  const c = inst()
  const paths = Array.from({ length: n }, (_, i) => 'p' + i)
  c.build(paths)
  ok(n + ' 张 → 列数 ' + cols, c.data.cols === cols, c.data)
  ok(n + ' 张 → 最多 9 格', c.data.list.length === Math.min(n, 9), c.data.list.length)
  ok(n + ' 张 → 折叠数 ' + Math.max(0, n - 9), c.data.more === Math.max(0, n - 9), c.data.more)
})

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
