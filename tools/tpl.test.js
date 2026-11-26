/**
 * 模板库与公开页（38 条）
 * 用法：node tools/tpl.test.js
 *
 * 这一批改动的风险不在"跑不起来"，而在**悄悄地失效**：
 *   · sitemap 写错一个路径 → 后台显示已开启，实际一页都收不到
 *   · 模板页读了 storage → 爬虫进来是空页，官方判定"与真实呈现不一致"不收录
 *   · 详情入口用了 bindtap → 页面上没有可跟随的链接，爬虫走不到 detail
 *   · 从模板进编辑页直接覆盖草稿 → 用户上一句没存的话被无声扔掉
 * 这些都是"没人报错、但功能等于没做"的问题，所以全部做静态断言。
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

const read = p => fs.readFileSync(path.join(B, p), 'utf8')

/** 取某个方法体（从缩进两格的 name( 到下一个缩进两格的 },） */
function bodyOf(src, name) {
  const i = src.indexOf('\n  ' + name + '(')
  if (i < 0) return ''
  const end = src.indexOf('\n  },', i)
  if (end < 0) return ''
  return src.slice(i, end)
}

// i18n 会读 storage 判断语言；这里给一个最小的假 wx，保证能在 Node 里 require
global.wx = {
  getAppBaseInfo() {
    return { language: 'zh_CN' }
  },
  getStorageSync() {
    return ''
  },
  setStorageSync() {}
}

const TPL = require(path.join(B, 'utils', 'templates.js'))
const i18n = require(path.join(B, 'utils', 'i18n.js'))

const app = JSON.parse(read('app.json'))
const sm = JSON.parse(read('sitemap.json'))

/* ================= 1. 模板数据本身 ================= */
console.log('1) 模板数据：数量、唯一性、字段完整')
{
  ok('模板数量是 25 条', TPL.count === 25, TPL.count)
  ok('LIST 长度与 count 一致', TPL.LIST.length === TPL.count)

  const ids = TPL.LIST.map(t => t.id)
  ok('id 唯一', new Set(ids).size === ids.length, ids.filter((v, i) => ids.indexOf(v) !== i))
  ok(
    'id 只含小写字母、数字、连字符（要进 URL）',
    ids.every(id => /^[a-z][a-z0-9-]*$/.test(id)),
    ids.filter(id => !/^[a-z][a-z0-9-]*$/.test(id))
  )

  const catIds = TPL.CATS.map(c => c.id)
  ok('每条模板的 cat 都在 CATS 里', TPL.LIST.every(t => catIds.indexOf(t.cat) >= 0))

  const emptyField = []
  TPL.LIST.forEach(t => {
    ;['title', 'scene', 'tip', 'skeleton', 'example'].forEach(k => {
      if (!String(t[k] || '').trim()) emptyField.push(t.id + '.' + k)
    })
  })
  ok('五个正文字段都不为空', emptyField.length === 0, emptyField)

  const thin = TPL.LIST.filter(t => t.skeleton.split('\n').length < 3)
  ok('每条骨架至少三行（一行不叫骨架）', thin.length === 0, thin.map(t => t.id))

  const noExample = TPL.LIST.filter(t => t.example.split('\n').length < 3)
  ok('每条示例至少三行', noExample.length === 0, noExample.map(t => t.id))

  // 示例是给人"照着写"的，太长会变成范文，反而不敢动笔
  const longExample = TPL.LIST.filter(t => t.example.length > 400)
  ok('示例不超过 400 字（示的不是范文）', longExample.length === 0, longExample.map(t => t.id))
}

/* ================= 1.5 分类顺序与折叠容量 ================= */
console.log('1.5) 分类顺序：灵感 → 作品 → 写 → 日常 → 工作')
{
  const names = TPL.CATS.map(c => c.name)
  ok('五个分类', TPL.CATS.length === 5, names)
  ok('「工作用」排在最后（它是给公司写的，不是给自己写的）', names[names.length - 1] === '工作用', names)
  ok(
    '前三类是创作者视角（灵感 / 作品 / 写）',
    names[0].indexOf('灵感') >= 0 && names[1].indexOf('作品') >= 0 && names[2] === '写下来',
    names
  )
  ok(
    '每类至少 4 条（否则"默认三条"没有可折叠的东西）',
    TPL.CATS.every(c => TPL.byCat(c.id).length >= 4),
    TPL.CATS.map(c => c.id + ':' + TPL.byCat(c.id).length)
  )

  // 示例里出现财务现场可以接受（工作用那五条就是职场），
  // 但前四类全是创作者，示例不该整组都是报表和门店
  const creator = TPL.LIST.filter(t => t.cat !== 'work')
  const officeWord = /报表|对账|门店|主体|月报/
  const tooOffice = creator.filter(t => officeWord.test(t.example))
  ok('前四类的示例不是"财务在写报表"', tooOffice.length === 0, tooOffice.map(t => t.id))

  // 反向：工作用也不许绑死在某个行业。「门店对账 / 电子烟 / 国补核销」这类例子
  // 对同行业的人是加分，对其他所有人是"这不是给我写的"。模板要换一个行当照样能用，
  // 所以换掉的是现场，不是具体性——数字和那个只有当事人才知道的细节都保留
  const industry = /门店|电子烟|国补|汇率|对账|月报|车贷|税务|主体/
  const niche = TPL.LIST.filter(t => industry.test(t.example))
  ok(
    '没有一条示例绑死在某个行业（工作用也在内）',
    niche.length === 0,
    niche.map(t => t.id + ':' + industry.exec(t.example)[0])
  )
}

/* ================= 2. 查询接口 ================= */
console.log('2) byId / groups：详情页只认这两个入口')
{
  const first = TPL.LIST[0]
  ok('byId 命中已知 id', TPL.byId(first.id) === first)
  ok('byId 对未知 id 返回 null（不抛错）', TPL.byId('nope-nope') === null)
  ok('byId 对空值返回 null', TPL.byId('') === null && TPL.byId(undefined) === null)

  const g = TPL.groups()
  const total = g.reduce((n, x) => n + x.items.length, 0)
  ok('groups 覆盖了全部模板（没有漏组的条目）', total === TPL.count, { total, count: TPL.count })
  ok('groups 里没有空分类', g.every(x => x.items.length > 0))
}

/* ================= 3. 数据模块不许有依赖 ================= */
console.log('3) templates.js 必须是纯常量（爬虫进来时本机没有数据）')
{
  const src = read('utils/templates.js')
  ok('不 require 任何模块', !/\brequire\s*\(/.test(src))
  ok('不访问 wx', !/\bwx\./.test(src))
  ok('不访问 storage', !/Storage/.test(src))
}

/* ================= 4. sitemap 白名单 ================= */
console.log('4) sitemap：只放三页，detail 只放带 k 的')
{
  const rules = sm.rules || []
  const allows = rules.filter(r => r.action === 'allow')
  const last = rules[rules.length - 1]

  ok('最后一条是 disallow *（白名单的收口）', last && last.action === 'disallow' && last.page === '*', last)
  ok('没有 allow *（那等于全站放开）', !allows.some(r => r.page === '*'))

  const pages = app.pages
  const bad = allows.filter(r => pages.indexOf(r.page) < 0)
  ok('allow 的页面路径都在 app.json 里（写错路径等于没开）', bad.length === 0, bad.map(r => r.page))

  ok('放行模板列表', allows.some(r => r.page === 'pages/tpl/list'))
  ok('放行使用指南', allows.some(r => r.page === 'pages/guide/guide'))

  const detail = allows.filter(r => r.page === 'pages/tpl/detail')
  ok('detail 只放行带 k 参数的那种', detail.length === 1 && Array.isArray(detail[0].params) && detail[0].params[0] === 'k', detail)

  // 首页渲染用户灵感正文、detail 渲染全文：放进索引等于把私人记录暴露给搜索
  const priv = ['pages/index/index', 'pages/detail/detail', 'pages/record/record']
  ok('首页 / 详情 / 记录页都没有被 allow', !allows.some(r => priv.indexOf(r.page) >= 0), allows.map(r => r.page))
}

/* ================= 5. 三个公开页不读本机数据 ================= */
console.log('5) 公开页：不读记录、不读 storage、不碰隐私接口')
{
  const pages = ['pages/tpl/list.js', 'pages/tpl/detail.js', 'pages/guide/guide.js']
  pages.forEach(p => {
    const s = read(p)
    ok(p + ' 不 require store', !/require\([^)]*utils\/store/.test(s))
    ok(p + ' 不直接读 storage', !/getStorageSync|getStorageInfo/.test(s))
    ok(p + ' 不调隐私类接口', !/getClipboardData|chooseImage|getLocation/.test(s))
  })
}

/* ================= 6. detail 页：可达、可分享、失败不白屏 ================= */
console.log('6) 详情页')
{
  const listWxml = read('pages/tpl/list.wxml')
  const listJs = read('pages/tpl/list.js')
  const listWxss = read('pages/tpl/list.wxss')
  const dJs = read('pages/tpl/detail.js')
  const dWxml = read('pages/tpl/detail.wxml')

  ok('列表页用真实 navigator 指向详情（bindtap 爬虫跟不到）', /<navigator/.test(listWxml))
  ok('分类头把条数显示出来（countText 不能是白算的）', /g\.countText/.test(listWxml))
  ok('列表页链接带 k 参数', /\/pages\/tpl\/detail\?k=/.test(listWxml))

  console.log('  6.1) 默认三条 + 折叠')
  ok('每类默认只露三条', /const PREVIEW = 3\b/.test(listJs), (listJs.match(/PREVIEW = \d+/) || [])[0])
  ok('剩余条目单独拆进 more 数组', /slice\(PREVIEW\)/.test(listJs))
  ok(
    '折叠用 hidden，不用 wx:if（wx:if 会把节点的链接从渲染结果里摘掉）',
    /<view class="more" hidden="\{\{!g\.open\}\}"/.test(listWxml) && !/wx:if="\{\{!g\.open\}\}"/.test(listWxml)
  )
  ok(
    '展开与收起都带 k 链接（两组 navigator 都要能被跟到）',
    (listWxml.match(/\/pages\/tpl\/detail\?k=/g) || []).length >= 2
  )
  ok('整行都是展开按钮，不是一个点不中的箭头', /catchtap="onToggle"/.test(listWxml) && /class="more-btn"/.test(listWxml))
  ok('按钮带下标，能改到对应的那一组', /data-idx="\{\{idx\}\}"/.test(listWxml) && /groups\[\s*' \+ idx \+ '\s*\]\.open/.test(listJs))
  ok('收起态说清还剩几个', /g\.moreText/.test(listWxml) && /expand_n/.test(listJs))
  ok('展开后可收起', /t\.collapse/.test(listWxml))
  ok('展开按钮的可点高度按手指给够（≥ 84rpx）', /\.more-btn\s*\{[\s\S]*?min-height:\s*(8[4-9]|9\d|\d{3,})rpx/.test(listWxss))
  ok('场景描述给两行（半句话判断不了这条是不是给自己写的）', /-webkit-line-clamp:\s*2/.test(listWxss))
  ok('详情页用 byId 查表，不用数组下标', /templates\.byId\(/.test(dJs))

  const show = bodyOf(dJs, 'show')
  ok('show() 抽出来了（onLoad 与后续复用同一处）', show.length > 100, show.length)
  ok('查不到时置 missing，而不是白屏', /missing:\s*true/.test(show))
  ok('缺参不抛错：先判空再查', /byId\(k\)/.test(show) && /if\s*\(!item\)/.test(show))

  ok('详情页可按 k 分享回自己', /path:\s*'\/pages\/tpl\/detail\?k='/.test(dJs))
  ok('分享标题带模板名', /tpl:share_title/.test(dJs))

  const use = bodyOf(dJs, 'onUse')
  ok('「用这个模板记一条」带 tpl 参数进编辑页', /tpl='\s*\+\s*item\.id/.test(use), use)
  ok('进编辑页时指定 type=text', /type=text/.test(use))

  const back = bodyOf(dJs, 'onBackList')
  ok('返回列表会判断栈深（分享直达时没有上一页）', /getCurrentPages/.test(back) && /navigateBack/.test(back) && /redirectTo/.test(back))

  const showHook = bodyOf(dJs, 'onShow')
  ok('从模板写完回到详情页会自动回首页（否则看不到刚存的那条）', showHook.length > 50 && /flashId/.test(showHook) && /reLaunch/.test(showHook), showHook.length)
  ok('flashId 交给首页消费，详情页不抢先清空', !/flashId\s*=\s*''/.test(showHook))

  // 骨架与示例必须在正常分支里直接渲染，不能被 wx:if 折叠起来
  ok('骨架与示例都直接渲染，没有折叠', /item\.skeleton/.test(dWxml) && /item\.example/.test(dWxml))
  ok('详情页没有"展开/收起"这种折叠结构', !/展开|收起/.test(dWxml))
}

/* ================= 7. 指南页 ================= */
console.log('7) 指南页')
{
  const gJs = read('pages/guide/guide.js')
  const gWxml = read('pages/guide/guide.wxml')

  ok('FAQ 从 q/a 键成对拼出来', /'a'\s*\+\s*k\.slice\(1\)/.test(gJs))
  ok('六条 FAQ 都在', gJs.indexOf("'q1'") > 0 && gJs.indexOf("'q6'") > 0)
  ok('FAQ 不折叠（这一页就是给人一次看全的）', !/wx:if="\{\{.*open/.test(gWxml))
  ok('底部能直接开始记一条', /onStart/.test(gWxml) && /pages\/record\/record\?type=text/.test(gJs))
  ok('和模板列表互相链接（两个公开页要能互相爬到）', /pages\/tpl\/list/.test(gWxml))
}

/* ================= 8. 列表页与指南互通、入口存在 ================= */
console.log('8) 入口')
{
  const lWxml = read('pages/tpl/list.wxml')
  ok('列表页能去指南', /pages\/guide\/guide/.test(lWxml))

  const homeJs = read('pages/index/index.js')
  const homeWxml = read('pages/index/index.wxml')
  ok('首页空态有模板入口', /goTemplates/.test(homeWxml))
  // 入口不能只挂在空态上：有了第一条记录，模板仍要够得着（列表滚到底处）
  const exitTag = (homeWxml.match(/<view\s+class="tpl-exit"[\s\S]{0,260}?<\/view>/) || [''])[0]
  ok('有记录时列表底部也有模板出口（条件里必须有 !empty）', /!empty/.test(exitTag) && /tpl_exit/.test(exitTag), exitTag.slice(0, 60))
  ok('首页 goTemplates 指向模板列表', /goTemplates\(\)\s*\{[\s\S]{0,120}\/pages\/tpl\/list/.test(homeJs))

  const meJs = read('pages/me/me.js')
  const meWxml = read('pages/me/me.wxml')
  ok('我的页有模板与指南两行', /onTemplates/.test(meWxml) && /onGuide/.test(meWxml))
  ok('我的页两个跳转都指向对应页面', /pages\/tpl\/list/.test(meJs) && /pages\/guide\/guide/.test(meJs))
  ok('我的页模板副标题带真实条数', /templates\.count/.test(meJs))

  ok('三页都已注册进 app.json', ['pages/tpl/list', 'pages/tpl/detail', 'pages/guide/guide'].every(p => app.pages.indexOf(p) >= 0))
}

/* ================= 9. 从模板进编辑页：不静默扔掉草稿 ================= */
console.log('9) 编辑页接模板参数')
{
  const rJs = read('pages/record/record.js')
  ok('记录页 require 了模板表', /require\([^)]*utils\/templates/.test(rJs))
  ok('读 options.tpl 并查表', /options\.tpl\s*\?/.test(rJs) && /templates\.byId\(options\.tpl\)/.test(rJs))

  const fill = bodyOf(rJs, 'fillTemplate')
  ok('fillTemplate 方法体切出来了（防止切片失效让后面的断言空跑）', fill.length > 200, fill.length)
  ok('有草稿时先弹确认，不直接覆盖', /dialog\s*\.\s*confirm/.test(fill))
  ok('确认后清掉旧草稿（否则下次开新记录会冒出上一句）', /store\.clearDraft\(\)/.test(fill))
  ok('没草稿时直接填骨架', /this\.setData\(\{\s*content:\s*tpl\.skeleton/.test(fill))
  ok('不调 markDirty（骨架不是用户写的，别弹"离开前确认"）', !/markDirty/.test(fill))
}

/* ================= 10. 文案 ================= */
console.log('10) 文案：两个命名空间的键齐全')
{
  const t = i18n.pack('tpl')
  ;['nav', 'lead', 'cat_count', 'expand_n', 'collapse', 'scene', 'tip', 'skeleton', 'example', 'use', 'start_hint', 'gone_title', 'gone_text', 'back', 'back_home', 'cn_only', 'share_title', 'share_list', 'rel', 'all', 'brand'].forEach(k => {
    ok('tpl:' + k + ' 存在', !!t[k])
  })

  const g = i18n.pack('guide')
  ;['nav', 'lead', 's1', 's1_b', 's2', 's2_b', 's3', 's3_b', 's4', 's4_b', 'faq', 'note', 'start', 'tpl_link'].forEach(k => {
    ok('guide:' + k + ' 存在', !!g[k])
  })
  ;['1', '2', '3', '4', '5', '6'].forEach(n => {
    ok('guide q' + n + '/a' + n + ' 成对', !!g['q' + n] && !!g['a' + n])
  })

  ok('占位符 {n} 在分类条数里保留', i18n.t('tpl:cat_count', { n: 20 }) === '20 个', i18n.t('tpl:cat_count', { n: 20 }))

  // 导语里的条数必须等于真实条数：数字只有一个来源（templates.count）
  const listJs = read('pages/tpl/list.js')
  const listWxml = read('pages/tpl/list.wxml')
  ok('导语的条数由 templates.count 填', /leadText:\s*i18n\.t\('tpl:lead',\s*\{\s*n:\s*templates\.count/.test(listJs))
  ok('导语真的上屏了', /\{\{leadText\}\}/.test(listWxml))
  ok('页面上不再有第二处「{n} 个模板」', !/'tpl:count'/.test(read('utils/i18n.js')) && !/\{\{countText\}\}/.test(listWxml))
  ok('填进去的就是真实条数', i18n.t('tpl:lead', { n: TPL.count }).indexOf(String(TPL.count)) === 0, i18n.t('tpl:lead', { n: TPL.count }))
}

/* ================= 11. 术语与入口 ================= */
console.log('11) 术语：用户看到的是「提纲」，不是开发词「骨架」')
{
  const raw = read('utils/i18n.js')

  // 键名保留 tpl:skeleton（内部标识、改它会牵动页面），值必须换成用户能懂的字
  ok("tpl:skeleton 中文是「提纲」", /'tpl:skeleton': '提纲'/.test(raw))
  ok("tpl:skeleton 英文是 Outline", /'tpl:skeleton': 'Outline'/.test(raw))
  ok("tpl:start_hint 中文用「提纲」", /'tpl:start_hint': '[^']*提纲/.test(raw))
  ok("tpl:start_hint 英文用 outline", /'tpl:start_hint': '[^']*outline/.test(raw))
  ok("me:row_tpl_sub 中文用「提纲」", /'me:row_tpl_sub': '\{n\} 个能照着写的提纲'/.test(raw))
  ok("me:row_tpl_sub 英文用 outlines", /'me:row_tpl_sub': '\{n\} outlines you can fill in'/.test(raw))

  // 导语里原来硬编码「25 个」，加模板时没人会记得回来改；数字交给 {n}
  const lead = i18n.pack('tpl').lead || ''
  ok('导语用 {n} 占位，不写死条数', /\{n\}/.test(lead) && !/\d/.test(lead), lead)
  ok('导语点出「模板」二字（从搜索落地的人要知道这是一页模板）', /模板/.test(lead), lead)
  ok('导语覆盖五类关键词（灵感 / 故事 / 周报 / 会议 / 读书）', ['灵感', '故事', '周报', '会议', '读书'].every(k => lead.indexOf(k) >= 0), lead)

  // 填完数要是一句通顺的话，不能是「{n} 个」后面跟了半个句子
  const leadZh = i18n.t('tpl:lead', { n: 25 })
  ok('导语填数后是完整句子', /^25 个写作与记录模板/.test(leadZh) && /。$/.test(leadZh), leadZh)

  // 英文同样只认 {n}，且不能整段照搬中文（切完记得切回来，后面的断言还看中文）
  i18n.setLang('en')
  const leadEn = i18n.pack('tpl').lead || ''
  i18n.setLang('zh')
  ok('英文导语也用 {n}，不写死条数', /\{n\}/.test(leadEn) && !/\d/.test(leadEn), leadEn)
  ok('英文导语是英文', !/[\u4e00-\u9fff]/.test(leadEn), leadEn)
}

console.log('12) 「记一条」页有提纲出口，且只在新建空稿时出现')
{
  const rWxml = read('pages/record/record.wxml')
  const rJs = read('pages/record/record.js')
  const rWxss = read('pages/record/record.wxss')

  const toolsAt = rWxml.indexOf('class="tools"')
  const linkAt = rWxml.indexOf('class="tpl-link"')
  const metaAt = rWxml.indexOf('class="meta-row"')

  ok('页面上有 .tpl-link', linkAt > 0)
  ok('点了走 goTemplates', /catchtap="goTemplates"/.test(rWxml))
  ok('新建且正文为空时才出现', /wx:if="\{\{mode === 'create' && !content\}\}"/.test(rWxml))
  ok('goTemplates 指向提纲列表', /goTemplates\(\)\s*\{\s*wx\.navigateTo\(\{\s*url:\s*'\/pages\/tpl\/list'/.test(rJs))

  // 真机反馈：放在底部固定区会被输入法整个盖住，而这行恰恰只在键盘弹起时要看
  ok('入口不在底部固定区里', toolsAt > 0 && linkAt < toolsAt, 'tools 起于 ' + toolsAt + '，入口在 ' + linkAt)
  ok('入口排在输入框、说明行之后（内容流内）', metaAt > 0 && linkAt > metaAt)
  ok('没有残留的 .with-tpl 留白补偿', !/with-tpl/.test(rWxml) && !/\.page\.with-tpl/.test(rWxss))
  ok('入口用强调色，不是说明灰', /\.tpl-link\s*\{[^}]*var\(--accent/.test(rWxss))
  ok('文案键存在且说「提纲」', /'record:tpl_link': '[^']*提纲/.test(read('utils/i18n.js')))
}

/* ================= 13. 同类内链、品牌落款、导航栏跟着语言走 ================= */
console.log('13) 同类内链 / 品牌 / 导航栏')
{
  const dJs = read('pages/tpl/detail.js')
  const dWxml = read('pages/tpl/detail.wxml')
  const dWxss = read('pages/tpl/detail.wxss')
  const lWxml = read('pages/tpl/list.wxml')
  const lJs = read('pages/tpl/list.js')
  const lWxss = read('pages/tpl/list.wxss')

  console.log('  13.1) related() 取同类，不跨类补齐')
  const base = TPL.byId('travel')
  const rel = TPL.related('travel', 3)
  ok('related 给 3 条', rel.length === 3, rel.length)
  ok('related 不含自己', rel.every(x => x.id !== 'travel'))
  ok('related 都同类', rel.every(x => x.cat === base.cat), rel.map(x => x.cat).join(','))
  ok('related 保持 LIST 原顺序', rel.every((x, i) => i === 0 || TPL.LIST.indexOf(x) > TPL.LIST.indexOf(rel[i - 1])))
  ok('不传 n 时默认 3 条', TPL.related('travel').length === 3)
  ok('认不出 id 时给空数组，不抛错', Array.isArray(TPL.related('no-such')) && TPL.related('no-such').length === 0)
  ok('不改原数组（每类仍是 5 条）', TPL.byCat(base.cat).length === 5)
  ok('每条模板都能取到 3 条同类', TPL.LIST.every(x => TPL.related(x.id, 3).length === 3))
  ok('同类里没有跨分类的', TPL.LIST.every(x => TPL.related(x.id, 3).every(y => y.cat === x.cat)))

  console.log('  13.2) 详情页底部内链')
  ok('详情页用 templates.related 取同类', /templates\.related\(/.test(dJs))
  // 只认「搬了 id 和 title」，不认具体写法——标题要走 pick 之后这里已经变过一版
  const relMap = (dJs.match(/templates\.related\(item\.id, 3\)\.map\(function \(x\) \{[\s\S]{0,200}?\}\)/) || [''])[0]
  ok('内链只搬 id 与标题，正文留在各自详情页',
    /id:\s*x\.id/.test(relMap) && /title:/.test(relMap) && !/skeleton|example|scene|tip/.test(relMap), relMap)
  ok('内链是真 navigator，不是 bindtap（爬虫跟得到）', /<navigator/.test(dWxml) && /\/pages\/tpl\/detail\?k=\{\{r\.id\}\}/.test(dWxml))
  ok('内链用 redirect，不加深页面栈（上限 10 层）', /open-type="redirect"/.test(dWxml))
  ok('内链排在主按钮之后（先让人写，再让人看）', dWxml.indexOf('class="rel"') > dWxml.indexOf('bindtap="onUse"'))
  ok('内链整行可点，高度按手指给够', /\.rel-item\s*\{[\s\S]*?min-height:\s*(8[4-9]|9\d|\d{3,})rpx/.test(dWxss))
  ok('查不到模板时清空同类，不留上一条的残留', /related:\s*\[\]/.test(dJs))

  console.log('  13.3) 「看全部」带条数')
  ok('看全部用 {n}，不写死', /\{n\}/.test(i18n.pack('tpl').all || ''), i18n.pack('tpl').all)
  ok('页面把 allText 算好再上屏', /allText:\s*i18n\.t\('tpl:all'/.test(dJs) && /\{\{allText\}\}/.test(dWxml))
  ok('看全部仍走 onBackList（栈里有上一页就返回）', /bindtap="onBackList"/.test(dWxml))

  console.log('  13.4) 品牌落款')
  ok('列表页底部有品牌行', /class="brand"/.test(lWxml))
  ok('详情页底部有品牌行', /class="brand"/.test(dWxml))
  ok('列表页品牌行在正文之后', lWxml.lastIndexOf('class="brand"') > lWxml.lastIndexOf('class="foot"'))
  ok('品牌行是灰字小字，不做成第二个按钮', /\.brand\s*\{[\s\S]*?font-size:\s*2[0-4]rpx/.test(lWxss) && !/\.brand\s*\{[^}]*background/.test(lWxss))
  ok('品牌行说清是什么产品（不只是一串名字）', /灵感本|notebook/i.test(i18n.pack('tpl').brand || ''), i18n.pack('tpl').brand)
  ok('分享标题带品牌', /灵感随时记/.test(i18n.t('tpl:share_list', { n: 25 })), i18n.t('tpl:share_list', { n: 25 }))
  ok('分享标题的条数同样来自 {n}', /^25 个/.test(i18n.t('tpl:share_list', { n: 25 })))
  ok('列表页分享时把 n 填进去', /tpl:share_list',\s*\{\s*n:\s*templates\.count/.test(lJs))
  ok('详情页查不到时分享也不留生占位符', /tpl:share_list',\s*\{\s*n:\s*templates\.count/.test(dJs))

  console.log('  13.5) 导航栏跟着语言走')
  ok('列表页 onLoad 设标题', /i18n\.title\('tpl:nav'\)/.test(lJs))
  ok('指南页标题也走 i18n', /i18n\.title\('guide:nav'\)/.test(read('pages/guide/guide.js')))
  ok('列表页静态标题只是兜底，值与 tpl:nav 一致', JSON.parse(read('pages/tpl/list.json')).navigationBarTitleText === i18n.t('tpl:nav'), JSON.parse(read('pages/tpl/list.json')).navigationBarTitleText)
  ok('详情页静态标题与 tpl:nav 一致', JSON.parse(read('pages/tpl/detail.json')).navigationBarTitleText === i18n.t('tpl:nav'))
  ok('指南页静态标题与 guide:nav 一致', JSON.parse(read('pages/guide/guide.json')).navigationBarTitleText === i18n.t('guide:nav'))
}

/* ================= 14. 展示层的英文 ================= */
console.log('14) 英文界面：分类名、模板标题、场景句都要有英文')
{
  const HAN = /[\u4e00-\u9fa5]/

  ok('5 个分类都有 name_en', TPL.CATS.every(c => !!c.name_en))
  ok('5 个分类都有 desc_en', TPL.CATS.every(c => !!c.desc_en))
  ok('25 条模板都有 title_en', TPL.LIST.every(i => !!i.title_en))
  ok('25 条模板都有 scene_en', TPL.LIST.every(i => !!i.scene_en))
  ok('英文分类名与说明里没有汉字',
    !TPL.CATS.some(c => HAN.test(c.name_en) || HAN.test(c.desc_en)),
    TPL.CATS.filter(c => HAN.test(c.name_en + c.desc_en)).map(c => c.id))
  ok('英文标题与场景里没有汉字',
    !TPL.LIST.some(i => HAN.test(i.title_en) || HAN.test(i.scene_en)),
    TPL.LIST.filter(i => HAN.test(i.title_en + i.scene_en)).map(i => i.id))
  ok('英文不是中文的复制品', TPL.LIST.every(i => i.title_en !== i.title && i.scene_en !== i.scene))
  // 正文刻意保留中文：只有"怎么用/提纲/示例"三样没有英文副本
  ok('正文没有英文副本（档位只到展示层）', !TPL.LIST.some(i => i.tip_en || i.skeleton_en || i.example_en))
  // 卡片里的场景只有两行（.it-scene 的 -webkit-line-clamp: 2），按 375px 实测每行约 49 字符
  ok('英文场景都装得进两行（≤80 字符）',
    TPL.LIST.every(i => i.scene_en.length <= 80),
    TPL.LIST.filter(i => i.scene_en.length > 80).map(i => i.id + ':' + i.scene_en.length))

  console.log('  14.1) pick 按语言取，缺字段回中文')
  ok('lang=en 取到英文', TPL.pick(TPL.LIST[0], 'title', 'en') === TPL.LIST[0].title_en)
  ok('lang=zh 取到中文', TPL.pick(TPL.LIST[0], 'title', 'zh') === TPL.LIST[0].title)
  ok('不传语言一律中文（不给半截翻译）', TPL.pick(TPL.LIST[0], 'title') === TPL.LIST[0].title)
  ok('缺 *_en 时退回中文而不是空白', TPL.pick({ title: '只有中文' }, 'title', 'en') === '只有中文')

  console.log('  14.2) 两页都按语言取')
  const lJs = read('pages/tpl/list.js')
  const dJs = read('pages/tpl/detail.js')
  ok('列表页语言只判一次', /const lang = i18n\.isEn\(\) \? 'en' : 'zh'/.test(lJs))
  ok('列表页分类名走 pick', /templates\.pick\(g,\s*'name',\s*lang\)/.test(lJs))
  ok('列表页分类说明走 pick', /templates\.pick\(g,\s*'desc',\s*lang\)/.test(lJs))
  ok('列表页标题与场景走 pick',
    /templates\.pick\(item,\s*'title',\s*lang\)/.test(lJs) && /templates\.pick\(item,\s*'scene',\s*lang\)/.test(lJs))
  ok('详情页标题与场景走 pick',
    /templates\.pick\(item,\s*'title',\s*lang\)/.test(dJs) && /templates\.pick\(item,\s*'scene',\s*lang\)/.test(dJs))
  ok('详情页导航标题用取好的 title，不用原字段', /setNavigationBarTitle\(\{\s*title:\s*title\s*\}\)/.test(dJs))
  ok('详情页「同类还有」也按语言取', /id:\s*x\.id,\s*title:\s*templates\.pick\(x,\s*'title',\s*lang\)/.test(dJs))
  ok('详情页把选好的 title/scene 覆盖进 item',
    /Object\.assign\(\{\},\s*item,\s*\{\s*title:\s*title,\s*scene:\s*scene\s*\}\)/.test(dJs))

  console.log('  14.3) 提示语与导航标题')
  i18n.setLang('en')
  const en = i18n.pack('tpl')
  ok('英文提示语点明只有提纲与示例是中文', /outline and example are in Chinese/.test(en.cn_only), en.cn_only)
  // 上一轮就是这里翻的车：Inspiration templates（21 字符）被截成 "Inspiration ..."
  ok('英文导航标题不超过 14 字符（否则又被截断）', en.nav.length <= 14, en.nav)
  i18n.setLang('zh')
  ok('中文提示语同样只说正文是中文', /提纲与示例/.test(i18n.t('tpl:cn_only')), i18n.t('tpl:cn_only'))
}

/* ================= 汇总 ================= */
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
