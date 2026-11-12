/**
 * 数据层（唯一读写本地存储的入口）
 *
 * 存储结构：记录按 id 哈希分到 10 个键（lg.r.v1.0 … lg.r.v1.9），对外仍是一个数组。
 * 老版本的单键 lg.records.v1 在首次启动时自动迁移，迁移完成后删除。
 * 为什么要分片、为什么按 id 哈希分，见下方常量处那段注释。
 *
 * 记录形状：
 * {
 *   id, type: 'text'|'voice'|'photo',
 *   content,                      // 正文；语音/照片时是备注
 *   mediaPath,                    // 兼容字段：语音=文件，照片=第一张
 *   mediaPaths: string[],         // 照片最多 9 张
 *   duration, size,
 *   tags: string[],               // 从正文 #标签 自动解析 + 手动补充
 *   starred: 0|1,
 *   archivedAt: number,           // 非 0 表示已归档，不进主列表
 *   createdAt, updatedAt, deletedAt
 * }
 *
 * 对外只暴露语义化方法，页面不直接碰 wx.getStorageSync。
 */
const media = require('./media')
const { uuid } = require('./id')
const dialog = require('./dialog')
const i18n = require('./i18n')

/**
 * 记录分片：lg.r.v1.0 … lg.r.v1.9
 *
 * 为什么必须分片：微信给「单个 key」的上限是 1MB，10MB 是整个 Storage 的总量。
 * 原来 1000 条全塞一个 key，平均每条 800 字节就会撞到单键上限——那时总量才用掉
 * 不到 1MB，却已经写不进去了，用户看到的是"存不下了"，其实空间还剩九成。
 *
 * 为什么按 id 哈希分、而不按下标切片：下标切片在列表中间插入或删除一条时，
 * 后面所有记录都要换到别的片里，一次改动会波及大部分片，写放大比单键还差。
 * 按 id 哈希则一条记录永远只属于一个片，新增/修改/删除通常只写 1 个键。
 */
const SHARD_PREFIX = 'lg.r.v1.'
const SHARD_COUNT = 10
/** 老版本的单键存储，只在迁移时读一次 */
const KEY_LEGACY = 'lg.records.v1'
/**
 * 结构版本。2 = 分片存储。
 * 迁移成功后写它，用来区分"没迁移过"和"迁移过但旧键没删干净"——
 * 后者必须跳过迁移，否则旧数据会把迁移之后新记的内容覆盖掉。
 */
const KEY_SCHEMA = 'lg.schema.v1'
const SCHEMA_VERSION = 2
const KEY_META = 'lg.meta.v1'
const KEY_DRAFT = 'lg.draft.v1'
const KEY_PREFS = 'lg.prefs.v1'
/**
 * 备份账本单独一个键，不塞进 KEY_META：
 * touchMeta / syncFirstAt 都是"整份覆盖"写，混在一起会被顺手抹掉。
 */
const KEY_BACKUP = 'lg.backup.v1'

const MAX_RECORDS = 1000
/** 软删记录保留 24 小时再物理清除，够覆盖撤销与误操作排查 */
const TRASH_TTL = 24 * 60 * 60 * 1000
/** 单条最多 9 张图，和微信相册选择的常用上限保持一致 */
const MAX_PHOTOS = 9
const MAX_TAGS = 8

/** #标签：中文/字母/数字，遇到空白与常见标点即止 */
const TAG_RE = /#([^\s#，。,.!！?？、;；:：()（）[\]【】"'“”]{1,12})/g

let cache = null
/** 每个分片在磁盘上的序列化快照；null = 未知（比如刚写完失败），下次全量重写 */
let shardRaw = null

/* ---------------------------- 基础工具 ---------------------------- */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function dayKeyOf(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 从正文里抽 #标签，去重、限长、限个数 */
function parseTags(content) {
  const out = []
  const seen = {}
  const text = typeof content === 'string' ? content : ''
  TAG_RE.lastIndex = 0
  let m = TAG_RE.exec(text)
  while (m) {
    const tag = m[1].trim()
    if (tag && !seen[tag] && out.length < MAX_TAGS) {
      seen[tag] = 1
      out.push(tag)
    }
    m = TAG_RE.exec(text)
  }
  return out
}

function normalizeTags(list, content) {
  const out = []
  const seen = {}
  const push = t => {
    const tag = String(t || '').trim().replace(/^#/, '')
    if (!tag || seen[tag] || out.length >= MAX_TAGS) return
    seen[tag] = 1
    out.push(tag)
  }
  if (Array.isArray(list)) list.forEach(push)
  parseTags(content).forEach(push)
  return out
}

/**
 * 读出来的记录统一整形。
 * 老数据没有 mediaPaths / tags / starred / archivedAt，在这里补齐，
 * 页面上就不需要到处写兼容判断。
 */
function normalizeRecord(r) {
  const out = Object.assign({}, r)
  // 正文首尾空白一律去掉。粘贴进来的文字常带首尾空行，留着会让卡片顶部多一条
  // 空白、导出的 Markdown 多一个空段落、分享标题以空格开头（微信会吃掉）。
  // 收口放在这里而不是各调用点：create / update / importRecords 都经过它。
  out.content = typeof out.content === 'string' ? out.content.trim() : ''
  out.type = ['text', 'voice', 'photo'].indexOf(out.type) >= 0 ? out.type : 'text'

  let paths = Array.isArray(out.mediaPaths) ? out.mediaPaths.filter(Boolean) : []
  if (!paths.length && out.mediaPath && out.type === 'photo') paths = [out.mediaPath]
  out.mediaPaths = out.type === 'photo' ? paths.slice(0, MAX_PHOTOS) : []
  out.mediaPath = out.type === 'photo' ? out.mediaPaths[0] || '' : out.mediaPath || ''

  out.tags = normalizeTags(out.tags, out.content)
  out.starred = out.starred ? 1 : 0
  out.archivedAt = out.archivedAt || 0
  out.duration = out.duration || 0
  out.size = out.size || 0
  out.deletedAt = out.deletedAt || 0
  return out
}

function clone(record) {
  const out = Object.assign({}, record)
  out.tags = record.tags ? record.tags.slice() : []
  out.mediaPaths = record.mediaPaths ? record.mediaPaths.slice() : []
  return out
}

/** 一条记录里所有需要随记录一起清理的文件 */
function mediaOf(record) {
  if (!record) return []
  if (record.type === 'voice') return record.mediaPath ? [record.mediaPath] : []
  return (record.mediaPaths || []).slice()
}

function shardKey(i) {
  return SHARD_PREFIX + i
}

/**
 * FNV-1a：只要求把 id 稳定地摊到 0..9，不要求密码学强度。
 * id 形如 r + base36 时间戳 + 6 位随机串，前缀高度相似，
 * 所以要先异或累积再乘质数，让尾部随机性把前缀的规律打散。
 */
function shardOf(id) {
  const s = String(id || '')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % SHARD_COUNT
}

/** 读全部分片，拼成一个数组；顺手记下每片的快照供后续增量写比对 */
function readShards() {
  const raw = []
  const list = []
  for (let i = 0; i < SHARD_COUNT; i++) {
    let part = ''
    try {
      part = wx.getStorageSync(shardKey(i))
    } catch (e) {
      console.error('[store] read shard failed', i, e)
      part = ''
    }
    if (!Array.isArray(part)) part = []
    const norm = part.map(normalizeRecord)
    // 快照记"归一化之后"的形状，才能和 writeShards 传进来的数组直接比对
    raw.push(JSON.stringify(norm))
    for (let j = 0; j < norm.length; j++) list.push(norm[j])
  }
  shardRaw = raw
  return list
}

/**
 * 按 id 分组写回，只写内容真的变了的片。
 *
 * 写失败时的语义要说清楚：某一篇写失败，只代表"这一片的这次改动没生效"，
 * 该片旧内容仍在盘上，记录不会凭空消失——丢的是一次修改，不是整条记录。
 * 同时把快照置空，下次写入会全量重写，避免内存与磁盘长期分叉。
 */
function writeShards(list) {
  const buckets = []
  for (let i = 0; i < SHARD_COUNT; i++) buckets.push([])
  for (let i = 0; i < list.length; i++) {
    buckets[shardOf(list[i].id)].push(list[i])
  }

  const next = []
  for (let i = 0; i < SHARD_COUNT; i++) next.push(JSON.stringify(buckets[i]))

  try {
    for (let i = 0; i < SHARD_COUNT; i++) {
      if (shardRaw && shardRaw[i] === next[i]) continue
      wx.setStorageSync(shardKey(i), buckets[i])
    }
  } catch (e) {
    console.error('[store] write shard failed', e)
    shardRaw = null
    return false
  }
  shardRaw = next
  return true
}

/**
 * 单键 → 分片的迁移。只跑一次，且可以安全重跑：
 *   写分片（覆盖写，幂等） → 落版本标记 → 删旧键
 * 任何一步失败都不丢数据：标记没写上就下次重来，旧键没删掉只是多占点空间。
 *
 * @returns {Array|null} 刚迁移的数组（已归一化），无需迁移时返回 null
 */
function ensureSchema() {
  let v = 0
  try {
    v = wx.getStorageSync(KEY_SCHEMA) || 0
  } catch (e) {
    v = 0
  }
  if (v >= SCHEMA_VERSION) return null

  let legacy = null
  try {
    legacy = wx.getStorageSync(KEY_LEGACY)
  } catch (e) {
    console.error('[store] read legacy failed', e)
  }

  // 新用户：没有旧键可迁，直接落标记，不写 10 个空片白占空间
  if (!Array.isArray(legacy)) {
    try {
      wx.setStorageSync(KEY_SCHEMA, SCHEMA_VERSION)
    } catch (e) {
      // 落标记失败不影响使用，下次再试
    }
    return null
  }

  const records = legacy.map(normalizeRecord)

  // 旧键存在但是空数组（老用户清空过全部记录）：不必写 10 个空片白占空间
  if (!records.length) {
    try {
      wx.setStorageSync(KEY_SCHEMA, SCHEMA_VERSION)
      wx.removeStorageSync(KEY_LEGACY)
    } catch (e) {
      // 同上，失败不影响使用
    }
    return []
  }

  if (!writeShards(records)) return records

  try {
    wx.setStorageSync(KEY_SCHEMA, SCHEMA_VERSION)
    wx.removeStorageSync(KEY_LEGACY)
  } catch (e) {
    // 标记或删除失败：旧键可能残留，但标记已尽量写入，下次不会重复迁移
    console.error('[store] mark schema failed', e)
  }
  return records
}

function readAll() {
  if (cache) return cache
  const migrated = ensureSchema()
  cache = migrated || readShards()
  return cache
}

/**
 * 写回存储。写失败（多半是空间不足）时把缓存置空，
 * 保证内存与磁盘不会静默分叉。
 */
function writeAll(list) {
  if (writeShards(list)) {
    cache = list
    return true
  }
  cache = null
  dialog.alert({
    title: i18n.t('store:nomem_title'),
    text: i18n.t('store:nomem_text')
  })
  return false
}

function sortDesc(list) {
  return list.slice().sort((a, b) => b.createdAt - a.createdAt)
}

function activeOnly(list) {
  return list.filter(r => !r.deletedAt)
}

function touchMeta(ts) {
  let meta = null
  try {
    meta = wx.getStorageSync(KEY_META)
  } catch (e) {
    meta = null
  }
  if (!meta || !meta.firstAt) {
    meta = { firstAt: ts }
    try {
      wx.setStorageSync(KEY_META, meta)
    } catch (e) {
      console.error('[store] meta write failed', e)
    }
  }
  return meta
}

/* ------------------------------ 读 ------------------------------ */

/** 列表：默认只返回未删除、未归档的，按创建时间倒序 */
function list(options) {
  const o = options || {}
  const all = readAll()
  let arr
  if (o.includeDeleted) arr = all
  else if (o.includeArchived) arr = activeOnly(all)
  else arr = activeOnly(all).filter(r => !r.archivedAt)
  return sortDesc(arr).map(clone)
}

/**
 * 带条件的查询：主列表、星标、归档、按标签、按关键词都用它，
 * 保证「筛选口径」只有一份实现。
 * @param {{only?:'all'|'star'|'archive', tag?:string, keyword?:string}} opts
 */
function query(opts) {
  const o = opts || {}
  const keyword = (o.keyword || '').trim().toLowerCase()
  let arr = activeOnly(readAll())

  if (o.only === 'star') arr = arr.filter(r => r.starred)
  else if (o.only === 'archive') arr = arr.filter(r => r.archivedAt)
  else arr = arr.filter(r => !r.archivedAt)

  if (o.tag) arr = arr.filter(r => r.tags.indexOf(o.tag) >= 0)
  if (keyword) arr = arr.filter(r => hitOf(r, keyword))

  return sortDesc(arr).map(clone)
}

function hitOf(record, keyword) {
  if (!keyword) return false
  if ((record.content || '').toLowerCase().indexOf(keyword) >= 0) return true
  for (let i = 0; i < record.tags.length; i++) {
    if (record.tags[i].toLowerCase().indexOf(keyword) >= 0) return true
  }
  return false
}

/**
 * 搜索：额外算出命中片段（前后各留 12 字），供页面做高亮。
 * WXML 里没法跑正则，所以切段必须在 JS 里做完。
 */
function search(keyword) {
  const kw = (keyword || '').trim()
  if (!kw) return []
  const lower = kw.toLowerCase()
  const hits = query({ keyword: kw })

  return hits.map(r => {
    const text = (r.content || '').replace(/\s+/g, ' ')
    const at = text.toLowerCase().indexOf(lower)
    let before = ''
    let mid = ''
    let after = ''
    if (at >= 0) {
      const from = Math.max(0, at - 12)
      const to = Math.min(text.length, at + kw.length + 12)
      before = (from > 0 ? '…' : '') + text.slice(from, at)
      mid = text.slice(at, at + kw.length)
      after = text.slice(at + kw.length, to) + (to < text.length ? '…' : '')
    } else {
      // 命中标签而不是正文：正文原样给前 40 字
      before = text.slice(0, 40) + (text.length > 40 ? '…' : '')
    }
    return Object.assign(clone(r), { _seg: { before: before, mid: mid, after: after } })
  })
}

function get(id) {
  const found = readAll().filter(r => r.id === id)[0]
  return found ? clone(found) : null
}

function count() {
  return activeOnly(readAll()).filter(r => !r.archivedAt).length
}

/** 标签云：按出现次数倒序 */
function tags() {
  const map = {}
  activeOnly(readAll()).forEach(r => {
    if (r.archivedAt) return
    r.tags.forEach(t => {
      map[t] = (map[t] || 0) + 1
    })
  })
  return Object.keys(map)
    .map(t => ({ tag: t, count: map[t] }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
}

/** 连续记录天数：今天没记就从昨天往前数，断了就是 0 */
function streak() {
  const marks = {}
  activeOnly(readAll()).forEach(r => {
    marks[dayKeyOf(r.createdAt)] = 1
  })
  let n = 0
  let cursor = startOfDay(Date.now())
  if (!marks[dayKeyOf(cursor)]) cursor -= 86400000
  while (marks[dayKeyOf(cursor)]) {
    n++
    cursor -= 86400000
  }
  return n
}

/**
 * 热力图：最近 n 周、以周一为起点的连续格子。
 * 返回按时间正序的数组，每项 {key, ts, count, level}，level 0-4 给样式用。
 */
function heat(weeks) {
  const n = weeks || 14
  const counts = {}
  activeOnly(readAll()).forEach(r => {
    const k = dayKeyOf(r.createdAt)
    counts[k] = (counts[k] || 0) + 1
  })

  const today = startOfDay(Date.now())
  const offset = (new Date(today).getDay() + 6) % 7 // 周一 = 0
  const end = today + (6 - offset) * 86400000 // 本周日
  const start = end - (n * 7 - 1) * 86400000

  const cells = []
  let max = 0
  for (let i = 0; i < n * 7; i++) {
    const ts = start + i * 86400000
    const key = dayKeyOf(ts)
    const c = counts[key] || 0
    if (c > max) max = c
    cells.push({
      key: key,
      ts: ts,
      count: c,
      future: ts > today ? 1 : 0,
      level: c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2 : c <= 4 ? 3 : 4
    })
  }
  return { cells: cells, weeks: n, max: max }
}

/** 我的页用的统计 */
function stats() {
  const arr = activeOnly(readAll())
  const byType = { text: 0, voice: 0, photo: 0 }
  let firstAt = 0
  let lastAt = 0
  let starred = 0
  let archived = 0
  let trashed = 0
  let tagged = 0

  arr.forEach(r => {
    byType[r.type] = (byType[r.type] || 0) + 1
    if (!firstAt || r.createdAt < firstAt) firstAt = r.createdAt
    if (r.createdAt > lastAt) lastAt = r.createdAt
    if (r.starred) starred++
    if (r.archivedAt) archived++
    if (r.tags.length) tagged++
  })
  readAll().forEach(r => {
    if (r.deletedAt) trashed++
  })

  return {
    total: arr.length,
    visible: arr.filter(r => !r.archivedAt).length,
    firstAt: firstAt,
    lastAt: lastAt,
    byType: byType,
    starred: starred,
    archived: archived,
    trashed: trashed,
    tagged: tagged,
    streak: streak()
  }
}

/* ------------------------------ 写 ------------------------------ */

/**
 * 新建记录
 * @param {{type:string, content?:string, mediaPath?:string, mediaPaths?:string[],
 *          duration?:number, size?:number, tags?:string[], starred?:number}} input
 * @returns {object|null} 失败返回 null（已提示用户）
 */
function create(input) {
  const all = readAll()
  if (activeOnly(all).length >= MAX_RECORDS) {
    dialog.alert({
      title: i18n.t('store:full_title', { n: MAX_RECORDS }),
      text: i18n.t('store:full_text')
    })
    return null
  }

  const ts = Date.now()
  const record = normalizeRecord({
    id: uuid(),
    type: input.type,
    content: input.content || '',
    mediaPath: input.mediaPath || '',
    mediaPaths: input.mediaPaths || [],
    duration: input.duration || 0,
    size: input.size || 0,
    tags: input.tags || [],
    starred: input.starred || 0,
    archivedAt: 0,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: 0
  })

  if (!writeAll(all.concat(record))) {
    // 落库失败，顺手把刚存进来的媒体文件删掉，别留孤儿
    mediaOf(record).forEach(p => media.remove(p))
    return null
  }
  touchMeta(ts)
  return clone(record)
}

/**
 * 更新记录。createdAt 永不变（列表顺序不会因为改一句话而跳动）。
 * 换图/换录音时，被换掉的旧文件在写盘成功后立即删除。
 */
function update(id, patch) {
  const all = readAll()
  const index = all.findIndex(r => r.id === id)
  if (index < 0) return null

  const prev = all[index]
  const next = normalizeRecord(Object.assign({}, prev, patch, { updatedAt: Date.now() }))

  const copy = all.slice()
  copy[index] = next
  if (!writeAll(copy)) return null

  const keep = mediaOf(next)
  mediaOf(prev).forEach(p => {
    if (keep.indexOf(p) < 0) media.remove(p)
  })
  return clone(next)
}

/** 单字段开关的轻封装：星标、归档都走这里，避免调用方各自拼 patch */
function setStar(id, on) {
  return update(id, { starred: on ? 1 : 0 })
}

function setArchive(id, on) {
  return update(id, { archivedAt: on ? Date.now() : 0 })
}

/** 删除 = 打软删标记，列表立刻消失，5 秒内还能 restore */
function remove(id) {
  const all = readAll()
  const index = all.findIndex(r => r.id === id)
  if (index < 0) return null
  const next = Object.assign({}, all[index], { deletedAt: Date.now() })
  const copy = all.slice()
  copy[index] = next
  if (!writeAll(copy)) return null
  return clone(next)
}

/** 撤销删除 */
function restore(id) {
  const done = restoreMany([id])
  return done.length ? get(id) : null
}

/** 物理清理过期的软删记录（启动、切后台时各跑一次） */
function purge() {
  const all = readAll()
  const now = Date.now()
  const keep = []
  const dead = []
  all.forEach(r => {
    if (r.deletedAt && now - r.deletedAt > TRASH_TTL) {
      dead.push(r)
      return
    }
    keep.push(r)
  })
  if (!dead.length) return
  if (writeAll(keep)) dead.forEach(r => mediaOf(r).forEach(p => media.remove(p)))
}

/** 回收站里还在 24 小时窗口内的记录 */
function trash() {
  return sortDesc(readAll().filter(r => r.deletedAt)).map(clone)
}

/** 彻底删掉（回收站里手动清空某条） */
function destroy(id) {
  const all = readAll()
  const found = all.filter(r => r.id === id)[0]
  if (!found) return false
  const keep = all.filter(r => r.id !== id)
  if (!writeAll(keep)) return false
  mediaOf(found).forEach(p => media.remove(p))
  return true
}

/** 清空全部：连媒体文件一起删干净 */
function clearAll() {
  const all = readAll()
  if (!writeAll([])) return false
  all.forEach(r => mediaOf(r).forEach(p => media.remove(p)))
  try {
    wx.removeStorageSync(KEY_META)
  } catch (e) {
    console.error('[store] meta clear failed', e)
  }
  return true
}

/* ---------------------------- 批量删除 ---------------------------- */

/**
 * 批量软删：只写一次盘，删到一半失败不会留下"删了一半"的状态。
 * @returns {string[]} 真正被删掉的 id（已被删过的不会重复计入）
 */
function removeMany(ids) {
  const set = {}
  ;(ids || []).forEach(id => {
    set[id] = 1
  })
  if (!Object.keys(set).length) return []

  const now = Date.now()
  const done = []
  const copy = readAll().map(r => {
    if (set[r.id] && !r.deletedAt) {
      done.push(r.id)
      return Object.assign({}, r, { deletedAt: now })
    }
    return r
  })
  if (!done.length) return []
  if (!writeAll(copy)) return []
  return done
}

/** 批量撤销：撤销条点「撤回」时整组回来 */
function restoreMany(ids) {
  const set = {}
  ;(ids || []).forEach(id => {
    set[id] = 1
  })
  if (!Object.keys(set).length) return []

  const done = []
  const copy = readAll().map(r => {
    if (set[r.id] && r.deletedAt) {
      done.push(r.id)
      return Object.assign({}, r, { deletedAt: 0 })
    }
    return r
  })
  if (!done.length) return []
  if (!writeAll(copy)) return []
  return done
}

/* ---------------------------- 导入导出 ---------------------------- */

/** 导出用：原始全量，含软删记录（配合 transfer 做完整快照） */
function allRaw() {
  return readAll().map(clone)
}

/** 导入后把「开始记录」时间修正到更早的那一条 */
function syncFirstAt() {
  const arr = activeOnly(readAll())
  if (!arr.length) return
  let firstAt = arr[0].createdAt
  arr.forEach(r => {
    if (r.createdAt && r.createdAt < firstAt) firstAt = r.createdAt
  })
  let meta = null
  try {
    meta = wx.getStorageSync(KEY_META)
  } catch (e) {
    meta = null
  }
  if (!meta || !meta.firstAt || firstAt < meta.firstAt) {
    try {
      wx.setStorageSync(KEY_META, { firstAt: firstAt })
    } catch (e) {
      console.error('[store] meta sync failed', e)
    }
  }
}

/**
 * 导入：按 id 去重合并，本机已存在的一律不覆盖。
 * 这样反复导入同一个文件不会产生重复，也不会冲掉换机后新记的内容。
 * @returns {{added:number, skipped:number}}
 */
function importRecords(records) {
  if (!Array.isArray(records)) return { added: 0, skipped: 0 }

  const all = readAll()
  const seen = {}
  all.forEach(r => {
    seen[r.id] = 1
  })

  const added = []
  let skipped = 0
  let room = MAX_RECORDS - activeOnly(all).length

  records.forEach(r => {
    if (!r || !r.id) {
      skipped++
      return
    }
    if (seen[r.id] || room <= 0) {
      skipped++
      return
    }
    seen[r.id] = 1
    room--
    added.push(
      normalizeRecord({
        id: r.id,
        type: r.type,
        content: typeof r.content === 'string' ? r.content : '',
        mediaPath: r.mediaPath || '',
        mediaPaths: r.mediaPaths || [],
        duration: r.duration || 0,
        size: r.size || 0,
        tags: r.tags || [],
        starred: r.starred || 0,
        archivedAt: r.archivedAt || 0,
        createdAt: r.createdAt || Date.now(),
        updatedAt: r.updatedAt || r.createdAt || Date.now(),
        deletedAt: 0
      })
    )
  })

  if (!added.length) return { added: 0, skipped: skipped }
  if (!writeAll(all.concat(added))) return { added: 0, skipped: skipped }
  syncFirstAt()
  return { added: added.length, skipped: skipped }
}

/* ---------------------------- 草稿 ---------------------------- */

/** 输入即存草稿（300ms 防抖由调用方做），关掉小程序也不丢 */
function saveDraft(draft) {
  try {
    wx.setStorageSync(KEY_DRAFT, Object.assign({ savedAt: Date.now() }, draft))
  } catch (e) {
    console.error('[store] draft write failed', e)
  }
}

function getDraft() {
  try {
    const d = wx.getStorageSync(KEY_DRAFT)
    return d && d.content ? d : null
  } catch (e) {
    return null
  }
}

function clearDraft() {
  try {
    wx.removeStorageSync(KEY_DRAFT)
  } catch (e) {
    console.error('[store] draft clear failed', e)
  }
}

/* ---------------------------- 偏好 ---------------------------- */

/** 提醒等设置，一个 key 存全部，读的时候补默认值 */
function getPrefs() {
  let raw = null
  try {
    raw = wx.getStorageSync(KEY_PREFS)
  } catch (e) {
    raw = null
  }
  const p = raw || {}
  return {
    remindOn: !!p.remindOn,
    remindHour: typeof p.remindHour === 'number' ? p.remindHour : 21,
    remindMinute: typeof p.remindMinute === 'number' ? p.remindMinute : 0,
    remindTipShown: !!p.remindTipShown
  }
}

function savePrefs(patch) {
  const next = Object.assign(getPrefs(), patch || {})
  try {
    wx.setStorageSync(KEY_PREFS, next)
    return next
  } catch (e) {
    console.error('[store] prefs write failed', e)
    return getPrefs()
  }
}

/* ---------------------------- 备份账本 ---------------------------- */

/**
 * 备份账本：上次导出成功的时间、当时导出多少条、以及"以后再说"的起点。
 * 这里只做读写；"该不该提醒"在 utils/backup.js（那边是纯函数，边界被测过）。
 */
function backupInfo() {
  let raw = null
  try {
    raw = wx.getStorageSync(KEY_BACKUP)
  } catch (e) {
    raw = null
  }
  const b = raw || {}
  return {
    at: typeof b.at === 'number' ? b.at : 0,
    total: typeof b.total === 'number' ? b.total : 0,
    snoozeAt: typeof b.snoozeAt === 'number' ? b.snoozeAt : 0
  }
}

/**
 * 导出成功才调用。
 * total 要传「含归档」的总数——导出范围已经包含归档，两边口径必须一致，
 * 否则归档的那几条会让账本永远觉得"还有新东西没备"。
 */
function markBackup(total) {
  const next = { at: Date.now(), total: total || 0, snoozeAt: 0 }
  try {
    wx.setStorageSync(KEY_BACKUP, next)
  } catch (e) {
    console.error('[store] backup write failed', e)
  }
  return next
}

/** 点"以后再说"：不动上次备份的记录，只记一个静默起点 */
function snoozeBackup(now) {
  const next = Object.assign(backupInfo(), { snoozeAt: now || Date.now() })
  try {
    wx.setStorageSync(KEY_BACKUP, next)
  } catch (e) {
    console.error('[store] backup snooze failed', e)
  }
  return next
}

/**
 * 本机占用，两本账要分开看：
 * 1) storage：wx.setStorage 的键值存储，记录分片 + 偏好 + 草稿都在这里。
 *    上限由微信给（通常 10240KB = 10MB），跟账号/设备绑定，卸载小程序才清空。
 *    注意单键还有 1MB 的独立上限，所以记录拆成 10 片，这片统计看的是总量。
 * 2) media：USER_DATA_PATH 下的图片、录音文件。这些是"文件"，不吃上面的 10MB，
 *    单独有约 200MB 的本地文件配额；删记录时会顺手 unlink。
 *
 * @returns {{storageKB:number, limitKB:number, percent:number, mediaBytes:number, mediaCount:number}}
 */
function usage() {
  let storageKB = 0
  let limitKB = 0
  try {
    const info = wx.getStorageInfoSync()
    storageKB = info.currentSize || 0
    limitKB = info.limitSize || 0
  } catch (e) {
    // 开发者工具个别版本会抛错，按 0 处理，不影响页面
  }

  let mediaBytes = 0
  let mediaCount = 0
  const dir = (wx.env && wx.env.USER_DATA_PATH) || ''
  if (dir) {
    try {
      const fs = wx.getFileSystemManager()
      const names = fs.readdirSync(dir) || []
      names.forEach(name => {
        try {
          const st = fs.statSync(dir + '/' + name)
          if (!st) return
          if (typeof st.isFile === 'function' ? st.isFile() : !!st.size) {
            mediaBytes += st.size || 0
            mediaCount++
          }
        } catch (e) {
          // 单个文件读不到就跳过，统计不是关键路径
        }
      })
    } catch (e) {
      // 目录还没建（全新用户）时到这里，保持 0
    }
  }

  return {
    storageKB: storageKB,
    limitKB: limitKB,
    percent: limitKB ? Math.min(100, Math.round((storageKB / limitKB) * 100)) : 0,
    mediaBytes: mediaBytes,
    mediaCount: mediaCount
  }
}

module.exports = {
  MAX_RECORDS,
  MAX_PHOTOS,
  usage,
  list,
  query,
  search,
  get,
  count,
  tags,
  streak,
  heat,
  stats,
  trash,
  create,
  update,
  setStar,
  setArchive,
  remove,
  restore,
  destroy,
  removeMany,
  restoreMany,
  purge,
  clearAll,
  allRaw,
  importRecords,
  parseTags,
  saveDraft,
  getDraft,
  clearDraft,
  getPrefs,
  savePrefs,
  backupInfo,
  markBackup,
  snoozeBackup
}
