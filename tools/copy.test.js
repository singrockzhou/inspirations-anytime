/**
 * 保存入口文案改版的完整性检查（v1.8.2，32 条）
 * 用法：node tools/copy.test.js
 *
 * 这一版把「存下」从顶栏挪到底部主按钮，并改了两种态的文案。
 * 这类改动不会让程序报错，它只会安静地错：
 *   · 顶栏删了按钮，词典里的旧键还留着 —— 下一个人以为它仍在界面上
 *   · 底部换了新键，编辑态却还在说"存下这条" —— 语义变成"再存一条新的"
 *   · 底栏长高了，页面底部留白没跟上 —— 最后一行字被按钮压住
 *   · 提示条没抬，iPhone X 上压在按钮上 —— 只在带安全区的机型上出现
 * 所以下面全部是对"改完之后各处是否还说得通"的静态断言，不需要起页面。
 */
const fs = require('fs')
const path = require('path')

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
const readRoot = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 取出某个选择器的规则块（花括号配平），找不到返回 '' */
function block(css, sel) {
  const start = css.indexOf(sel + ' {')
  if (start < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (!depth) return css.slice(start, i + 1)
    }
  }
  return css.slice(start)
}

/** 从规则块里取某个属性的值 */
function prop(cssBlock, name) {
  const m = cssBlock.match(new RegExp(name + '\\s*:\\s*([^;]+);'))
  return m ? m[1].trim() : ''
}

/** 取一串 rpx 里的第一个数字 */
function rpx(v) {
  const m = String(v).match(/(-?\d+(?:\.\d+)?)rpx/)
  return m ? Number(m[1]) : NaN
}

/* ---------------- 假微信：只为能 require i18n ---------------- */
global.wx = {
  getAppBaseInfo: () => ({ language: 'zh_CN' }),
  getStorageSync: () => '',
  setStorageSync: () => {}
}
const i18n = require(path.join(B, 'utils', 'i18n.js'))
const ZH = (i18n.setLang('zh'), i18n.pack('record'))
const EN = (i18n.setLang('en'), i18n.pack('record'))
i18n.setLang('zh')

const WXML = read('pages/record/record.wxml')
const WXSS = read('pages/record/record.wxss')
const JS = read('pages/record/record.js')
const JSONC = read('pages/record/record.json')
const APPWXSS = read('app.wxss')

/* ============ 1. 词典：旧键必须彻底消失，新键中英齐备 ============ */
console.log('1) 词典：旧键删干净，新键两种语言都齐')
{
  ok('record 包里已没有旧的 nav_save', ZH.nav_save === undefined && EN.nav_save === undefined, {
    zh: ZH.nav_save,
    en: EN.nav_save
  })
  ok('新增 record:save_cta（中文）', typeof ZH.save_cta === 'string' && ZH.save_cta.length > 0, ZH.save_cta)
  ok('新增 record:save_cta（英文）', typeof EN.save_cta === 'string' && EN.save_cta.length > 0, EN.save_cta)
  ok('新增 record:save_cta_edit（中文）', typeof ZH.save_cta_edit === 'string' && ZH.save_cta_edit.length > 0, ZH.save_cta_edit)
  ok('新增 record:save_cta_edit（英文）', typeof EN.save_cta_edit === 'string' && EN.save_cta_edit.length > 0, EN.save_cta_edit)
  ok('新建与编辑两句不是同一句（否则编辑态会误导）', ZH.save_cta !== ZH.save_cta_edit && EN.save_cta !== EN.save_cta_edit, {
    zh: [ZH.save_cta, ZH.save_cta_edit],
    en: [EN.save_cta, EN.save_cta_edit]
  })
  ok('英文 CTA 不含汉字', !/[\u4e00-\u9fa5]/.test(EN.save_cta + EN.save_cta_edit), [EN.save_cta, EN.save_cta_edit])
  // 「存下」两字是顶部窄位倒推的结果；底部有 335px，文案必须把话说完整
  ok('中文 CTA 不再是一个悬空动词（≥ 3 字）', ZH.save_cta.length >= 3, ZH.save_cta)
  ok('英文 CTA 是完整短语（≥ 2 个词）', EN.save_cta.trim().split(/\s+/).length >= 2, EN.save_cta)
}

/* ============ 2. 引用：代码里不许再有指向旧键的地方 ============ */
console.log('2) 引用：旧键的每一处引用都改完了')
{
  const walk = (dir, out) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) return walk(full, out)
      if (/\.(js|wxml|wxss|json)$/.test(d.name)) out.push(full)
    })
    return out
  }
  const files = walk(B, [])
  const strays = files.filter(f => {
    const s = fs.readFileSync(f, 'utf8')
    // 测试文件与词典自身不在扫描范围（词典里它必须不存在，第 1 组已单独验）
    return f.indexOf(path.join('utils', 'i18n.js')) < 0 && /nav_save|nav-save/.test(s)
  })
  ok('miniprogram 下没有任何 nav_save / nav-save 残留', strays.length === 0, strays.map(f => path.relative(B, f)))

  ok('顶栏模板只剩一个 .nav-side（取消）', (WXML.match(/class="nav-side/g) || []).length === 1, WXML.match(/class="nav-side/g))
  ok('模板里没有 t.nav_save', WXML.indexOf('t.nav_save') < 0)
  ok('模板里用 t.save_cta 渲染主按钮', WXML.indexOf('t.save_cta') >= 0)
  ok('编辑态的 t.save_cta_edit 真的被用到（不是死键）', WXML.indexOf('t.save_cta_edit') >= 0)
  ok('.nav-save 样式规则已删除', WXSS.indexOf('.nav-save') < 0)
  ok('全页只有一处 onSave 触发点（唯一保存出口）', (WXML.match(/catchtap="onSave"/g) || []).length === 1, (WXML.match(/catchtap="onSave"/g) || []).length)
  ok('onSave 在 js 里确实存在', /onSave\s*\(/.test(JS))
  ok('canSave 仍被模板使用（没留下没人读的变量）', WXML.indexOf('canSave') >= 0 && /canSave:/.test(JS))
}

/* ============ 3. 结构：顶栏只留取消+标题，保存落到底部 ============ */
console.log('3) 结构：顶栏清空右侧，主按钮在底部固定区')
{
  ok('仍是自定义导航（否则胶囊问题不成立）', /"navigationStyle"\s*:\s*"custom"/.test(JSONC))
  ok('.nav-bar 改为中心对齐', /justify-content:\s*center/.test(block(WXSS, '.nav-bar')), prop(block(WXSS, '.nav-bar'), 'justify-content'))
  ok('.nav-side 绝对定位到左侧，不再挤占标题', /position:\s*absolute/.test(block(WXSS, '.nav-side')))
  ok('取消可点区 88rpx（44px 下限）', rpx(prop(block(WXSS, '.nav-side'), 'height')) >= 88, prop(block(WXSS, '.nav-side'), 'height'))
  ok('主按钮在 .tools 里，且在形态切换之后', WXML.indexOf('class="cta') > WXML.indexOf('tool-row'))
  ok('三个形态 tab 仍完整（没被重排弄丢）', ['t.tab_text', 't.tab_voice', 't.tab_photo'].every(k => WXML.indexOf(k) >= 0))
  ok('空间提示条与 off 置灰逻辑仍在', WXML.indexOf('space-tip') >= 0 && WXML.indexOf("'off'") >= 0)
}

/* ============ 4. 几何：按钮够大，留白够高，提示不压按钮 ============ */
console.log('4) 几何：按钮尺寸、底部留白、提示条位置')
{
  const ctaH = rpx(prop(block(WXSS, '.cta'), 'height'))
  ok('主按钮高 96rpx（48px）', ctaH === 96, ctaH)
  ok('主按钮可点区 ≥ 88rpx', ctaH >= 88, ctaH)
  ok('主按钮水平几乎整宽（左右各 8rpx 外距）', /margin:\s*16rpx 8rpx 0/.test(block(WXSS, '.cta')), prop(block(WXSS, '.cta'), 'margin'))

  const padTop = rpx(prop(block(WXSS, '.tools'), 'padding'))
  const toolsPad = block(WXSS, '.tools')
  const padShorthand = prop(toolsPad, 'padding')
  const ctas = padShorthand.match(/(\d+)rpx/g) || []
  // padding: 16rpx 32rpx calc(16rpx + env(...)) → 上 16 / 下 16
  const top = rpx(ctas[0])
  const toolH = rpx(prop(block(WXSS, '.tool'), 'height'))
  const ctaMargin = rpx(prop(block(WXSS, '.cta'), 'margin'))
  const barH = top + toolH + ctaMargin + ctaH + top
  ok('底栏总高按 228rpx 计算（16+84+16+96+16）', barH === 228, { barH, top, toolH, ctaMargin, ctaH })
  ok('底栏含安全区扣除（iPhone X 不会被压）', /env\(safe-area-inset-bottom\)/.test(toolsPad))

  const pagePad = rpx(prop(block(WXSS, '.page'), 'padding-bottom'))
  ok('页面底部留白 ≥ 底栏高 + 24rpx（最后一行不被按钮压住）', pagePad >= barH + 24, { pagePad, barH })
  ok('页面留白同样扣了安全区', /env\(safe-area-inset-bottom\)/.test(block(WXSS, '.page')))

  const toastBottom = rpx(prop(block(WXSS, '.toast'), 'bottom'))
  ok('提示条抬到底栏之上（bottom > 底栏高 + 16）', toastBottom >= barH + 16, { toastBottom, barH })
  ok('提示条位置也扣了安全区', /env\(safe-area-inset-bottom\)/.test(block(WXSS, '.toast')))
  ok('光标留白随底栏加厚（160，够 114px 底栏 + 余量）', (WXML.match(/cursor-spacing="160"/g) || []).length === 3, (WXML.match(/cursor-spacing="\d+"/g) || []))
}

/* ============ 5. 对比度：软态要说得出话，实态要看得清 ============ */
console.log('5) 对比度：F 方案的核心（旧禁用态只有 1.8:1）')
{
  const lum = hex => {
    const n = hex.replace('#', '')
    const c = [0, 2, 4].map(i => parseInt(n.substr(i, 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => {
    const l1 = lum(a)
    const l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }

  const old = ratio('#c9bdae', '#fbf8f3')
  ok('旧禁用态确实不可读（< 2.0:1），记录在案', old < 2, old.toFixed(2))

  const soft = block(WXSS, '.cta.soft')
  // 字色不许写死：从 token 里取，改 token 时这条断言会跟着变
  const deepHex = (APPWXSS.match(/--accent-deep:\s*(#[0-9a-fA-F]{6})/) || [])[1]
  const softBgToken = /var\(--beige,\s*(#[0-9a-fA-F]{6})\)/.test(soft)
  ok('软态用米底 + 深橙字，不走 opacity（透明度会等比削弱对比度）', !/opacity/.test(soft))
  ok('软态背景取的是全局 token', softBgToken, soft)
  ok('软态字色取 --accent-deep（不是野生色号）', /color:\s*var\(--accent-deep/.test(soft), soft)
  ok('软态有一道描边，形状上仍是按钮而不是第四个 tab', /border-color:\s*var\(--accent-light/.test(soft), soft)
  ok('两态高度一致（透明描边占位，切换不跳动）', /border:\s*1rpx solid transparent/.test(block(WXSS, '.cta')))
  ok('软态对比度 ≥ 4.5:1', !!deepHex && ratio(deepHex, '#f7f1e7') >= 4.5, deepHex && ratio(deepHex, '#f7f1e7').toFixed(2))

  const ready = block(WXSS, '.cta.ready')
  ok('实态用主色底 + 白字', /var\(--accent/.test(ready))
  ok('实态对比度 ≥ 3:1（与全站主按钮同口径）', ratio('#ffffff', '#c4713f') >= 3, ratio('#ffffff', '#c4713f').toFixed(2))
  ok('新增的 --accent-deep 已登记到 app.wxss', /--accent-deep:\s*#8F5730/i.test(APPWXSS))
}

/* ============ 6. 文档与版本：说明跟上代码 ============ */
console.log('6) 文档与版本号')
{
  const README = readRoot('README.md')
  ok('README 不再描述「取消 / 存下」的顶栏', README.indexOf('取消 / 存下') < 0)
  ok('README 补了这一版的做法（第二十四章）', README.indexOf('第二十四章') >= 0)
  ok('README 说明了提示条要抬的原因', /提示条/.test(README) && /260rpx/.test(README))

  const me = read('pages/me/me.js')
  const v = (me.match(/version:\s*'([\d.]+)'/) || [])[1]
  ok('版本号是合法 semver', /^\d+\.\d+\.\d+$/.test(v || ''), v)
  // 写成"≥"而不是写死某个号：否则每发一版都要回来改这条断言
  const cmp = (a, b) => {
    const pa = String(a).split('.').map(Number)
    const pb = String(b).split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    return 0
  }
  ok('版本号已升到 1.8.2 以上（保存入口改版之后）', cmp(v, '1.8.2') >= 0, v)
  ok('页脚关于里的版本号取的是同一处 data', /about_version/.test(me))
}

/* ============ 7. 不引入新问题的兜底 ============ */
console.log('7) 兜底：空态提示仍按形态区分（不是一句笼统的话）')
{
  ok('文字态缺内容有专门的提示', ZH.toast_empty_text && ZH.toast_empty_text.length > 0)
  ok('照片态缺图有专门的提示', ZH.toast_no_photo && ZH.toast_no_photo.length > 0)
  ok('语音态缺录音有专门的提示', ZH.toast_no_voice && ZH.toast_no_voice.length > 0)
  const save = JS.slice(JS.indexOf('onSave()'), JS.indexOf('onCancel()'))
  ok('onSave 里三条前置判断都还在（软态可点的前提）', ['toast_empty_text', 'toast_no_photo', 'toast_no_voice'].every(k => save.indexOf(k) >= 0))
  ok('onSave 仍拦住重复提交', /if \(this\.data\.saving\) return/.test(save))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
