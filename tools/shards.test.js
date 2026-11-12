/**
 * 分片存储（lg.r.v1.0 … lg.r.v1.9）
 * 用法：node tools/shards.test.js
 *
 * 这个改动碰的是"所有数据都从这里过"的读写出口，而它出错的形态全是静默的：
 * 记录少了、改完没生效、迁移只迁了一半、旧数据反过来盖掉新数据。
 * 所以测试重点不在"能存能读"，而在四件事：
 *   1. 迁移：老数据一条不少地搬过来，且只搬一次；
 *   2. 防覆盖：迁移完成后旧键就算残留，也不能反过来盖掉迁移之后的新记录；
 *   3. 增量写：改一条只写 1 个分片，否则分片只是把一次写放大成十次；
 *   4. 单键上限：1000 条撑满时，最大的那一片要明显低于 1MB。
 */
const path = require('path')
const B = path.resolve(__dirname, '..', 'miniprogram')

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
let FAIL_WRITE = false
let MODALS = []
let SHARD_WRITES = []
let FILES = new Map()

const clone = v => JSON.parse(JSON.stringify(v))
const SHARD_PREFIX = 'lg.r.v1.'
const LEGACY = 'lg.records.v1'
const SCHEMA = 'lg.schema.v1'
const ONE_MB = 1024 * 1024

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
    if (FAIL_WRITE) throw new Error('exceed storage max size')
    // 只记记录分片的写入，meta / schema / prefs 不参与"写放大"统计
    if (String(k).indexOf(SHARD_PREFIX) === 0) SHARD_WRITES.push(k)
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

/** 清模块缓存，拿一份干净的 store（store 里有内存 cache 与分片快照） */
function fresh() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(B, 'utils')) === 0) delete require.cache[k]
  })
  return require(path.join(B, 'utils', 'store.js'))
}

function reset() {
  STORE = {}
  FAIL_WRITE = false
  MODALS = []
  SHARD_WRITES = []
  FILES = new Map()
}

function shardKeys() {
  return Object.keys(STORE).filter(k => k.indexOf(SHARD_PREFIX) === 0)
}

function shardTotal() {
  return shardKeys().reduce((n, k) => n + (STORE[k] || []).length, 0)
}

function shardBytes() {
  const out = []
  shardKeys().forEach(k => {
    out.push({ key: k, n: (STORE[k] || []).length, bytes: Buffer.byteLength(JSON.stringify(STORE[k] || []), 'utf8') })
  })
  return out.sort((a, b) => b.bytes - a.bytes)
}

/** 造一条"老版本形状"的记录：只有最早那几个字段，没有 tags/starred 之类 */
function legacyRecord(i, content) {
  return {
    id: 'r' + (1700000000000 + i).toString(36) + 'abc' + i,
    type: 'text',
    content: content || '旧记录 ' + i,
    mediaPath: '',
    mediaPaths: [],
    createdAt: 1700000000000 + i,
    updatedAt: 1700000000000 + i,
    deletedAt: 0
  }
}

/* ================= 1. 新用户：不写空片 ================= */
console.log('1) 新用户首次打开：不产生空分片，只落版本标记')
reset()
{
  const store = fresh()
  ok('列表为空', store.list().length === 0)
  ok('旧键没有被创建', STORE[LEGACY] === undefined)
  ok('没有写任何分片（10 个空键白占空间）', shardKeys().length === 0, shardKeys())
  ok('结构版本已标记为 2', STORE[SCHEMA] === 2, STORE[SCHEMA])
}

/* ================= 2. 分片分布：稳定且均匀 ================= */
console.log('2) 分片分布：200 条要摊到 10 个片里，不能挤在一起')
reset()
{
  const store = fresh()
  const list = []
  for (let i = 0; i < 200; i++) list.push(legacyRecord(i, '内容 ' + i))
  store.importRecords(list)

  const sizes = shardBytes().map(s => s.n)
  ok('200 条一条不少', shardTotal() === 200, shardTotal())
  ok('用到了 10 个分片', shardKeys().length === 10, shardKeys().length)
  ok('每片都有记录，最大片不超过 60 条', Math.max.apply(null, sizes) <= 60, sizes)
  ok('每片至少 8 条，没有空片', Math.min.apply(null, sizes) >= 8, sizes)
}

/* ================= 3. 增量写：改一条只写一片 ================= */
console.log('3) 增量写：新增 / 修改 / 加星 / 删除各自只写 1 个分片')
reset()
{
  const store = fresh()
  const seed = []
  for (let i = 0; i < 40; i++) seed.push(legacyRecord(i))
  store.importRecords(seed)

  SHARD_WRITES = []
  const created = store.create({ type: 'text', content: '新的一条' })
  ok('新增 1 条 → 只写 1 个分片', SHARD_WRITES.length === 1, SHARD_WRITES)

  SHARD_WRITES = []
  store.update(created.id, { content: '改过的内容' })
  ok('修改 1 条 → 只写 1 个分片', SHARD_WRITES.length === 1, SHARD_WRITES)

  SHARD_WRITES = []
  store.setStar(created.id, 1)
  ok('加星 1 条 → 只写 1 个分片', SHARD_WRITES.length === 1, SHARD_WRITES)

  SHARD_WRITES = []
  store.remove(created.id)
  ok('软删 1 条 → 只写 1 个分片', SHARD_WRITES.length === 1, SHARD_WRITES)

  SHARD_WRITES = []
  store.list()
  ok('纯读不写盘', SHARD_WRITES.length === 0, SHARD_WRITES)
}

/* ================= 4. 迁移：老数据一条不少地搬过来 ================= */
console.log('4) 迁移：单键里的老记录搬到分片，旧键删掉')
reset()
{
  const old = []
  for (let i = 0; i < 5; i++) old.push(legacyRecord(i, '第 ' + i + ' 条旧记录'))
  STORE[LEGACY] = old

  const store = fresh()
  const list = store.list()

  ok('5 条都读得到', list.length === 5, list.length)
  ok('正文原样保留', list.map(r => r.content).sort().join('|') === old.map(r => r.content).sort().join('|'))
  ok('旧键已删除', STORE[LEGACY] === undefined)
  ok('结构版本已标记', STORE[SCHEMA] === 2)
  ok('5 条都在分片里', shardTotal() === 5, shardTotal())
  ok('缺失字段被补齐（tags 是数组）', Array.isArray(list[0].tags) && list[0].starred === 0)
}

/* ================= 5. 防覆盖：旧键残留也不能盖掉新数据 ================= */
console.log('5) 防覆盖：迁移后旧键若残留，不能反把新记录冲掉')
reset()
{
  const old = []
  for (let i = 0; i < 3; i++) old.push(legacyRecord(i))
  STORE[LEGACY] = old

  let store = fresh()
  store.list()
  store.create({ type: 'text', content: '迁移之后记的一条' })

  // 模拟"删旧键失败"：旧键又出现了
  STORE[LEGACY] = old

  store = fresh()
  const list = store.list()
  ok('重新加载后是 4 条，不是回到 3 条', list.length === 4, list.length)
  ok('迁移后新增的那条还在', list.some(r => r.content === '迁移之后记的一条'))
  ok('不会重复迁移（旧键原样留着也不影响读取）', shardTotal() === 4, shardTotal())
}

/* ================= 6. 迁移写入失败：能读、能重试 ================= */
console.log('6) 迁移时写盘失败：数据还能读，下次启动接着迁')
reset()
{
  const old = []
  for (let i = 0; i < 3; i++) old.push(legacyRecord(i))
  STORE[LEGACY] = old
  FAIL_WRITE = true

  let store = fresh()
  const list = store.list()
  ok('写不进去也能读出 3 条（不阻断使用）', list.length === 3, list.length)
  ok('旧键保留，没有被误删', Array.isArray(STORE[LEGACY]) && STORE[LEGACY].length === 3)
  ok('没有落下版本标记', STORE[SCHEMA] === undefined, STORE[SCHEMA])

  FAIL_WRITE = false
  store = fresh()
  ok('空间恢复后重新迁移成功', store.list().length === 3)
  ok('这次旧键删掉了', STORE[LEGACY] === undefined)
  ok('版本标记补上', STORE[SCHEMA] === 2)
}

/* ================= 7. 旧键是空数组：不留空片 ================= */
console.log('7) 边界：旧键存在但内容为空（清空过全部记录的老用户）')
reset()
{
  STORE[LEGACY] = []
  const store = fresh()
  ok('读出 0 条', store.list().length === 0)
  ok('没有生成 10 个空分片', shardKeys().length === 0, shardKeys())
  ok('旧键被清掉', STORE[LEGACY] === undefined)
  ok('版本标记已落', STORE[SCHEMA] === 2)
}

/* ================= 8. 单键上限：1000 条撑满时的最大片 ================= */
console.log('8) 单键上限：1000 条 × 350 字，最大的片要远低于 1MB')
reset()
{
  const store = fresh()
  const big = []
  for (let i = 0; i < 1000; i++) {
    big.push(legacyRecord(i, '灵'.repeat(350) + i))
  }
  const t0 = Date.now()
  const res = store.importRecords(big)
  const cost = Date.now() - t0

  const parts = shardBytes()
  const total = parts.reduce((n, s) => n + s.bytes, 0)
  const maxPart = parts[0]

  ok('1000 条全部写入（受 MAX_RECORDS 限制）', res.added === 1000, res)
  ok('总量已超过 1MB —— 旧方案在这个量级必然撞单键上限', total > ONE_MB, total)
  ok('最大分片 < 200KB，单键上限不再是瓶颈', maxPart.bytes < ONE_MB * 0.2, maxPart)
  ok('最大分片 < 总量 / 5，分片确实分摊了压力', maxPart.bytes < total / 5, {
    max: maxPart.bytes,
    total: total
  })
  ok('1000 条一次导入在 2 秒内完成', cost < 2000, cost + 'ms')
  console.log('    最大片 ' + Math.round(maxPart.bytes / 1024) + 'KB / 总量 ' + Math.round(total / 1024) + 'KB，用时 ' + cost + 'ms')
}

/* ================= 9. 清空与写失败 ================= */
console.log('9) 清空全部 / 写盘失败的提示')
reset()
{
  let store = fresh()
  const seed = []
  for (let i = 0; i < 12; i++) seed.push(legacyRecord(i))
  store.importRecords(seed)

  store.clearAll()
  ok('清空后列表为 0', store.list().length === 0)
  ok('分片里也不留记录', shardTotal() === 0, shardTotal())

  FAIL_WRITE = true
  MODALS = []
  const r = store.create({ type: 'text', content: '存不进去的一条' })
  ok('写盘失败时 create 返回 null，不假装存下', r === null)
  ok('给了"存不下了"的解释', MODALS.some(m => m.title === '存不下了'), MODALS)

  FAIL_WRITE = false
  store = fresh()
  ok('失败后不会留下半条脏数据', store.list().length === 0, store.list().length)
}

/* ================= 10. 读原始数据 / 备份口径 ================= */
console.log('10) allRaw 与 list 口径一致（备份导出依赖它）')
reset()
{
  let store = fresh()
  const seed = []
  for (let i = 0; i < 6; i++) seed.push(legacyRecord(i))
  store.importRecords(seed)
  store.setArchive(seed[0].id, 1)

  ok('allRaw 含归档，共 6 条', store.allRaw().length === 6, store.allRaw().length)
  ok('list 不含归档，共 5 条', store.list().length === 5, store.list().length)
  ok('归档的那条能从 allRaw 里找到', store.allRaw().some(r => r.archivedAt > 0))

  store = fresh()
  ok('重新加载后归档状态还在（归档也走了分片）', store.allRaw().filter(r => r.archivedAt > 0).length === 1)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
