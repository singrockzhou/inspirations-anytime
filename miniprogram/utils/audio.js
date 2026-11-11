/**
 * 全局单例播放器
 * 列表里同时存在多条语音，但同一时刻只该有一条在响，
 * 因此不按卡片创建 AudioContext，而是共用这一个。
 */
let ctx = null
let handlers = {}
let paused = false

function ensure() {
  if (ctx) return ctx
  ctx = wx.createInnerAudioContext()
  // 静音模式下也要能听见，否则用户会以为"点了没反应"
  ctx.obeyMuteSwitch = false
  ctx.onEnded(() => {
    const fn = handlers.end
    handlers = {}
    paused = false
    if (fn) fn()
  })
  // 播放进度：列表里的音频要能画出走到哪儿了
  ctx.onTimeUpdate(() => {
    const fn = handlers.time
    if (fn) fn({ currentTime: ctx.currentTime || 0, duration: ctx.duration || 0 })
  })
  ctx.onError(err => {
    const fn = handlers.error
    handlers = {}
    paused = false
    if (fn) fn(err)
  })
  return ctx
}

/**
 * @param {string} src 本地文件路径
 * @param {{end?: Function, time?: Function, error?: Function}} cb
 */
function play(src, cb) {
  const c = ensure()
  c.stop()
  handlers = cb || {}
  paused = false
  c.src = src
  c.play()
}

/** 暂停：保留进度，再 resume 从原处continue */
function pause() {
  if (!ctx) return
  ctx.pause()
  paused = true
}

function resume() {
  if (!ctx) return
  ctx.play()
  paused = false
}

function isPaused() {
  return paused
}

function stop() {
  if (!ctx) return
  ctx.stop()
  handlers = {}
  paused = false
}

/** 页面卸载时调用，避免离开后还有声音 */
function release() {
  if (!ctx) return
  ctx.stop()
  ctx.destroy()
  ctx = null
  handlers = {}
  paused = false
}

module.exports = { play, pause, resume, isPaused, stop, release }
