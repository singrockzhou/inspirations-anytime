/**
 * 语音转文字适配层
 *
 * 小程序没有"给一个音频文件、还一段文字"的官方能力，只有三条路：
 *   1) 微信同声传译插件 WechatSI —— 它的识别是"边录边转"，返回文字和录音文件
 *   2) wx.translateVoice —— 老接口，依赖 wx.startRecord 的 localId，新基础库已不可用
 *   3) 自建服务端 ASR —— 要后端，与本产品"数据不出本机"的前提冲突
 *
 * 因此这里做两件事：
 *   - 能力探测：能用插件就用，不能用就明确告诉页面"不可用"，绝不假装成功；
 *   - 统一出口：页面只调 transcribe()/available()，不关心底下是哪条路。
 *
 * 想启用真转写：把 USE_PLUGIN 改成 true，并在 app.json 里加
 *   "plugins": { "WechatSI": { "version": "0.3.5", "provider": "wx069ba97219f66d99" } }
 * 且在小程序后台「设置 → 第三方设置 → 插件管理」里添加该插件。
 * 没做这两步就打开开关，requirePlugin 会抛错，这里会捕获并降级为不可用。
 */
const i18n = require('./i18n')

const USE_PLUGIN = false
const PLUGIN_NAME = 'WechatSI'

let cached = null

/** 失败原因 → 当前语言的说明。label 不进缓存，否则切换语言后还是旧文案 */
function labelFor(state) {
  if (state.ok) return i18n.t('asr:plugin')
  const map = {
    'not-enabled': 'asr:not_enabled',
    'no-manager': 'asr:no_manager',
    'no-plugin': 'asr:no_plugin'
  }
  return i18n.t(map[state.reason] || 'asr:not_enabled')
}

function withLabel(state) {
  return { ok: !!state.ok, reason: state.reason, label: labelFor(state) }
}

/**
 * @returns {{ok:boolean, reason:string, label:string}}
 */
function availability() {
  if (cached) return withLabel(cached)

  if (!USE_PLUGIN) {
    cached = { ok: false, reason: 'not-enabled' }
    return withLabel(cached)
  }

  try {
    // 声明了插件才能拿到；没声明或后台未添加都会抛错
    const plugin = requirePlugin(PLUGIN_NAME)
    if (plugin && typeof plugin.getRecordRecognitionManager === 'function') {
      cached = { ok: true, reason: '' }
      return withLabel(cached)
    }
    cached = { ok: false, reason: 'no-manager' }
  } catch (e) {
    console.warn('[asr] 插件不可用:', (e && e.message) || e)
    cached = { ok: false, reason: 'no-plugin' }
  }
  return withLabel(cached)
}

/**
 * 转写一段已经录好的音频。
 * 插件只支持"边录边转"，对已落盘的 aac 文件无能为力，
 * 所以这里对文件输入一律返回 unsupported，由页面引导用户手动补一句。
 * @returns {Promise<string>}
 */
function transcribe() {
  const state = availability()
  if (!state.ok) {
    return Promise.reject({ code: 'unsupported', message: state.label })
  }
  return Promise.reject({
    code: 'file-unsupported',
    message: i18n.t('asr:cannot_retro')
  })
}

/**
 * 边说边转：返回一个控制器，供记录页在录音时旁路使用。
 * 插件的识别会自己录音，因此只能在"新录一条语音"时启用，
 * 不能叠加在我们自己的 RecorderManager 上，否则麦克风会被抢占。
 * @returns {null|{start:Function, stop:Function, onPartial:Function, onFinal:Function}}
 */
function createRealtime(options) {
  const state = availability()
  if (!state.ok) return null

  const opts = options || {}
  let manager = null
  try {
    const plugin = requirePlugin(PLUGIN_NAME)
    manager = plugin.getRecordRecognitionManager()
  } catch (e) {
    return null
  }
  if (!manager) return null

  manager.onRecognize = res => {
    if (opts.onPartial) opts.onPartial((res && res.result) || '')
  }
  manager.onStop = res => {
    if (opts.onFinal) {
      opts.onFinal({
        text: (res && res.result) || '',
        tempFilePath: (res && res.tempFilePath) || '',
        duration: (res && res.duration) || 0
      })
    }
  }
  manager.onError = err => {
    if (opts.onError) opts.onError(err)
  }

  return {
    start() {
      manager.start({ duration: 60000, lang: 'zh_CN' })
    },
    stop() {
      manager.stop()
    }
  }
}

module.exports = {
  availability,
  transcribe,
  createRealtime
}
