/**
 * 数据搬移：换设备的完整备份 + 选中条目的纯文本导出
 *
 * 为什么不是"存到云"/"同步"：这个产品的承诺是数据只在本机。
 * 所以换设备只能靠一次显式的「导出文件 → 传到新设备 → 导入」。
 *
 * 关键点：记录里的 mediaPath / mediaPaths 指向本机沙箱目录，换机必然失效，
 * 因此导出时把图片/录音读成 base64 内嵌进 JSON，导入时再写回新机的沙箱。
 * 媒体体积大，设了单条 2MB / 总计 15MB 的上限，超出的条目只迁文字，并在结果里如实报告。
 */
const store = require('./store')
const i18n = require('./i18n')
const sniff = require('./sniff')

const APP_TAG = 'linggan-suishi-ji'
const FORMAT_VERSION = 2
const USER_DIR = (wx.env && wx.env.USER_DATA_PATH) || ''

const MAX_MEDIA_ONE = 2 * 1024 * 1024
const MAX_MEDIA_TOTAL = 15 * 1024 * 1024
/** 单条正文上限，与记录页的 maxlength 对齐；从剪贴板/文件进来的文字都按它截 */
const MAX_TEXT = 1000

/**
 * 导出失败的码表。首页的备份横幅和「我的 → 导出到文件」是两个入口、同一条链路，
 * 文案放在这里只写一次，改的时候不会漏掉另一个。
 */
const EXPORT_ERR = i18n.table('transfer', [
  'empty',
  'serialize',
  'write',
  'save',
  'share',
  'unsupported'
], 'err')

function fs() {
  return wx.getFileSystemManager()
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function stamp() {
  const d = new Date()
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes())
  )
}

function dayStamp(ts) {
  const d = new Date(ts)
  return (
    i18n.t('date:year_month_day', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }) +
    ' ' +
    i18n.t('date:week' + d.getDay())
  )
}

function hhmm(ts) {
  const d = new Date(ts)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function extOf(path) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path || '')
  return m ? m[1].toLowerCase() : 'dat'
}

function fileSize(path) {
  try {
    const info = fs().statSync(path)
    return (info && info.size) || 0
  } catch (e) {
    return 0
  }
}

function readBase64(path) {
  try {
    return fs().readFileSync(path, 'base64') || ''
  } catch (e) {
    return ''
  }
}

function writeBase64(b64, ext) {
  const target =
    USER_DIR + '/import_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + (ext || 'dat')
  try {
    fs().writeFileSync(target, b64, 'base64')
    return target
  } catch (e) {
    console.error('[transfer] 媒体还原失败', e)
    return ''
  }
}

function isDesktop() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    const p = (info && info.platform) || ''
    return p === 'windows' || p === 'mac' || p === 'devtools'
  } catch (e) {
    return false
  }
}

/** 记录里所有需要搬走的媒体路径 */
function mediaPathsOf(record) {
  if (!record) return []
  if (record.type === 'voice') return record.mediaPath ? [record.mediaPath] : []
  const list = Array.isArray(record.mediaPaths) && record.mediaPaths.length
    ? record.mediaPaths
    : record.mediaPath
      ? [record.mediaPath]
      : []
  return list.slice()
}

/** 组装快照对象（纯函数，方便单测） */
function buildPayload(records) {
  let mediaTotal = 0
  let mediaCarried = 0
  let mediaDropped = 0

  const items = records.map(r => {
    const out = {
      id: r.id,
      type: r.type,
      content: r.content || '',
      duration: r.duration || 0,
      tags: r.tags || [],
      starred: r.starred || 0,
      archivedAt: r.archivedAt || 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }

    const paths = mediaPathsOf(r)
    if (!paths.length) return out

    const carried = []
    paths.forEach(p => {
      const size = fileSize(p)
      const ok = size > 0 && size <= MAX_MEDIA_ONE && mediaTotal + size <= MAX_MEDIA_TOTAL
      if (!ok) {
        mediaDropped++
        return
      }
      const b64 = readBase64(p)
      if (!b64) {
        mediaDropped++
        return
      }
      carried.push({ ext: extOf(p), b64: b64 })
      mediaTotal += size
      mediaCarried++
    })

    if (carried.length) out.mediaList = carried
    return out
  })

  return {
    payload: {
      app: APP_TAG,
      version: FORMAT_VERSION,
      exportedAt: Date.now(),
      count: items.length,
      records: items
    },
    stats: { total: items.length, mediaCarried: mediaCarried, mediaDropped: mediaDropped }
  }
}

/** 写文件 → 桌面端存盘 / 手机端转发到微信 */
function deliverFile(filePath, fileName) {
  return new Promise((resolve, reject) => {
    const done = mode => resolve({ mode: mode, fileName: fileName, filePath: filePath })

    if (wx.saveFileToDisk && isDesktop()) {
      wx.saveFileToDisk({
        filePath: filePath,
        fileName: fileName,
        success: () => done('disk'),
        fail: err => {
          if (String(err && err.errMsg).indexOf('cancel') >= 0) done('cancel')
          else if (wx.shareFileMessage) share()
          else reject({ code: 'save' })
        }
      })
      return
    }

    function share() {
      wx.shareFileMessage({
        filePath: filePath,
        fileName: fileName,
        success: () => done('share'),
        fail: err => {
          if (String(err && err.errMsg).indexOf('cancel') >= 0) done('cancel')
          else reject({ code: 'share' })
        }
      })
    }

    if (wx.shareFileMessage) {
      share()
      return
    }

    reject({ code: 'unsupported' })
  })
}

/**
 * 导出全量备份
 * @returns {Promise<{total, mediaCarried, mediaDropped, mode, fileName, filePath}>}
 */
function exportBackup() {
  return new Promise((resolve, reject) => {
    // 必须带上归档：归档只是"收起来"，不是"不要了"。少了这一步，用户换手机后
    // 归档过的内容会静默消失，而且他永远不知道少了什么。
    const records = store.list({ includeArchived: true })
    if (!records.length) {
      reject({ code: 'empty' })
      return
    }

    const built = buildPayload(records)
    let text = ''
    try {
      text = JSON.stringify(built.payload)
    } catch (e) {
      reject({ code: 'serialize' })
      return
    }

    const fileName = '灵感随时记-' + stamp() + '.json'
    const filePath = USER_DIR + '/' + fileName
    try {
      fs().writeFileSync(filePath, text, 'utf8')
    } catch (e) {
      reject({ code: 'write' })
      return
    }

    deliverFile(filePath, fileName)
      .then(res => {
        // 文件真的交到用户手里（转发出去或存到电脑）才记账。用户自己取消不算，
        // 否则账本会显示"已备份"，而他手里其实什么都没有。
        if (res.mode !== 'cancel') store.markBackup(records.length)
        resolve(Object.assign(res, built.stats))
      })
      .catch(reject)
  })
}

/**
 * 把选中的若干条导出成纯文本（Markdown 风格），用于贴到别处或存档。
 * 图片/语音只留占位标记，不带二进制——这份文件的用途是"可读"，不是"可还原"。
 */
function exportText(records) {
  return new Promise((resolve, reject) => {
    const list = (records || []).slice()
    if (!list.length) {
      reject({ code: 'empty' })
      return
    }

    const lines = []
    lines.push(i18n.t('transfer:md_title'))
    lines.push('')
    lines.push(i18n.t('transfer:md_time', { t: dayStamp(Date.now()) + ' ' + hhmm(Date.now()) }))
    lines.push(i18n.t('transfer:md_count', { n: list.length }))
    lines.push('')

    let currentDay = ''
    // 按时间正序写成流水，读起来比倒序自然
    list
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach(r => {
        const day = dayStamp(r.createdAt)
        if (day !== currentDay) {
          currentDay = day
          lines.push('## ' + day)
          lines.push('')
        }
        const typeLabel =
          r.type === 'voice'
            ? i18n.t('common:type_voice') + ' ' + (r.duration || 0) + '″'
            : r.type === 'photo'
              ? i18n.t('common:type_photo')
              : i18n.t('common:type_text')
        lines.push('**' + hhmm(r.createdAt) + ' · ' + typeLabel + '**')
        if (r.tags && r.tags.length) lines.push(r.tags.map(t => '`#' + t + '`').join(' '))
        if (r.content) lines.push('')
        if (r.content) lines.push(r.content)
        const paths = mediaPathsOf(r)
        if (paths.length) {
          lines.push('')
          lines.push(
            r.type === 'voice'
              ? i18n.t('transfer:md_audio')
              : i18n.t('transfer:md_images', { n: paths.length })
          )
        }
        lines.push('')
      })

    const fileName = i18n.t('transfer:md_prefix') + stamp() + '.md'
    const filePath = USER_DIR + '/' + fileName
    try {
      fs().writeFileSync(filePath, lines.join('\n'), 'utf8')
    } catch (e) {
      reject({ code: 'write' })
      return
    }

    deliverFile(filePath, fileName)
      .then(res => resolve(Object.assign(res, { total: list.length })))
      .catch(reject)
  })
}

/**
 * 导入：从聊天记录选一个之前导出的 json
 * @returns {Promise<{added, skipped, mediaRestored, mediaFailed, exportedAt}>}
 */
function importBackup() {
  return new Promise((resolve, reject) => {
    if (typeof wx.chooseMessageFile !== 'function') {
      reject({ code: 'unsupported' })
      return
    }

    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: res => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.path) {
          reject({ code: 'nofile' })
          return
        }

        let text = ''
        try {
          text = fs().readFileSync(file.path, 'utf8')
        } catch (e) {
          reject({ code: 'read' })
          return
        }

        let payload = null
        try {
          payload = JSON.parse(text)
        } catch (e) {
          reject({ code: 'parse' })
          return
        }

        if (!payload || payload.app !== APP_TAG || !Array.isArray(payload.records)) {
          reject({ code: 'format' })
          return
        }

        let mediaRestored = 0
        let mediaFailed = 0
        payload.records.forEach(r => {
          if (!r) return
          // v1 只有单个 media，v2 是 mediaList；两种都认
          const bags = Array.isArray(r.mediaList) ? r.mediaList : r.media && r.media.b64 ? [r.media] : []
          if (!bags.length) return

          const paths = []
          bags.forEach(bag => {
            if (!bag || !bag.b64) return
            const path = writeBase64(bag.b64, bag.ext)
            if (path) {
              paths.push(path)
              mediaRestored++
            } else {
              mediaFailed++
            }
          })
          r.mediaPaths = paths
          r.mediaPath = paths[0] || ''
          delete r.media
          delete r.mediaList
        })

        const result = store.importRecords(payload.records)
        resolve({
          added: result.added,
          skipped: result.skipped,
          mediaRestored: mediaRestored,
          mediaFailed: mediaFailed,
          exportedAt: payload.exportedAt || 0
        })
      },
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        reject({ code: msg.indexOf('cancel') >= 0 ? 'cancel' : 'choose' })
      }
    })
  })
}

/**
 * 从聊天里挑文件，存成灵感。
 *
 * 两条原则，都是被真实反馈逼出来的：
 *
 *   1. **先认出它是什么**（走 utils/sniff）。聊天来的临时路径经常没有扩展名
 *      （iOS 是 wxfile://tmp_xxxx），只按路径猜后缀会把一张截图判成"未知二进制"，
 *      于是列表里多出一条正文为「来自「78a4bca0…」」的空壳记录——看不懂也搜不到。
 *   2. **一个文件失败不连累其它**。成功的照常入库，失败的收进 skipped 里如实报告；
 *      只有全部失败才 reject，并且带上明细——不再用一句"文件可能已经损坏"打包所有原因。
 *
 * @returns {Promise<{
 *   records: object[],  待入库的记录
 *   skipped: object[],  完全没存下的，[{name,reason,ext}]，reason 取 read/save/type
 *   shells: number,     只留下文件名的条数（PDF/Word 打不开正文，仍留着让用户补一句）
 *   failed: number,     skipped.length + shells，兼容旧调用
 *   compressed: number, 压过的张数
 *   savedBytes: number  省下的字节
 * }>}
 */
function importFromChat() {
  return new Promise((resolve, reject) => {
    if (typeof wx.chooseMessageFile !== 'function') {
      reject({ code: 'unsupported' })
      return
    }

    wx.chooseMessageFile({
      count: 9,
      type: 'all',
      success: res => {
        const files = (res.tempFiles || []).filter(f => f && f.path)
        if (!files.length) {
          reject({ code: 'nofile' })
          return
        }

        const records = []
        const skipped = []
        let shells = 0
        let compressed = 0
        let savedBytes = 0

        const step = i => {
          if (i >= files.length) {
            // 一条都没成：把明细带出去，让页面能说清"是哪几个、为什么"
            if (!records.length) {
              reject({ code: 'read', skipped: skipped })
              return
            }
            resolve({
              records: records,
              skipped: skipped,
              shells: shells,
              failed: skipped.length + shells,
              compressed: compressed,
              savedBytes: savedBytes
            })
            return
          }

          const f = files[i]
          const info = sniff.classify(f)
          const label = info.label // 机器名（哈希）在这里是空串

          /* ---------- 图片：压缩后落盘，失败也要退到"存原件"再退"报告" ---------- */
          if (info.kind === 'image') {
            const media = require('./media')
            const keepOriginal = () =>
              media
                .persist(f.path, 'img', info.ext || 'jpg')
                .then(p => (p ? { path: p, size: 0, originSize: f.size || 0, compressed: false } : null))
                .catch(() => null)

            media
              .saveChatImage(f.path, info.ext || 'jpg', f.size || 0)
              .then(r => (r && r.path ? r : keepOriginal()))
              .catch(() => keepOriginal())
              .then(r => {
                if (!r || !r.path) {
                  skipped.push({ name: label, reason: 'save', ext: info.ext })
                } else {
                  records.push({
                    // 名字是哈希就不写字：宁可只有一张图，也不要一串看不懂的编号当正文
                    type: 'photo',
                    content: label ? i18n.t('transfer:from_file', { name: label }) : '',
                    mediaPaths: [r.path],
                    size: r.size || 0
                  })
                  if (r.compressed) {
                    compressed++
                    savedBytes += Math.max(0, (r.originSize || 0) - (r.size || 0))
                  }
                }
                step(i + 1)
              })
            return
          }

          /* ---------- 文本：能读出正文才算文本 ---------- */
          if (info.kind === 'text') {
            let body = ''
            try {
              body = String(fs().readFileSync(f.path, 'utf8') || '')
            } catch (e) {
              body = ''
            }
            // 去掉 BOM，再掐掉首尾空白——大量 txt 是 Windows 存的，开头藏着 \uFEFF
            body = body.replace(/^\uFEFF/, '').trim().slice(0, MAX_TEXT)

            if (body) {
              records.push({ type: 'text', content: body })
            } else if (label) {
              // 空文件但名字能读：留一条让用户补一句，总比什么都不留好
              records.push({ type: 'text', content: i18n.t('transfer:from_file', { name: label }) })
              shells++
            } else {
              skipped.push({ name: label, reason: 'read', ext: info.ext })
            }
            step(i + 1)
            return
          }

          /* ---------- 二进制：名字能读就留个壳，名字不能读就别往列表里塞垃圾 ---------- */
          if (label) {
            records.push({ type: 'text', content: i18n.t('transfer:from_file', { name: label }) })
            shells++
          } else {
            skipped.push({ name: label, reason: 'type', ext: info.ext })
          }
          step(i + 1)
        }

        step(0)
      },
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        reject({ code: msg.indexOf('cancel') >= 0 ? 'cancel' : 'choose' })
      }
    })
  })
}

/**
 * 从剪贴板收一条文字。
 *
 * 为什么只能这么做：微信不开放"读取聊天消息"的接口，
 * wx.chooseMessageFile 拿到的是文件，聊天里直接打的字不会出现在选择器里。
 * 唯一的合法通路是用户自己在聊天里长按复制，再由这里读剪贴板。
 *
 * 因此有两个必须守住的边界：
 *   1. 只能由用户点击触发，绝不自动读（iOS 读剪贴板会弹系统提示，偷偷读会吓到人）；
 *   2. 超长要如实告知截断位置，不静默丢字。
 *
 * @returns {Promise<{text:string, total:number, truncated:boolean}>}
 */
function fromClipboard() {
  return new Promise((resolve, reject) => {
    if (typeof wx.getClipboardData !== 'function') {
      reject({ code: 'unsupported' })
      return
    }

    const read = () => {
      wx.getClipboardData({
        success: res => {
          const raw = String((res && res.data) || '')
          // 首尾空白清掉；中间换行保留，那是用户原本的排版
          const text = raw.replace(/^\s+|\s+$/g, '')
          if (!text) {
            reject({ code: 'empty' })
            return
          }
          const kept = text.slice(0, MAX_TEXT)
          resolve({ text: kept, total: text.length, truncated: text.length > kept.length })
        },
        fail: err => {
          const msg = String((err && err.errMsg) || '')
          // 用户拒绝：「auth deny」；后台没声明隐私用途：「api scope is not declared」
          reject({ code: /deny|auth|privacy|scope/i.test(msg) ? 'denied' : 'read' })
        }
      })
    }

    // 剪贴板是隐私接口：先争取一次授权，失败也继续读，让具体错误浮现出来
    require('./media').ensurePrivacy().then(read, read)
  })
}

module.exports = {
  APP_TAG,
  FORMAT_VERSION,
  MAX_TEXT,
  EXPORT_ERR,
  exportBackup,
  exportText,
  importBackup,
  importFromChat,
  fromClipboard,
  buildPayload
}
