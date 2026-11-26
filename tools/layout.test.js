/**
 * 竖向布局（36 条断言）
 * 用法：node tools/layout.test.js
 *
 * 这几页的问题是"内容少 → 底部一大片空"，靠肉眼看截图只能确认"空了"，
 * 无法确认改完之后"空白归谁"。所以这里对样式文件做静态断言：
 *   - 页面是不是 flex 列，剩余空间由谁吸收
 *   - 卡片高度是"跟内容走"还是"被拉满"
 *   - 底部安全距离有没有被误当成留白（120rpx 那笔）
 *   - 首页空态三行的顺序、字号递减与用词（第 5 节）
 */
const path = require('path')
const fs = require('fs')
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

/** 取出某个选择器的规则块（含嵌套花括号的简单配平） */
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

const read = p => fs.readFileSync(path.join(B, p), 'utf8')

/* ---------- 详情页 ---------- */
console.log('1) 详情页：内容贴顶、操作区贴底')
const dWxml = read('pages/detail/detail.wxml')
const dWxss = read('pages/detail/detail.wxss')

ok('模板把内容包进 .main、操作区包进 .bottom', /class="main"/.test(dWxml) && /class="bottom"/.test(dWxml))
ok('.main 在 .bottom 之前，不改变原有阅读顺序', dWxml.indexOf('class="main"') < dWxml.indexOf('class="bottom"'))
ok('六个动作都在 .bottom 里', dWxml.indexOf('class="actions"') > dWxml.indexOf('class="bottom"'))
// 两行各三个才排得满；五个时第二行右边空一大块，看着像漏了东西
ok('动作按两行三列排满（六个 .act）', (dWxml.match(/class="act[\s"]/g) || []).length === 6,
  (dWxml.match(/class="act[\s"]/g) || []).length)
// 顶部那颗星也在 onToggleStar 上，所以只能在操作区内比较先后
const acts = dWxml.slice(dWxml.indexOf('class="actions"'))
ok('标星夹在归档与删了之间', acts.indexOf('onToggleArchive') < acts.indexOf('onToggleStar') &&
  acts.indexOf('onToggleStar') < acts.indexOf('onDelete'), acts.slice(0, 260))

const page = block(dWxss, '.page')
ok('.page 是 flex 列（剩余空间才有归处）', /display:\s*flex/.test(page) && /flex-direction:\s*column/.test(page), page)
ok('底部内距不再用 120rpx 充当留白', !/120rpx/.test(page), page)
ok('安全区仍在扣除', /env\(safe-area-inset-bottom\)/.test(page))

const bottom = block(dWxss, '.bottom')
ok('.bottom 用 margin-top:auto 贴底', /margin-top:\s*auto/.test(bottom), bottom)
ok('.main 不参与撑高', /flex:\s*0 0 auto/.test(block(dWxss, '.main')))

/* ---------- 重温页 ---------- */
console.log('2) 重温页：纸跟内容走，按钮贴底')
const rWxss = read('pages/review/review.wxss')

const paper = block(rWxss, '.paper')
ok('纸不再 flex:1（那样会被拉到最大高度）', !/flex:\s*1\s*;/.test(paper), paper)
ok('纸的高度按内容取，同时保留最矮身量', /flex:\s*0 0 auto/.test(paper) && /min-height:\s*[\d.]+vh/.test(paper), paper)
ok('纸仍有上限，长文不会顶到屏外', /max-height:\s*62vh/.test(paper))

const body = block(rWxss, '.body')
ok('滚动区不强制占满（纸内空白的直接来源）', /flex:\s*0 1 auto/.test(body), body)
ok('滚动区保留长文上限', /max-height:\s*46vh/.test(body))
ok('滚动区允许收缩，滚动才生效', /min-height:\s*0/.test(body))

ok('操作条贴底，空白收在纸与按钮之间', /margin-top:\s*auto/.test(block(rWxss, '.ops')))

/* ---------- 我的页：接不通的提醒入口已整块下掉 ---------- */
console.log('3) 提醒入口已下掉（换成首页「今天还没记一句」）')
const mWxml = read('pages/me/me.wxml')
ok('「每日提醒」不再出现在我的页', !/每日提醒/.test(mWxml))
ok('也没有留下一个设了也不生效的时间选择器', !/mode="time"/.test(mWxml))
ok('不再有"看得到但用不了"的占位判断', !/remindShow/.test(mWxml))
ok('「关于」行点得动，且有按下反馈', /class="row tap" bindtap="onAbout"/.test(mWxml))

/* ---------- 记录页：一句功能说明和字数 ---------- */
console.log('4) 记录页：说明与字数同一行')
const rcWxml = read('pages/record/record.wxml')
const rcWxss = read('pages/record/record.wxss')
const metaTag = (rcWxml.match(/<view class="meta-row">[\s\S]{0,400}?<\/view>\s*<\/view>/) || [''])[0]
ok(
  '.meta-row 同时装着说明与字数（不许再各占一行）',
  /class="tip"/.test(metaTag) && /class="counter"/.test(metaTag),
  metaTag.length
)
ok('.meta-row 用 flex 横排（否则又退回上下两行）', /display:\s*flex/.test(block(rcWxss, '.meta-row')))
ok('说明的字色不再是 2.1:1 的浅灰（那是装饰色，这句是功能说明）', !/#b8ab99/.test(block(rcWxss, '.tip')))

/* ---------- 首页空态：三行递减 ---------- */
console.log('5) 首页空态：情绪 → 身份 → 门槛，三层递减')
const iWxml = read('pages/index/index.wxml')
const iWxss = read('pages/index/index.wxss')
const iJs = read('pages/index/index.js')
const i18n = require(path.join(B, 'utils', 'i18n.js'))

const emptyBlock = iWxml.slice(iWxml.indexOf('class="empty"'), iWxml.indexOf('class="empty-btn"'))
ok('空态里有身份行，且绑的是 emptyIdentity', /class="empty-id"[^>]*\{\{emptyIdentity\}\}/.test(emptyBlock), emptyBlock.slice(0, 200))
ok(
  '身份行夹在主句与门槛之间（顺序不能倒）',
  emptyBlock.indexOf('empty-line') < emptyBlock.indexOf('empty-id') &&
    emptyBlock.indexOf('empty-id') < emptyBlock.indexOf('empty-sub')
)
ok('身份行有条件渲染（归档空了、标签空了时不许出现）', /wx:if="\{\{emptyIdentity\}\}"/.test(emptyBlock))
ok('JS 里身份行受 filtering 控制', /const emptyIdentity = filtering \? '' : i18n\.t\('index:empty_identity'\)/.test(iJs))
ok('身份行已进 setData', /emptyIdentity: emptyIdentity/.test(iJs))

const idSize = Number((block(iWxss, '.empty-id').match(/font-size:\s*(\d+)rpx/) || [])[1])
const subSize = Number((block(iWxss, '.empty-sub').match(/font-size:\s*(\d+)rpx/) || [])[1])
const lineSize = Number((block(iWxss, '.empty-line').match(/font-size:\s*(\d+)rpx/) || [])[1])
ok('字号 主句 > 身份 > 门槛（' + lineSize + ' / ' + idSize + ' / ' + subSize + '）',
  lineSize > idSize && idSize > subSize, [lineSize, idSize, subSize])
ok('身份行用 --ink-2，不跟门槛一起泡在最浅的灰里', /var\(--ink-2/.test(block(iWxss, '.empty-id')))
ok('门槛行降了字号，但 color 没降到 2.3:1 的装饰灰', !/color:\s*#b3a795/.test(block(iWxss, '.empty-sub')), block(iWxss, '.empty-sub'))

const zhId = i18n.t('index:empty_identity')
i18n.setLang('en')
const enId = i18n.t('index:empty_identity')
i18n.setLang('zh')
ok('身份行中英都在', !!zhId && !!enId && enId !== zhId, [zhId, enId])
ok('英文那行没夹中文', !/[\u4e00-\u9fa5]/.test(enId), enId)
// 「不联网」是当场能被 guide:a3（转文字要联网）戳破的话，首屏不能这么写
ok('身份行不说「不联网」（与 guide:a3 冲突）', !/不联网/.test(zhId), zhId)
ok('身份行说的是「不上传」', /不上传/.test(zhId), zhId)

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
