/**
 * 发布前静态检查（不发版、不联网，只读仓库）
 * 用法：node tools/preflight.js
 *
 * 为什么要有这一层：单元测试能证明"算得对"，但发布前翻车的原因往往是另一类——
 * 页面少注册一个、wxml 里 bindtap 写了个不存在的方法、JSON 多个逗号、
 * 用了隐私接口却没在后台勾选。这些都不是逻辑错误，测试跑不到，真机上才炸。
 * 所以这里做的是"发版体检"：把能静态发现的问题一次列全。
 *
 * 退出码：有 error 时为 1，只有 warn 为 0。
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const B = path.join(ROOT, 'miniprogram')

const errors = []
const warns = []
const notes = []

function err(code, msg) { errors.push({ code, msg }) }
function warn(code, msg) { warns.push({ code, msg }) }
function note(msg) { notes.push(msg) }

const read = p => fs.readFileSync(path.join(B, p), 'utf8')
const exists = p => fs.existsSync(path.join(B, p))
const walk = (dir, out) => {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
    const full = path.join(dir, d.name)
    if (d.isDirectory()) walk(full, out)
    else out.push(full)
  })
  return out
}

/* ---------------- 0. 项目身份：AppID 决定代码传给谁 ---------------- */
// 最容易致命、又最没人检查的一步。2026-11-11 真踩过：project.config.json 里
// 写的是「国色天湘香菜」的 AppID，于是灵感随时记的所有版本都传进了那个餐厅
// 小程序的开发版本槽位；再往前走一步点提审、发布，被换掉的就是它的线上版本。
const WRONG_APPID = {
  wxa12c398753852198: '国色天湘香菜（另一个业务的小程序，不是本项目）'
}
let pcfg = null
try {
  pcfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
} catch (e) {
  err('appid.config', 'project.config.json 缺失或不是合法 JSON：' + e.message)
}
if (pcfg) {
  const id = String(pcfg.appid || '')
  if (!id) {
    err('appid.empty', 'project.config.json 没有 appid，上传会被拒')
  } else if (id === 'touristappid' || /^wxid_/.test(id)) {
    err('appid.tourist', 'appid 是游客号（' + id + '），只能本地看，不能上传发布')
  } else if (WRONG_APPID[id]) {
    err('appid.wrong', 'appid 指向「' + WRONG_APPID[id] + '」，上传等于改别人的小程序，提审发布会把它的线上版本换掉')
  } else if (!/^wx[0-9a-f]{16}$/.test(id)) {
    warn('appid.format', 'appid 格式可疑：' + id)
  }
  note('项目 ' + (pcfg.projectname || '(未命名)') + ' → AppID ' + (id || '(空)'))
}

/* ---------------- 1. 页面注册与四件套 ---------------- */
const app = JSON.parse(read('app.json'))
const pages = app.pages || []
if (!pages.length) err('app.pages', 'app.json 没有任何页面')

pages.forEach(p => {
  const base = p
  ;['.js', '.wxml', '.wxss'].forEach(ext => {
    if (!exists(base + ext)) err('page.file', p + ext + ' 缺失')
  })
  // 页面 json 可以没有，但一旦有必须能解析
  if (exists(base + '.json')) {
    try { JSON.parse(read(base + '.json')) } catch (e) {
      err('page.json', p + '.json 不是合法 JSON：' + e.message)
    }
  }
})

// 磁盘上有页面目录却没注册（发布包里会白占体积）
const onDisk = fs.readdirSync(path.join(B, 'pages')).filter(d =>
  fs.statSync(path.join(B, 'pages', d)).isDirectory()
)
onDisk.forEach(d => {
  if (pages.indexOf('pages/' + d + '/' + d) < 0) warn('page.unregistered', 'pages/' + d + ' 没有在 app.json 注册')
})

/* ---------------- 2. 组件引用 ---------------- */
const compDirs = fs.readdirSync(path.join(B, 'components'))
const checkComponents = (jsonPath, label) => {
  let j
  try { j = JSON.parse(read(jsonPath)) } catch (e) { return }
  const uc = j.usingComponents || {}
  Object.keys(uc).forEach(k => {
    const v = uc[k]
    if (!v) return
    const target = v.startsWith('/') ? v.slice(1) : path.join(path.dirname(jsonPath), v)
    const okJs = exists(target + '.js')
    const okWxml = exists(target + '.wxml')
    if (!okJs || !okWxml) err('component.missing', label + ' 引用的组件 ' + k + ' 找不到（' + v + '）')
  })
}
checkComponents('app.json', 'app.json')
pages.forEach(p => {
  if (exists(p + '.json')) checkComponents(p + '.json', p)
})
notes.push('自定义组件 ' + compDirs.length + ' 个：' + compDirs.join(' / '))

/* ---------------- 3. wxml 事件绑定必须有对应方法 ---------------- */
const EVENT_ATTR = /\b(?:bind|catch|capture-bind|capture-catch|mut-bind)(?::)?([a-zA-Z]+)="([^"{}]+)"/g
const EVENT_ATTR_CUSTOM = /\b(?:bind|catch):([a-zA-Z-]+)="([^"{}]+)"/g   // bind:open 这种自定义事件

pages.forEach(p => {
  const wxmlPath = p + '.wxml'
  const jsPath = p + '.js'
  if (!exists(wxmlPath) || !exists(jsPath)) return
  const wxml = read(wxmlPath)
  const js = read(jsPath)
  const missing = []
  const scan = re => {
    re.lastIndex = 0
    let m
    while ((m = re.exec(wxml))) {
      const handler = m[2].trim()
      if (!handler || handler.indexOf('{{') >= 0) continue
      // 方法可能写成 name(){} 或 name: function
      const defined = new RegExp('(^|[^\\w.])' + handler + '\\s*[:(]').test(js)
      if (!defined) missing.push(handler)
    }
  }
  scan(EVENT_ATTR)
  scan(EVENT_ATTR_CUSTOM)
  if (missing.length) {
    err('event.missing', p + '.wxml 绑定了 ' + Array.from(new Set(missing)).join('、') + '，但 ' + p + '.js 里没有这些方法')
  }
})

/* ---------------- 4. wxml 标签配对 ---------------- */
// 只列真正没有闭合标签的空元素。canvas / video / camera / map 在 wxml 里
// 常写成 <canvas></canvas>，不能当空元素跳过，否则会把正常闭合报成错。
const VOID = ['image', 'input', 'icon', 'progress', 'switch', 'slider', 'import', 'include', 'wxs']
pages.forEach(p => {
  const f = p + '.wxml'
  if (!exists(f)) return
  let src = read(f)
  src = src.replace(/<!--[\s\S]*?-->/g, '')       // 去注释
  src = src.replace(/\{\{[\s\S]*?\}\}/g, 'X')     // 去插值里的 < >
  const stack = []
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
  let m
  let bad = null
  while ((m = re.exec(src))) {
    const name = m[1]
    const selfClosed = m[3] === '/'
    const closing = m[0][1] === '/'
    if (closing) {
      if (stack[stack.length - 1] !== name) {
        bad = '闭合 </' + name + '> 与最近的 <' + (stack[stack.length - 1] || '无') + '> 不匹配'
        break
      }
      stack.pop()
    } else if (!selfClosed && VOID.indexOf(name) < 0) {
      stack.push(name)
    }
  }
  if (bad) err('wxml.tag', f + '：' + bad)
  else if (stack.length) err('wxml.tag', f + '：还有未闭合的标签 ' + stack.join(' > '))
})

/* ---------------- 5. JSON 全部可解析 ---------------- */
walk(B, []).filter(f => f.endsWith('.json')).forEach(f => {
  try { JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) {
    err('json.parse', path.relative(B, f) + '：' + e.message)
  }
})

/* ---------------- 6. JS 语法 ---------------- */
walk(B, []).filter(f => f.endsWith('.js')).forEach(f => {
  try {
    execSync('node --check "' + f + '"', { stdio: 'pipe' })
  } catch (e) {
    err('js.syntax', path.relative(B, f) + '：语法错误')
  }
})

/* ---------------- 7. 隐私接口清单（后台必须勾选） ---------------- */
const PRIVACY = {
  'wx.getClipboardData': '剪切板',
  'wx.setClipboardData': '剪切板（写入，一般随剪切板一并声明）',
  'wx.chooseMedia': '选中的照片或视频信息 / 相册',
  'wx.chooseImage': '相册',
  'wx.previewImage': '相册（预览）',
  'wx.getRecorderManager': '麦克风',
  'wx.chooseMessageFile': '从聊天中选择文件（不涉隐私声明，但需真机验证）',
  'wx.saveFileToDisk': '写入文件（PC 端）',
  'wx.shareFileMessage': '转发文件（不涉隐私声明）'
}
const allSource = walk(B, []).filter(f => /\.(js)$/.test(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n')
const usedPrivacy = Object.keys(PRIVACY).filter(k => allSource.indexOf(k) >= 0)
notes.push('用到的敏感接口（发布前逐项在「用户隐私保护指引」里勾对）：\n    ' +
  usedPrivacy.map(k => k + '  →  ' + PRIVACY[k]).join('\n    '))

/* ---------------- 8. 体积与残留 ---------------- */
const files = walk(B, [])
const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0)
notes.push('包体（未压缩源码）：' + (bytes / 1024).toFixed(1) + ' KB，' + files.length + ' 个文件')
if (bytes > 1.5 * 1024 * 1024) warn('size', '源码已超过 1.5MB，分包或裁图后再发版')

const logs = []
files.filter(f => f.endsWith('.js')).forEach(f => {
  const t = fs.readFileSync(f, 'utf8')
  const m = t.match(/console\.log\(/g)
  if (m) logs.push(path.relative(B, f) + ' ×' + m.length)
})
if (logs.length) warn('console', '还有 console.log 残留：' + logs.join('、'))

/* ---------------- 9. sitemap 与可搜索性 ---------------- */
let sm = null
try { sm = JSON.parse(read('sitemap.json')) } catch (e) { err('sitemap', 'sitemap.json 解析失败') }
if (sm && sm.rules) {
  const allDisallow = sm.rules.every(r => r.action === 'disallow')
  const allowAll = sm.rules.some(r => r.action === 'allow' && r.page === '*')
  if (allowAll) {
    // 首页就是用户的记录列表，被索引等于把私人内容递到搜索里
    warn('sitemap.open', 'sitemap 允许索引全部页面：首页是私人记录列表，不要开放')
  } else if (allDisallow) {
    note('sitemap 全站不索引：搜索曝光只靠名称与简介，页面内容不进微信索引（对私密记录是正确取舍）')
  }
}

/* ---------------- 10. 关键路径可达性 ---------------- */
const navTargets = []
allSource.replace(/url:\s*'(\/pages\/[^'?]+)/g, (_, u) => navTargets.push(u))
Array.from(new Set(navTargets)).forEach(u => {
  const p = u.replace(/^\//, '')
  if (pages.indexOf(p) < 0) err('nav.missing', '代码里要跳转 ' + u + '，但 app.json 没注册这个页面')
  else if (!exists(p + '.wxml')) err('nav.missing', '跳转目标 ' + u + ' 没有 wxml')
})

/* ---------------- 输出 ---------------- */
console.log('发布前静态检查\n')
notes.forEach(n => console.log('· ' + n))

if (warns.length) {
  console.log('\n警告 ' + warns.length + ' 项')
  warns.forEach(w => console.log('  ! [' + w.code + '] ' + w.msg))
}
if (errors.length) {
  console.log('\n错误 ' + errors.length + ' 项')
  errors.forEach(e => console.log('  × [' + e.code + '] ' + e.msg))
}
if (!errors.length && !warns.length) console.log('\n没有发现问题。')
else if (!errors.length) console.log('\n没有阻塞问题，警告项按需处理。')

process.exit(errors.length ? 1 : 0)
