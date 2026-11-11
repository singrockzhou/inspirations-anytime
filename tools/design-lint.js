/**
 * 设计一致性检查（对话框）
 * 用法：node tools/design-lint.js
 *
 * 只做能机器判定的部分，判断不了的（留白呼吸、层级）留给状态板人眼过。
 * 规则：
 *  1. 颜色必须是全局 token（var(--x, #hex)）或登记过的中性色，不许出现"野生色号"
 *  2. 尺寸单位必须是 rpx，不许混 px
 *  3. 按钮高度 ≥ 88rpx（可点区下限）
 *  4. 圆角、字号只能取设计规范里的档位
 *  5. 页面里不许直接调 wx.showModal（统一走 utils/dialog）
 *  6. 给用户看的文案里不许出现代码：文件路径、源码文件名、后台术语
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'miniprogram')
const FILE = path.join(ROOT, 'components/dialog/dialog.wxss')

/** app.wxss 的 token + 对话框允许的中性色（按下底、禁用字、正文） */
const ALLOWED_HEX = new Set([
  'ffffff', 'fff',
  'fbf8f3',
  '2c2723',
  '4a423a',
  '8b8178',
  'f0e7da',
  'c4713f',
  'b5673f',
  'faf5ef',
  'c9c0b6'
])

/** 允许的圆角档位（rpx） */
const RADIUS = ['8', '12', '16', '18', '20', '24', '32', '36', '48', '50%', '999rpx']
/** 允许的字号档位（rpx） */
const FONTS = ['20', '22', '24', '26', '28', '30', '32', '34']

const errors = []
const notes = []

function fail(msg) {
  errors.push(msg)
}

const css = fs.readFileSync(FILE, 'utf8')

/* ---------- 1. 颜色 ---------- */
// 先把 var(--x, #hex) 的 fallback 摘掉，剩下的才是"裸色号"
const withoutVarFallback = css.replace(/var\(\s*--[\w-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g, 'VAR()')

const hexes = withoutVarFallback.match(/#[0-9a-fA-F]{3,8}\b/g) || []
hexes.forEach(h => {
  const v = h.slice(1).toLowerCase()
  if (!ALLOWED_HEX.has(v)) fail('未登记的颜色：' + h)
})

const rgbas = css.match(/rgba?\([^)]*\)/g) || []
const RGBA_OK = ['rgba(196,113,63,0.12)', 'rgba(196,113,63,0.25)']
rgbas.forEach(r => {
  const compact = r.replace(/\s+/g, '')
  if (!/^rgba\(44,39,35,/.test(compact) && RGBA_OK.indexOf(compact) === -1) {
    fail('未登记的透明色：' + r)
  }
})

/* ---------- 2. 单位 ---------- */
const px = css.match(/(?<![\d.])-?\d+px\b/g) || []
px.forEach(p => fail('出现 px 单位（应统一 rpx）：' + p))

/* ---------- 3. 可点区 ---------- */
const btnBlock = css.match(/\.btn\s*\{[^}]*\}/)
if (!btnBlock) {
  fail('找不到 .btn 规则')
} else {
  const h = btnBlock[0].match(/height:\s*(\d+)rpx/)
  if (!h) fail('.btn 没有显式高度')
  else if (Number(h[1]) < 88) fail('.btn 高度 ' + h[1] + 'rpx，低于可点区下限 88rpx')
  else notes.push('.btn 高度 ' + h[1] + 'rpx ✓')
}

/* ---------- 4. 档位 ---------- */
const radii = css.match(/border-radius:\s*([^;]+);/g) || []
radii.forEach(r => {
  const vals = r.replace(/border-radius:\s*/, '').replace(';', '').trim().split(/\s+/)
  vals.forEach(v => {
    const num = v.replace('rpx', '')
    if (!RADIUS.includes(num) && !v.includes('%')) fail('圆角不在档位内：' + v)
  })
})

const fonts = css.match(/font-size:\s*(\d+)rpx/g) || []
fonts.forEach(f => {
  const n = f.match(/(\d+)rpx/)[1]
  if (!FONTS.includes(n)) fail('字号不在档位内：' + n + 'rpx')
})

/* ---------- 5. 弹窗唯一出口 ---------- */
function walk(dir) {
  fs.readdirSync(dir).forEach(name => {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) return walk(p)
    if (!name.endsWith('.js')) return
    if (p.endsWith(path.join('utils', 'dialog.js'))) return
    const src = fs.readFileSync(p, 'utf8')
    if (/wx\.showModal\s*\(/.test(src)) fail('直接调用了 wx.showModal：' + path.relative(ROOT, p))
  })
}
walk(ROOT)

/* ---------- 6. 用户可见文案里不许出现代码 ---------- */
/**
 * 只扫"会被念给用户听"的地方：
 *   - dialog.alert(...) / dialog.confirm(...) 的实参块
 *   - 形如 COLLECT_ERR / EXPORT_TEXT 的文案常量对象
 * 全文扫会把注释里的真实路径也算进来，那些是给人看的，不该报。
 */
const CODE_IN_UI = [
  { re: /utils\//, why: '内部文件路径 utils/' },
  { re: /\/pages\//, why: '内部页面路径 /pages/' },
  { re: /[\w-]+\.js\b/, why: '源码文件名 .js' },
  { re: /TMPL_ID/, why: '配置常量 TMPL_ID' },
  { re: /模板\s*ID/, why: '“模板 ID”是后台术语' },
  { re: /小程序后台/, why: '“小程序后台”是后台术语' },
  { re: /\bopenid\b/i, why: '技术字段 openid' },
  // 原始错误串：requestSubscribeMessage:fail xxx、chooseMessageFile:fail …
  // 这类东西只在开发者工具里对开发者有用，摆到用户面前只会让人以为「坏了」
  { re: /\b(?:err|e|error|res)\s*\.\s*(?:message|errMsg)\b/, why: '原始错误串 err.message' }
]

/** 从一个 '(' 开始按括号配平，取出整段实参 */
function argBlock(src, from) {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (!depth) return src.slice(from, i + 1)
    }
  }
  return src.slice(from)
}

function copyBlocks(src) {
  const out = []
  const callRe = /dialog\s*\.\s*(alert|confirm)\s*\(/g
  let m
  while ((m = callRe.exec(src))) out.push(argBlock(src, src.indexOf('(', m.index)))

  const constRe = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{/g
  while ((m = constRe.exec(src))) {
    if (!/_(ERR|TEXT|COPY|MSG|TIP)$/.test(m[1])) continue
    const start = src.indexOf('{', m.index)
    let depth = 0
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (!depth) {
          out.push(src.slice(start, i + 1))
          break
        }
      }
    }
  }
  return out
}

function checkCopy(dir) {
  fs.readdirSync(dir).forEach(name => {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) return checkCopy(p)
    if (!name.endsWith('.js')) return
    const src = fs.readFileSync(p, 'utf8')
    copyBlocks(src).forEach(block => {
      CODE_IN_UI.forEach(rule => {
        const hit = block.match(rule.re)
        if (hit) fail('文案里混进代码（' + rule.why + '）：' + path.relative(ROOT, p) + ' → ' + hit[0])
      })
    })
  })
}
checkCopy(path.join(ROOT, 'pages'))
checkCopy(path.join(ROOT, 'components'))

/* ---------- 输出 ---------- */
notes.forEach(n => console.log('  · ' + n))
if (errors.length) {
  console.log('\n✗ 设计检查未通过（' + errors.length + ' 项）：')
  errors.forEach(e => console.log('  - ' + e))
  process.exit(1)
}
console.log('\n✓ 设计检查通过：颜色/单位/可点区/圆角/字号/弹窗出口/文案洁净 均符合规范')
