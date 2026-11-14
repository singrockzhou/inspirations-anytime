/**
 * 长图绘制（Canvas 2D）
 *
 * 目标：把一条灵感排成一张可以直接发出去的图。
 * 单位全部用 px，画布固定 750 宽（与设计稿同宽的整数倍），高度按内容算。
 *
 * 分两步是必须的：canvas 2d 每次改 width/height 都会重置整个上下文状态，
 * 所以先在临时高度下用 measureText 量出总高，再按真实高度重建上下文绘制。
 *
 * 多图用的是首页那套错落堆叠（utils/stack.js 是唯一出处）：
 * 卡片拼 CSS、这里画 canvas，坐标和抖动取自同一份数据，同一条记录在列表里
 * 和在图里的摆放完全一致。750px 画布 ≈ 750rpx，所以版式里的数字可以直接当 px 用。
 */
const i18n = require('./i18n')
const stack = require('./stack')

const WIDTH = 750
const PAD = 60

const COLOR = {
  bg: '#FBF8F3',
  paper: '#FFFFFF',
  ink: '#2C2723',
  ink2: '#8B8178',
  accent: '#C4713F',
  accentBg: '#F8ECE0',
  line: '#EFE5D8',
  tag: '#F3EDE3'
}

const BODY_FONT = '38px sans-serif'
const BODY_LINE = 64
const MAX_BODY_LINES = 26

/** 配图区上方的间距（正文/标签与照片之间） */
const PHOTO_GAP = 36

function typeLabel(type) {
  if (type === 'voice') return i18n.t('common:type_voice')
  if (type === 'photo') return i18n.t('common:type_photo')
  return i18n.t('common:type_text')
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** 按字符宽度折行，中文逐字断、英文单词尽量整词断 */
function wrapText(ctx, text, maxWidth) {
  const out = []
  const paragraphs = String(text || '').split('\n')

  paragraphs.forEach(para => {
    if (!para) {
      out.push('')
      return
    }
    // 先按"词 + 空格"切，中文没有空格自然退化为逐字
    const tokens = para.match(/[A-Za-z0-9]+|\s|[^A-Za-z0-9\s]/g) || []
    let line = ''
    tokens.forEach(tk => {
      const test = line + tk
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line)
        line = tk === ' ' ? '' : tk
        return
      }
      line = test
    })
    if (line) out.push(line)
  })

  return out
}

function bodyText(record) {
  const text = (record.content || '').trim()
  if (text) return text
  if (record.type === 'voice') return i18n.t('poster:voice_note', { n: record.duration || 0 })
  if (record.type === 'photo') return i18n.t('poster:photo_note', { n: pathsOf(record).length })
  return ''
}

/** 这条记录有哪些照片：mediaPaths 优先，老数据只有 mediaPath */
function pathsOf(record) {
  const list = ((record && record.mediaPaths) || []).filter(Boolean)
  if (list.length) return list
  return record && record.mediaPath ? [record.mediaPath] : []
}

function dateText(ts) {
  const d = new Date(ts)
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 量高：给定画布上下文与记录，算出总高度和绘制所需的中间结果
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} record
 * @param {{images?: Array}} opts images 与 pathsOf(record) 一一对应，加载失败的位置为 null
 * @returns {{height:number, lines:string[], tagRows:Array, photo:object|null}}
 */
function measure(ctx, record, opts) {
  const o = opts || {}
  const maxWidth = WIDTH - PAD * 2

  ctx.font = BODY_FONT
  let lines = wrapText(ctx, bodyText(record), maxWidth)
  let clipped = false
  if (lines.length > MAX_BODY_LINES) {
    lines = lines.slice(0, MAX_BODY_LINES)
    lines[MAX_BODY_LINES - 1] = lines[MAX_BODY_LINES - 1].slice(0, -1) + '…'
    clipped = true
  }

  // 标签折行
  const tagRows = []
  const tags = (record.tags || []).slice(0, 6)
  if (tags.length) {
    ctx.font = '26px sans-serif'
    let row = []
    let rowWidth = 0
    tags.forEach(tag => {
      const w = ctx.measureText('#' + tag).width + 36
      if (rowWidth + w + 12 > maxWidth && row.length) {
        tagRows.push(row)
        row = []
        rowWidth = 0
      }
      row.push({ tag: tag, w: w, x: rowWidth })
      rowWidth += w + 12
    })
    if (row.length) tagRows.push(row)
  }

  // 照片：版式按张数算，与实际加载成功几张无关（少加载一张不该让版面挪位）。
  // 但一张都没加载出来时整块不画——否则图里会多出一片空相纸。
  // 只认 photo 类型的记录：语音记录的 mediaPath 是音频，别被当成照片排进版面。
  const paths = record.type === 'photo' ? pathsOf(record) : []
  const images = o.images || []
  const block = paths.length ? stack.planAll(record.id || record.createdAt || '', paths.length) : null
  const anyLoaded = images.some(Boolean)
  const photo = block && anyLoaded ? block : null

  let height = 72 + 44 + 52 // 顶部留白 + 角标行 + 与正文的间距
  height += lines.length * BODY_LINE
  if (clipped) height += 8
  if (tagRows.length) height += 28 + tagRows.length * 56
  if (photo) height += PHOTO_GAP + photo.height
  height += 92 // 页脚上方的呼吸空间
  height += 56 // 页脚文字
  height += 56 // 底部留白

  return {
    height: Math.max(height, 620),
    lines: lines,
    tagRows: tagRows,
    photo: photo
  }
}

/** 等比裁切填满（cover）：先按两边缩放比取大的，再居中裁 */
function drawCover(ctx, image, x, y, w, h) {
  const iw = image.width || w
  const ih = image.height || h
  const scale = Math.max(w / iw, h / ih)
  const dw = iw * scale
  const dh = ih * scale
  ctx.drawImage(image.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/**
 * 画一张相纸：白边 + 投影 + 旋转 + 内嵌圆角照片。
 * 与首页卡片同构——卡片里是 box-shadow，这里用 canvas 的 shadow，
 * 参数按 1:1 从 wxss 的 rpx 值取（0 10rpx 26rpx rgba(44,39,35,.14)）。
 */
function paintFrame(ctx, image, left, top, rot) {
  const w = stack.FRAME_W
  const h = stack.FRAME_H
  const pad = stack.FRAME_PAD
  const ix = -w / 2 + pad
  const iy = -h / 2 + pad
  const iw = w - pad * 2
  const ih = h - pad * 2

  ctx.save()
  ctx.translate(left + w / 2, top + h / 2)
  ctx.rotate((rot * Math.PI) / 180)

  ctx.shadowColor = 'rgba(44,39,35,0.14)'
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 10
  roundRect(ctx, -w / 2, -h / 2, w, h, stack.FRAME_RADIUS)
  ctx.fillStyle = COLOR.paper
  ctx.fill()
  // 投影只给相纸本身，别糊到照片上
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  ctx.save()
  roundRect(ctx, ix, iy, iw, ih, stack.IMAGE_RADIUS)
  ctx.clip()
  if (image) {
    drawCover(ctx, image, ix, iy, iw, ih)
  } else {
    // 文件被系统清掉：留一块米色，不留白洞（与卡片加载前的占位同色）
    ctx.fillStyle = COLOR.tag
    ctx.fillRect(ix, iy, iw, ih)
  }
  ctx.restore()

  ctx.restore()
}

/**
 * 画整块配图：单张就是整幅大图，多张按首页的错落堆叠（一组最多 4 张，多则分组往下排）
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} block stack.planAll 的结果
 * @param {Array} images 与 pathsOf(record) 一一对应，可为 null
 * @param {number} x0
 * @param {number} y0
 * @param {number} boxW
 */
function paintPhotos(ctx, block, images, x0, y0, boxW) {
  if (block.single) {
    const h = block.height
    ctx.save()
    roundRect(ctx, x0, y0, boxW, h, 24)
    ctx.clip()
    if (images[0]) drawCover(ctx, images[0], x0, y0, boxW, h)
    else {
      ctx.fillStyle = COLOR.tag
      ctx.fillRect(x0, y0, boxW, h)
    }
    ctx.restore()
    return
  }

  let idx = 0
  let y = y0
  block.clusters.forEach((cluster, ci) => {
    if (ci) y += stack.CLUSTER_GAP
    // 按层级从下往上画，压住关系才和卡片一致
    const ordered = cluster.frames
      .map((f, i) => ({ f: f, i: i }))
      .sort((a, b) => a.f.z - b.f.z)
    ordered.forEach(item => {
      paintFrame(ctx, images[idx + item.i], x0 + item.f.x, y + item.f.y, item.f.r)
    })
    idx += cluster.size
    y += cluster.height
  })
}

/**
 * 画：按 measure 的结果落到画布上
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} record
 * @param {object} layout measure 的返回值
 * @param {{images?:Array, footer?:string}} opts images 与 pathsOf(record) 一一对应
 */
function paint(ctx, record, layout, opts) {
  const o = opts || {}
  const maxWidth = WIDTH - PAD * 2
  const H = layout.height

  // 底色
  ctx.fillStyle = COLOR.bg
  ctx.fillRect(0, 0, WIDTH, H)

  // 顶部一条极淡的暖色晕，避免整张图太平
  const grad = ctx.createLinearGradient(0, 0, 0, 260)
  grad.addColorStop(0, '#F7EDE2')
  grad.addColorStop(1, 'rgba(251,248,243,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, WIDTH, 260)

  const topY = 72

  // 类型角标
  const label = typeLabel(record.type)
  ctx.font = '26px sans-serif'
  const badgeW = ctx.measureText(label).width + 40
  roundRect(ctx, PAD, topY, badgeW, 44, 12)
  ctx.fillStyle = COLOR.accentBg
  ctx.fill()
  ctx.fillStyle = COLOR.accent
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, PAD + 20, topY + 23)

  // 日期（右对齐）
  ctx.font = '26px sans-serif'
  ctx.fillStyle = COLOR.ink2
  ctx.textAlign = 'right'
  ctx.fillText(dateText(record.createdAt), WIDTH - PAD, topY + 23)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // 正文
  let y = topY + 44 + 52
  ctx.font = BODY_FONT
  ctx.fillStyle = COLOR.ink
  layout.lines.forEach(line => {
    y += BODY_LINE - 18
    ctx.fillText(line, PAD, y)
    y += 18
  })

  // 标签
  if (layout.tagRows.length) {
    y += 28
    ctx.font = '26px sans-serif'
    layout.tagRows.forEach(row => {
      row.forEach(item => {
        roundRect(ctx, PAD + item.x, y, item.w, 44, 22)
        ctx.fillStyle = COLOR.tag
        ctx.fill()
        ctx.fillStyle = COLOR.ink2
        ctx.fillText('#' + item.tag, PAD + item.x + 18, y + 30)
      })
      y += 56
    })
  }

  // 配图
  if (layout.photo) {
    y += PHOTO_GAP
    paintPhotos(ctx, layout.photo, o.images || [], PAD, y, maxWidth)
    y += layout.photo.height
  }

  // 页脚
  const lineY = H - 112
  ctx.strokeStyle = COLOR.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, lineY)
  ctx.lineTo(WIDTH - PAD, lineY)
  ctx.stroke()

  ctx.font = '26px sans-serif'
  ctx.fillStyle = COLOR.ink2
  ctx.textAlign = 'left'
  ctx.fillText(o.footer || '', PAD, lineY + 48)

  ctx.textAlign = 'right'
  ctx.fillStyle = '#B8AB99'
  ctx.fillText(i18n.t('poster:slogan'), WIDTH - PAD, lineY + 48)
}

/**
 * 位图预算，两个约束一起卡：
 *   面积 ≈ 1200 万像素（约 48 MB 位图），750×1892 的长图在 3 倍下正好压线；
 *   单边 ≤ 7000 设备像素——canvas 2d 在部分机型上超过这个量级会画不出东西，
 *   而 26 行正文 + 配图的老长图（约 6100 高）线上跑了半年没出问题，7000 是安全的一档。
 * 下限 1.5 倍：再低字就发虚，那时的取舍是"能导出"优先于"更清晰"。
 * @param {number} height 图的逻辑高度
 * @param {number} baseDpr 设备像素比（已按 3 截断）
 * @returns {number}
 */
const MAX_PIXELS = 12 * 1000 * 1000
const MAX_SIDE = 7000
function fitDpr(height, baseDpr) {
  const dpr = Math.min(baseDpr || 2, 3)
  const h = Math.max(height || 0, 1)
  const byArea = Math.sqrt(MAX_PIXELS / (WIDTH * h))
  const bySide = MAX_SIDE / h
  const fit = Math.min(dpr, byArea, bySide)
  return Math.max(1.5, Math.floor(fit * 10) / 10)
}

/**
 * 预加载一张配图。
 * Canvas 2D 的 drawImage 只吃 canvas.createImage() 出来的 Image 对象，喂路径字符串是画不出来的，
 * 所以这里必须先取图片尺寸、再把路径塞进 Image 等 onload。
 * @returns {Promise<{img:object, width:number, height:number}|null>} 失败返回 null
 */
function loadImage(canvas, src) {
  return new Promise(resolve => {
    if (!src || !canvas || typeof canvas.createImage !== 'function') return resolve(null)
    try {
      wx.getImageInfo({
        src: src,
        success: info => {
          const img = canvas.createImage()
          img.onload = () => resolve({ img: img, width: info.width, height: info.height })
          img.onerror = () => resolve(null)
          img.src = info.path || src
        },
        fail: () => resolve(null)
      })
    } catch (e) {
      resolve(null)
    }
  })
}

/**
 * 批量预加载，返回与入参等长的数组，失败的位置是 null。
 * 等长很关键：版式按张数排，某张加载失败也不该让后面几张错位。
 * @param {object} canvas
 * @param {string[]} paths
 * @returns {Promise<Array>}
 */
function loadImages(canvas, paths) {
  const list = (paths || []).filter(Boolean)
  if (!list.length) return Promise.resolve([])
  if (!canvas || typeof canvas.createImage !== 'function') return Promise.resolve(list.map(() => null))
  return Promise.all(list.map(src => loadImage(canvas, src)))
}

module.exports = {
  WIDTH,
  PAD,
  MAX_PIXELS,
  pathsOf,
  fitDpr,
  measure,
  paint,
  loadImage,
  loadImages,
  drawCover,
  wrapText,
  roundRect
}
