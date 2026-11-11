/**
 * 全局单例播放器
 * 列表里同时存在多条语音，但同一时刻只该有一条在响，
 * 因此不按卡片创建 AudioContext，而是共用这一个。
 */
let ctx = null
let handlers = {}

function ensure() {
  if (ctx) return ctx
  ctx = wx.createInnerAudioContext()
  // 静音模式下也要能听见，否则用户会以为"点了没反应"
  ctx.obeyMuteSwitch = false
  ctx.onEnded(() => {
    const fn = handlers.end
    handlers = {}
    if (fn) fn()
  })
  ctx.onError(err => {
    const fn = handlers.error
    handlers = {}
    if (fn) fn(err)
  })
  return ctx
}

/**
 * @param {string} src 本地文件路径
 * @param {{end?: Function, error?: Function}} cb
 */
function play(src, cb) {
  const c = ensure()
  c.stop()
  handlers = cb || {}
  c.src = src
  c.play()
}

function stop() {
  if (!ctx) return
  ctx.stop()
  handlers = {}
}

/** 页面卸载时调用，避免离开后还有声音 */
function release() {
  if (!ctx) return
  ctx.stop()
  ctx.destroy()
  ctx = null
  handlers = {}
}

module.exports = { play, stop, release }
