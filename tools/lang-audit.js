/**
 * 双语一致性审计
 * 用法：node tools/lang-audit.js
 *
 * 为什么需要这个脚本：
 * 前面 15 个测试文件都能证明"用 t() 取词是对的"，但没有一个能证明
 * **切完语言之后，屏幕上每一个字都换了**。而混排恰恰不体现在某一处代码错了，
 * 而是体现在"某一处没跟着换"——它跑得起来、测试全绿、只有用户看得见。
 *
 * 做法：把 7 个页面在假 wx 下真实实例化，跑 onLoad/onShow，
 * 把 setData 出来的每个字符串、以及 setNavigationBarTitle / showToast /
 * showModal / showActionSheet 传出去的文案全部录下来；
 * 然后中英各跑一遍，逐字段比对。
 *
 * 判定口径：
 *   MIXED  英文模式下这个字段里还有汉字（品牌名除外）→ 真实混排
 *   STALE  英文模式与中文模式的值一模一样，且含汉字 → 没跟着换
 *   MISS   英文模式下是空字符串，中文模式下有值 → 英文缺失
 *   OK     其余
 *
 * 关键还原点：热切换（wx.reLaunch）**不重新执行 js 模块**，
 * 所以这里只重建页面实例、不清 require 缓存——模块级常量会原地保留，
 * 正是要抓的那类问题。冷启动另跑一轮作为对照。
 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const MINI = path.join(ROOT, 'miniprogram')

/* ============================ 结果记录 ============================ */
let fail = 0
const findings = [] // { page, field, zh, en, kind }
const userData = [] // 用户自己写的内容，记下来但不判为混排

/**
 * 用户内容不参与翻译，这是产品语义而不是漏改：
 * 一条记录写的是中文，界面切成英文后它仍然该是中文。
 * 所以按字段名识别出来单独计数——不是为了放过它们，而是为了证明
 * "剩下的中文都来自用户输入"这件事本身被检查过。
 */
const DATA_FIELD = /(^|\.)(content|_peek|tags|tag|mediaPath|mediaPaths|duration|size|name|excerpt)$/
const DATA_INDEX = /^(groups|tags|item|record|voices|photos)\[?\d*\]?\.?(content|_peek|tags|tag)$/

function isUserData(field) {
  const leaf = field.replace(/\[\d+\]/g, '')
  if (DATA_FIELD.test(leaf)) return true
  if (/\.(content|_peek)$/.test(leaf)) return true
  if (/\.tags(\[\d+\])?$/.test(field) || /\.tag$/.test(leaf)) return true
  return false
}

/** 界面上出现过的用户输入（记录正文、标签、搜索词），用于把「模板 + 用户输入」排除掉 */
const USER_STRINGS = new Set()

function harvest(data) {
  const f = flat(data)
  Object.keys(f).forEach(k => {
    if (!isUserData(k) && !/\.(notFoundText|keyword)$/.test(k)) return
    if (/[\u4e00-\u9fff]/.test(f[k])) USER_STRINGS.add(f[k])
  })
}

/** 英文句子里夹的汉字，如果整段都来自用户输入，那是对的（Nothing for "复盘"） */
function fromUserInput(s) {
  const runs = String(s).match(/[\u4e00-\u9fff]+/g) || []
  if (!runs.length) return false
  return runs.every(r => {
    for (const u of USER_STRINGS) if (u.indexOf(r) >= 0) return true
    return false
  })
}

function record(page, field, zh, en) {
  const cn = /[\u4e00-\u9fff]/
  const z = typeof zh === 'string' ? zh : ''
  const e = typeof en === 'string' ? en : ''
  if (!z && !e) return
  if (isUserData(field)) {
    if (cn.test(z) || cn.test(e)) userData.push({ page, field, zh: z, en: e })
    return
  }
  if (e && cn.test(e) && fromUserInput(e)) return
  let kind = 'OK'
  if (e && cn.test(e) && !BRAND.ok(e)) kind = 'MIXED'
  else if (!e && z && cn.test(z)) kind = 'MISS'
  else if (z === e && cn.test(z) && z.length > 1 && !BRAND.ok(z)) kind = 'STALE'
  if (kind !== 'OK') {
    findings.push({ page, field, zh: z, en: e, kind })
    fail++
  }
}

/**
 * 允许在英文界面出现汉字的白名单：品牌名、作者公众号。
 * 应用叫「灵感随时记」，英文版里出现这个名字是正确的，不是漏译。
 */
const BRAND = {
  list: ['灵感随时记', '不卷的迭代老爸'],
  ok(s) {
    return this.list.some(b => s.indexOf(b) >= 0)
  }
}

/* ============================ 冻结时钟与随机 ============================ */
/**
 * 重温页是从旧记录里随机抽一条，详情页会显示"3 天前"这类相对时间。
 * 不冻结的话，中英两轮抽到的不是同一条，diff 出来的全是噪声。
 */
const FIXED_NOW = 1763000000000
const REAL_NOW = Date.now
const REAL_RANDOM = Math.random
Date.now = () => FIXED_NOW
function seedRandom() {
  let s = 42
  Math.random = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/* ============================ 假微信 ============================ */
let STORE = {}
let SYS_LANG = 'zh_CN'
let captured = [] // 命令式文案

function capture(kind, payload) {
  captured.push({ kind, payload })
}

function makeWx() {
  const impl = {
    env: { USER_DATA_PATH: '/udp' },
    getAppBaseInfo: () => ({ language: SYS_LANG }),
    getDeviceInfo: () => ({ platform: 'devtools' }),
    getWindowInfo: () => ({ pixelRatio: 2, windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ language: SYS_LANG, platform: 'devtools', pixelRatio: 2, windowWidth: 375 }),

    getStorageSync: k => (STORE[k] === undefined ? '' : STORE[k]),
    setStorageSync: (k, v) => {
      STORE[k] = v
    },
    removeStorageSync: k => {
      delete STORE[k]
    },
    getStorageInfoSync: () => ({
      keys: Object.keys(STORE),
      currentSize: 12,
      limitSize: 10240
    }),

    setNavigationBarTitle: o => capture('nav', o && o.title),
    showToast: o => capture('toast', o && o.title),
    showModal: o => capture('modal', o),
    showActionSheet: o => capture('sheet', o),
    showLoading: () => {},
    hideLoading: () => {},
    vibrateShort: () => {},
    stopPullDownRefresh: () => {},
    pageScrollTo: () => {},
    setClipboardData: o => capture('clip', o && o.data),
    previewImage: () => {},
    navigateTo: () => {},
    navigateBack: () => {},
    reLaunch: () => {},
    openSetting: () => {},
    getSetting: o => o && o.success && o.success({ authSetting: {} }),
    authorize: o => o && o.fail && o.fail({}),
    requirePrivacyAuthorize: o => o && o.success && o.success({}),
    chooseMessageFile: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    chooseMedia: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    chooseImage: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    getImageInfo: o => o && o.fail && o.fail({ errMsg: 'fail' }),
    saveImageToPhotosAlbum: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    compressImage: o => o && o.fail && o.fail({ errMsg: 'fail' }),
    getFileSystemManager: () => ({
      accessSync: () => {},
      statSync: () => ({ size: 0 }),
      readdirSync: () => [],
      readFileSync: () => '',
      writeFileSync: () => {},
      unlinkSync: () => {},
      mkdirSync: () => {},
      copyFileSync: () => {},
      rmdirSync: () => {},
      saveFileSync: () => '',
      getFileInfo: o => o && o.fail && o.fail({}),
      removeSavedFile: o => o && o.success && o.success({})
    }),
    getRecorderManager: () => ({
      onStart() {},
      onStop() {},
      onError() {},
      onFrameRecorded() {},
      start() {},
      stop() {},
      pause() {},
      resume() {}
    }),
    createInnerAudioContext: () => ({
      obeyMuteSwitch: true,
      onEnded() {},
      onTimeUpdate() {},
      onError() {},
      onPlay() {},
      onStop() {},
      play() {},
      pause() {},
      stop() {},
      seek() {},
      destroy() {},
      src: ''
    }),
    createSelectorQuery: () => ({
      in: () => ({
        select: () => ({
          fields: () => ({
            exec: cb => cb && cb([{ node: null, width: 0, height: 0 }])
          }),
          boundingClientRect: () => ({ exec: cb => cb && cb([{}]) })
        })
      })
    }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, bottom: 80, left: 281, right: 368, width: 87, height: 32 }),
    canvasToTempFilePath: o => o && o.fail && o.fail({ errMsg: 'fail' }),
    showShareImageMenu: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    shareFileMessage: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    saveFileToDisk: o => o && o.fail && o.fail({ errMsg: 'cancel' }),
    enableAlertBeforeUnload: () => {},
    disableAlertBeforeUnload: () => {},
    startRecord: o => o && o.fail && o.fail({ errMsg: 'fail' }),
    translateVoice: o => o && o.fail && o.fail({ errMsg: 'fail' }),
    setStorage: o => o && o.success && o.success({}),
    showShareMenu: () => {}
  }
  return new Proxy(impl, {
    get(t, k) {
      if (k in t) return t[k]
      // 未实现的 API 一律给个空函数：页面的是  isFunction 判断不该因为缺 mock 而走 fallback
      return function () {}
    }
  })
}

/* ============================ 页面/组件注册 ============================ */
let lastDef = null
const pageDefs = {} // 模块只执行一次，注册结果缓存 —— 与真机一致
const compDefs = {}
let appDef = null

const APP = { globalData: { flashId: '', pendingFilter: '' } }

function install() {
  global.wx = makeWx()
  global.App = def => {
    appDef = def
  }
  global.getApp = () => APP
  global.Page = def => {
    lastDef = def
  }
  global.Component = def => {
    lastDef = def
  }
}

function loadPage(rel) {
  if (pageDefs[rel]) return pageDefs[rel]
  lastDef = null
  require(path.join(MINI, rel))
  pageDefs[rel] = lastDef
  return lastDef
}

function loadComp(rel) {
  if (compDefs[rel]) return compDefs[rel]
  lastDef = null
  require(path.join(MINI, rel))
  compDefs[rel] = lastDef
  return lastDef
}

/** 深拷贝 + 实例化。setData 支持 'a.b' 路径（页面里大量使用） */
function instantiate(def) {
  const inst = Object.create(null)
  Object.keys(def).forEach(k => {
    if (k === 'data') return
    inst[k] = def[k]
  })
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (patch, cb) {
    if (patch && typeof patch === 'object') {
      Object.keys(patch).forEach(key => {
        if (key.indexOf('.') < 0) {
          inst.data[key] = patch[key]
          return
        }
        // 'sheet.visible' 这类路径
        const segs = key.split('.')
        let cur = inst.data
        for (let i = 0; i < segs.length - 1; i++) {
          if (cur[segs[i]] === undefined || cur[segs[i]] === null) cur[segs[i]] = {}
          cur = cur[segs[i]]
        }
        cur[segs[segs.length - 1]] = patch[key]
      })
    }
    if (typeof cb === 'function') cb()
  }
  inst.triggerEvent = () => {}
  inst.selectComponent = () => null
  inst.createSelectorQuery = () => global.wx.createSelectorQuery()
  return inst
}

/* ============================ 数据预置 ============================ */
const DAY = 86400000

/** 造一批记录：覆盖文字/语音/照片、星标、归档、标签、不同日期、回收站 */
function seed() {
  const store = require(path.join(MINI, 'utils', 'store.js'))
  const now = Date.now()
  const rows = [
    { type: 'text', content: '明天要把那份年报的现金流底稿再过一遍 #工作 #财务', createdAt: now - 1 * DAY },
    { type: 'text', content: '想到一个标题：把灵感攒成一条线 #写作', createdAt: now - 2 * DAY },
    { type: 'voice', content: '路上想到的：预算会和实际差在哪', duration: 12, createdAt: now - 3 * DAY },
    { type: 'photo', content: '白板上的流程图', mediaPaths: ['/udp/img_a.jpg'], createdAt: now - 4 * DAY },
    { type: 'text', content: '记一下这个月的复盘角度 #复盘', createdAt: now - 9 * DAY },
    { type: 'text', content: '客户提的那个点，值得单独做一页', createdAt: now - 20 * DAY },
    { type: 'text', content: '读到一句话：慢就是快', createdAt: now - 40 * DAY }
  ]
  rows.forEach(r => {
    const rec = store.create(r)
    if (!rec) return
    // create 用 Date.now()，这里把 createdAt 改回过去，好让分组/相对时间/提醒都出现
    Object.keys(STORE).forEach(k => {
      if (k.indexOf('lg.r.v1.') !== 0) return
      const list = STORE[k]
      if (!Array.isArray(list)) return
      let dirty = false
      list.forEach(x => {
        if (x && x.id === rec.id) {
          x.createdAt = r.createdAt
          dirty = true
        }
      })
      if (dirty) STORE[k] = list
    })
  })
  const all = store.allRaw()
  if (all[0]) store.setStar(all[0].id, 1)
  if (all[1]) store.setArchive(all[1].id, 1)
  return all.map(r => r.id)
}

/* ============================ 跑一轮 ============================ */
const PAGES = [
  { rel: 'pages/index/index.js', name: '首页', opts: {} },
  { rel: 'pages/record/record.js', name: '记录页', opts: { mode: 'create' } },
  { rel: 'pages/record/record.js', name: '记录页(编辑)', opts: { mode: 'edit', id: '' } },
  { rel: 'pages/detail/detail.js', name: '详情页', opts: { id: '' } },
  { rel: 'pages/search/search.js', name: '搜索页', opts: {} },
  { rel: 'pages/review/review.js', name: '重温页', opts: {} },
  { rel: 'pages/poster/poster.js', name: '做成图', opts: { id: '' } },
  { rel: 'pages/me/me.js', name: '我的页', opts: {} }
]

/** 跑一个页面，返回 { data: {...}, caps: [...] } */
function runPage(p, ids) {
  const opts = Object.assign({}, p.opts)
  if (opts.id === '') opts.id = ids[0] || 'none'
  const capStart = captured.length
  let inst
  try {
    const def = loadPage(p.rel)
    if (!def) return { err: 'not registered' }
    inst = instantiate(def)
    if (typeof inst.onLoad === 'function') inst.onLoad(opts)
    if (typeof inst.onShow === 'function') inst.onShow()
    if (typeof inst.onReady === 'function') inst.onReady()
  } catch (e) {
    return { err: (e && e.message) || String(e) }
  }
  // 交互态：这些文案只在点了之后才出现，光跑生命周期看不到
  const evs = INTERACT[p.name] || []
  evs.forEach(([fn, arg]) => {
    if (typeof inst[fn] !== 'function') return
    try {
      inst[fn](arg || {})
    } catch (e) {
      /* 单条交互失败不影响其余采集 */
    }
  })
  if (inst && inst.data) harvest(inst.data)
  return { data: inst && inst.data, caps: captured.slice(capStart), inst }
}

/**
 * 每条 = [方法名, 假事件]。
 * 只用不依赖真实文件系统、不改语言的那几个：
 * onLang 的 success 回调没被触发（假 wx 不回调），所以不会真的切语言。
 */
const INTERACT = {
  首页: [['onFilter', { currentTarget: { dataset: { f: 'star' } } }], ['onBackupClose'], ['onNudge']],
  详情页: [['onDelete'], ['onAddText'], ['onToggleStar'], ['onToggleArchive']],
  我的页: [['onStorage'], ['onClear'], ['onAbout'], ['onLang'], ['onImport']],
  记录页: [
    ['onInput', { detail: { value: '测试一条' } }],
    ['onTab', { currentTarget: { dataset: { type: 'voice' } } }],
    ['onTab', { currentTarget: { dataset: { type: 'photo' } } }],
    ['onCancel']
  ],
  重温页: [['onNext'], ['onStar'], ['onOpen']],
  搜索页: [['run', '复盘'], ['onClear']]
}

/** 把 data 摊平成 { 'a.b': '字符串值' }，只留字符串 */
function flat(data, prefix, out) {
  const o = out || {}
  const p = prefix || ''
  if (!data || typeof data !== 'object') return o
  Object.keys(data).forEach(k => {
    const v = data[k]
    const key = p ? p + '.' + k : k
    if (typeof v === 'string') o[key] = v
    else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (typeof x === 'string') o[key + '[' + i + ']'] = x
        else if (x && typeof x === 'object') flat(x, key + '[' + i + ']', o)
      })
    } else if (v && typeof v === 'object') flat(v, key, o)
  })
  return o
}

/** 清掉所有业务模块缓存（模拟冷启动） */
function clearCache() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(MINI) === 0) delete require.cache[k]
  })
  Object.keys(pageDefs).forEach(k => delete pageDefs[k])
  Object.keys(compDefs).forEach(k => delete compDefs[k])
  appDef = null
  lastDef = null
}

function boot(langCode, savedLang) {
  clearCache()
  STORE = {}
  captured = []
  SYS_LANG = langCode
  seedRandom()
  install()
  if (savedLang) STORE['lg.lang.v1'] = savedLang
  require(path.join(MINI, 'app.js'))
  return seed()
}

/* ============================ 主流程 ============================ */
function scan(label, langCode, savedLang, hotFrom) {
  // 对话框中枢是模块级单例，上一轮 bind 的实例不解绑会一直挡在最上层
  const hub = require(path.join(MINI, 'utils', 'dialog.js'))
  while (hub.top()) hub.unbind(hub.top())

  let ids
  if (hotFrom) {
    // 热切换：只重建实例，模块与页面定义全部复用（这正是 reLaunch 的行为）
    const i18n = require(path.join(MINI, 'utils', 'i18n.js'))
    i18n.setLang(savedLang)
    // 数据要回到与上一轮相同的起点，否则 diff 出来的差异来自"筛选态不同"而不是语言
    const store = require(path.join(MINI, 'utils', 'store.js'))
    store.clearAll()
    STORE = {}
    if (savedLang) STORE['lg.lang.v1'] = savedLang
    captured = []
    USER_STRINGS.clear()
    ids = seed()
  } else {
    USER_STRINGS.clear()
    ids = boot(langCode, savedLang)
  }
  const rows = {}
  PAGES.forEach(p => {
    const r = runPage(p, ids)
    const tag = p.name + (p.opts.mode === 'edit' ? '' : '')
    rows[tag] = r
  })
  // 组件：只跑有文案的那两个
  ;[
    { rel: 'components/dialog/dialog.js', name: '组件·对话框' },
    { rel: 'components/action-sheet/action-sheet.js', name: '组件·操作面板' }
  ].forEach(c => {
    try {
      const def = loadComp(c.rel)
      const inst = instantiate(def)
      if (def.lifetimes && def.lifetimes.attached) def.lifetimes.attached.call(inst)
      if (def.methods && def.methods.open) def.methods.open.call(inst, { title: 'T', text: 'X' })
      if (inst.data) harvest(inst.data)
      rows[c.name] = { data: inst.data, caps: [] }
    } catch (e) {
      rows[c.name] = { err: (e && e.message) || String(e) }
    }
  })
  return { label, rows, ids }
}

console.log('双语一致性审计\n' + '='.repeat(72))

/* ---- 1. 冷启动中文 vs 冷启动英文 ---- */
const zh = scan('中文', 'zh_CN', 'zh', null)
const idsAfterZh = zh.ids

/* ---- 2. 热切换：中文会话里切到英文（复现 reLaunch）---- */
const hotEn = scan('热切en', 'zh_CN', 'en', idsAfterZh)

/* ---- 3. 冷启动英文（对照）---- */
const coldEn = scan('冷启 en', 'en_US', 'en', null)

/* ============================ 输出 ============================ */
const brands = BRAND.list.join(' / ')

function section(title, note) {
  console.log('\n### ' + title)
  if (note) console.log(note)
  console.log('')
}

/** 采集量诊断：0 处不一致如果是"什么都没采到"，那结论就是假的 */
function coverage(run) {
  const names = Object.keys(run.rows)
  let fields = 0
  let caps = 0
  const bad = []
  names.forEach(n => {
    const r = run.rows[n]
    if (r.err) {
      bad.push(n + ' → ' + r.err)
      return
    }
    fields += Object.keys(flat(r.data)).length
    caps += (r.caps || []).length
  })
  return { fields, caps, bad, pages: names.length }
}

function reportCoverage(run) {
  const c = coverage(run)
  console.log(
    '  [' +
      run.label +
      '] 页面 ' +
      c.pages +
      ' 个 · 采集字符串字段 ' +
      c.fields +
      ' 个 · 命令式文案 ' +
      c.caps +
      ' 条' +
      (c.bad.length ? ' · 运行失败 ' + c.bad.length + ' 个: ' + c.bad.join('; ') : '')
  )
  return c
}

function diffPair(a, b, labelA, labelB) {
  const names = Object.keys(a.rows)
  names.forEach(name => {
    const ra = a.rows[name]
    const rb = b.rows[name]
    if (ra.err || rb.err) {
      findings.push({ page: name, field: '(运行失败)', zh: ra.err || '', en: rb.err || '', kind: 'MISS' })
      fail++
      return
    }
    const fa = flat(ra.data)
    const fb = flat(rb.data)
    const keys = Object.keys(fa)
    Object.keys(fb).forEach(k => {
      if (!(k in fa)) keys.push(k)
    })
    keys.forEach(k => {
      if (k === 't' || k.indexOf('t.') === 0) return // 整包文案由别处逐键检查
      record(name, k, fa[k], fb[k])
    })
    // 命令式文案
    const ca = ra.caps || []
    const cb = rb.caps || []
    const n = Math.max(ca.length, cb.length)
    for (let i = 0; i < n; i++) {
      const x = ca[i] || {}
      const y = cb[i] || {}
      const pick = o =>
        typeof o.payload === 'string'
          ? o.payload
          : o.payload
            ? [o.payload.title, o.payload.text, o.payload.cancelText, o.payload.confirmText]
                .filter(v => typeof v === 'string')
                .join(' | ')
            : ''
      record(name, '[' + (y.kind || x.kind) + ']', pick(x), pick(y))
    }
  })
}

section('一、中文会话 → 切英文（真实路径：wx.reLaunch 不重跑模块）', '与冷启动中文比对，英文字段里出现汉字的即为混排')
reportCoverage(zh)
reportCoverage(hotEn)
diffPair(zh, hotEn)

section('二、冷启动英文（对照）', '如果这里干净、第一组不干净，说明问题出在"模块只执行一次"')
reportCoverage(coldEn)
diffPair(zh, coldEn)

/* ---- 4. 英文模式下 t 包逐键检查 ---- */
{
  const i18n = require(path.join(MINI, 'utils', 'i18n.js'))
  i18n.setLang('en')
  const packs = ['common', 'date', 'nudge', 'backup', 'me', 'index', 'record', 'detail', 'review', 'search', 'poster', 'transfer', 'store', 'dialog', 'media', 'share', 'card', 'nav']
  packs.forEach(p => {
    const pk = i18n.pack(p)
    Object.keys(pk).forEach(k => {
      const v = pk[k]
      if (typeof v === 'string' && /[\u4e00-\u9fff]/.test(v) && !BRAND.ok(v)) {
        findings.push({ page: '文案包·' + p, field: k, zh: i18n.t(p + ':' + k), en: v, kind: 'MIXED' })
        fail++
      }
    })
  })
  i18n.setLang('zh')
}

/* ============================ 四、结构守卫 ============================ */
/**
 * 前面三组是"跑一遍看结果"，这一组是"看形状就知道有没有问题"：
 *   a) 同处并列双语——一个值里同时有中文和英文单词
 *   b) 中英同形——两种语言下是同一个值，切了等于没切
 *   c) 导航标题覆盖——有没有页面从来没设过标题，只能吃 json 里的死中文
 * 这三类不需要触发场景，静态就能判，适合当长期守卫。
 */
section('三、结构守卫', '不依赖某次渲染，靠静态特征判定')

const fs = require('fs')
const CN = /[\u4e00-\u9fff]/
const LATIN = /[A-Za-z]{3,}/
/** 技术词与文件后缀是通用写法，不算混排 */
const TECH = /\.?(json|md|txt|csv|pdf|word|mb|kb|gb|id)\b/gi

function stripTech(s) {
  let v = String(s)
    .replace(/\{[^}]*\}/g, '') // 占位符名不是词
    .replace(TECH, '')
  // 产品名是品牌，不是"没翻译"：先把它摘掉，剩下的才谈得上并列
  BRAND.list.forEach(b => {
    v = v.split(b).join('')
  })
  return v
}

{
  const i18nMod = require(path.join(MINI, 'utils', 'i18n.js'))
  const packs = {}
  ;['zh', 'en'].forEach(l => {
    i18nMod.setLang(l)
    packs[l] = i18nMod.pack('')
  })
  i18nMod.setLang('zh')
  const zhPack = packs.zh
  const packOf = (pk, k) => (pk[k] === undefined ? '' : pk[k])

  // a) 同处并列双语
  const para = []
  ;['zh', 'en'].forEach(l => {
    Object.keys(packs[l]).forEach(k => {
      const v = stripTech(packs[l][k])
      if (CN.test(v) && LATIN.test(v)) para.push(l + ' ' + k + ' = ' + JSON.stringify(packs[l][k]))
    })
  })
  if (para.length) {
    para.forEach(x => {
      const k = x.split(' ')[1]
      findings.push({
        page: '结构守卫',
        field: k,
        zh: packOf(zhPack, k),
        en: packOf(packs.en, k),
        kind: 'PARALLEL'
      })
      fail++
    })
    console.log('  ✗ 同一处并列中英（' + para.length + ' 处）')
    para.forEach(x => console.log('      ' + x))
  } else {
    console.log('  ✓ 没有任何一个值同时含中文与英文单词')
  }

  // b) 中英同形
  const same = Object.keys(packs.zh).filter(k => packs.zh[k] === packs.en[k] && CN.test(packs.zh[k]))
  const sameBrand = same.filter(k => BRAND.ok(packs.zh[k]))
  const sameBad = same.filter(k => !BRAND.ok(packs.zh[k]))
  if (sameBad.length) {
    sameBad.forEach(k => {
      findings.push({ page: '结构守卫', field: k, zh: packs.zh[k], en: packs.en[k], kind: 'SAME' })
      fail++
    })
    console.log('  ✗ 中英同形且含汉字（切换后不变化，' + sameBad.length + ' 处）')
    sameBad.forEach(k => console.log('      ' + k + ' = ' + JSON.stringify(packs.zh[k])))
  } else {
    console.log('  ✓ 除品牌名外，没有"两种语言取到同一个值"的键')
  }
  if (sameBrand.length) {
    console.log('  · 品牌名同形（合理）：' + sameBrand.join(', '))
  }

  // c) 导航标题覆盖
  const pagesDir = path.join(MINI, 'pages')
  const noTitle = fs.readdirSync(pagesDir).filter(d => {
    const f = path.join(pagesDir, d, d + '.js')
    if (!fs.existsSync(f)) return false
    return !/i18n\.title\(/.test(fs.readFileSync(f, 'utf8'))
  })
  if (noTitle.length) {
    console.log(
      '  · 从未 override 导航标题的页面：' +
        noTitle.join(', ') +
        '（用的是 pages/xx/xx.json 里写死的中文，英文界面下与其他页的英文标题并存）'
    )
  } else {
    console.log('  ✓ 每个页面都会按当前语言重设导航标题')
  }

  // d) 模块级取词：这是"切了语言没反应"的根因，必须零容忍
  //    模块只执行一次，wx.reLaunch 不重跑它，所以顶层求值的 i18n.t 会永远停在启动语言
  const offenders = []
  function walk(dir) {
    fs.readdirSync(dir).forEach(name => {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) return walk(full)
      if (!/\.js$/.test(name)) return
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
      lines.forEach((ln, i) => {
        // 只认真正顶格的声明；缩进的是函数体，每次调用都重取，没问题
        if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*i18n\.(t|pack)\(/.test(ln)) {
          offenders.push(path.relative(MINI, full) + ':' + (i + 1) + '  ' + ln.trim())
        }
      })
    })
  }
  walk(MINI)
  if (offenders.length) {
    offenders.forEach(o => {
      const [loc, ...rest] = o.split('  ')
      findings.push({ page: '模块级取词', field: loc, zh: rest.join('  '), en: '', kind: 'STALE' })
      fail++
    })
    console.log('  ✗ 模块级 i18n.t/pack（切语言后不会更新，' + offenders.length + ' 处）')
    offenders.forEach(o => console.log('      ' + o))
  } else {
    console.log('  ✓ 没有任何模块级 i18n.t / i18n.pack（文案都在渲染那一刻取）')
  }
}

/* ---- 调试开关：LANG_AUDIT_DUMP=1 时打印英文模式下所有含汉字的值 ---- */
if (process.env.LANG_AUDIT_DUMP === '1') {
  console.log('\n### 英文模式全量含汉字字段（含用户内容）\n')
  Object.keys(coldEn.rows).forEach(name => {
    const r = coldEn.rows[name]
    if (r.err) return
    const f = flat(r.data)
    Object.keys(f).forEach(k => {
      if (/[\u4e00-\u9fff]/.test(f[k])) {
        console.log('  ' + name + '  ' + k + '  = ' + JSON.stringify(f[k]).slice(0, 90))
      }
    })
    ;(r.caps || []).forEach(c => {
      const t = typeof c.payload === 'string' ? c.payload : JSON.stringify(c.payload)
      if (t && /[\u4e00-\u9fff]/.test(t)) console.log('  ' + name + '  [' + c.kind + ']  = ' + t.slice(0, 120))
    })
  })
}

section('四、问题清单', '按严重程度：MIXED（英文里有中文）> STALE（没换语言）> MISS（英文缺失）')

const order = { PARALLEL: -1, MIXED: 0, STALE: 1, SAME: 2, MISS: 3 }
findings.sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9))

if (!findings.length) {
  console.log('  未发现混排。')
} else {
  const pad = (s, n) => {
    let w = 0
    let out = ''
    for (const ch of String(s)) {
      w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
      out += ch
      if (w >= n) break
    }
    return out + ' '.repeat(Math.max(0, n - w))
  }
  console.log('  ' + pad('级别', 7) + pad('位置', 18) + pad('字段', 26) + '中文 / 英文')
  console.log('  ' + '-'.repeat(96))
  findings.forEach(f => {
    console.log(
      '  ' +
        pad(f.kind, 7) +
        pad(f.page, 18) +
        pad(f.field, 26) +
        (f.zh || '∅') +
        '  ⟶  ' +
        (f.en || '∅')
    )
  })
}

/* ---- 品牌名保留项：不是漏译，但需要知情 ---- */
{
  const i18nMod = require(path.join(MINI, 'utils', 'i18n.js'))
  i18nMod.setLang('en')
  const en = i18nMod.pack('')
  i18nMod.setLang('zh')
  const brandKeys = Object.keys(en).filter(
    k => /[\u4e00-\u9fa5]/.test(String(en[k])) && BRAND.ok(en[k])
  )
  console.log('\n### 五、品牌名保留项（英文界面里出现中文产品名，需决策而非修 bug）')
  if (!brandKeys.length) console.log('  无')
  brandKeys.forEach(k => console.log('  · ' + k + ' = ' + JSON.stringify(en[k])))
}

console.log('\n' + '='.repeat(72))
console.log('共 ' + findings.length + ' 处不一致' + (fail ? '' : '（通过）'))
console.log('品牌名白名单：' + brands)
process.exit(findings.length ? 1 : 0)
