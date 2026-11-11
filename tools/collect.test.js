/**
 * 从聊天/剪贴板收一条 + 分享 path 长度（19 条断言）
 * 用法：node tools/collect.test.js
 *
 * 顶掉 utils/store 与 utils/media，直接驱动真实的 utils/transfer.js 与 utils/share.js。
 * 覆盖三件在真机上很难复现的事：
 *   - 剪贴板为空 / 超长 / 没有权限
 *   - 聊天文件的三种分流（图片 / 文本 / 二进制）
 *   - 分享 path 里 encodeURIComponent 之后的中文长度
 */
const path = require('path')
const fs = require('fs')
const B = path.resolve(__dirname, '..', 'miniprogram')

const storePath = path.join(B, 'utils', 'store.js')
const mediaPath = path.join(B, 'utils', 'media.js')

let savedSeq = 0
const fakeStore = { MAX_RECORDS: 1000 }
const fakeMedia = {
  ensurePrivacy: () => Promise.resolve(true),
  saveFile: (p, ext) => Promise.resolve({ path: '/user/file_' + ++savedSeq + '.' + ext, size: 2048 })
}

require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore, children: [], paths: [] }
require.cache[mediaPath] = { id: mediaPath, filename: mediaPath, loaded: true, exports: fakeMedia, children: [], paths: [] }

/** 假文件系统：路径 → 内容 */
const files = {}

let clipboard = ''
let clipboardFail = ''
let pickup = null
let pickupFail = ''

global.wx = {
  env: { USER_DATA_PATH: '/user' },
  getFileSystemManager() {
    return {
      readFileSync(p) {
        if (!(p in files)) throw new Error('no such file')
        return files[p]
      },
      statSync() {
        return { size: 1 }
      }
    }
  },
  getClipboardData(opts) {
    if (clipboardFail) {
      opts.fail({ errMsg: clipboardFail })
      return
    }
    opts.success({ data: clipboard })
  },
  chooseMessageFile(opts) {
    if (pickupFail) {
      opts.fail({ errMsg: pickupFail })
      return
    }
    opts.success({ tempFiles: pickup || [] })
  }
}

const transfer = require(path.join(B, 'utils', 'transfer.js'))
const share = require(path.join(B, 'utils', 'share.js'))

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

;(async () => {
  console.log('1) 分享 path：120 字上限与中文膨胀')
  const empty = share.card('')
  ok('没有正文时只带路径', empty.path === '/pages/index/index' && !!empty.title, empty)

  const back = share.card('今天想到一个点子')
  ok('正文能原样往返', decodeURIComponent(back.path.split('inbox=')[1]) === '今天想到一个点子', back.path)

  const long = share.card('灵'.repeat(200))
  const kept = decodeURIComponent(long.path.split('inbox=')[1])
  ok('超长截到 120 字', kept.length === 120, kept.length)
  ok('path 长度留在 1200 以内', long.path.length < 1200, long.path.length)
  ok('标题取前 30 字', long.title.length === 30, long.title.length)

  const wrap = share.card('第一行\n\n第二行   第三行')
  ok('换行与多余空格压成单空格', decodeURIComponent(wrap.path.split('inbox=')[1]) === '第一行 第二行 第三行', wrap.path)

  console.log('2) 剪贴板：正常、空白、超长、无权限')
  clipboard = '  在电梯里想到：把提醒做成一句反问  '
  const one = await transfer.fromClipboard()
  ok('读到文字并清掉首尾空白', one.text === '在电梯里想到：把提醒做成一句反问', one.text)
  ok('未截断时 truncated=false', one.truncated === false && one.total === one.text.length)

  clipboard = '   '
  let code = ''
  await transfer.fromClipboard().catch(e => (code = e.code))
  ok('剪贴板只有空白时如实报 empty', code === 'empty', code)

  clipboard = '字'.repeat(1200)
  const big = await transfer.fromClipboard()
  ok('超长只收前 1000 字', big.text.length === 1000, big.text.length)
  ok('超长标记 truncated 并给出原字数', big.truncated === true && big.total === 1200, big.total)

  clipboardFail = 'getClipboardData:fail api scope is not declared'
  code = ''
  await transfer.fromClipboard().catch(e => (code = e.code))
  ok('隐私未声明时归到 denied', code === 'denied', code)

  clipboardFail = ''
  const raw = global.wx.getClipboardData
  delete global.wx.getClipboardData
  code = ''
  await transfer.fromClipboard().catch(e => (code = e.code))
  ok('环境没有接口时归到 unsupported', code === 'unsupported', code)
  global.wx.getClipboardData = raw

  console.log('3) 聊天文件：图片 / 文本 / 二进制三种分流')
  files['/tmp/a.txt'] = '第一段想法\n第二段想法'
  files['/tmp/b.png'] = 'binary'
  files['/tmp/c.docx'] = 'binary'

  pickup = [
    { path: '/tmp/a.txt', name: 'a.txt' },
    { path: '/tmp/b.png', name: 'b.png' },
    { path: '/tmp/c.docx', name: 'c.docx' }
  ]
  const res = await transfer.importFromChat()
  const byType = res.records.map(r => r.type).join(',')
  ok('三条各归各位：text,photo,text', byType === 'text,photo,text', byType)
  ok('txt 读出正文', res.records[0].content === '第一段想法\n第二段想法', res.records[0].content)
  ok('图片落盘成照片并带路径', res.records[1].type === 'photo' && res.records[1].mediaPaths.length === 1)
  ok('读不出正文的只留文件名', res.records[2].content === '来自「c.docx」', res.records[2].content)
  ok('读不出的计入 failed', res.failed === 1, res.failed)

  files['/tmp/big.md'] = '甲'.repeat(1500)
  pickup = [{ path: '/tmp/big.md', name: 'big.md' }]
  const clipped = await transfer.importFromChat()
  ok('超长文本只取前 1000 字', clipped.records[0].content.length === 1000, clipped.records[0].content.length)

  console.log('4) 入口位置：回顾位在首页，不在「我的」')
  const homeWxml = fs.readFileSync(path.join(B, 'pages', 'index', 'index.wxml'), 'utf8')
  ok('首页挂着回顾位并指向 openReview', /catchtap="openReview"/.test(homeWxml) && /reviewTotal/.test(homeWxml))
  ok('回顾位的条件是"超过一条"才出现', /reviewTotal > 1/.test(homeWxml))

  const meWxml = fs.readFileSync(path.join(B, 'pages', 'me', 'me.wxml'), 'utf8')
  ok('「我的」不再有回顾入口', !/onReview/.test(meWxml))

  const homeJs = fs.readFileSync(path.join(B, 'pages', 'index', 'index.js'), 'utf8')
  ok('首页收一条拆成两个来源', /collectFiles/.test(homeJs) && /collectClipboard/.test(homeJs))

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
