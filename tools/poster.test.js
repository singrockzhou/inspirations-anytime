/**
 * 「做成图」多图堆叠（40 条）
 * 用法：node tools/poster.test.js
 *
 * 这一版把长图里"只显示第一张"改成"按首页那套错落堆叠显示全部"。
 * 画布代码跑不起来不会报错，它只会画错——而这种错只有导出之后才看得见：
 *   · 写着 3 张、图里只有 1 张（本次要修的问题）
 *   · 版式挪了位、和首页卡片摆得不一样
 *   · 某张图加载失败，后面几张跟着错位（数组长度和版式对不上）
 *   · 9 张照片的长图把画布撑到 50MB，导出直接失败
 * 所以这里用假的 ctx 把"画了什么、画在哪、画了几张"逐项录下来核对。
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const B = path.join(ROOT, 'miniprogram')

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

/* ---------------- 假微信 / 假画布 ---------------- */
let SYS = { language: 'zh_CN' }
global.wx = {
  getAppBaseInfo: () => ({ language: SYS.language }),
  getStorageSync: () => '',
  setStorageSync: () => {}
}

/** 记录每一次绘制，够判断"画了几张、画在哪、什么顺序" */
function mockCtx() {
  const log = { drawImage: [], translate: [], rotate: [], fillText: [], fillRect: [] }
  const ctx = {
    font: '38px sans-serif',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    log: log,
    save() {},
    restore() {},
    translate(x, y) {
      log.translate.push({ x: x, y: y })
    },
    rotate(a) {
      log.rotate.push(a)
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    clip() {},
    stroke() {},
    setTransform() {},
    scale() {},
    fillRect(x, y, w, h) {
      log.fillRect.push({ x: x, y: y, w: w, h: h })
    },
    drawImage(img, x, y, w, h) {
      log.drawImage.push({ img: img, x: x, y: y, w: w, h: h })
    },
    fillText(t, x, y) {
      log.fillText.push({ t: t, x: x, y: y })
    },
    measureText(t) {
      const m = /(\d+)px/.exec(this.font || '38px')
      const size = m ? Number(m[1]) : 38
      return { width: String(t).length * size * 0.6 }
    },
    createLinearGradient() {
      return { addColorStop() {} }
    }
  }
  return ctx
}

const stack = require(path.join(B, 'utils', 'stack.js'))
const poster = require(path.join(B, 'utils', 'poster.js'))
const i18n = require(path.join(B, 'utils', 'i18n.js'))

/** 一张能塞给 drawImage 的假图 */
const fakeImage = (w, h) => ({ img: { fake: true }, width: w || 1200, height: h || 900 })

/* ============ 1. 分组：张数怎么切 ============ */
console.log('1) 分组：一组最多 4 张，且不出现"落单 1 张"')
{
  ok('0 张不分组', stack.clusters(0).length === 0, stack.clusters(0))
  ok('1 张单独走整幅大图', JSON.stringify(stack.clusters(1)) === '[1]', stack.clusters(1))
  ok('2 张一组', JSON.stringify(stack.clusters(2)) === '[2]', stack.clusters(2))
  ok('4 张一组', JSON.stringify(stack.clusters(4)) === '[4]', stack.clusters(4))
  ok('5 张切 3+2（不是 4+1）', JSON.stringify(stack.clusters(5)) === '[3,2]', stack.clusters(5))
  ok('7 张切 4+3', JSON.stringify(stack.clusters(7)) === '[4,3]', stack.clusters(7))
  ok('9 张切 3+3+3', JSON.stringify(stack.clusters(9)) === '[3,3,3]', stack.clusters(9))

  const bad = []
  for (let n = 2; n <= 30; n++) {
    const c = stack.clusters(n)
    if (c.reduce((a, b) => a + b, 0) !== n) bad.push(n + ' 总数不对')
    if (c.some(v => v < 2 || v > stack.MAX_FRAMES)) bad.push(n + ' 组大小越界 ' + c)
  }
  ok('2–30 张：每组 2–4 张且总数守恒', bad.length === 0, bad.slice(0, 4))
}

/* ============ 2. 版式与首页卡片同源 ============ */
console.log('2) 版式：与首页卡片共用一份数字（不是两套参数）')
{
  // 把 card.js 顶部（Component 之前）的 buildStack 拿出来跑，逐字比对样式串
  const src = read('components/card/card.js')
  const cut = src.slice(0, src.indexOf('Component({'))
  const mod = { exports: {} }
  const fn = new Function('module', 'require', cut + '\nmodule.exports={buildStack}')
  fn(mod, p => require(path.resolve(B, p.replace('../../', ''))))
  const { buildStack } = mod.exports

  const diffs = []
  ;['a', 'b', 'rec_1750000000000_x'].forEach(id => {
    ;[2, 3, 4].forEach(n => {
      const paths = Array.from({ length: n }, (_, i) => 'p' + i + '.jpg')
      const card = buildStack({ id: id, createdAt: 1 }, paths)
      const p = stack.plan(id, n)
      if (card.height !== p.height) diffs.push(id + '/' + n + ' 高度 ' + card.height + '≠' + p.height)
      p.frames.forEach((f, i) => {
        const want = 'left:' + f.x + 'rpx;top:' + f.y + 'rpx;width:' + stack.FRAME_W + 'rpx;height:' +
          stack.FRAME_H + 'rpx;z-index:' + f.z + ';transform:rotate(' + f.r.toFixed(1) + 'deg);'
        if (card.frames[i].style !== want) diffs.push(id + '/' + n + '/' + i)
      })
    })
  })
  ok('卡片与 stack.plan 的坐标、角度、层高逐字一致', diffs.length === 0, diffs.slice(0, 3))

  const p4 = stack.plan('same', 4)
  ok('同一 id 反复算结果稳定（不会每次刷新都歪一点）', JSON.stringify(p4) === JSON.stringify(stack.plan('same', 4)))
  ok('不同 id 会错开（不雷同）', JSON.stringify(stack.plan('a', 3)) !== JSON.stringify(stack.plan('b', 3)))
  ok('相纸外框是 330×254，与 wxss 一致', stack.FRAME_W === 330 && stack.FRAME_H === 254)
  ok('白边 10rpx、圆角 18/12，与卡片一致', stack.FRAME_PAD === 10 && stack.FRAME_RADIUS === 18 && stack.IMAGE_RADIUS === 12)
  ok('旋转都在 ±12° 内（再多就不像"随手放的"）', [2, 3, 4].every(n => stack.plan('z', n).frames.every(f => Math.abs(f.r) <= 12)))
}

/* ============ 3. 多组纵向排布 ============ */
console.log('3) 多组：9 张排成三摞，间距与总高对得上')
{
  const one = stack.planAll('k', 4)
  ok('4 张只有一组', one.clusters.length === 1 && !one.single)
  ok('4 张时总高 = 组高', one.height === one.clusters[0].height)

  const five = stack.planAll('k', 5)
  ok('5 张分两组 3+2', five.clusters.length === 2 && five.sizes.join() === '3,2')
  ok('两组之间有 28rpx 间距', five.height === five.clusters[0].height + stack.CLUSTER_GAP + five.clusters[1].height, five)

  const nine = stack.planAll('k', 9)
  ok('9 张分三组', nine.clusters.length === 3)
  ok('每组张数与 frames 数量一致', nine.clusters.every(c => c.frames.length === c.size))
  ok('9 张的总高 = 三组 + 两道间距', nine.height === nine.clusters.reduce((s, c) => s + c.height, 0) + 2 * stack.CLUSTER_GAP)
  ok('后两组换了种子（三摞不会一模一样）', JSON.stringify(nine.clusters[0].frames) !== JSON.stringify(nine.clusters[1].frames))

  const single = stack.planAll('k', 1)
  ok('单张走整幅大图，高 420', single.single === true && single.height === stack.SINGLE_H)
  ok('0 张返回 null', stack.planAll('k', 0) === null)
}

/* ============ 4. 量高：照片块占多少 ============ */
console.log('4) 量高：照片块的高度进了总高，且按张数增长')
{
  const ctx = mockCtx()
  // 正文要够长：短正文会撞到 620 的最小高度，那样"加图前后差多少"就算不清了
  const longText = Array.from({ length: 12 }, (_, i) => '第' + (i + 1) + '行').join('\n')
  const rec = (n) => ({
    id: 'r1',
    type: 'photo',
    content: longText,
    createdAt: 1750000000000,
    mediaPaths: Array.from({ length: n }, (_, i) => 'p' + i + '.jpg')
  })
  const imgs = n => Array.from({ length: n }, () => fakeImage())

  const l3 = poster.measure(ctx, rec(3), { images: imgs(3) })
  const l3no = poster.measure(ctx, rec(3), { images: [] })
  const block3 = stack.planAll('r1', 3)
  ok('12 行正文已经超过最小高度（量高对比才有效）', l3no.height > 620, l3no.height)
  ok('3 张：有照片块', !!l3.photo)
  ok('3 张：总高 = 无图高 + 36 + 块高', l3.height === l3no.height + 36 + block3.height, {
    with: l3.height, without: l3no.height, block: block3.height
  })

  const l9 = poster.measure(ctx, rec(9), { images: imgs(9) })
  ok('9 张比 3 张更高（全部排进去了）', l9.height > l3.height + 2 * 300, { l9: l9.height, l3: l3.height })
  ok('9 张照片块 = 三摞之和', l9.photo.clusters.length === 3)

  const text = poster.measure(ctx, { id: 't', type: 'text', content: '一句话', createdAt: 1 }, {})
  ok('纯文字记录不占照片块', text.photo === null)

  const allFailed = poster.measure(ctx, rec(3), { images: [null, null, null] })
  ok('一张都没加载出来：整块不画，退回纯文字版', allFailed.photo === null, allFailed.photo && allFailed.photo.sizes)
}

/* ============ 5. 画：三张图就得画三张 ============ */
console.log('5) 画：所有照片都上，一张不少')
{
  const rec = (n) => ({
    id: 'r9',
    type: 'photo',
    content: '',
    createdAt: 1750000000000,
    mediaPaths: Array.from({ length: n }, (_, i) => 'p' + i + '.jpg')
  })

  const run = (n, images, opt) => {
    const ctx = mockCtx()
    const layout = poster.measure(ctx, rec(n), { images: images })
    const c2 = mockCtx()
    poster.paint(c2, rec(n), layout, Object.assign({ images: images, footer: 'footer' }, opt))
    return { ctx: c2, layout: layout }
  }

  const three = run(3, [fakeImage(), fakeImage(), fakeImage()])
  ok('3 张照片画了 3 次 drawImage', three.ctx.log.drawImage.length === 3, three.ctx.log.drawImage.length)
  ok('每张都带旋转（不是摆正贴上去）', three.ctx.log.rotate.length === 3, three.ctx.log.rotate.length)

  const boxW = stack.FRAME_W - stack.FRAME_PAD * 2
  const boxH = stack.FRAME_H - stack.FRAME_PAD * 2
  ok('每张都覆盖满相纸内框（cover 裁切，不留白边）',
    three.ctx.log.drawImage.every(d => d.w >= boxW - 0.5 && d.h >= boxH - 0.5),
    three.ctx.log.drawImage.map(d => Math.round(d.w) + '×' + Math.round(d.h)))

  const nine = run(9, Array.from({ length: 9 }, () => fakeImage()))
  ok('9 张照片画了 9 次（这就是本次要修的问题）', nine.ctx.log.drawImage.length === 9, nine.ctx.log.drawImage.length)
  ok('9 张 = 三摞，纵向依次往下', nine.ctx.log.translate.length === 9 &&
    nine.ctx.log.translate.slice(3).every((t, i) => t.y > nine.ctx.log.translate[i].y))
  ok('画布高度够放三摞（画完不越界）', nine.layout.height > nine.layout.photo.height)

  const single = run(1, [fakeImage(1600, 1200)])
  ok('单张仍是整幅大图（宽 630）', single.ctx.log.drawImage.length === 1 && single.ctx.log.drawImage[0].w >= 630 - 0.5,
    single.ctx.log.drawImage[0] && Math.round(single.ctx.log.drawImage[0].w))

  const partial = run(3, [fakeImage(), null, fakeImage()])
  ok('中间一张加载失败：只画 2 张，且不抛错', partial.ctx.log.drawImage.length === 2, partial.ctx.log.drawImage.length)
  ok('版式仍按 3 张排（缺一张不导致后面的图错位）', partial.layout.photo.sizes.join() === '3')

  const none = run(3, [null, null, null])
  ok('三张全失败：不画照片，也不留空相纸', none.ctx.log.drawImage.length === 0 && none.layout.photo === null)

  // 层级：按 z 从下往上画，压住关系才和卡片一致
  const order = run(4, [fakeImage(), fakeImage(), fakeImage(), fakeImage()])
  const plan4 = stack.plan('r9', 4)
  const seen = order.ctx.log.translate.map(t => {
    const hit = plan4.frames.findIndex(f => Math.abs((f.x + stack.FRAME_W / 2) + 60 - t.x) < 0.6)
    return hit >= 0 ? plan4.frames[hit].z : -1
  })
  ok('绘制顺序 = 层级从下到上', seen.every((z, i) => i === 0 || z > seen[i - 1]), seen)
}

/* ============ 6. 边界：不越出画布 ============ */
console.log('6) 边界：相纸不出画布、不被页脚压住')
{
  const bad = []
  ;[2, 3, 4].forEach(n => {
    ;['a', 'b', 'c', 'd', 'e'].forEach(id => {
      const p = stack.plan(id, n)
      p.frames.forEach(f => {
        // 旋转会让包围盒外扩，按 254/2 * sin(12°) ≈ 26 留余量
        if (f.x < -26) bad.push(id + '/' + n + ' 左边越界 ' + f.x)
        if (f.x + stack.FRAME_W > 630 + 26) bad.push(id + '/' + n + ' 右边越界 ' + (f.x + stack.FRAME_W))
      })
    })
  })
  ok('所有照片都落在 630 宽的内容区内（含旋转余量）', bad.length === 0, bad.slice(0, 3))

  const ctx = mockCtx()
  const rec = { id: 'r9', type: 'photo', content: '', createdAt: 1750000000000, mediaPaths: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }
  const images = Array.from({ length: 9 }, () => fakeImage())
  const layout = poster.measure(ctx, rec, { images: images })
  const c2 = mockCtx()
  poster.paint(c2, rec, layout, { images: images, footer: 'f' })
  // 相纸中心 + 半高 + 旋转外扩（254/2·sin12° ≈ 26）就是最下沿
  const frameBottom = Math.max.apply(null, c2.log.translate.map(t => t.y)) + stack.FRAME_H / 2 + 26
  ok('最下面那张相纸没压到页脚线', frameBottom <= layout.height - 112, {
    frameBottom: Math.round(frameBottom), footerY: layout.height - 112
  })
  ok('照片块底部与页脚之间仍有留白', layout.height - 112 - frameBottom >= 60, layout.height - 112 - frameBottom)
}

/* ============ 7. 位图预算：照片多了先降倍率 ============ */
console.log('7) 位图预算：9 张照片的长图不至于把画布撑爆')
{
  ok('普通高度仍用设备倍率（3）', poster.fitDpr(620, 3) === 3, poster.fitDpr(620, 3))
  ok('长图自动降倍率', poster.fitDpr(1892, 3) < 3, poster.fitDpr(1892, 3))
  ok('9 张照片那档仍 ≥ 2.5（字不能发虚）', poster.fitDpr(1892, 3) >= 2.5, poster.fitDpr(1892, 3))
  ok('降倍率有下限 1.5', poster.fitDpr(9000, 3) === 1.5, poster.fitDpr(9000, 3))
  ok('永远不超过 3', poster.fitDpr(620, 4) <= 3)

  const h = 1892
  const d = poster.fitDpr(h, 3)
  ok('降完之后总面积在预算内', poster.WIDTH * h * d * d <= poster.MAX_PIXELS * 1.02, {
    px: Math.round(poster.WIDTH * h * d * d), budget: poster.MAX_PIXELS
  })
  ok('单边不超过 7000 设备像素', h * d <= 7000, h * d)
  // 极端长图（26 行正文 + 9 张照片）也不该超单边上限
  const extreme = 3300
  const de = poster.fitDpr(extreme, 3)
  ok('极端长图同样受单边约束', extreme * de <= 7000, { dpr: de, side: extreme * de })
}

/* ============ 8. 加载：等长数组是版式不错位的前提 ============ */
console.log('8) 加载：失败的位置留空，数组长度不变')
;(async () => {
  // 用假的 canvas.createImage + wx.getImageInfo 走真实分支
  let failOn = []
  global.wx.getImageInfo = opt => {
    const src = opt.src
    if (failOn.indexOf(src) >= 0) return opt.fail({ errMsg: 'no such file' })
    opt.success({ width: 1200, height: 900, path: src })
  }
  const canvas = {
    createImage() {
      const obj = {
        onload: null,
        onerror: null,
        _src: '',
        set src(v) {
          this._src = v
          setTimeout(() => (this.onload ? this.onload() : null), 0)
        },
        get src() {
          return this._src
        }
      }
      return obj
    }
  }

  const empty = await poster.loadImages(canvas, [])
  ok('没有照片时返回空数组', Array.isArray(empty) && empty.length === 0)

  const all = await poster.loadImages(canvas, ['a.jpg', 'b.jpg', 'c.jpg'])
  ok('三张都成功', all.length === 3 && all.every(Boolean))

  failOn = ['b.jpg']
  const partial = await poster.loadImages(canvas, ['a.jpg', 'b.jpg', 'c.jpg'])
  ok('中间一张失败：数组仍为 3 且该位置是 null', partial.length === 3 && partial[1] === null && !!partial[0] && !!partial[2],
    partial.map(x => !!x))

  failOn = ['a.jpg', 'b.jpg', 'c.jpg']
  const none = await poster.loadImages(canvas, ['a.jpg', 'b.jpg', 'c.jpg'])
  ok('全失败：等长的 null 数组，不抛错', none.length === 3 && none.every(x => x === null))

  const noCanvas = await poster.loadImages(null, ['a.jpg'])
  ok('没有 canvas 节点时安全降级', noCanvas.length === 1 && noCanvas[0] === null)

  /* ============ 9. 页面接线 ============ */
  console.log('9) 页面接线：把全部照片交给绘制层')
  {
    const page = read('pages/poster/poster.js')
    ok('页面用 loadImages 一次取全部（不是 loadImage 取第一张）', /poster\.loadImages\(/.test(page) && !/poster\.loadImage\(/.test(page))
    ok('照片清单取自 pathsOf（兼容只有 mediaPath 的老数据）', /poster\.pathsOf\(rec\)/.test(page))
    ok('measure 与 paint 拿到的是同一份 images', (page.match(/images: images/g) || []).length === 2)
    ok('导出前按高度挑倍率（fitDpr）', /poster\.fitDpr\(/.test(page))
    ok('不再有"只取 mediaPaths[0]"的写法', !/mediaPaths \|\| \[\]\)\[0\]/.test(page))
  }

  /* ============ 10. 页脚品牌 ============ */
  console.log('10) 页脚品牌：图标 + 名称，左边不再重复 slogan')
  {
    const rec = { id: 'b1', type: 'text', content: '一句话', createdAt: 1750000000000 }
    const paintWith = brandImage => {
      const ctx = mockCtx()
      const layout = poster.measure(ctx, rec, {})
      const c2 = mockCtx()
      poster.paint(c2, rec, layout, { images: [], brandImage: brandImage })
      return { log: c2.log, layout: layout }
    }

    const withIcon = paintWith({ fake: 'brand' })
    const noIcon = paintWith(null)

    ok('有图标时比没图标多画一次 drawImage',
      withIcon.log.drawImage.length === noIcon.log.drawImage.length + 1,
      { withIcon: withIcon.log.drawImage.length, noIcon: noIcon.log.drawImage.length })

    ok('两页都画了品牌名', [withIcon, noIcon].every(r =>
      r.log.fillText.some(f => String(f.t).indexOf('灵感') >= 0 || /Inspiration/.test(f.t))))

    const texts = withIcon.log.fillText.map(f => f.t)
    ok('slogan 只出现一次（左边不再重复）', texts.filter(t => t === texts[texts.length - 1]).length === 1, texts)

    const icon = withIcon.log.drawImage[0]
    ok('图标画在页脚左侧、尺寸取常量', icon && icon.x === poster.PAD && icon.w === poster.BRAND_SIZE && icon.h === poster.BRAND_SIZE, icon)
    ok('图标视觉中心与「灵感随时记」对齐（比基线高 BRAND_LIFT）',
      icon && Math.abs((icon.y + poster.BRAND_SIZE / 2) - (withIcon.layout.height - 112 + 48 - poster.BRAND_LIFT)) < 0.6,
      icon && icon.y)
    ok('图标不顶到页脚分隔线', icon && icon.y > withIcon.layout.height - 112, icon && icon.y)

    // 加载：没有 canvas / onerror 都要安全降级
    const none = await poster.loadBrand(null)
    ok('没有 canvas 时返回 null', none === null)

    const badCanvas = {
      createImage() {
        const o = { onload: null, onerror: null, _src: '' }
        Object.defineProperty(o, 'src', {
          set(v) { this._src = v; setTimeout(() => this.onerror && this.onerror(), 0) },
          get() { return this._src }
        })
        return o
      }
    }
    ok('图标加载失败返回 null（不抛错）', (await poster.loadBrand(badCanvas)) === null)

    const goodCanvas = {
      createImage() {
        const o = { onload: null, onerror: null, _src: '', width: 192, height: 192 }
        Object.defineProperty(o, 'src', {
          set(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0) },
          get() { return this._src }
        })
        return o
      }
    }
    const img = await poster.loadBrand(goodCanvas)
    ok('图标加载成功返回 Image 对象', !!img && img.width === 192)

    const asset = path.join(B, 'images', 'brand-logo.png')
    ok('包内资源存在', fs.existsSync(asset))
    const buf = fs.readFileSync(asset)
    ok('是 PNG（不是改名后的 jpg）', buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    // 192×192 写在 PNG 头 IHDR 里；页脚显示 40px，3 倍屏 120，192 有余量
    ok('尺寸 192×192', buf.readUInt32BE(16) === 192 && buf.readUInt32BE(20) === 192,
      { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) })
    ok('体积 < 60KB（包体预算）', buf.length < 60 * 1024, Math.round(buf.length / 1024) + 'KB')
    ok('路径是包内绝对路径', poster.BRAND_SRC === '/images/brand-logo.png', poster.BRAND_SRC)

    const page = read('pages/poster/poster.js')
    ok('页面加载图标并交给 paint', /poster\.loadBrand\(canvas\)/.test(page) && /brandImage: brandImage/.test(page))
    ok('页面不再把 slogan 当左边页脚传进去', !/footer:\s*i18n\.t\('poster:slogan'\)/.test(page))
  }

  /* ============ 11. 页脚上方的小程序码 ============ */
  console.log('11) 小程序码：压在页脚上方，码在左、说明在右')
  {
    // 正文写够 12 行：低于 620 的最小高度会把差值吃掉，看不出加减
    const rec = {
      id: 'c1',
      type: 'text',
      content: new Array(12).fill('这是一行用来撑高的正文').join('\n'),
      createdAt: 1750000000000
    }

    const paintWith = codeImage => {
      const ctx = mockCtx()
      const layout = poster.measure(ctx, rec, { codeImage: codeImage })
      const c2 = mockCtx()
      poster.paint(c2, rec, layout, { images: [], codeImage: codeImage })
      return { log: c2.log, layout: layout }
    }

    const withCode = paintWith({ fake: 'code' })
    const noCode = paintWith(null)

    ok('有码时高度多出「码 + 与分隔线的间距」',
      withCode.layout.height - noCode.layout.height === poster.CODE_SIZE + poster.CODE_GAP,
      { delta: withCode.layout.height - noCode.layout.height })

    ok('有码时多画一次 drawImage',
      withCode.log.drawImage.length === noCode.log.drawImage.length + 1,
      { withCode: withCode.log.drawImage.length, noCode: noCode.log.drawImage.length })

    const code = withCode.log.drawImage[0]
    ok('码画在左边距处、正方形不变形',
      code && code.x === poster.PAD && code.w === poster.CODE_SIZE && code.h === poster.CODE_SIZE, code)

    const lineY = withCode.layout.height - 112
    ok('码的底边距页脚分隔线正好是 CODE_GAP',
      code && Math.abs((code.y + poster.CODE_SIZE) - (lineY - poster.CODE_GAP)) < 0.6,
      code && (code.y + poster.CODE_SIZE))

    // 正文 baseline 每行 64，最后一行的基线位置
    const bodyBottom = 168 + withCode.layout.lines.length * 64
    ok('码不压到正文', code && code.y > bodyBottom, { codeTop: code && code.y, bodyBottom: bodyBottom })

    const texts = withCode.log.fillText.map(f => f.t)
    const scanKeys = ['poster:scan_title', 'poster:scan_1', 'poster:scan_2', 'poster:scan_3'].map(k => i18n.t(k))
    ok('四行扫码文案全画了', scanKeys.every(s => texts.indexOf(s) >= 0), { texts: texts, scanKeys: scanKeys })

    const rightEdge = poster.PAD + poster.CODE_SIZE
    const scanTexts = withCode.log.fillText.filter(f => scanKeys.indexOf(f.t) >= 0)
    ok('说明文字都在码右边',
      scanTexts.length === 4 && scanTexts.every(f => f.x >= rightEdge + poster.CODE_TEXT_GAP - 0.5),
      scanTexts)

    ok('标题 32 加粗、说明 24（层级分明）',
      /bold 32px sans-serif/.test(read('utils/poster.js')) && /'24px sans-serif'/.test(read('utils/poster.js')))

    ok('没有码时整块不画、不留空白', noCode.log.fillText.length === withCode.log.fillText.length - 4)

    const none = await poster.loadCode(null)
    ok('没有 canvas 时 loadCode 返回 null', none === null)

    const badCanvas = {
      createImage() {
        const o = { onload: null, onerror: null, _src: '' }
        Object.defineProperty(o, 'src', {
          set(v) { this._src = v; setTimeout(() => this.onerror && this.onerror(), 0) },
          get() { return this._src }
        })
        return o
      }
    }
    ok('码加载失败返回 null（不抛错）', (await poster.loadCode(badCanvas)) === null)

    const goodCanvas = {
      createImage() {
        const o = { onload: null, onerror: null, _src: '', width: 430, height: 430 }
        Object.defineProperty(o, 'src', {
          set(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0) },
          get() { return this._src }
        })
        return o
      }
    }
    const img = await poster.loadCode(goodCanvas)
    ok('码加载成功返回 Image 对象', !!img && img.width === 430)

    ok('路径是包内绝对路径', poster.CODE_SRC === '/images/mp-code.jpg', poster.CODE_SRC)

    const asset = path.join(B, 'images', 'mp-code.jpg')
    ok('码图在包内', fs.existsSync(asset))
    const buf = fs.readFileSync(asset)
    ok('是 JPEG（FFD8 开头）', buf[0] === 0xff && buf[1] === 0xd8)

    // 从 SOF 段读宽高，确认是正方形且够清晰
    let jw = 0
    let jh = 0
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        jh = buf.readUInt16BE(i + 5)
        jw = buf.readUInt16BE(i + 7)
        break
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    ok('码图是正方形', jw > 0 && jw === jh, { w: jw, h: jh })
    ok('边长 ≥ 400（3 倍导出也不糊）', jw >= 400, jw)
    ok('体积 < 120KB（包体预算）', buf.length < 120 * 1024, Math.round(buf.length / 1024) + 'KB')

    const page = read('pages/poster/poster.js')
    ok('页面加载码', /poster\.loadCode\(canvas\)/.test(page))
    ok('码同时交给 measure 与 paint',
      /codeImage: codeImage/.test(page) && (page.match(/codeImage: codeImage/g) || []).length === 2,
      (page.match(/codeImage: codeImage/g) || []).length)
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
