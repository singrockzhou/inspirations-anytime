/**
 * 正文里的 #标签 展示处理（27 条断言）
 * 用法：node tools/tagtext.test.js
 *
 * 背景：记录里 #标签 是正文的一部分，同时又被 store.parseTags 抽成 tags 字段，
 * 详情页/首页摘要/做成图都会用 tags 再画一遍。正文原样渲染就会出现两遍。
 * 规则只在「整行只有标签」时剥掉那一行，句中不动，数据一律不改。
 *
 * 覆盖：
 *   - 独占一行的标签剥掉，且只剥那一行
 *   - 一行多个标签、连续多行标签
 *   - 句中/句末出现的标签不剥（否则句子会被切成两截）
 *   - 「# 灵感」带空格不剥（与 store.TAG_RE 口径一致）
 *   - 空行压缩、首尾空行清理、CRLF
 *   - 整条只有标签 → 空串
 *   - 四个展示点（详情页、首页摘要、做成图）都接了这层
 */
const fs = require('fs')
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

const tagtext = require(path.join(B, 'utils', 'tagtext.js'))
const strip = tagtext.stripTagLines

function read(rel) {
  return fs.readFileSync(path.join(B, rel), 'utf8')
}

/* ============ 1. 纯函数 ============ */
console.log('1) 纯函数：不碰运行时')
{
  const src = read('utils/tagtext.js')
  ok('文件里没有 require(', !/require\(/.test(src))
  ok('不碰 wx.', !/\bwx\./.test(src))
  ok('不碰本地存储', !/Storage|storage/.test(src))
  ok('导出 stripTagLines', typeof strip === 'function')
}

/* ============ 2. 剥离规则 ============ */
console.log('2) 标签独占一行才剥')
{
  ok('首行标签被剥，正文一句不动',
    strip('#灵感\n每一个灵感都是财富，都值得被记住') === '每一个灵感都是财富，都值得被记住')

  ok('中间整行标签被剥，前后两行直接相邻',
    strip('内容一\n#灵感\n内容二') === '内容一\n内容二')

  ok('一行里多个标签全剥', strip('#灵感 #想法\n内容一') === '内容一')

  ok('连续几行标签全剥', strip('#灵感\n#想法\n正文') === '正文')

  ok('末尾整行标签也剥', strip('内容\n#灵感') === '内容')

  ok('整条只有标签 → 空串', strip('#灵感') === '')

  ok('整条只有多行标签 → 空串', strip('#灵感\n#想法') === '')
}

/* ============ 3. 不该动的地方 ============ */
console.log('3) 句中标签一句都不切')
{
  ok('句中标签保留', strip('今天想到 #灵感 这件事，先记下') === '今天想到 #灵感 这件事，先记下')
  ok('句末标签保留（后面还有句号/别的字）', strip('先记一句 #灵感。') === '先记一句 #灵感。')
  ok('行首标签后面跟空格再接正文，不算整行标签', strip('#灵感 就是说一句') === '#灵感 就是说一句')
  // 中文没有词边界：「#灵感就是说一句」在 store.TAG_RE 眼里就是一个 7 字标签，
  // 会被抽成胶囊，这里也按同一口径整行剥掉——两处口径必须一致，不能一个剥一个不剥。
  ok('中文连写会被当成一个标签（与 store.TAG_RE 同口径）', strip('#灵感就是说一句') === '')
  ok('「# 灵感」带空格不是标签（与 store.TAG_RE 同口径）', strip('# 灵感\n内容') === '# 灵感\n内容')
  ok('超过 12 字不算标签', strip('#' + '灵'.repeat(13) + '\n内容') === '#' + '灵'.repeat(13) + '\n内容')
  ok('英文/数字标签照剥', strip('#idea2026\n内容') === '内容')
  ok('半角逗号截断后不算整行标签', strip('#灵感,内容') === '#灵感,内容')
}

/* ============ 4. 空行与边界 ============ */
console.log('4) 空行与边界')
{
  ok('开头空行丢掉', strip('\n\n#灵感\n\n内容') === '内容')
  ok('结尾空行丢掉', strip('内容\n#灵感\n\n') === '内容')
  ok('剥离后的两个空行压成一个', strip('内容一\n\n#灵感\n\n内容二') === '内容一\n\n内容二')
  ok('原本的空行分段保留', strip('第一段\n\n第二段') === '第一段\n\n第二段')
  ok('行尾空白清掉', strip('内容   \n#灵感') === '内容')
  ok('CRLF 也认得出整行标签', strip('#灵感\r\n内容') === '内容')
  ok('空串返回空串', strip('') === '')
  ok('非字符串返回空串', strip(null) === '' && strip(undefined) === '' && strip(123) === '')
}

/* ============ 5. 四个展示点都接了 ============ */
console.log('5) 接线：详情页 / 首页摘要 / 做成图')
{
  const djs = read('pages/detail/detail.js')
  ok('详情页 require 了 tagtext', /require\('\.\.\/\.\.\/utils\/tagtext'\)/.test(djs))
  ok('详情页 setData 出 bodyText', /bodyText:\s*tagtext\.stripTagLines\(/.test(djs))
  ok('详情页 data 里有 bodyText 默认值', /bodyText:\s*''/.test(djs))

  const dwxml = read('pages/detail/detail.wxml')
  ok('详情页不再原样渲染 record.content', !/\{\{record\.content\}\}/.test(dwxml))
  ok('详情页三处正文输出都用 bodyText', (dwxml.match(/>\{\{bodyText\}\}</g) || []).length === 3,
    (dwxml.match(/>\{\{bodyText\}\}</g) || []).length)
  ok('语音/照片的说明文字按 bodyText 判空', /wx:if="\{\{bodyText\}\}"/.test(dwxml))
  ok('文字类型在 bodyText 为空时不渲染空盒子', /record\.type === 'text' && bodyText/.test(dwxml))

  const ijs = read('pages/index/index.js')
  ok('首页摘要剥过标签', /tagtext\.stripTagLines\(item\.content/.test(ijs))
  ok('整条只有标签时摘要退回原文（卡片不能空着）', /const text = body \|\| raw/.test(ijs))

  const pjs = read('utils/poster.js')
  ok('做成图正文剥过标签', /tagtext\.stripTagLines\(raw\)/.test(pjs))
  ok('做成图整条只有标签时退回原文', /stripTagLines\(raw\)\.trim\(\) \|\| raw/.test(pjs))

  const sjs = read('utils/store.js')
  ok('数据层仍然只解析不改正文（parseTags 里没有 replace）',
    !/function parseTags[\s\S]{0,400}replace\(/.test(sjs))
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
