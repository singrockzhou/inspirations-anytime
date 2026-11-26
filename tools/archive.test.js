/**
 * 整组归档（批量 setArchiveMany + 撤销分流）
 * 用法：node tools/archive.test.js
 *
 * 这条路的错法全是静默的：
 *   · 批量归档只改了一半（读一次写一次，中途没对齐）
 *   · 已经归档的重复计入，撤销条上虚报条数
 *   · 归档顺带刷新了 updatedAt，卡片凭空多出「改过」标记
 *   · 在归档视图里点「归档整组」不做反转，等于点了个寂寞
 * 所以测试重点不在「能归档」，而在上面这四件事。
 */
const path = require('path')
const fs = require('fs')
const B = path.resolve(__dirname, '..', 'miniprogram')
const read = rel => fs.readFileSync(path.join(B, rel), 'utf8')

const realError = console.error
console.error = function () {
  if (typeof arguments[0] === 'string' && arguments[0].indexOf('[store]') === 0) return
  realError.apply(console, arguments)
}

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
let STORE = {}
let MODALS = []

const clone = v => JSON.parse(JSON.stringify(v))

const FS = {
  readFileSync() {
    return ''
  },
  statSync() {
    return { size: 0 }
  },
  writeFileSync() {},
  unlink(o) {
    if (o && o.success) o.success({})
  },
  saveFile(o) {
    if (o && o.success) o.success({ savedFilePath: o.filePath || '/udata/x' })
  },
  accessSync() {},
  mkdirSync() {},
  readdirSync() {
    return []
  },
  copyFileSync() {}
}

global.wx = {
  env: { USER_DATA_PATH: '/udata' },
  getStorageSync(k) {
    return STORE[k] === undefined ? '' : clone(STORE[k])
  },
  setStorageSync(k, v) {
    STORE[k] = clone(v)
  },
  removeStorageSync(k) {
    delete STORE[k]
  },
  getStorageInfoSync() {
    return { currentSize: 0, limitSize: 10240 }
  },
  showModal(o) {
    MODALS.push({ title: o.title, content: o.content })
  },
  showToast() {},
  getFileSystemManager() {
    return FS
  }
}

/** 清模块缓存，拿一份干净的 store（带内存 cache 与分片快照） */
function fresh() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(B, 'utils')) === 0) delete require.cache[k]
  })
  return require(path.join(B, 'utils', 'store.js'))
}

/** 把时钟钉住：用来分辨「归档有没有偷偷刷新 updatedAt」 */
const realNow = Date.now
let NOW = 1700000000000
Date.now = () => NOW

let store = fresh()

function reset() {
  STORE = {}
  MODALS = []
  NOW = 1700000000000
  store = fresh()
}

function make(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(store.create({ type: 'text', content: '第 ' + (i + 1) + ' 条' }))
  return out
}

const ids = list => list.map(r => r.id)
const byId = (list, id) => list.filter(r => r.id === id)[0]

console.log('\n【批量归档：一次改一批，且只改该改的】')
reset()
{
  const recs = make(3)
  const before = store.allRaw()
  const done = store.setArchiveMany(ids(recs), true)
  ok('三条全部归档，返回的正是这三条', done.length === 3 && ids(recs).every(id => done.indexOf(id) >= 0), done)

  const after = store.list()
  ok('归档后主列表里一条都不剩', after.length === 0, after.length)

  const arch = store.query({ only: 'archive' })
  ok('归档视图里三条都在', arch.length === 3, arch.length)

  ok(
    '每条 archivedAt 都落到了同一个时间点',
    arch.every(r => r.archivedAt === NOW),
    arch.map(r => r.archivedAt)
  )

  ok(
    '正文 / 创建时间都没被动过',
    ids(recs).every(id => {
      const a = byId(before, id)
      const b = byId(arch, id)
      return b.content === a.content && b.createdAt === a.createdAt && b.type === a.type
    })
  )
}

console.log('\n【重复归档不虚报：撤销条上的数字要等于真正改动的条数】')
reset()
{
  const recs = make(2)
  store.setArchiveMany(ids(recs), true)
  const again = store.setArchiveMany(ids(recs), true)
  ok('同一批再归档一次，返回空数组', again.length === 0, again)
  ok('主列表仍然为空，没有被反向解开', store.list().length === 0)
}

console.log('\n【混合批次：只动方向不对的那几条】')
reset()
{
  const recs = make(3)
  store.setArchiveMany([recs[0].id], true)
  const done = store.setArchiveMany(ids(recs), true)
  ok('三条里只有两条需要改，返回 2', done.length === 2, done)
  ok('三条现在都在归档里', store.query({ only: 'archive' }).length === 3)
}

console.log('\n【取消归档：回主列表，不是复制一份】')
reset()
{
  const recs = make(3)
  store.setArchiveMany(ids(recs), true)
  const back = store.setArchiveMany(ids(recs), false)
  ok('三条全部取回，返回 3', back.length === 3, back)
  ok('主列表恢复三条', store.list().length === 3, store.list().length)
  ok('归档视图清空', store.query({ only: 'archive' }).length === 0)
  ok(
    'archivedAt 归零（不是留一个旧时间戳）',
    store.allRaw().every(r => r.archivedAt === 0),
    store.allRaw().map(r => r.archivedAt)
  )

  const noop = store.setArchiveMany(ids(recs), false)
  ok('对没归档的取消归档，返回空数组', noop.length === 0, noop)
}

console.log('\n【不碰 updatedAt：归档不是编辑】')
reset()
{
  const recs = make(2)
  const created = store.allRaw()
  NOW = NOW + 3600 * 1000 // 一小时后再归档
  store.setArchiveMany(ids(recs), true)

  const after = store.allRaw()
  ok(
    '归档后 updatedAt 仍等于创建时的值',
    ids(recs).every(id => byId(after, id).updatedAt === byId(created, id).updatedAt),
    ids(recs).map(id => ({ before: byId(created, id).updatedAt, after: byId(after, id).updatedAt }))
  )
  ok(
    '所以「改过没有」的判据 updatedAt - createdAt > 60s 不会被归档触发',
    ids(recs).every(id => byId(after, id).updatedAt - byId(after, id).createdAt <= 60000)
  )

  // 单条那条路也一样（原来走 update，会刷新 updatedAt）
  NOW = NOW + 3600 * 1000
  store.setArchive(recs[0].id, false)
  const afterOne = store.allRaw()
  ok(
    '单条 setArchive 同样不刷新 updatedAt',
    byId(afterOne, recs[0].id).updatedAt === byId(created, recs[0].id).updatedAt,
    byId(afterOne, recs[0].id).updatedAt
  )
}

console.log('\n【不该动的记录：软删的、不存在的、空输入】')
reset()
{
  const recs = make(3)
  store.remove(recs[0].id)
  const done = store.setArchiveMany(ids(recs), true)
  ok('软删的那条不计入，只归档剩下两条', done.length === 2, done)
  ok('软删的那条 archivedAt 仍是 0', byId(store.allRaw(), recs[0].id).archivedAt === 0)

  const ghost = store.setArchiveMany(['no-such-id'], true)
  ok('不存在的 id 不报错、返回空数组', ghost.length === 0, ghost)

  ok('空数组返回空数组', store.setArchiveMany([], true).length === 0)
  ok('undefined 也当空处理', store.setArchiveMany(undefined, true).length === 0)
}

console.log('\n【计数：归档会让「全部」减、「归档」增】')
reset()
{
  const recs = make(4)
  store.setArchiveMany(ids(recs).slice(0, 3), true)
  const stats = store.stats()
  ok('可见条数 = 1', stats.visible === 1, stats.visible)
  ok('归档条数 = 3', stats.archived === 3, stats.archived)
}

console.log('\n【页面侧：整组按钮与撤销分流】')
{
  const js = read('pages/index/index.js')
  const wxml = read('pages/index/index.wxml')

  ok('分组头接了 onArchiveGroup', /catchtap="onArchiveGroup"/.test(wxml))
  ok(
    '归档视图里按钮文案反转成「取消归档」',
    /filter === 'archive' \? t\.group_unarchive : t\.group_archive/.test(wxml)
  )
  ok('归档视图里传的是 unarchive，撤销才能反向', /inArchive \? 'unarchive' : 'archive'/.test(js))
  ok('撤销时归档走 setArchiveMany(ids, false)', /act\.kind === 'archive'.*setArchiveMany\(ids, false\)/s.test(js))
  ok('撤销时取消归档走 setArchiveMany(ids, true)', /act\.kind === 'unarchive'.*setArchiveMany\(ids, true\)/s.test(js))
  ok('删除的撤销路径没被改坏（仍走 restoreMany）', /store\.restoreMany\(ids\)/.test(js))
  ok('整组归档不弹确认框（只有删除才 confirm）', !/onArchiveGroup[\s\S]{0,600}dialog\s*\n?\s*\.confirm/.test(js))
}

console.log('\n【文案：中英成对，占位符都在】')
{
  const i18nRaw = read('utils/i18n.js')
  const keys = ['group_archive', 'group_unarchive', 'undo_group_archived', 'undo_group_unarchived']
  keys.forEach(k => {
    const hits = i18nRaw.split("'index:" + k + "'").length - 1
    ok("'index:" + k + "' 中英各一条", hits === 2, hits)
  })
  ok('撤销文案带 {name}', /'index:undo_group_archived': '[^']*\{name\}/.test(i18nRaw))
  ok('撤销文案带 {n}', /'index:undo_group_archived': '[^']*\{n\}/.test(i18nRaw))
  ok('英文撤销文案同样带 {name} 与 {n}', /'index:undo_group_archived': 'Archived \{n\} from "\{name\}"'/.test(i18nRaw))
}

Date.now = realNow

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
