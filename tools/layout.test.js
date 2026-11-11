/**
 * 竖向布局（19 条断言）
 * 用法：node tools/layout.test.js
 *
 * 这两页的问题是"内容少 → 底部一大片空"，靠肉眼看截图只能确认"空了"，
 * 无法确认改完之后"空白归谁"。所以这里对样式文件做静态断言：
 *   - 页面是不是 flex 列，剩余空间由谁吸收
 *   - 卡片高度是"跟内容走"还是"被拉满"
 *   - 底部安全距离有没有被误当成留白（120rpx 那笔）
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
ok('五个动作都在 .bottom 里', dWxml.indexOf('class="actions"') > dWxml.indexOf('class="bottom"'))

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

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
