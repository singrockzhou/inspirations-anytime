/**
 * 双语（zh / en）
 * 用法：node tools/i18n.test.js
 *
 * 这一层最容易出的错都不是"跑不起来"，而是**看不出来**：
 *   · 英文界面里冒出半句中文（漏译一个键）
 *   · 某个键只在中文里有，切英文后显示键名
 *   · 占位符 {n} 在一种语言里被写丢，数字凭空消失
 *   · 系统语言是日语时界面空白（回退没生效）
 * 所以下面全部是静态一致性检查，不需要起页面。
 */
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

/* ---------------- 假微信 ---------------- */
let SYS = { language: 'zh_CN' }
let STORE = {}

global.wx = {
  getAppBaseInfo() {
    return { language: SYS.language }
  },
  getStorageSync(k) {
    return STORE[k] === undefined ? '' : STORE[k]
  },
  setStorageSync(k, v) {
    STORE[k] = v
  }
}

function fresh() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(B, 'utils')) === 0) delete require.cache[k]
  })
  return require(path.join(B, 'utils', 'i18n.js'))
}

function reset(language) {
  SYS = { language: language === undefined ? 'zh_CN' : language }
  STORE = {}
}

const i18nFile = path.join(B, 'utils', 'i18n.js')
const src = require('fs').readFileSync(i18nFile, 'utf8')

/** 从源码里把两份字典抠出来，做静态比对（比运行时遍历更可靠，能发现重复键） */
function grabDict(name) {
  const start = src.indexOf('const ' + name + ' = {')
  if (start < 0) throw new Error('dictionary not found: ' + name)
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  let inStr = false
  let quote = ''
  for (let p = i; p < src.length; p++) {
    const c = src[p]
    if (inStr) {
      if (c === '\\') {
        p++
        continue
      }
      if (c === quote) inStr = false
      continue
    }
    if (c === "'" || c === '"') {
      inStr = true
      quote = c
      continue
    }
    if (c === '{') depth++
    if (c === '}') {
      depth--
      if (depth === 0) {
        end = p
        break
      }
    }
  }
  if (end < 0) throw new Error('unbalanced dictionary: ' + name)
  return src.slice(start, end + 1)
}

/* ================= 1. 两份字典的键必须一一对应 ================= */
console.log('1) 字典一致性：中英文键集合必须完全相同')
{
  const mod = fresh()
  const zhKeys = Object.keys(mod.pack(''))
  const enKeys = (function () {
    mod.setLang('en')
    return Object.keys(mod.pack(''))
  })()
  ok('中文键数量合理（> 180）', zhKeys.length > 180, zhKeys.length)
  ok('英文键数量与中文相同', enKeys.length === zhKeys.length, {
    zh: zhKeys.length,
    en: enKeys.length
  })

  mod.setLang('zh')
  const zhPack = mod.pack('')
  mod.setLang('en')
  const enPack = mod.pack('')
  const missing = Object.keys(zhPack).filter(k => enPack[k] === undefined)
  ok('没有"只有中文"的键', missing.length === 0, missing.slice(0, 8))
}

/* ================= 2. 占位符必须对齐 ================= */
console.log('2) 占位符：{n} / {t} 这类变量不能在某一种语言里丢掉')
{
  const mod = fresh()
  mod.setLang('zh')
  const zh = mod.pack('')
  mod.setLang('en')
  const en = mod.pack('')

  const bad = []
  Object.keys(zh).forEach(k => {
    const vars = s => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',')
    if (vars(zh[k]) !== vars(en[k])) bad.push(k + ' zh=' + vars(zh[k]) + ' en=' + vars(en[k]))
  })
  ok('全部键的占位符一致', bad.length === 0, bad.slice(0, 6))
}

/* ================= 3. 英文里不能残留中文 ================= */
console.log('3) 漏译检查：英文值里不能出现汉字')
{
  const mod = fresh()
  mod.setLang('en')
  const en = mod.pack('')
  const leaked = Object.keys(en).filter(k => /[\u4e00-\u9fa5]/.test(en[k]))
  // 品牌名「灵感随时记」在英文界面里保留中文（小程序名称就是它），
  // 「语言 / Language」这一行刻意双语并排，让人一眼知道按哪个。
  // pack('') 返回的是带命名空间的完整键，所以这里也要写全名
  const allowed = [
    'me:row_lang',
    'me:about_version',
    'me:err_format',
    'transfer:md_title',
    'share:title'
  ]
  const real = leaked.filter(k => allowed.indexOf(k) < 0)
  ok('除品牌名与语言行外，没有英文值含汉字', real.length === 0, real.slice(0, 8))
  ok('诊断用：允许清单里的键确实是那些', leaked.every(k => allowed.indexOf(k) >= 0), leaked)
}

/* ================= 4. 空值与键名回退 ================= */
console.log('4) 取词：空值不许出现，未知键如实暴露')
{
  const mod = fresh()
  const zh = mod.pack('')
  const empty = Object.keys(zh).filter(k => !String(zh[k]).trim())
  ok('中文没有空值', empty.length === 0, empty)
  ok('未知键原样返回（便于发现拼错）', mod.t('nope:missing') === 'nope:missing')
}

/* ================= 5. 占位符替换 ================= */
console.log('5) 占位符替换')
{
  const mod = fresh()
  mod.setLang('zh')
  ok('单个参数', mod.t('nudge:keep', { n: 3 }) === '连续 3 天了，今天补一句就不断')
  ok('多个参数', mod.t('index:undo_text', { label: '删了 1 条', n: 5 }) === '删了 1 条 · 5 秒内可以撤回')
  ok('缺参数时保留占位符，不吞掉', mod.t('nudge:keep', {}).indexOf('{n}') > 0)

  mod.setLang('en')
  ok('英文同样替换', mod.t('nudge:keep', { n: 3 }) === '3d in a row — one line keeps it going')
}

/* ================= 6. 系统语言检测 ================= */
console.log('6) 系统语言：中文/英文都认，其余回退中文')
{
  const cases = [
    ['zh_CN', 'zh'],
    ['zh_TW', 'zh'],
    ['zh-Hans', 'zh'],
    ['en', 'en'],
    ['en_US', 'en'],
    ['ja', 'zh'],
    ['ja_JP', 'zh'],
    ['ko', 'zh'],
    ['', 'zh'],
    ['ru_RU', 'zh']
  ]
  cases.forEach(([raw, want]) => {
    reset(raw)
    const mod = fresh()
    ok('系统 ' + (raw || '(空)') + ' → ' + want, mod.systemLang() === want, mod.systemLang())
  })
}

/* ================= 7. 用户选择优先于系统 ================= */
console.log('7) 用户选过的语言优先，且能持久化')
{
  reset('en_US')
  let mod = fresh()
  ok('首次打开跟随系统（英文）', mod.lang() === 'en')

  mod.setLang('zh')
  ok('切到中文后当前会话生效', mod.lang() === 'zh')
  ok('写进了 lg.lang.v1', STORE['lg.lang.v1'] === 'zh', STORE)

  mod = fresh()
  ok('重新加载仍是中文（用户选择压过系统英文）', mod.lang() === 'zh')

  reset('zh_CN')
  mod = fresh()
  mod.setLang('en')
  mod = fresh()
  ok('反向同理：中文系统 + 用户选英文 → 英文', mod.lang() === 'en')

  ok('非法值回退到中文', mod.normalize('klingon') === 'zh')
  ok('大写也认', mod.normalize('EN-US') === 'en')
}

/* ================= 8. pack 前缀筛选 ================= */
console.log('8) pack：按页面只取自己那份，键去掉前缀')
{
  reset()
  const mod = fresh()
  mod.setLang('zh')
  const me = mod.pack('me')
  ok('me 包里没有别的命名空间', Object.keys(me).every(k => k.indexOf(':') < 0))
  ok('me 包里有 hero_unit', me.hero_unit === '条灵感')
  ok('me 包里不含 index 的键', me.title === undefined, me.title)
  ok('完整包比单页包大', Object.keys(mod.pack('')).length > Object.keys(me).length)

  const idx = mod.pack('index')
  ok('index 包里有 title', idx.title === '我的灵感')
  ok('index 包里没有 me 的 hero_unit', idx.hero_unit === undefined)
}

/* ================= 9. 无 wx 环境（构建脚本 / Node）也能 require ================= */
console.log('9) 没有 wx 时安全降级（构建脚本会 require 它）')
{
  const saved = global.wx
  delete global.wx
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(B, 'utils')) === 0) delete require.cache[k]
  })
  const mod = require(path.join(B, 'utils', 'i18n.js'))
  ok('不抛错', true)
  ok('回退中文', mod.lang() === 'zh', mod.lang())
  ok('仍能取词', mod.t('common:ok') === '好')
  global.wx = saved
}

/* ================= 10. 代码里引用的键必须真的存在 ================= */
console.log('10) 引用即存在：i18n.t / i18n.table 用到的键都在词典里')
{
  const fs = require('fs')
  const mod = fresh()
  const dict = mod.pack('')

  const used = [] // [{ key, file }]
  function walk(dir) {
    fs.readdirSync(dir).forEach(name => {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!/\.(js|wxml)$/.test(name)) return
      if (p.indexOf('utils' + path.sep + 'i18n.js') >= 0) return // 词典本体不查自己
      const s = fs.readFileSync(p, 'utf8')
      const rel = path.relative(B, p)

      // 只认"键名后面直接跟右引号和右括号"的写法：
      // i18n.t('date:week' + i) 这种拼出来的动态键不在此列，由单测另行覆盖
      const reT = /i18n\.(?:t|title)\('([a-z]+:[a-z0-9_]+)'\)/g
      let m
      while ((m = reT.exec(s))) used.push({ key: m[1], file: rel })

      const reTable = /i18n\.table\('([a-z]+)',\s*\[([^\]]*)\](?:\s*,\s*'([a-z]+)')?/g
      while ((m = reTable.exec(s))) {
        const head = m[1] + ':' + (m[3] ? m[3] + '_' : '')
        const codes = m[2].match(/'[^']+'/g) || []
        codes.forEach(c => used.push({ key: head + c.replace(/'/g, ''), file: rel }))
      }

      // wxml 里 {{t.xxx}} 走的是 pack(命名空间)，这里只查 js
    })
  }
  walk(B)

  const missing = used.filter(u => dict[u.key] === undefined)
  ok('至少扫到 200 处引用', used.length > 200, used.length)
  ok('没有指向不存在的键', missing.length === 0, missing.slice(0, 5))
}

/* ================= 11. wxml 里的 {{t.xxx}} 必须都在本页包里 ================= */
console.log('11) wxml 引用的字段与 pack(页面) 对得上（对不上会渲染成空白）')
{
  const fs = require('fs')
  const mod = fresh()
  const PAGES = ['index', 'record', 'detail', 'review', 'search', 'poster', 'me']
  const bad = []
  PAGES.forEach(p => {
    const file = path.join(B, 'pages', p, p + '.wxml')
    const s = fs.readFileSync(file, 'utf8')
    const names = new Set()
    const re = /\bt\.([a-z][a-z0-9_]*)/g
    let m
    while ((m = re.exec(s))) names.add(m[1])
    const pack = mod.pack(p)
    names.forEach(n => {
      if (pack[n] === undefined) bad.push(p + ': t.' + n)
    })
  })
  ok('七个页面的 t.xxx 全部有对应文案', bad.length === 0, bad.slice(0, 6))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
