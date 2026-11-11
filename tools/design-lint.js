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

/* ---------- 输出 ---------- */
notes.forEach(n => console.log('  · ' + n))
if (errors.length) {
  console.log('\n✗ 设计检查未通过（' + errors.length + ' 项）：')
  errors.forEach(e => console.log('  - ' + e))
  process.exit(1)
}
console.log('\n✓ 设计检查通过：颜色/单位/可点区/圆角/字号/弹窗出口 均符合规范')
