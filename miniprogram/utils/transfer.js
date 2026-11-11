/**
 * 换设备时的数据搬移
 *
 * 为什么不是"存到云"/"同步"：这个产品的承诺是数据只在本机。
 * 所以换设备只能靠一次显式的「导出文件 → 传到新设备 → 导入」。
 *
 * 关键点：记录里的 mediaPath 指向本机沙箱目录，换机必然失效，
 * 因此导出时把图片/录音读成 base64 内嵌进 JSON，导入时再写回新机的沙箱。
 * 媒体体积大，设了单条 2MB / 总计 15MB 的上限，超出的条目只迁文字，并在结果里如实报告。
 */
const store = require('./store')

const APP_TAG = 'linggan-suishi-ji'
const FORMAT_VERSION = 1
const USER_DIR = (wx.env && wx.env.USER_DATA_PATH) || ''

const MAX_MEDIA_ONE = 2 * 1024 * 1024
const MAX_MEDIA_TOTAL = 15 * 1024 * 1024

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
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }
    if (r.mediaPath) {
      const size = fileSize(r.mediaPath)
      const ok = size > 0 && size <= MAX_MEDIA_ONE && mediaTotal + size <= MAX_MEDIA_TOTAL
      if (ok) {
        const b64 = readBase64(r.mediaPath)
        if (b64) {
          out.media = { ext: extOf(r.mediaPath), b64: b64 }
          mediaTotal += size
          mediaCarried++
          return out
        }
      }
      mediaDropped++
    }
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

/**
 * 导出：写临时 JSON → 桌面端存盘 / 手机端转发到微信
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

    const done = mode => resolve(Object.assign({ mode: mode, fileName: fileName, filePath: filePath }, built.stats))

    // 桌面端：直接存到磁盘，用户拿到一个文件最省事
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

    // 手机端：转发给「文件传输助手」，再从聊天记录里拿到文件
    if (wx.shareFileMessage) {
      share()
      return
    }

    reject({ code: 'unsupported' })
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
          if (r && r.media && r.media.b64) {
            const path = writeBase64(r.media.b64, r.media.ext)
            if (path) {
              r.mediaPath = path
              mediaRestored++
            } else {
              r.mediaPath = ''
              mediaFailed++
            }
          }
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

module.exports = {
  APP_TAG,
  FORMAT_VERSION,
  exportBackup,
  importBackup,
  buildPayload
}
