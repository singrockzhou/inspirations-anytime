/**
 * 数据层（唯一读写本地存储的入口）
 *
 * 存储结构：一条平铺的数组，全部记录放在同一个 key 下。
 * 为什么不用分表/分页存储：单用户上限 1000 条，纯文本记录序列化后不过几百 KB，
 * 一次同步读写比多次异步分片更简单，也不会出现"分片之间时序错乱"的经典坑。
 *
 * 对外只暴露语义化方法，页面不直接碰 wx.getStorageSync。
 */
const media = require('./media')
const { uuid } = require('./id')

const KEY_RECORDS = 'lg.records.v1'
const KEY_META = 'lg.meta.v1'
const KEY_DRAFT = 'lg.draft.v1'

const MAX_RECORDS = 1000
/** 软删记录保留 24 小时再物理清除，够覆盖撤销与误操作排查 */
const TRASH_TTL = 24 * 60 * 60 * 1000

let cache = null

function readAll() {
  if (cache) return cache
  let list = []
  try {
    list = wx.getStorageSync(KEY_RECORDS)
  } catch (e) {
    console.error('[store] read failed', e)
  }
  if (!Array.isArray(list)) list = []
  cache = list
  return cache
}

/**
 * 写回存储。写失败（多半是空间不足）时把缓存置空，
 * 保证内存与磁盘不会静默分叉。
 */
function writeAll(list) {
  try {
    wx.setStorageSync(KEY_RECORDS, list)
    cache = list
    return true
  } catch (e) {
    console.error('[store] write failed', e)
    cache = null
    wx.showModal({
      title: '存不下了',
      content: '本机存储空间不足，先删掉几条旧灵感再试试。',
      showCancel: false,
      confirmText: '知道了'
    })
    return false
  }
}

function sortDesc(list) {
  return list.slice().sort((a, b) => b.createdAt - a.createdAt)
}

function clone(record) {
  return Object.assign({}, record)
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

/** 列表：默认只返回未删除的，按创建时间倒序 */
function list(options) {
  const includeDeleted = options && options.includeDeleted
  const all = readAll()
  const arr = includeDeleted ? all : activeOnly(all)
  return sortDesc(arr).map(clone)
}

function get(id) {
  const found = readAll().filter(r => r.id === id)[0]
  return found ? clone(found) : null
}

function count() {
  return activeOnly(readAll()).length
}

/** 我的页用的统计 */
function stats() {
  const arr = activeOnly(readAll())
  const byType = { text: 0, voice: 0, photo: 0 }
  let firstAt = 0
  let lastAt = 0
  arr.forEach(r => {
    byType[r.type] = (byType[r.type] || 0) + 1
    if (!firstAt || r.createdAt < firstAt) firstAt = r.createdAt
    if (r.createdAt > lastAt) lastAt = r.createdAt
  })
  return { total: arr.length, firstAt: firstAt, lastAt: lastAt, byType: byType }
}

/* ------------------------------ 写 ------------------------------ */

/**
 * 新建记录
 * @param {{type:string, content?:string, mediaPath?:string, duration?:number, size?:number}} input
 * @returns {object|null} 失败返回 null（已提示用户）
 */
function create(input) {
  const all = readAll()
  if (activeOnly(all).length >= MAX_RECORDS) {
    wx.showModal({
      title: '满 1000 条了',
      content: '先清掉一些不再需要的灵感，再继续记。',
      showCancel: false,
      confirmText: '知道了'
    })
    return null
  }

  const ts = Date.now()
  const record = {
    id: uuid(),
    type: input.type,
    content: input.content || '',
    mediaPath: input.mediaPath || '',
    duration: input.duration || 0,
    size: input.size || 0,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: 0
  }

  if (!writeAll(all.concat(record))) {
    // 落库失败，顺手把刚存进来的媒体文件删掉，别留孤儿
    media.remove(record.mediaPath)
    return null
  }
  touchMeta(ts)
  return clone(record)
}

/**
 * 更新记录。createdAt 永不变（列表顺序不会因为改一句话而跳动）。
 * 换图/换录音时，旧文件立即删除。
 */
function update(id, patch) {
  const all = readAll()
  const index = all.findIndex(r => r.id === id)
  if (index < 0) return null

  const prev = all[index]
  const next = Object.assign({}, prev, patch, { updatedAt: Date.now() })
  if (typeof next.content === 'string') next.content = next.content
  if (patch && patch.mediaPath && patch.mediaPath !== prev.mediaPath) {
    media.remove(prev.mediaPath)
  }

  const copy = all.slice()
  copy[index] = next
  if (!writeAll(copy)) return null
  return clone(next)
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
  const all = readAll()
  const index = all.findIndex(r => r.id === id)
  if (index < 0) return null
  const next = Object.assign({}, all[index], { deletedAt: 0 })
  const copy = all.slice()
  copy[index] = next
  if (!writeAll(copy)) return null
  return clone(next)
}

/** 物理清理过期的软删记录（启动、切后台时各跑一次） */
function purge() {
  const all = readAll()
  const now = Date.now()
  const keep = []
  let removed = 0
  all.forEach(r => {
    if (r.deletedAt && now - r.deletedAt > TRASH_TTL) {
      media.remove(r.mediaPath)
      removed++
      return
    }
    keep.push(r)
  })
  if (removed) writeAll(keep)
}

/** 清空全部：连媒体文件一起删干净 */
function clearAll() {
  readAll().forEach(r => media.remove(r.mediaPath))
  const ok = writeAll([])
  if (ok) {
    try {
      wx.removeStorageSync(KEY_META)
    } catch (e) {
      console.error('[store] meta clear failed', e)
    }
  }
  return ok
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

module.exports = {
  MAX_RECORDS,
  list,
  get,
  count,
  stats,
  create,
  update,
  remove,
  restore,
  purge,
  clearAll,
  saveDraft,
  getDraft,
  clearDraft
}
