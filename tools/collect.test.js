/**
 * 从聊天/剪贴板收一条 + 分享 path 长度（41 条断言）
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
let failChatImage = false // 模拟压缩+落盘都失败的极端情况
let failPersist = false
const chatCalls = []
const fakeStore = { MAX_RECORDS: 1000 }
const fakeMedia = {
  ensurePrivacy: () => Promise.resolve(true),
  saveFile: (p, ext) => Promise.resolve({ path: '/user/file_' + ++savedSeq + '.' + ext, size: 2048 }),
  // 图片压缩失败时的兜底：原件搬进沙箱
  persist: (p, prefix, ext) => Promise.resolve(failPersist ? '' : '/user/' + prefix + '_' + ++savedSeq + '.' + ext),
  // 聊天里的图片必须走压缩，这里记录它被怎么调用
  saveChatImage: (p, ext, originSize) => {
    chatCalls.push({ path: p, ext: ext, originSize: originSize })
    if (failChatImage) return Promise.resolve({ path: '', size: 0, originSize: originSize || 0, compressed: false })
    return Promise.resolve({
      path: '/user/img_' + ++savedSeq + '.jpg',
      size: 200 * 1024,
      originSize: originSize || 0,
      compressed: (originSize || 0) > 200 * 1024
    })
  }
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
      // 同时支持"给编码读字符串"和"不给编码读字节"——
      // 后者是 utils/sniff 判断魔数用的，必须返回真实字节，不能是 'binary' 这种占位串
      readFileSync(p, enc) {
        if (!(p in files)) throw new Error('no such file')
        const v = files[p]
        if (enc) return Buffer.isBuffer(v) ? v.toString(enc) : String(v)
        return Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')
      },
      statSync(p) {
        if (!(p in files)) throw new Error('no such file')
        return { size: Buffer.isBuffer(files[p]) ? files[p].length : String(files[p]).length }
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
  // 图片与 docx 都写成真实字节：识别层靠魔数判断，占位字符串会让它判错
  files['/tmp/b.png'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  files['/tmp/c.docx'] = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])

  pickup = [
    { path: '/tmp/a.txt', name: 'a.txt' },
    { path: '/tmp/b.png', name: 'b.png', size: 3000 * 1024 },
    { path: '/tmp/c.docx', name: 'c.docx' }
  ]
  const res = await transfer.importFromChat()
  const byType = res.records.map(r => r.type).join(',')
  ok('三条各归各位：text,photo,text', byType === 'text,photo,text', byType)
  ok('txt 读出正文', res.records[0].content === '第一段想法\n第二段想法', res.records[0].content)
  ok('图片落盘成照片并带路径', res.records[1].type === 'photo' && res.records[1].mediaPaths.length === 1)
  ok('读不出正文的只留文件名', res.records[2].content === '来自「c.docx」', res.records[2].content)
  ok('读不出的计入 failed', res.failed === 1, res.failed)

  console.log('3.1) 聊天图片必须压缩后再落盘')
  ok('图片走的是会压缩的 saveChatImage', chatCalls.length === 1, chatCalls)
  ok('原始体积与扩展名都传给了压缩层', chatCalls[0].path === '/tmp/b.png' && chatCalls[0].ext === 'png', chatCalls[0])
  ok('原始体积不丢，便于算省了多少', chatCalls[0].originSize === 3000 * 1024, chatCalls[0].originSize)
  ok('压缩张数与省下的字节回传上层', res.compressed === 1 && res.savedBytes === 3000 * 1024 - 200 * 1024, [res.compressed, res.savedBytes])

  files['/tmp/big.md'] = '甲'.repeat(1500)
  pickup = [{ path: '/tmp/big.md', name: 'big.md' }]
  const clipped = await transfer.importFromChat()
  ok('超长文本只取前 1000 字', clipped.records[0].content.length === 1000, clipped.records[0].content.length)

  console.log('3.2) 没有扩展名的图片：必须靠内容认出来，不能当成"未知文件"')
  files['/tmp/tmp_9f8a7b'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  pickup = [{ path: '/tmp/tmp_9f8a7b', name: 'tmp_9f8a7b', size: 800 * 1024 }]
  chatCalls.length = 0
  const noExt = await transfer.importFromChat()
  ok('无后缀的 JPEG 仍然被当成照片', noExt.records[0] && noExt.records[0].type === 'photo', noExt.records[0])
  ok('嗅出来的后缀交给了压缩层', chatCalls[0] && chatCalls[0].ext === 'jpg', chatCalls[0])
  ok('机器名不写进正文（不再出现"来自「78a4…」"）', noExt.records[0].content === '', noExt.records[0].content)

  console.log('3.3) 认不出的文件：不进列表，但要说清是哪几个、为什么')
  files['/tmp/tmp_hash_1'] = Buffer.from([0x00, 0x01, 0x02, 0xff])
  pickup = [{ path: '/tmp/tmp_hash_1', name: '78a4bca059cff70d66e6b33621a75d18_26439', size: 1000 }]
  let err = null
  await transfer.importFromChat().catch(e => (err = e))
  ok('全部失败时 reject 并带上明细', !!err && err.code === 'read' && err.skipped.length === 1, err)
  ok('明细里写清原因是"认不出类型"', err && err.skipped[0].reason === 'type', err && err.skipped[0])
  ok('哈希名不以原始形态暴露给用户', err && !err.skipped[0].name, err && err.skipped[0].name)

  console.log('3.4) 能读出名字的 PDF：留个壳，计入 shells')
  files['/tmp/d.pdf'] = Buffer.from('%PDF-1.7\n')
  pickup = [{ path: '/tmp/d.pdf', name: '会议纪要.pdf' }]
  const shell = await transfer.importFromChat()
  ok(
    'PDF 留一条只有文件名的记录',
    shell.records.length === 1 && shell.records[0].content === '来自「会议纪要.pdf」',
    shell.records[0]
  )
  ok('计入 shells 而不是 skipped', shell.shells === 1 && shell.skipped.length === 0, shell)

  console.log('3.5) 图片存不进来：先退到原件，再退到如实报告')
  files['/tmp/e.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  pickup = [{ path: '/tmp/e.jpg', name: '截图.jpg', size: 2 * 1024 * 1024 }]
  failChatImage = true
  const fallback = await transfer.importFromChat()
  ok(
    '压缩失败时退到存原件，记录照样入库',
    fallback.records.length === 1 && fallback.records[0].type === 'photo',
    fallback.records[0]
  )
  ok('退回原件的这条不计压缩收益', fallback.compressed === 0, fallback.compressed)

  failPersist = true
  err = null
  await transfer.importFromChat().catch(e => (err = e))
  ok('连原件都存不下时如实报 save', !!err && err.skipped[0].reason === 'save', err)
  failChatImage = false
  failPersist = false

  console.log('3.6) 一部分成、一部分不成：不能因为一个失败就整批丢掉')
  files['/tmp/ok.txt'] = '还能记一条'
  files['/tmp/tmp_hash_2'] = Buffer.from([0x00, 0xff, 0x01])
  pickup = [
    { path: '/tmp/ok.txt', name: '想法.txt' },
    { path: '/tmp/tmp_hash_2', name: '78a4bca059cff70d66e6b33621a75d19_26440' }
  ]
  const mixed = await transfer.importFromChat()
  ok('成功的那条照常入库', mixed.records.length === 1 && mixed.records[0].content === '还能记一条', mixed.records)
  ok(
    '失败的进 skipped，不拖垮整批',
    mixed.skipped.length === 1 && mixed.skipped[0].reason === 'type',
    mixed.skipped
  )
  ok('failed 是 shells + skipped 的合计', mixed.failed === 1, mixed.failed)

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
