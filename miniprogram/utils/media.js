/**
 * 本地媒体文件处理
 * 文字以外的记录（照片/语音）拿到的都是临时路径，重启后失效，
 * 所以必须落到 wx.env.USER_DATA_PATH 里才能长期保存。
 */
const USER_DIR = wx.env.USER_DATA_PATH

function fs() {
  return wx.getFileSystemManager()
}

/** 只删自己目录下的文件，临时文件（http://tmp/...）交给微信自己回收 */
function remove(path) {
  if (!path) return
  if (path.indexOf(USER_DIR) !== 0) return
  try {
    fs().unlink({ filePath: path, fail() {} })
  } catch (e) {
    // 文件已不存在时忽略
  }
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
    const target = USER_DIR + '/' + prefix + '_' + Date.now() + '.' + (ext || 'dat')
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

/** 选图：优先 chooseMedia（2.10.0+），老基础库回落到 chooseImage */
function chooseImage() {
  return new Promise((resolve, reject) => {
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: res => resolve(res.tempFiles[0].tempFilePath),
        fail: reject
      })
      return
    }
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: res => resolve(res.tempFilePaths[0]),
      fail: reject
    })
  })
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

/** 语音同理，保存为 aac（16kHz 单声道，由录音参数保证） */
function saveVoice(tempFilePath) {
  return persist(tempFilePath, 'voice', 'aac').then(path => ({
    path: path,
    size: statSize(path)
  }))
}

module.exports = {
  remove,
  statSize,
  persist,
  chooseImage,
  saveImage,
  saveVoice
}
