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
/** 一次从聊天取图的上限，与选择器的 count、store.MAX_PHOTOS 保持同一个数 */
const MAX_CHAT_IMAGES = 9

/**
 * 明确收不了的类型：视频、音频、压缩包、安装包。
 *
 * 为什么要单独列一份、而不是统一走"留个文件名占位"：
 * 给 PDF/Word 留壳是有用的（用户知道这份文档在这儿，可以自己补一句），
 * 但给一个 .mp4 留一条「来自「会议录像.mp4」」的记录纯属垃圾——点不开、听不了、
 * 还占着列表。收不了就当面说清楚，别让人以为存下了。
 */
const UNSUPPORTED_EXT = [
  'mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v', '3gp',
  'mp3', 'm4a', 'wav', 'aac', 'amr', 'silk', 'flac', 'ogg',
  'zip', 'rar', '7z', 'gz', 'tar', 'bz2',
  'apk', 'ipa', 'exe', 'dmg', 'iso'
]

/**
 * 文本类文件最多读多大。
 * readFileSync 是同步的，读一个 50MB 的 json 会把界面卡住，进度条一直在转——
 * 而正文最多只要 1000 字，读进来也是白读。
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

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

    // 文件名也按语言走：英文界面导出的备份叫 灵感随时记-xxx.json，
    // 用户在文件传输助手里翻半天认不出来，这条通路就白走了
    const fileName = i18n.t('transfer:json_prefix') + stamp() + '.json'
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
 * 三条原则，都是被真实反馈逼出来的：
 *
 *   1. **先认出它是什么**（走 utils/sniff）。聊天来的临时路径经常没有扩展名
 *      （iOS 是 wxfile://tmp_xxxx），只按路径猜后缀会把一张截图判成"未知二进制"，
 *      于是列表里多出一条正文为「来自「78a4bca0…」」的空壳记录——看不懂也搜不到。
 *   2. **一个文件失败不连累其它**。成功的照常入库，失败的收进 skipped 里如实报告；
 *      只有全部失败才 reject，并且带上明细——不再用一句"文件可能已经损坏"打包所有原因。
 *   3. **一次选的几张图属于同一件事，合成一条**。用户一次勾 6 张图，这个动作本身
 *      就说明了"这是同一批"；拆成 6 条会把共享的那个语境（同一段对话、同一个需求）
 *      丢掉，还会把当天的卡片流刷满。所以图片按首次出现的位置占一个坑，后选的图
 *      往同一个坑里填，顺序不变；文本、文档仍然各成一条（它们本来就是独立内容）。
 *
 * @param {{onProgress?: function}} [options]
 *   onProgress(done, total) 每开始处理一个文件回调一次，用来显示「正在保存 3/6」。
 *   注意：调用方要等选择器返回之后再挂 loading——遮罩会把隐私授权弹窗挡住。
 *
 * @returns {Promise<{
 *   records: object[],  待入库的记录
 *   skipped: object[],  完全没存下的，[{name,reason,ext}]，reason 取 read/save/type
 *   shells: number,     只留下文件名的条数（PDF/Word 打不开正文，仍留着让用户补一句）
 *   failed: number,     skipped.length + shells，兼容旧调用
 *   compressed: number, 压过的张数
 *   savedBytes: number, 省下的字节
 *   photoCount: number, 存下的图片张数
 *   merged: boolean     是否把多张图合成了一条
 * }>}
 */
function importFromChat(options) {
  const opts = options || {}
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null

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
        /** 明确收不了的文件（视频/音频/压缩包/超大文本），要当面告诉用户 */
        const unsupported = []
        let shells = 0
        let compressed = 0
        let savedBytes = 0

        /**
         * 图片坑：-1 表示还没遇到图片，>=0 是这条合并记录在 records 里的下标。
         * 用"占位 + 回填"而不是"攒到最后再 push"，是为了让合并后的这条留在
         * 它第一次出现的位置上——顺序还是用户在聊天里看到的那个顺序。
         */
        let photoAt = -1
        const photoPaths = []
        let photoSize = 0
        let photoName = ''

        /** 收尾：把图片坑填成真正的记录；一张都没成时把坑删掉，不留空条 */
        const settlePhotos = () => {
          if (photoAt < 0) return
          const kept = photoPaths.slice(0, MAX_CHAT_IMAGES)
          if (photoPaths.length > kept.length) {
            // 选择器最多给 9 个，正常到不了这里；真超了就删掉多余的，别留孤儿文件
            require('./media').removeAll(photoPaths.slice(kept.length))
          }
          if (!kept.length) {
            records.splice(photoAt, 1)
            return
          }
          records[photoAt] = {
            type: 'photo',
            // 单张时文件名还有意义；多家图是"同一批"，写任何一张的名字都会误导
            content: kept.length === 1 && photoName ? i18n.t('transfer:from_file', { name: photoName }) : '',
            mediaPaths: kept,
            size: photoSize
          }
        }

        const step = i => {
          if (i >= files.length) {
            settlePhotos()
            // 一条都没成：把明细带出去，让页面能说清"是哪几个、为什么"
            if (!records.length) {
              // 全是"压根收不了"的类型时单独报一个码：这是最容易被看成"卡住了"的情形
              if (unsupported.length) reject({ code: 'unsupported_type', unsupported: unsupported, skipped: skipped })
              else reject({ code: 'read', skipped: skipped })
              return
            }
            resolve({
              records: records,
              skipped: skipped,
              unsupported: unsupported,
              shells: shells,
              failed: skipped.length + shells,
              compressed: compressed,
              savedBytes: savedBytes,
              photoCount: photoPaths.length,
              merged: photoPaths.length > 1
            })
            return
          }

          if (onProgress) onProgress(i + 1, files.length)

          const f = files[i]
          // classify 会自己去读文件头，极端情况下（文件被系统清掉）会抛错。
          // 抛错就等于这条链断了：loading 不会关，用户看到的就是"一直转圈"。
          let info
          try {
            info = sniff.classify(f)
          } catch (e) {
            skipped.push({ name: '', reason: 'read', ext: '' })
            step(i + 1)
            return
          }
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
                  // 第一次遇到图片才占坑；之后的图都填进同一个坑
                  if (photoAt < 0) {
                    photoAt = records.length
                    records.push(null)
                  }
                  if (!photoPaths.length && label) photoName = label
                  photoPaths.push(r.path)
                  photoSize += r.size || 0
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
            if ((f.size || 0) > MAX_TEXT_BYTES) {
              unsupported.push({ name: label, ext: info.ext, reason: 'big' })
              step(i + 1)
              return
            }
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

          /* ---------- 二进制：先判"明确收不了"，再决定留壳还是丢弃 ---------- */
          if (UNSUPPORTED_EXT.indexOf(String(info.ext || '').toLowerCase()) >= 0) {
            unsupported.push({ name: label, ext: info.ext, reason: 'type' })
            step(i + 1)
            return
          }
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
 * 取一次隐私授权状态，**只给诊断用，不参与任何流程判断**。
 *
 * `wx.getPrivacySetting` 从基础库 2.32.3 起才有；官方 API 页没有列出
 * 「微信 鸿蒙 OS 版」的支持情况，所以接口不在就返回 null，不猜它该返回什么。
 * 拿到的 `needAuthorization` 含义见官方《小程序隐私协议开发指南》二.2：
 * 为 true 表示微信侧还记着"这个用户有待同意的隐私政策"。
 */
function privacySnapshot() {
  return new Promise(resolve => {
    if (typeof wx.getPrivacySetting !== 'function') return resolve(null)
    wx.getPrivacySetting({
      success: res => resolve({ need: !!(res && res.needAuthorization) }),
      fail: () => resolve(null)
    })
  })
}

/**
 * 从剪贴板读一条文字。
 *
 * 时序上有一条来自真机验证的规矩：**先走一遍隐私授权，再读**。
 *
 * v1.8.0 ~ v1.8.4 一直是这个顺序，你在手机上读到过。v1.8.5 我把它改成
 * "先直接读、失败再补授权"，理由是"异步会脱离用户点击的时机"——这个理由是我
 * 臆想的：官方文档对 getClipboardData 只字未提手势要求，还明确标注
 * "微信鸿蒙 OS 版：支持"。改完之后鸿蒙上回 `fail:system permission denied`。
 *
 * 那句 errMsg 的成因**至今没有出处**：官方《隐私协议开发指南》列出的隐私错误
 * 只有 `api scope is not declared in the privacy agreement`(errno 112)、
 * `appid privacy api banned`、用户拒绝弹窗(103/104)，没有这一句。
 * 所以它到底来自微信还是鸿蒙系统，属于未知，不做结论，只如实上报。
 *
 * 顺序固定回：先 ensurePrivacy（首次会弹系统隐私框），再读。
 * 万一第一次授权被弹框/遮罩吞掉，失败后再补一次授权重读，最后才如实报错。
 * **任何一步都不下"这台机器读不到剪贴板"的结论。**
 */
function fromClipboard(attempt) {
  const tries = typeof attempt === 'number' ? attempt : 0

  return new Promise((resolve, reject) => {
    if (typeof wx.getClipboardData !== 'function') {
      reject({ code: 'unsupported' })
      return
    }

    let retriedPrivacy = false
    // 隐私授权那一步的原始 errMsg。只用于失败时的诊断行——
    // 不参与任何判断，避免把"猜的原因"当成流程分支（README 第 30 章的教训）。
    let privacyErr = ''

    const again = () => {
      if (tries >= 1) return false
      setTimeout(() => {
        fromClipboard(tries + 1).then(resolve, reject)
      }, 200)
      return true
    }

    const settle = res => {
      const raw = String((res && res.data) || '')
      // 首尾空白清掉；中间换行保留，那是用户原本的排版
      const text = raw.replace(/^\s+|\s+$/g, '')
      if (!text) {
        // 空有两种：真的没复制，或者内容还没交出来
        if (again()) return
        reject({ code: 'empty' })
        return
      }
      const kept = text.slice(0, MAX_TEXT)
      resolve({ text: kept, total: text.length, truncated: text.length > kept.length })
    }

    const read = () => wx.getClipboardData({ success: settle, fail: onFail })

    const onFail = err => {
      const msg = String((err && err.errMsg) || '')
      // 用户拒绝：「auth deny」/「...denied」；后台没声明用途：「api scope is not declared」
      // 正则必须显式写 denied：d-e-n-i-e-d 里没有 deny 这个连续子串，漏掉它就会
      // 把真实的 "permission denied" 误判成普通读失败。
      const denied = /denied|deny|auth|privacy|scope|112/i.test(msg)

      // 补一次授权再读。只补一次：授权框本身要用户点，反复补只会连环弹框。
      // 注意这里**不再解释** `system permission denied` 的成因——官方文档的
      // 隐私错误码只有 103/104/112 和 `appid privacy api banned` 这几种，
      // 没有这一句，所以它到底来自微信还是鸿蒙系统，目前无出处，属于未知。
      if (!retriedPrivacy && (denied || /system permission denied/i.test(msg))) {
        retriedPrivacy = true
        const retry = () => setTimeout(read, 50)
        require('./media')
          .ensurePrivacyInfo()
          .then(info => {
            privacyErr = (info && info.errMsg) || ''
            retry()
          })
        return
      }

      // 非权限类失败（弹窗刚关、系统还在交接）值得再来一次
      if (!denied && again()) return
      console.warn('[transfer] 读剪贴板失败:', msg)
      // 三条线索一起交出去：隐私设置状态 / 授权那一步的 errMsg / 读取的 errMsg。
      // 少了前两条，「读不到」就只能靠猜，而这一轮已经猜错过一次了。
      privacySnapshot().then(snap => {
        const parts = []
        if (snap) parts.push('need=' + (snap.need ? '1' : '0'))
        if (privacyErr) parts.push('auth=' + privacyErr)
        parts.push('read=' + msg)
        reject({
          code: denied ? 'denied' : 'read',
          // 系统权限被关掉时 errMsg 是 `getClipboardData:fail:system permission denied`。
          // 这种情况只有"去系统设置里打开剪贴板"有用，讲小程序隐私授权是白讲，
          // 所以单独标出来，让页面能换成另一套提示（真机已确认，见 README 第 32 章）。
          sysDenied: /system permission denied/i.test(msg),
          detail: parts.join(' | ')
        })
      })
    }

    // 先授权，再读。这一行是 v1.8.4 的真机行为，不要再"优化"掉。
    require('./media')
      .ensurePrivacyInfo()
      .then(info => {
        privacyErr = (info && info.errMsg) || ''
        read()
      })
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
