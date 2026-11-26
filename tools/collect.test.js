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
  // 真实 media.js 里这是"把授权结果交出来"的那层；剪贴板路径靠它拿诊断信息
  ensurePrivacyInfo: () => Promise.resolve({ ok: true, errMsg: '' }),
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
/** 假 storage：只给剪贴板"本机不可用"这条记忆用 */
const kv = {}
/** 按顺序吐出剪贴板内容：用来模拟"第一次读到空、重试才拿到" */
let clipboardSeq = null
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
  getStorageSync(k) {
    return k in kv ? kv[k] : ''
  },
  setStorageSync(k, v) {
    kv[k] = v
  },
  removeStorageSync(k) {
    delete kv[k]
  },
  getClipboardData(opts) {
    if (clipboardSeq && clipboardSeq.length) {
      const v = clipboardSeq.shift()
      if (v === null) opts.fail({ errMsg: 'getClipboardData:fail system busy' })
      else opts.success({ data: v })
      return
    }
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

  console.log('2.1) 剪贴板：第一次读空或接口忙，自动重试一次')
  // 真机上最常见的两种"明明有字却读不到"：隐私弹窗刚关掉时读到空、接口偶发 fail
  clipboardFail = ''
  clipboardSeq = ['', '重试之后才读到的这句话']
  const retried = await transfer.fromClipboard()
  ok('第一次读空、第二次拿到内容时算成功', retried.text === '重试之后才读到的这句话', retried.text)
  ok('重试成功时 truncated 照常为 false', retried.truncated === false, retried)
  clipboardSeq = null

  clipboardFail = 'getClipboardData:fail timeout'
  let detailErr = null
  await transfer.fromClipboard().catch(e => (detailErr = e))
  ok('非权限类失败重试后仍失败，归到 read', detailErr && detailErr.code === 'read', detailErr)
  ok(
    '原始 errMsg 带出去，线上能定位原因',
    detailErr && /timeout/.test(detailErr.detail || ''),
    detailErr && detailErr.detail
  )
  clipboardFail = ''

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

  console.log('3.7) 一次选的几张图要合成一条（同一件事不该拆成六条）')
  files['/tmp/g1.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01])
  files['/tmp/g2.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x02])
  files['/tmp/g3.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x03])
  pickup = [
    { path: '/tmp/g1.jpg', name: '主卧1.jpg', size: 500 * 1024 },
    { path: '/tmp/g2.jpg', name: '主卧2.jpg', size: 500 * 1024 },
    { path: '/tmp/g3.jpg', name: '主卧3.jpg', size: 500 * 1024 }
  ]
  chatCalls.length = 0
  const merged = await transfer.importFromChat()
  ok('三张图只产生一条记录', merged.records.length === 1, merged.records.map(r => r.type))
  ok(
    '这条是照片记录且带满三张',
    merged.records[0].type === 'photo' && merged.records[0].mediaPaths.length === 3,
    merged.records[0]
  )
  ok(
    '压缩顺序与选择顺序一致（不按名字、不按时间重排）',
    chatCalls.map(c => c.path).join(',') === '/tmp/g1.jpg,/tmp/g2.jpg,/tmp/g3.jpg',
    chatCalls.map(c => c.path)
  )
  ok('多张时不把其中任何一张的文件名写进正文', merged.records[0].content === '', merged.records[0].content)
  ok('体积是几张的合计', merged.records[0].size === 3 * 200 * 1024, merged.records[0].size)
  ok('photoCount / merged 如实回传，页面才能说"6 张合成了一条"', merged.photoCount === 3 && merged.merged === true)

  console.log('3.8) 合并后的照片记录要留在图片第一次出现的位置')
  files['/tmp/m1.txt'] = '先记一句'
  files['/tmp/g4.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x04])
  files['/tmp/g5.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x05])
  pickup = [
    { path: '/tmp/m1.txt', name: '想法.txt' },
    { path: '/tmp/g4.jpg', name: '图1.jpg', size: 300 * 1024 },
    { path: '/tmp/g5.jpg', name: '图2.jpg', size: 300 * 1024 }
  ]
  const ordered = await transfer.importFromChat()
  ok('顺序是 text,photo，不是 photo,text', ordered.records.map(r => r.type).join(',') === 'text,photo', ordered.records.map(r => r.type))
  ok('三选二出一，不多不少', ordered.records.length === 2, ordered.records.length)

  console.log('3.9) 图全存不下：不留空照片条，如实报 save')
  files['/tmp/h1.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x06])
  files['/tmp/m2.txt'] = '图挂了这条也要留下'
  pickup = [
    { path: '/tmp/h1.jpg', name: '坏图.jpg', size: 900 * 1024 },
    { path: '/tmp/m2.txt', name: '想法.txt' }
  ]
  failChatImage = true
  failPersist = true
  const partial = await transfer.importFromChat()
  ok('照片占位被删掉，不出现空记录', partial.records.map(r => r.type).join(',') === 'text', partial.records.map(r => r.type))
  ok(
    '失败的图进 skipped 并写清原因',
    partial.skipped.length === 1 && partial.skipped[0].reason === 'save',
    partial.skipped
  )
  failChatImage = false
  failPersist = false

  console.log('3.10) 进度回调：9 张图要看到"正在保存 3/9"')
  const seen = []
  pickup = [
    { path: '/tmp/g1.jpg', name: 'a.jpg', size: 100 * 1024 },
    { path: '/tmp/g2.jpg', name: 'b.jpg', size: 100 * 1024 },
    { path: '/tmp/g3.jpg', name: 'c.jpg', size: 100 * 1024 }
  ]
  await transfer.importFromChat({ onProgress: (i, n) => seen.push(i + '/' + n) })
  ok('每个文件回调一次，序号与总数都对', seen.join(',') === '1/3,2/3,3/3', seen)

  console.log('4) 入口位置：回顾位在首页，不在「我的」')
  const homeWxml = fs.readFileSync(path.join(B, 'pages', 'index', 'index.wxml'), 'utf8')
  ok('首页挂着回顾位并指向 openReview', /catchtap="openReview"/.test(homeWxml) && /reviewTotal/.test(homeWxml))
  ok('回顾位的条件是"超过一条"才出现', /reviewTotal > 1/.test(homeWxml))

  const meWxml = fs.readFileSync(path.join(B, 'pages', 'me', 'me.wxml'), 'utf8')
  ok('「我的」不再有回顾入口', !/onReview/.test(meWxml))

  const homeJs = fs.readFileSync(path.join(B, 'pages', 'index', 'index.js'), 'utf8')
  ok('首页收一条拆成两个来源', /collectFiles/.test(homeJs) && /collectClipboard/.test(homeJs))

  console.log('5) 剪贴板兜底：读不到不能让用户卡死在那一步')
  // 按函数体切片，不按"两个名字的先后顺序"切：pasteManual 现在定义在
  // collectClipboard 前面，老写法会切出空串，断言变成空跑——明明失败却看不见。
  const bodyOf = name => {
    const m = new RegExp('\\n  ' + name + '\\([^)]*\\) \\{').exec(homeJs)
    if (!m) return ''
    const fin = homeJs.indexOf('\n  },', m.index)
    return fin > m.index ? homeJs.slice(m.index, fin) : ''
  }
  const clipBody = bodyOf('collectClipboard')
  const pasteBody = bodyOf('pasteManual')
  // 自绘输入框从 pasteManual 拆出来了（它现在只做分流：系统权限 / 隐私授权 / 空）。
  // 断言跟着函数走，不然切片会切到一段不含这些代码的分流逻辑上，白白空跑。
  const askBody = bodyOf('askPasteText')

  ok(
    '三个函数体都切出来了（防止切片失效让后面的断言空跑）',
    clipBody.length > 100 && pasteBody.length > 100 && askBody.length > 100,
    { clip: clipBody.length, paste: pasteBody.length, ask: askBody.length }
  )
  ok(
    '读剪贴板之前不挂 loading（遮罩会把隐私授权框挡掉，正是"有字却说没读成"的成因）',
    !/wx\.showLoading/.test(clipBody),
    clipBody.slice(0, 120)
  )
  ok('读不到时改走手动粘贴，而不是只弹一个错', /this\.pasteManual\(err\)/.test(clipBody))
  ok('手动粘贴与剪贴板走同一条落库路径', /this\.saveCollected\(/.test(askBody))

  console.log('5.0) 存下之后，那条记录必须真的出现在眼前')
  // 入口钉在屏幕最底部，新记录插在列表最上方。只 toast 不回顶时，
  // 用户看到的是「存下了，就在最上面」，然后自己往上翻——那句文案本身
  // 就是在替设计道歉（截图里两条一样的记录，第一条就是这么被漏看的）。
  const saveBody = bodyOf('saveCollected')
  const revealBody = bodyOf('reveal')
  ok('两个函数体都切出来了（防空白跑）', saveBody.length > 200 && revealBody.length > 60, {
    save: saveBody.length,
    reveal: revealBody.length
  })
  ok('存完调的是 reveal，不是只闪一下', /this\.reveal\(rec\.id\)/.test(saveBody) && !/this\.flash\(rec\.id\)/.test(saveBody))
  ok('reveal 把视口带回顶部', /wx\.pageScrollTo/.test(revealBody) && /scrollTop:\s*0/.test(revealBody))
  ok('reveal 之后才点亮那条', revealBody.indexOf('pageScrollTo') < revealBody.indexOf('this.flash('))
  ok(
    '从记录页新建后返回也回顶，编辑返回则不回顶（不把用户正看的位置顶掉）',
    /flashNew/.test(homeJs) && /if \(flashNew\) this\.reveal\(flashId\)/.test(homeJs)
  )
  // 注释里引用旧文案是为了记下这段弯路，不算违规：只看代码行
  const codeOnly = s =>
    s
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/)/.test(l))
      .join('\n')
  ok(
    '「就在最上面」这句已删掉',
    !/就在最上面/.test(codeOnly(homeJs)) &&
      !/就在最上面/.test(fs.readFileSync(path.join(B, 'utils', 'i18n.js'), 'utf8'))
  )

  console.log('5.0.1) 连点两下不该落下两条一样的')
  ok('有冷却常量', /const SAVE_COOLDOWN_MS = \d+/.test(homeJs))
  ok('冷却期内直接并进第一次，不再落库', /now < this\.saveGuardUntil\) return/.test(saveBody))
  ok('落库失败时清掉冷却，允许立刻重试', /if \(!rec\) \{\s*\n\s*this\.saveGuardUntil = 0/.test(saveBody))
  ok(
    '「和上一条一样」在 create 之前取（create 之后最新一条就是自己）',
    saveBody.indexOf('this.prevText()') < saveBody.indexOf('store.create(')
  )
  ok('内容相同会如实说出来，不是静默重复', /index:clip_dup_saved/.test(saveBody))
  // 正常保存不再弹浮层：卡片自身 1.8 秒整卡暖色渐变就是回执，比三字黑条显眼
  // 且不遮内容。微信读剪贴板成功时会在屏幕顶部弹自己的合规提示，我们再来一条
  // 就成一上一下两个黑条（README 第 42 章）。
  ok(
    '正常保存不再弹「存下了」浮层',
    !/i18n\.t\('index:clip_saved'\)/.test(codeOnly(saveBody)),
    codeOnly(saveBody).match(/.*clip_saved.*/)?.[0] || ''
  )
  ok(
    '「和上一条一样」仍然弹（不解释就像重复落库的 bug）',
    /this\.toast\(i18n\.t\('index:clip_dup_saved'\)\)/.test(saveBody)
  )
  const cardWxss = fs.readFileSync(path.join(B, 'components', 'card', 'card.wxss'), 'utf8')
  ok(
    '不弹浮层的前提成立：卡片高亮是整卡 1.8 秒暖色渐变，够显眼',
    /\.card\.fresh/.test(cardWxss) && /animation:\s*fresh\s+1\.8s/.test(cardWxss) && /#f6e5d5/.test(cardWxss)
  )
  ok(
    '按钮热区：顶部三个文字入口都抬到 72rpx',
    (fs.readFileSync(path.join(B, 'pages', 'index', 'index.wxss'), 'utf8').match(/min-height: 72rpx/g) || []).length >= 3
  )
  // 只数顶栏那三个。空态的两条文字链也带 tap-dim（v1.8.5 加的模板入口），
  // 全页计数会把它们算进来，看起来像"多了两个入口"，其实是别处的按钮。
  const topStart = homeWxml.indexOf('class="top-right"')
  const topEnd = homeWxml.indexOf('</view>', homeWxml.indexOf('goMe', topStart))
  const topBar = topStart >= 0 && topEnd > topStart ? homeWxml.slice(topStart, topEnd) : ''
  ok(
    '按钮热区：三个入口都有按下反馈',
    (topBar.match(/hover-class="tap-dim"/g) || []).length === 3,
    topBar.length
  )
  ok(
    'toast 停留时间按字数放宽（长句不再读一半就熄）',
    /Math\.min\(3200, 1600 \+/.test(homeJs)
  )

  console.log('5.1) 兜底不许依赖基础库版本判断（v1.8.5 线上翻车点）')
  ok(
    '自绘 dialog，不再用 wx.showModal',
    /dialog/.test(askBody) && /\.show\(/.test(askBody) && !/wx\.showModal/.test(askBody)
  )
  ok('粘贴框是多行 textarea（长文才看得见全文）', /multiline: *true/.test(askBody))
  ok(
    '全项目不再用 wx.canIUse 判断 showModal.editable（schema 缺 object 层必然 false）',
    // 只看代码行：注释里提到 canIUse 是解释这条坑，不算违规
    !/canIUse/.test(homeJs.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n'))
  )
  ok(
    'dialog 组件真的渲染了 textarea',
    /<textarea/.test(fs.readFileSync(path.join(B, 'components', 'dialog', 'dialog.wxml'), 'utf8'))
  )
  ok(
    '失败原因只在开发版/体验版显示',
    /envVersion/.test(homeJs) && /'develop'/.test(homeJs) && /'trial'/.test(homeJs)
  )

  console.log('5.2) 隐私未确认时那句 system permission denied，要补授权重读，不能判死')
  // 真机教训：鸿蒙微信在隐私协议没确认时读剪贴板，回的是
  // `fail:system permission denied`——看着像永久性系统限制，其实只差用户点一次"同意"。
  // 曾经把它当成"这台机器永远读不到"还记了 30 天，功能从此再没机会跑起来。
  const realGet = wx.getClipboardData
  let rawCalls = 0
  wx.getClipboardData = o => {
    rawCalls++
    if (rawCalls === 1) o.fail({ errMsg: 'getClipboardData:fail:system permission denied' })
    else o.success({ data: '补完授权读到的字' })
  }
  let sysOk = null
  let sysErr = null
  await transfer.fromClipboard().then(r => (sysOk = r), e => (sysErr = e))
  ok('补一次授权后能读到，这次就该算成功', !!sysOk && sysOk.text === '补完授权读到的字', sysOk || sysErr)
  ok('确实重读过，不是一次失败就放弃', rawCalls >= 2, rawCalls)

  rawCalls = 0
  wx.getClipboardData = o => {
    rawCalls++
    o.fail({ errMsg: 'getClipboardData:fail:system permission denied' })
  }
  sysOk = null
  sysErr = null
  await transfer.fromClipboard().then(r => (sysOk = r), e => (sysErr = e))
  ok('两次都失败才 reject，并带上原始 errMsg', !sysOk && !!sysErr && /permission denied/.test(sysErr.detail || ''), sysErr && sysErr.detail)
  ok(
    '归到 denied（d-e-n-i-e-d 里没有 deny 子串，正则漏写就会误判成 read）',
    !!sysErr && sysErr.code === 'denied',
    sysErr && sysErr.code
  )
  // 诊断行要能区分"用户还没同意隐私政策"和"接口本身读不到"。
  // 官方《隐私协议开发指南》列出的隐私错误只有 112 / banned / 103 / 104，
  // 没有 system permission denied 这一句，所以只报读取 errMsg 定不了因。
  wx.getPrivacySetting = o => o.success({ needAuthorization: true })
  fakeMedia.ensurePrivacyInfo = () =>
    Promise.resolve({ ok: false, errMsg: 'requirePrivacyAuthorize:fail 104 privacy not agreed' })
  sysOk = null
  sysErr = null
  await transfer.fromClipboard().then(r => (sysOk = r), e => (sysErr = e))
  ok(
    '诊断行同时带上 need=1 与授权那一步的 errMsg',
    !!sysErr && /need=1/.test(sysErr.detail || '') && /auth=.*104/.test(sysErr.detail || ''),
    sysErr && sysErr.detail
  )
  delete wx.getPrivacySetting
  fakeMedia.ensurePrivacyInfo = () => Promise.resolve({ ok: true, errMsg: '' })
  ok(
    '没有 getPrivacySetting 时诊断行也不炸，只是少一项',
    await transfer.fromClipboard().then(
      () => false,
      e => /read=/.test(e.detail || '') && !/need=/.test(e.detail || '') && !/auth=/.test(e.detail || '')
    )
  )

  wx.getClipboardData = realGet
  clipboardFail = ''

  console.log('5.3) 时序：先授权再读——v1.8.0~v1.8.4 的真机行为，不许再"优化"掉')
  const transferJs = fs.readFileSync(path.join(B, 'utils', 'transfer.js'), 'utf8')
  ok(
    '先走隐私授权再读（v1.8.5 改成"先读"之后，真机上就再也读不到了）',
    /ensurePrivacyInfo\(\)\s*\.then\(info => \{[\s\S]{0,160}?read\(\)/.test(transferJs)
  )
  ok(
    '失败后仍会补一次授权重读，而不是一次失败就判死',
    /!retriedPrivacy/.test(transferJs) &&
      /retriedPrivacy = true/.test(transferJs) &&
      (transferJs.match(/ensurePrivacyInfo\(\)/g) || []).length >= 2,
    '前瞻授权 + 失败补授权，两处都要走同一个能交出结果的口子'
  )
  ok(
    '代码里不存在"这台机器读不到剪贴板"的永久性判断',
    !/clipboardBlocked|markClipboardBlocked|CLIP_BLOCK|sysperm/.test(transferJs),
    '这套机制建立在错误结论上，不许回来'
  )
  ok('页面上不再有"跳过读取、直接给输入框"的短路', !/clipboardBlocked/.test(homeJs))
  ok('隐私未过时给的是"还差一步"的解释 + 粘贴框', /clip_denied_title/.test(homeJs) && /clip_denied_text/.test(homeJs))
  ok('剪贴板失败会重试一次', /const again = \(\) =>/.test(transferJs) && /tries >= 1/.test(transferJs))
  ok(
    '重试失败仍把原始 errMsg 带出去',
    /parts\.push\('read=' \+ msg\)/.test(transferJs) && /join\(' \| '\)/.test(transferJs)
  )
  ok(
    '诊断行带上隐私设置状态与授权 errMsg，不只报读取那一句',
    /privacySnapshot\(\)/.test(transferJs) && /parts\.push\('need='/.test(transferJs) && /parts\.push\('auth='/.test(transferJs)
  )
  ok(
    'denied 分支不再把诊断行覆盖掉（曾经因此连续几轮看不到任何 errMsg）',
    /clip_denied_text'\)\s*\+\s*'\\n'\s*\+\s*note/.test(homeJs)
  )
  console.log('5.4) 系统层把剪贴板关了：必须指到系统设置，讲小程序隐私授权等于白讲')
  ok(
    'transfer 把 system permission denied 单独标出来',
    /sysDenied: \/system permission denied\/i\.test\(msg\)/.test(transferJs),
    '真机已确认：鸿蒙的「剪贴板」是微信 App 的一项系统权限，关掉就报这句'
  )
  ok(
    '页面见到 sysDenied 先走系统权限分支，不再讲"隐私授权"',
    /code === 'denied' && err && err\.sysDenied/.test(pasteBody) && /this\.askSystemPermission\(\)/.test(pasteBody)
  )
  const sysBody = bodyOf('askSystemPermission')
  ok(
    '弹框给的是「去打开 / 手动粘贴」，不是一句"知道了"',
    /clip_sysperm_open/.test(sysBody) && /clip_sysperm_manual/.test(sysBody)
  )
  const openBody = bodyOf('openSystemPermission')
  ok('用官方接口跳系统微信授权管理页', /wx\.openAppAuthorizeSetting/.test(openBody))
  ok(
    '接口不在时降级成文字路径，不静默失败',
    /typeof wx\.openAppAuthorizeSetting !== 'function'/.test(openBody) && /clip_sysperm_noway/.test(openBody)
  )
  ok(
    '从系统页返回会自动重读一次',
    /this\.retryOnShow = true/.test(openBody) &&
      /if \(this\.retryOnShow\)/.test(homeJs) &&
      /setTimeout\(\(\) => this\.collectClipboard\(\), 300\)/.test(homeJs)
  )
  ok(
    '引导只做一次，不让人在弹框之间打转',
    /this\.sysPermTried = true/.test(openBody) && /this\.sysPermTried/.test(pasteBody)
  )

  const mediaJs = fs.readFileSync(path.join(B, 'utils', 'media.js'), 'utf8')
  ok(
    '隐私授权失败时把 errMsg 交出来，而不是 resolve(true) 吞掉',
    /ok: false, errMsg: msg/.test(mediaJs) && !/fail: err => \{[\s\S]{0,200}?resolve\(true\)/.test(mediaJs)
  )

  console.log('3.11) 收不了的类型：必须当面说，不能留壳也不能一直转圈')
  files['/tmp/v.mp4'] = Buffer.from([0x00, 0x00, 0x00, 0x18])
  pickup = [{ path: '/tmp/v.mp4', name: '会议录像.mp4', size: 8 * 1024 * 1024 }]
  let unErr = null
  await transfer.importFromChat().catch(e => (unErr = e))
  ok('全是不支持的格式时单独报 unsupported_type', !!unErr && unErr.code === 'unsupported_type', unErr && unErr.code)
  ok('带上清单一并回传，页面才能说清是哪几个', !!unErr && unErr.unsupported.length === 1, unErr && unErr.unsupported)
  ok(
    '不把视频做成「来自「xx.mp4」」的壳记录',
    !!unErr && !(unErr.records || []).length && unErr.skipped.length === 0,
    unErr && unErr.skipped
  )

  files['/tmp/v2.zip'] = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  files['/tmp/y.jpg'] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x07])
  files['/tmp/k.txt'] = '这条要留下'
  pickup = [
    { path: '/tmp/y.jpg', name: '截图.jpg', size: 100 * 1024 },
    { path: '/tmp/v2.zip', name: '素材包.zip', size: 1024 },
    { path: '/tmp/k.txt', name: '想法.txt' }
  ]
  const someOk = await transfer.importFromChat()
  ok('支持的照常入库，不支持的单独列出', someOk.records.length === 2 && someOk.unsupported.length === 1, {
    records: someOk.records.map(r => r.type),
    unsupported: someOk.unsupported
  })
  ok('收不了的带类型信息，提示里能说"这是 zip"', someOk.unsupported[0].ext === 'zip', someOk.unsupported[0])
  ok('收不了的不算进 failed（它没坏，只是不支持）', someOk.failed === 0, someOk.failed)

  console.log('3.12) 超大文本文件：不读、不卡界面')
  files['/tmp/huge.csv'] = 'a,b'
  pickup = [{ path: '/tmp/huge.csv', name: '导出.csv', size: 3 * 1024 * 1024 }]
  unErr = null
  await transfer.importFromChat().catch(e => (unErr = e))
  ok(
    '超过 2MB 的文本归到收不了（原因 big）',
    !!unErr && unErr.code === 'unsupported_type' && unErr.unsupported[0].reason === 'big',
    unErr && unErr.unsupported
  )

  console.log('3.13) pdf/word 仍然留壳，不受"不支持"名单影响')
  files['/tmp/d2.pdf'] = Buffer.from('%PDF-1.7\n')
  pickup = [{ path: '/tmp/d2.pdf', name: '合同.pdf', size: 200 * 1024 }]
  const pdfOk = await transfer.importFromChat()
  ok('pdf 还是留一条可补一句的壳', pdfOk.records.length === 1 && pdfOk.shells === 1, pdfOk.records)
  ok('pdf 不进收不了清单', pdfOk.unsupported.length === 0, pdfOk.unsupported)

  console.log('6) 多图合并的配套展示：卡片补说明 + 详情堆叠')
  const cardJs = fs.readFileSync(path.join(B, 'components', 'card', 'card.js'), 'utf8')
  const cardWxml = fs.readFileSync(path.join(B, 'components', 'card', 'card.wxml'), 'utf8')
  ok('照片没有正文时卡片才算 needText', /needText: item\.type === 'photo' && !content\.trim\(\)/.test(cardJs))
  ok('卡片上有「补个说明」这一行', /class="need-text"/.test(cardWxml) && /onAddText/.test(cardWxml))
  ok('多选模式下不显示这条提示（别干扰勾选流程）', /needText && !selectMode/.test(cardWxml))
  ok('点提示只冒泡事件，卡片不自己跳页', /triggerEvent\('addtext'/.test(cardJs))
  const homeWxmlCards = fs.readFileSync(path.join(B, 'pages', 'index', 'index.wxml'), 'utf8')
  ok(
    '首页两处卡片都接了这个事件（列表 + 分组视图）',
    (homeWxmlCards.match(/bind:addtext="onCardAddText"/g) || []).length === 2,
    (homeWxmlCards.match(/bind:addtext="onCardAddText"/g) || []).length
  )
  ok('补说明直达编辑页并聚焦配文框', /record\?mode=edit&id=' \+ item\.id \+ '&focus=1'/.test(homeJs))

  const detailJs = fs.readFileSync(path.join(B, 'pages', 'detail', 'detail.js'), 'utf8')
  const detailWxml = fs.readFileSync(path.join(B, 'pages', 'detail', 'detail.wxml'), 'utf8')
  ok('详情页多图走 stack.planAll（与卡片、做成图同一份版式）', /stack\.planAll/.test(detailJs))
  ok('详情页照片区按 multi 分流，单图仍是整幅', /wx:if="\{\{!multi\}\}"/.test(detailWxml))
  ok('堆叠里的每张都能点开看大图', /catchtap="onPreviewPhoto"/.test(detailWxml) && /previewImage/.test(detailJs))
  ok(
    '详情页不再用九宫格铺多图',
    !/<photo-grid paths="\{\{photos\}\}" single="auto" \/>\s*\n\s*<view class="text sub"/.test(detailWxml),
    'photo-grid 仍应只服务单图'
  )

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
