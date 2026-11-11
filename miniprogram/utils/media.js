/**
 * 本地媒体文件处理
 * 文字以外的记录（照片/语音）拿到的都是临时路径，重启后失效，
 * 所以必须落到 wx.env.USER_DATA_PATH 里才能长期保存。
 */
const USER_DIR = (wx.env && wx.env.USER_DATA_PATH) || ''

function fs() {
  return wx.getFileSystemManager()
}

/** 只删自己目录下的文件，临时文件（http://tmp/...）交给微信自己回收 */
function remove(path) {
  if (!path) return
  if (!USER_DIR) return
  if (path.indexOf(USER_DIR) !== 0) return
  try {
    fs().unlink({ filePath: path, fail() {} })
  } catch (e) {
    // 文件已不存在时忽略
  }
}

/** 一批文件一起删，重复路径只删一次 */
function removeAll(paths) {
  const seen = {}
  ;(paths || []).forEach(p => {
    if (!p || seen[p]) return
    seen[p] = 1
    remove(p)
  })
}

function statSize(path) {
  try {
    const info = fs().statSync(path)
    return (info && info.size) || 0
  } catch (e) {
    return 0
  }
}

/** 把临时文件转存到用户目录，失败时降级为临时路径（本次会话可见） */
function persist(tempFilePath, prefix, ext) {
  return new Promise(resolve => {
    if (!tempFilePath) return resolve('')
    if (tempFilePath.indexOf(USER_DIR) === 0) return resolve(tempFilePath)
    const target =
      USER_DIR + '/' + prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + (ext || 'dat')
    fs().saveFile({
      tempFilePath: tempFilePath,
      filePath: target,
      success: res => resolve(res.savedFilePath || target),
      fail: err => {
        console.error('[media] saveFile failed', err)
        resolve(tempFilePath)
      }
    })
  })
}

/**
 * 隐私授权（基础库 2.32.3+）
 * 相册/相机/剪贴板都属于隐私接口，用户没同意过隐私协议时调用会直接失败，
 * 表现就是"点了没反应"。这里先争取一次授权机会；
 * 若后台还没配「用户隐私保护指引」，把失败交给具体接口抛出，便于提示到具体原因。
 */
function ensurePrivacy() {
  return new Promise(resolve => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') return resolve(true)
    wx.requirePrivacyAuthorize({
      success: () => resolve(true),
      fail: err => {
        console.warn('[media] 隐私授权未通过:', (err && err.errMsg) || err)
        resolve(true)
      }
    })
  })
}

/**
 * 选图：优先 chooseMedia（2.10.0+），老基础库回落到 chooseImage
 * @param {{sourceType?:string[], count?:number, camera?:string}} options
 *   sourceType=['camera'] 直接唤起系统相机，不出现相册/拍照的选择菜单
 *   camera 传 'back' 时优先后置摄像头，拍灵感素材一般用它
 * @returns {Promise<string[]>} 临时路径数组
 */
function chooseImages(options) {
  const opts = options || {}
  const sourceType = opts.sourceType && opts.sourceType.length ? opts.sourceType : ['album', 'camera']
  const count = Math.max(1, Math.min(9, opts.count || 1))
  const camera = opts.camera || 'back'

  return ensurePrivacy().then(
    () =>
      new Promise((resolve, reject) => {
        const hasMedia = typeof wx.chooseMedia === 'function'
        const hasImage = typeof wx.chooseImage === 'function'

        if (!hasMedia && !hasImage) {
          reject({ errMsg: 'chooseImage:fail 当前环境不支持选图' })
          return
        }

        if (hasMedia) {
          const params = {
            count: count,
            mediaType: ['image'],
            sourceType: sourceType,
            sizeType: ['compressed'],
            success: res => {
              const files = (res && res.tempFiles) || []
              const paths = files.map(f => f && f.tempFilePath).filter(Boolean)
              if (paths.length) resolve(paths)
              else reject({ errMsg: 'chooseMedia:fail 没有拿到图片' })
            },
            fail: reject
          }
          if (sourceType.indexOf('camera') >= 0) params.camera = camera
          wx.chooseMedia(params)
          return
        }

        wx.chooseImage({
          count: count,
          sizeType: ['compressed'],
          sourceType: sourceType,
          success: res => {
            const paths = ((res && res.tempFilePaths) || []).filter(Boolean)
            if (paths.length) resolve(paths)
            else reject({ errMsg: 'chooseImage:fail 没有拿到图片' })
          },
          fail: reject
        })
      })
  )
}

/** 单张版本：记录页「拍一张」直达相机时用 */
function chooseImage(options) {
  return chooseImages(Object.assign({ count: 1 }, options || {})).then(paths => paths[0])
}

/** 压缩：目标长边 1280 / ≤300KB（PRD 13 章媒体要求），失败则原图继续 */
function compress(src) {
  return new Promise(resolve => {
    if (!wx.compressImage) return resolve(src)
    wx.compressImage({
      src: src,
      quality: 70,
      success: res => resolve(res.tempFilePath || src),
      fail: () => resolve(src)
    })
  })
}

/** 选图 → 压缩 → 落盘，返回可直接入库的路径 */
function saveImage(tempFilePath) {
  return compress(tempFilePath)
    .then(path => persist(path, 'img', 'jpg'))
    .then(path => ({ path: path, size: statSize(path) }))
}

/** 多图：串行处理，避免同时压缩多张大图把内存顶爆 */
function saveImages(tempPaths) {
  const list = (tempPaths || []).filter(Boolean)
  const out = []
  return list
    .reduce(
      (chain, temp) =>
        chain.then(() =>
          saveImage(temp).then(res => {
            if (res.path) out.push(res)
          })
        ),
      Promise.resolve()
    )
    .then(() => out)
}

/** 语音同理，保存为 aac（16kHz 单声道，由录音参数保证） */
function saveVoice(tempFilePath) {
  return persist(tempFilePath, 'voice', 'aac').then(path => ({
    path: path,
    size: statSize(path)
  }))
}

/** 把任意文件存进用户目录（从聊天里导入的文件走这里） */
function saveFile(tempFilePath, ext) {
  return persist(tempFilePath, 'file', ext || 'dat').then(path => ({
    path: path,
    size: statSize(path)
  }))
}

module.exports = {
  remove,
  removeAll,
  statSize,
  persist,
  ensurePrivacy,
  chooseImage,
  chooseImages,
  saveImage,
  saveImages,
  saveVoice,
  saveFile
}
