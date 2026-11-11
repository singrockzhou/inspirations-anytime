/**
 * 聊天图片压缩（18 条断言）
 * 用法：node tools/image.test.js
 *
 * 直接驱动真实的 utils/media.js，只把 wx 的四五个接口换成记录型假实现，
 * 因为压缩这件事在真机上只能"看出来小了"，看不出"到底压了几轮、给了什么参数"。
 *
 * 覆盖：
 *   - 长边超 1280 时要同时给出压缩宽高（不只是降质量）
 *   - 压一轮还超 300KB → 降质量再压一轮；已经够了就不再压
 *   - 老基础库不认宽高参数 → 退回只给质量，不能把图丢了
 *   - 压不了（接口不存在 / 全 fail）→ 交原件
 *   - gif 不压（压了就成静图）
 *   - 体积回落情况如实报给上层
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
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}

/* ---------- 假 wx ---------- */
const KB = 1024
const sizes = {} // 路径 → 字节数
let calls = [] // compressImage 的每次入参
let seq = 0
let meta = { width: 4000, height: 3000 }
let roundBytes = [] // 第 n 轮压缩产出的体积，按顺序取
let rejectSizeArgs = false // 模拟老基础库：带压缩宽高就 fail
let noImageInfo = false // 模拟没有 wx.getImageInfo

global.wx = {
  env: { USER_DATA_PATH: '/user' },
  getFileSystemManager() {
    return {
      statSync(p) {
        if (!(p in sizes)) throw new Error('no such file')
        return { size: sizes[p] }
      },
      saveFile(opts) {
        if (!(opts.tempFilePath in sizes)) {
          opts.fail({ errMsg: 'saveFile:fail no such file' })
          return
        }
        sizes[opts.filePath] = sizes[opts.tempFilePath]
        opts.success({ savedFilePath: opts.filePath })
      },
      unlink() {}
    }
  },
  getImageInfo(opts) {
    if (noImageInfo) {
      opts.fail({ errMsg: 'getImageInfo:fail' })
      return
    }
    opts.success({ width: meta.width, height: meta.height })
  },
  compressImage(opts) {
    calls.push({
      src: opts.src,
      quality: opts.quality,
      w: opts.compressedWidth,
      h: opts.compressedHeight
    })
    if (rejectSizeArgs && opts.compressedWidth) {
      opts.fail({ errMsg: 'compressImage:fail parameter error' })
      return
    }
    const out = '/tmp/c' + ++seq
    const size = roundBytes.length ? roundBytes.shift() : 200 * KB
    sizes[out] = size
    opts.success({ tempFilePath: out })
  }
}

const media = require(path.join(B, 'utils', 'media.js'))

/** 每个用例开始前把状态清零 */
function reset(cfg) {
  const c = cfg || {}
  Object.keys(sizes).forEach(k => delete sizes[k])
  calls = []
  seq = 0
  roundBytes = (c.rounds || []).slice()
  meta = c.meta || { width: 4000, height: 3000 }
  rejectSizeArgs = !!c.rejectSizeArgs
  noImageInfo = false
}

;(async () => {
  console.log('1) 大图：既缩边又降质量')
  reset()
  sizes['/tmp/a.jpg'] = 5000 * KB
  const big = await media.saveChatImage('/tmp/a.jpg', 'jpg', 5000 * KB)
  ok('长边 4000 缩到 1280（高按比例）', calls[0].w === 1280 && calls[0].h === 960, calls[0])
  ok('质量给的是 70', calls[0].quality === 70, calls[0].quality)
  ok('回落体积如实报告', big.size === 200 * KB && big.originSize === 5000 * KB, [big.size, big.originSize])
  ok('标记为已压缩', big.compressed === true)
  ok('落盘到用户目录且是 jpg', big.path.indexOf('/user/img_') === 0 && /\.jpg$/.test(big.path), big.path)

  console.log('2) 一轮不够就再来一轮；够了不重复压')
  reset({ rounds: [800 * KB, 120 * KB] })
  sizes['/tmp/b.jpg'] = 4000 * KB
  const two = await media.saveChatImage('/tmp/b.jpg', 'jpg', 4000 * KB)
  ok('压了两轮', calls.length === 2, calls.length)
  ok('第二轮降质量到 45', calls[1].quality === 45, calls[1].quality)
  ok('采用更小的第二轮结果', two.size === 120 * KB, two.size)

  reset()
  sizes['/tmp/c.jpg'] = 900 * KB
  await media.saveChatImage('/tmp/c.jpg', 'jpg', 900 * KB)
  ok('第一轮已 ≤300KB 时只压一次', calls.length === 1, calls.length)

  console.log('3) 边界：小图、老基础库、压不动、gif')
  reset({ meta: { width: 600, height: 400 } })
  sizes['/tmp/s.png'] = 80 * KB
  await media.saveChatImage('/tmp/s.png', 'png', 80 * KB)
  ok('长边不到 1280 时不传压缩宽高', calls[0].w === undefined, calls[0])

  reset({ rejectSizeArgs: true })
  sizes['/tmp/o.jpg'] = 3000 * KB
  const retried = await media.saveChatImage('/tmp/o.jpg', 'jpg', 3000 * KB)
  ok('不认宽高参数时退回只给质量', calls.length === 2 && calls[1].w === undefined, calls)
  ok('退回后仍能存下', !!retried.path && retried.size > 0, retried)

  reset()
  delete global.wx.compressImage
  sizes['/tmp/n.jpg'] = 1200 * KB
  const raw = await media.saveChatImage('/tmp/n.jpg', 'jpg', 1200 * KB)
  ok('没有压缩接口时交原件，不丢图', raw.size === 1200 * KB && raw.compressed === false, raw)
  global.wx.compressImage = function (opts) {
    calls.push({ src: opts.src, quality: opts.quality, w: opts.compressedWidth, h: opts.compressedHeight })
    const out = '/tmp/c' + ++seq
    const size = roundBytes.length ? roundBytes.shift() : 200 * KB
    sizes[out] = size
    opts.success({ tempFilePath: out })
  }

  reset()
  sizes['/tmp/x.gif'] = 900 * KB
  const gif = await media.saveChatImage('/tmp/x.gif', 'gif', 900 * KB)
  ok('gif 不压，保留动图', calls.length === 0 && gif.size === 900 * KB, [calls.length, gif.size])
  ok('gif 保留扩展名', /\.gif$/.test(gif.path), gif.path)

  console.log('4) 体积未知时现场取')
  reset({ meta: { width: 3000, height: 3000 } })
  sizes['/tmp/u.jpg'] = 2400 * KB
  const unknown = await media.saveChatImage('/tmp/u.jpg', 'jpg', 0)
  ok('originSize 缺省时用 stat 拿到的体积', unknown.originSize === 2400 * KB, unknown.originSize)
  ok('仍按 1:1 缩边', calls[0].w === 1280 && calls[0].h === 1280, calls[0])

  reset()
  noImageInfo = true
  sizes['/tmp/m.jpg'] = 2000 * KB
  await media.saveChatImage('/tmp/m.jpg', 'jpg', 2000 * KB)
  ok('拿不到原图尺寸时只降质量，不猜宽高', calls[0].w === undefined && calls[0].quality === 70, calls[0])

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
