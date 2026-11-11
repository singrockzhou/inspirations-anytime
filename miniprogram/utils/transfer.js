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

const APP_TAG = 'linggan-suishi-ji'
const FORMAT_VERSION = 2
const USER_DIR = (wx.env && wx.env.USER_DATA_PATH) || ''

const MAX_MEDIA_ONE = 2 * 1024 * 1024
const MAX_MEDIA_TOTAL = 15 * 1024 * 1024
/** 单条正文上限，与记录页的 maxlength 对齐；从剪贴板/文件进来的文字都按它截 */
const MAX_TEXT = 1000

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()]
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
    const records = store.list()
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
      .then(res => resolve(Object.assign(res, built.stats)))
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
    lines.push('# 灵感随时记 · 摘录')
    lines.push('')
    lines.push('导出时间：' + dayStamp(Date.now()) + ' ' + hhmm(Date.now()))
    lines.push('共 ' + list.length + ' 条')
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
        const typeLabel = r.type === 'voice' ? '语音 ' + (r.duration || 0) + '″' : r.type === 'photo' ? '照片' : '文字'
        lines.push('**' + hhmm(r.createdAt) + ' · ' + typeLabel + '**')
        if (r.tags && r.tags.length) lines.push(r.tags.map(t => '`#' + t + '`').join(' '))
        if (r.content) lines.push('')
        if (r.content) lines.push(r.content)
        const paths = mediaPathsOf(r)
        if (paths.length) {
          lines.push('')
          lines.push(r.type === 'voice' ? '> 附一段录音' : '> 附 ' + paths.length + ' 张图片')
        }
        lines.push('')
      })

    const fileName = '灵感摘录-' + stamp() + '.md'
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
 * 从聊天里挑一个文件，存成一条灵感。
 * 文本文件读前 1000 字进正文；图片落盘成照片记录；其他类型只留文件名。
 * @returns {Promise<{records:object[]}>}
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
        let failed = 0

        const step = i => {
          if (i >= files.length) {
            if (!records.length) reject({ code: failed ? 'read' : 'nofile' })
            else resolve({ records: records, failed: failed })
            return
          }
          const f = files[i]
          const name = f.name || '来自聊天'
          const ext = extOf(f.path)
          const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].indexOf(ext) >= 0
          const isText = ['txt', 'md', 'markdown', 'json', 'csv'].indexOf(ext) >= 0

          if (isImage) {
            require('./media')
              .saveFile(f.path, ext)
              .then(r => {
                if (r.path) {
                  records.push({ type: 'photo', content: '来自「' + name + '」', mediaPaths: [r.path], size: r.size })
                } else {
                  failed++
                }
                step(i + 1)
              })
            return
          }

          let body = ''
          if (isText) {
            try {
              body = String(fs().readFileSync(f.path, 'utf8') || '').slice(0, MAX_TEXT)
            } catch (e) {
              body = ''
            }
          }
          if (!body) {
            // 读不出正文（PDF/Word 等二进制）时，至少把文件名留下来，之后能补一句
            body = '来自「' + name + '」'
            failed++
          }
          records.push({ type: 'text', content: body })
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
  exportBackup,
  exportText,
  importBackup,
  importFromChat,
  fromClipboard,
  buildPayload
}
