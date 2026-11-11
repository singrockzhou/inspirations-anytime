/**
 * 翻一条 + 详情页左右滑（24 条断言）
 * 用法：node tools/flip.test.js
 *
 * 顶掉 utils/store（换成内存记录）和 Page/wx，直接驱动真实的 utils/flip.js
 * 与 pages/detail/detail.js，不需要开发者工具。
 */
const path = require('path')
const B = path.resolve(__dirname, '..', 'miniprogram')

const DAY = 86400000
const now = Date.now()
let seq = 0

/** 造一条记录：ageDays 越大越旧 */
function mk(ageDays, type) {
  seq++
  return {
    id: 'r' + seq,
    type: type || 'text',
    content: '第 ' + seq + ' 条',
    createdAt: now - ageDays * DAY,
    updatedAt: now - ageDays * DAY,
    mediaPaths: [],
    mediaPath: '',
    duration: 0,
    tags: [],
    starred: 0,
    archivedAt: 0,
    deletedAt: 0
  }
}

// 4 条"放了一阵子"的 + 2 条刚写的：抽样只该落在前 4 条里
const recs = [mk(30), mk(20), mk(10), mk(8), mk(0), mk(0)]
const oldCount = 4

const fakeStore = {
  list() {
    return recs.filter(r => !r.deletedAt).slice().sort((a, b) => b.createdAt - a.createdAt)
  },
  get(id) {
    return recs.filter(r => r.id === id && !r.deletedAt)[0] || null
  },
  MAX_RECORDS: 1000
}

const storePath = path.join(B, 'utils', 'store.js')
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: fakeStore,
  children: [],
  paths: []
}

let scrolled = 0
global.wx = {
  pageScrollTo() {
    scrolled++
  },
  vibrateShort() {},
  navigateTo() {},
  navigateBack() {},
  setClipboardData() {}
}

const flip = require(path.join(B, 'utils', 'flip.js'))

let def = null
global.Page = d => {
  def = d
}
require(path.join(B, 'pages', 'detail', 'detail.js'))
const detailDef = def

// 重温页单独加载：两页各有一份 Page 定义，不能互相覆盖
let reviewDef = null
global.Page = d => {
  reviewDef = d
}
require(path.join(B, 'pages', 'review', 'review.js'))

function page(d) {
  const source = d || detailDef
  return Object.assign(
    {
      data: JSON.parse(JSON.stringify(source.data)),
      setData(patch, cb) {
        Object.assign(this.data, patch)
        if (cb) cb()
      }
    },
    source
  )
}

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
const wait = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  console.log('1) 抽样规则（与「再来一条」同一套）')
  flip.enter(recs[0].id)
  const drawn = []
  for (let i = 0; i < 40; i++) drawn.push(flip.next())

  ok('从 6 条里抽 40 次都有结果', drawn.every(Boolean))
  ok(
    '只抽 7 天以上的那 4 条',
    drawn.every(r => {
      const age = (now - r.createdAt) / DAY
      return age > 7
    }),
    drawn.map(r => Math.round((now - r.createdAt) / DAY))
  )
  ok('不会连抽同一条', drawn.every((r, i) => i === 0 || r.id !== drawn[i - 1].id))

  console.log('2) 上一条：先回退看过的，再按时间往前接')
  flip.reset()
  const first = recs[0]
  flip.enter(first.id)
  const n1 = flip.next()
  const n2 = flip.next()
  ok('返回的确实是刚才那条', flip.prev().id === n1.id)
  ok('再退一次回到起点', flip.prev().id === first.id)

  flip.reset()
  const mid = recs[2] // 10 天前那条，前面还有更早的
  flip.enter(mid.id)
  const back = flip.prev()
  ok('起点右滑：按时间接一条更早的', back && back.createdAt < mid.createdAt, back && back.content)
  ok('右滑之后再左滑：原路回到刚才那条', flip.next().id === mid.id)

  console.log('3) 边界')
  const keep = recs.slice()
  recs.length = 1
  flip.reset()
  flip.enter(recs[0].id)
  ok('只剩一条时 canPrev=false', flip.canPrev() === false)
  ok('只剩一条时 total=1', flip.total() === 1)

  // 恢复两条：当前这条被删掉后，右滑要跳过它
  recs.length = 0
  keep.slice(0, 3).forEach(r => recs.push(r))
  flip.reset()
  flip.enter(recs[0].id)
  const step = flip.next()
  step.deletedAt = now
  ok('上一条被删了会继续往前找', flip.prev().id === recs[0].id)
  step.deletedAt = 0

  recs.length = 0
  keep.forEach(r => recs.push(r))

  console.log('4) 详情页：手势阈值与方向')
  const p = page()
  p.onLoad({ id: recs[0].id })
  p.onShow() // 框架里 onLoad 之后紧接 onShow，测试里显式调一次
  ok('进页面就对齐到这一轮', p.data.record && p.data.record.id === recs[0].id)
  ok('记录多于一条时露出翻页条', p.data.total === 6)

  p.onTouchStart({ touches: [{ clientX: 300, clientY: 300 }] })
  p.onTouchMove({ touches: [{ clientX: 288, clientY: 262 }] }) // 竖着划
  ok('纵向拖动不接管', p.data.swipeDx === 0)
  p.onTouchEnd({})

  p.onTouchStart({ touches: [{ clientX: 300, clientY: 300 }] })
  p.onTouchMove({ touches: [{ clientX: 270, clientY: 300 }] })
  ok('横向拖动跟手（阻尼 0.4）', Math.round(p.data.swipeDx) === -12, p.data.swipeDx)
  const before = p.id
  p.onTouchEnd({})
  ok('没到阈值：滑回原位', p.data.swipeDx === 0)
  ok('没到阈值：不换条', p.id === before)

  p.onTouchStart({ touches: [{ clientX: 320, clientY: 300 }] })
  p.onTouchMove({ touches: [{ clientX: 20, clientY: 306 }] })
  ok('拖到 96rpx 上限（不把整页拖飞）', p.data.swipeDx === -96, p.data.swipeDx)
  const playing0 = p.data.playing
  p.data.playing = true
  scrolled = 0
  p.onTouchEnd({})
  await wait(320)
  ok('左滑越过阈值后换了一条', p.id !== before && p.data.record.id === p.id)
  ok('换条后播放态归零', p.data.playing === false, p.data.playing)
  ok('换条后回到页首', scrolled > 0)
  ok('换条后位移归零', p.data.swipeDx === 0)

  console.log('5) 上一条到底：置灰 + 如实提示')
  const oldest = recs[0] // mk(30)，全批里最早的一条
  flip.reset()
  p.id = oldest.id
  flip.enter(oldest.id)
  p.load()
  ok('最早一条时 canPrev=false', p.data.canPrev === false, p.data.canPrev)
  p.onPrev()
  ok('翻不动时不动 id', p.id === oldest.id)
  ok('翻不动时给了一句提示', /最早/.test(p.data.toastText), p.data.toastText)

  console.log('6) 重温页：左右滑切换（此前手势只加在详情页，这一页根本没绑事件）')
  const fs = require('fs')
  const wxml = fs.readFileSync(path.join(B, 'pages', 'review', 'review.wxml'), 'utf8')
  ok(
    '模板上确实绑了 touchstart/move/end',
    /bindtouchstart="onTouchStart"/.test(wxml) &&
      /bindtouchmove="onTouchMove"/.test(wxml) &&
      /bindtouchend="onTouchEnd"/.test(wxml)
  )
  ok('纸上有跟手位移样式', /translateX\(\{\{swipeDx\}\}px\)/.test(wxml))

  const r = page(reviewDef)
  r.onLoad()
  ok('进页就落在一条真实记录上', !!(r.data.item && r.data.item.id))
  ok('总数与库里一致', r.data.total === 6)

  r.onTouchStart({ touches: [{ clientX: 200, clientY: 420 }] })
  r.onTouchMove({ touches: [{ clientX: 206, clientY: 350 }] })
  ok('纵向拖动不接管（留给 scroll-view 滚正文）', r.data.swipeDx === 0)
  r.onTouchEnd({})

  r.onTouchStart({ touches: [{ clientX: 300, clientY: 420 }] })
  r.onTouchMove({ touches: [{ clientX: 270, clientY: 424 }] })
  ok('横向拖动跟手（阻尼 0.4）', Math.round(r.data.swipeDx) === -12, r.data.swipeDx)
  const stayId = r.data.item.id
  r.onTouchEnd({})
  ok('没到阈值：回弹', r.data.swipeDx === 0)
  ok('没到阈值：不换条', r.data.item.id === stayId)

  const firstId = r.data.item.id
  scrolled = 0
  r.onTouchStart({ touches: [{ clientX: 330, clientY: 420 }] })
  r.onTouchMove({ touches: [{ clientX: 20, clientY: 424 }] })
  ok('拖到 96 上限（不把纸拖飞）', r.data.swipeDx === -96, r.data.swipeDx)
  r.onTouchEnd({})
  await wait(340)
  const nextId = r.data.item.id
  ok('左滑 → 下一条', nextId !== firstId, nextId)
  ok('换条后位移归零', r.data.swipeDx === 0)
  ok('换条后回到页首', scrolled > 0)

  r.onTouchStart({ touches: [{ clientX: 20, clientY: 420 }] })
  r.onTouchMove({ touches: [{ clientX: 330, clientY: 424 }] })
  ok('右滑跟手到 +96', r.data.swipeDx === 96, r.data.swipeDx)
  r.onTouchEnd({})
  await wait(340)
  ok('右滑 → 上一条（回到刚看过的那条）', r.data.item.id === firstId, r.data.item.id)

  r.onTouchStart({ touches: [{ clientX: 330, clientY: 420 }] })
  r.onTouchMove({ touches: [{ clientX: 20, clientY: 424 }] })
  r.onTouchEnd({})
  await wait(340)
  ok('右滑之后再左滑：原路回到下一条', r.data.item.id === nextId, r.data.item.id)

  console.log('7) 首尾边界')
  const keepAll = recs.slice()
  recs.length = 1
  flip.reset()
  flip.enter(recs[0].id)
  ok('只有一条时 next() 返回 null（不再把自己再发一次）', flip.next() === null)

  const r1 = page(reviewDef)
  r1.onLoad()
  ok('只有一条时也照常展示这一条', !!(r1.data.item && r1.data.item.id === keepAll[0].id), r1.data.item)
  ok('只有一条时 total=1', r1.data.total === 1)
  const onlyId = r1.data.item.id
  r1.onTouchStart({ touches: [{ clientX: 330, clientY: 420 }] })
  r1.onTouchMove({ touches: [{ clientX: 20, clientY: 424 }] })
  ok('只有一条时左滑阻力更大', Math.abs(r1.data.swipeDx) < 40, r1.data.swipeDx)
  r1.onTouchEnd({})
  await wait(340)
  ok('只有一条时左滑不换条', r1.data.item.id === onlyId)
  ok('只有一条时不误报提示', r1.data.toastText === '', r1.data.toastText)

  recs.length = 0
  keepAll.forEach(x => recs.push(x))
  const earliest = recs[0] // 30 天前那条，全批里最早
  const r2 = page(reviewDef)
  r2.onLoad()
  flip.reset()
  flip.enter(earliest.id)
  r2.show(earliest)
  ok('最早一条时 canPrev=false', r2.data.canPrev === false, r2.data.canPrev)
  r2.onTouchStart({ touches: [{ clientX: 20, clientY: 420 }] })
  r2.onTouchMove({ touches: [{ clientX: 320, clientY: 424 }] })
  ok('到头时右滑阻力加大', Math.abs(r2.data.swipeDx) < 40, r2.data.swipeDx)
  r2.onTouchEnd({})
  await wait(340)
  ok('到头时右滑不动', r2.data.item.id === earliest.id)
  ok('到头时如实提示', /最早/.test(r2.data.toastText), r2.data.toastText)

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
