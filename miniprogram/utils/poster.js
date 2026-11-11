/**
 * 长图绘制（Canvas 2D）
 *
 * 目标：把一条灵感排成一张可以直接发出去的图。
 * 单位全部用 px，画布固定 750 宽（与设计稿同宽的整数倍），高度按内容算。
 *
 * 分两步是必须的：canvas 2d 每次改 width/height 都会重置整个上下文状态，
 * 所以先在临时高度下用 measureText 量出总高，再按真实高度重建上下文绘制。
 */

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

const TYPE_LABEL = { text: '文字', voice: '语音', photo: '照片' }

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
  if (record.type === 'voice') return '（一段 ' + (record.duration || 0) + ' 秒的录音）'
  if (record.type === 'photo') return '（' + (record.mediaPaths || []).length + ' 张照片）'
  return ''
}

function dateText(ts) {
  const d = new Date(ts)
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 量高：给定画布上下文与记录，算出总高度和绘制所需的中间结果
 * @returns {{height:number, lines:string[], tagRows:Array, showImage:boolean}}
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

  const showImage = !!(o.image && o.image.width)
  const imageH = showImage ? 420 : 0

  let height = 72 + 44 + 52 // 顶部留白 + 角标行 + 与正文的间距
  height += lines.length * BODY_LINE
  if (clipped) height += 8
  if (tagRows.length) height += 28 + tagRows.length * 56
  if (showImage) height += 36 + imageH
  height += 92 // 页脚上方的呼吸空间
  height += 56 // 页脚文字
  height += 56 // 底部留白

  return {
    height: Math.max(height, 620),
    lines: lines,
    tagRows: tagRows,
    showImage: showImage,
    imageH: imageH
  }
}

/**
 * 画：按 measure 的结果落到画布上
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} record
 * @param {object} layout measure 的返回值
 * @param {{image?:object, footer?:string}} opts image 为 {img, width, height}
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
  const label = TYPE_LABEL[record.type] || '文字'
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
  if (layout.showImage) {
    y += 36
    const img = o.image
    const boxW = maxWidth
    const boxH = layout.imageH
    // 等比裁切填满（cover）
    const scale = Math.max(boxW / img.width, boxH / img.height)
    const dw = img.width * scale
    const dh = img.height * scale

    ctx.save()
    roundRect(ctx, PAD, y, boxW, boxH, 24)
    ctx.clip()
    ctx.drawImage(img.img, PAD + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh)
    ctx.restore()
    y += boxH
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
  ctx.fillText(o.footer || '灵感随时记', PAD, lineY + 48)

  ctx.textAlign = 'right'
  ctx.fillStyle = '#B8AB99'
  ctx.fillText('想到什么，就记一句', WIDTH - PAD, lineY + 48)
}

/**
 * 预加载配图。
 * Canvas 2D 的 drawImage 只吃 canvas.createImage() 出来的 Image 对象，喂路径字符串是画不出来的，
 * 所以这里必须先取图片尺寸、再把路径塞进 Image 等 onload。
 * @param {object} canvas 页面里的 canvas 节点
 * @returns {Promise<{img:object, width:number, height:number}|null>} 失败返回 null（页面据此退回纯文字版）
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

module.exports = {
  WIDTH,
  PAD,
  measure,
  paint,
  loadImage,
  wrapText,
  roundRect
}
