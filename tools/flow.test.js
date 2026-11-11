/**
 * 数据流端到端（mock 掉 wx，跑真实 store / transfer 代码）
 * 用法：node tools/flow.test.js
 *
 * 为什么要有这一层：其它测试测的是"某个函数算得对"，而发布前的风险集中在
 * 跨函数的整条链上——记一条 → 改它 → 归档 → 备份 → 换机导入 → 删掉 → 撤销。
 * 这条链只在真机上走得到，但它的每一步都只是数据变换，可以用内存里的假微信
 * 完整跑一遍。这里就是那套假环境：假 Storage、假文件系统、假弹窗、假分享。
 *
 * 重点盯三类容易静默出错的地方：
 *   1. 归档：默认列表看不见，但备份、counts、导入都必须还认它；
 *   2. 写盘失败 / 到上限：不能让用户以为存下了；
 *   3. 取消：导出被取消时不能记成"已备份"。
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
let STORE = {}
let FILES = new Map()
let MODALS = []
let FAIL_WRITE = false
let SHARE = 'success'      // success | cancel | fail
let CHOOSE = ''            // chooseMessageFile 返回的临时路径，空 = 用户取消

// 假时钟：每次取时间 +1ms。真人不可能在同一毫秒记两条，但测试会；
// 固定住它，排序类断言才不会被“同一毫秒”搅成随机失败。
let CLOCK = 1700000000000
Date.now = () => (CLOCK += 1)

const clone = v => JSON.parse(JSON.stringify(v))

const FS = {
  readFileSync(p, enc) {
    if (!FILES.has(p)) throw new Error('no such file: ' + p)
    const f = FILES.get(p)
    if (enc === 'base64') return Buffer.from(f.raw || 'x').toString('base64')
    return f.raw || ''
  },
  statSync(p) {
    if (!FILES.has(p)) return { size: 0 }
    return { size: FILES.get(p).size }
  },
  writeFileSync(p, data) {
    FILES.set(p, { size: String(data).length, raw: String(data) })
  },
  unlink(o) {
    FILES.delete(o.filePath)
    if (o.success) o.success({})
  },
  saveFile(o) {
    FILES.set(o.filePath, { size: 100, raw: 'x' })
    if (o.success) o.success({ savedFilePath: o.filePath })
  },
  accessSync(p) {
    if (!FILES.has(p)) throw new Error('not exist')
  },
  mkdirSync() {},
  readdirSync() {
    return Array.from(FILES.keys()).map(k => k.split('/').pop())
  },
  copyFileSync() {}
}

global.wx = {
  env: { USER_DATA_PATH: '/udata' },
  getStorageSync(k) {
    return STORE[k] === undefined ? '' : clone(STORE[k])
  },
  setStorageSync(k, v) {
    if (FAIL_WRITE) throw new Error('exceed storage max size')
    STORE[k] = clone(v)
  },
  removeStorageSync(k) {
    delete STORE[k]
  },
  showModal(o) {
    MODALS.push({ title: o.title, content: o.content })
  },
  showToast() {},
  chooseMessageFile(o) {
    if (!CHOOSE) return o.fail && o.fail({ errMsg: 'chooseMessageFile:fail cancel' })
    if (o.success) o.success({ tempFiles: [{ path: CHOOSE, name: 'backup.json', size: 100 }] })
  },
  getFileSystemManager() {
    return FS
  },
  shareFileMessage(o) {
    if (SHARE === 'cancel') return o.fail && o.fail({ errMsg: 'shareFileMessage:fail cancel' })
    if (SHARE === 'fail') return o.fail && o.fail({ errMsg: 'shareFileMessage:fail unknown' })
    if (o.success) o.success({})
  }
}

/** 清模块缓存，拿一份干净的 store / transfer（store 里有内存 cache） */
function fresh() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(B, 'utils')) === 0) delete require.cache[k]
  })
  return {
    store: require(path.join(B, 'utils', 'store.js')),
    transfer: require(path.join(B, 'utils', 'transfer.js')),
    backup: require(path.join(B, 'utils', 'backup.js'))
  }
}

function reset() {
  STORE = {}
  FILES = new Map()
  MODALS = []
  FAIL_WRITE = false
  SHARE = 'success'
  CHOOSE = ''
}

/* ================= 1. 记一条 ================= */
console.log('1) 记一条：三种形态都能落库，统计跟着变')
reset()
{
  const { store } = fresh()
  const a = store.create({ type: 'text', content: '  客户要的是不用他操心  ' })
  ok('文字：返回记录，正文去掉了首尾空白', a && a.content === '客户要的是不用他操心', a && a.content)
  ok('文字：createdAt / updatedAt 都有', a.createdAt > 0 && a.updatedAt === a.createdAt)

  FILES.set('/udata/aac1', { size: 2048, raw: 'voice' })
  const b = store.create({ type: 'voice', content: '', mediaPath: '/udata/aac1', duration: 24 })
  ok('语音：落了时长', b.duration === 24)

  FILES.set('/udata/p1', { size: 1024, raw: 'img' })
  const c = store.create({ type: 'photo', content: '', mediaPaths: ['/udata/p1'], mediaPath: '/udata/p1' })
  ok('照片：mediaPaths 有一张', c.mediaPaths.length === 1)

  const st = store.stats()
  ok('stats.total = 3', st.total === 3, st.total)
  ok('stats.byType 分别是 1/1/1', st.byType.text === 1 && st.byType.voice === 1 && st.byType.photo === 1, st.byType)
  ok('列表按时间倒序（最新在前）', store.list()[0].id === c.id)

  const d = store.create({ type: 'text', content: '想法 #复盘 #门店' })
  ok('#标签 进 tags', store.get(d.id).tags.length === 2, store.get(d.id).tags)
}

/* ================= 2. 编辑 / 星标 / 归档 ================= */
console.log('2) 编辑不跳序；星标、归档各归各的账')
reset()
{
  const { store } = fresh()
  const a = store.create({ type: 'text', content: '第一条' })
  const b = store.create({ type: 'text', content: '第二条' })

  store.update(a.id, { content: '第一条（改过）' })
  const after = store.get(a.id)
  ok('编辑后内容变了', after.content === '第一条（改过）')
  ok('编辑后 createdAt 不变（列表顺序不会跳）', after.createdAt === a.createdAt)
  ok('列表顺序仍是 b 在前', store.list()[0].id === b.id)

  store.setStar(a.id, true)
  ok('加星后 starred=1', store.stats().starred === 1)
  ok('只查星标只剩一条', store.query({ only: 'star' }).length === 1)
  store.setStar(a.id, false)
  ok('取消星标后 starred=0', store.stats().starred === 0)

  store.setArchive(a.id, true)
  ok('归档后默认列表看不到', store.list().every(r => r.id !== a.id))
  ok('归档后 total 仍然算它（含归档）', store.stats().total === 2, store.stats().total)
  ok('归档后 visible 不算它', store.stats().visible === 1, store.stats().visible)
  ok('includeArchived 能取到', store.list({ includeArchived: true }).some(r => r.id === a.id))
  ok('只查归档能取到', store.query({ only: 'archive' }).length === 1)
}

/* ================= 3. 删除 / 回收站 / 撤销 ================= */
console.log('3) 删除先进回收站，撤销能回来，彻底删才动文件')
reset()
{
  const { store } = fresh()
  FILES.set('/udata/v1', { size: 999, raw: 'v' })
  const v = store.create({ type: 'voice', content: '', mediaPath: '/udata/v1', duration: 9 })

  store.remove(v.id)
  ok('软删后默认列表没有', store.list().every(r => r.id !== v.id))
  ok('软删后回收站有', store.trash().length === 1)
  ok('软删后 total 不算它', store.stats().total === 0)
  ok('软删不删媒体文件（还能撤销）', FILES.has('/udata/v1'))

  const done = store.restoreMany([v.id])
  ok('撤销：回来了 1 条', done.length === 1)
  ok('撤销后列表又有', store.list().length === 1)
  ok('撤销后 trash 空', store.trash().length === 0)

  store.remove(v.id)
  ok('彻底删成功', store.destroy(v.id) === true)
  ok('彻底删会删媒体文件', !FILES.has('/udata/v1'))
  ok('彻底删后回收站空', store.trash().length === 0)
}

/* ================= 4. 写盘失败 ================= */
console.log('4) 写不进去时，不能让用户以为存下了')
reset()
{
  const { store } = fresh()
  FILES.set('/udata/x1', { size: 500, raw: 'x' })
  FAIL_WRITE = true

  const r = store.create({ type: 'voice', content: '', mediaPath: '/udata/x1', duration: 3 })
  ok('写失败返回 null', r === null)
  ok('写失败弹出"存不下了"', MODALS.some(m => /存不下/.test(m.title || '')), MODALS)
  ok('写失败把刚存的媒体文件清掉（不留孤儿）', !FILES.has('/udata/x1'))
  ok('写失败不会把残记录留在内存列表里', store.list().length === 0)
  FAIL_WRITE = false
}

/* ================= 5. 上限 ================= */
console.log('5) 条数上限：到顶就说明白，不静默丢')
reset()
{
  const { store } = fresh()
  const MAX = store.MAX_RECORDS
  for (let i = 0; i < MAX; i++) store.create({ type: 'text', content: '第 ' + i + ' 条' })
  ok('攒到上限：' + MAX + ' 条', store.stats().total === MAX, store.stats().total)

  MODALS = []
  const over = store.create({ type: 'text', content: '第 MAX+1 条' })
  ok('超限返回 null', over === null)
  ok('超限有弹窗，且说清了怎么办', MODALS.some(m => /满/.test(m.title || '') && /清/.test(m.content || '')), MODALS)
  ok('超限后总数没变', store.stats().total === MAX)
}

async function main() {
  /* ================= 6. 备份：含归档、取消不记账 ================= */
  console.log('6) 备份：带上归档，取消不算备份过')
  reset()
  {
    const { store, transfer } = fresh()
    const a = store.create({ type: 'text', content: '归档过的那条' })
    store.create({ type: 'text', content: '普通的这条' })
    store.setArchive(a.id, true)

    const res = await transfer.exportBackup()
    ok('导出条数 = 含归档的总数（2）', res.total === 2, res.total)
    ok('导出走 share', res.mode === 'share', res.mode)
    ok('导出成功后账本记了条数与时间', store.backupInfo().at > 0 && store.backupInfo().total === 2, store.backupInfo())

    reset()
    const s2 = fresh()
    s2.store.create({ type: 'text', content: 'x' })
    SHARE = 'cancel'
    const r2 = await s2.transfer.exportBackup()
    ok('取消时 mode=cancel', r2 && r2.mode === 'cancel', r2 && r2.mode)
    ok('取消不记入账本（仍为 0）', s2.store.backupInfo().at === 0, s2.store.backupInfo())
  }

  /* ================= 7. 换机往返 ================= */
  console.log('7) 换机：导出的文件能不能真的在新机器上还原')
  reset()
  {
    const { store, transfer } = fresh()
    const t1 = store.create({ type: 'text', content: '#门店 陈列要往上走' })
    store.setStar(t1.id, true)
    const arc = store.create({ type: 'text', content: '这条归档了但要能带走' })
    store.setArchive(arc.id, true)
    FILES.set('/udata/img', { size: 800, raw: 'IMG' })
    store.create({ type: 'photo', content: '', mediaPaths: ['/udata/img'], mediaPath: '/udata/img' })

    const res = await transfer.exportBackup()
    const backupFile = res.filePath
    const raw = FILES.get(backupFile).raw
    ok('备份文件写出来了', !!raw && raw.length > 100, raw && raw.length)

    // 新机器：清空一切，只留那个备份文件
    reset()
    FILES.set(backupFile, { size: raw.length, raw: raw })
    CHOOSE = backupFile
    const s3 = fresh()
    ok('新机器上一开始是空的', s3.store.stats().total === 0)

    const imp = await s3.transfer.importBackup()
    ok('导入 3 条', imp.added === 3, imp)
    ok('文字回来了', s3.store.list({ includeArchived: true }).some(r => /陈列要往上走/.test(r.content)))
    ok('星标状态还在', s3.store.stats().starred === 1, s3.store.stats().starred)
    ok('归档状态还在（不会混进默认列表）', s3.store.query({ only: 'archive' }).length === 1)
    ok('照片文件被还原到新机', imp.mediaRestored >= 1, imp.mediaRestored)

    const again = await s3.transfer.importBackup()
    ok('同一个文件再导一次：0 新增（按 id 去重）', again.added === 0, again.added)
    ok('重复导入不会把条数变多', s3.store.stats().total === 3, s3.store.stats().total)
  }

  /* ================= 8. 导入异常 ================= */
  console.log('8) 导入异常：坏文件要说清楚，不能吞')
  reset()
  {
    const s4 = fresh()
    FILES.set('/udata/bad.json', { size: 10, raw: '{ 这不是 json' })
    CHOOSE = '/udata/bad.json'
    let code = ''
    try { await s4.transfer.importBackup() } catch (e) { code = e && e.code }
    ok('坏 JSON → parse', code === 'parse', code)

    FILES.set('/udata/other.json', { size: 30, raw: JSON.stringify({ hello: 'world' }) })
    CHOOSE = '/udata/other.json'
    code = ''
    try { await s4.transfer.importBackup() } catch (e) { code = e && e.code }
    ok('不是本应用的备份 → format', code === 'format', code)

    CHOOSE = ''
    code = ''
    try { await s4.transfer.importBackup() } catch (e) { code = e && e.code }
    ok('用户取消选择 → cancel', code === 'cancel', code)
  }

  console.log('')
  console.log('结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('\n测试自身出错：', e)
  process.exit(1)
})
