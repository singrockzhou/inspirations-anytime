const store = require('../../utils/store')
const media = require('../../utils/media')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const asr = require('../../utils/asr')
const dialog = require('../../utils/dialog')
const i18n = require('../../utils/i18n')

const MAX_TEXT = 1000
const MAX_CAPTION = 200
const MAX_VOICE_SECONDS = 300
const MAX_PHOTOS = 9

/** 类型名随语言变，做成函数而不是常量（模块只执行一次，语言切了不会重跑） */
function typeLabel(type) {
  if (type === 'voice') return i18n.t('common:type_voice')
  if (type === 'photo') return i18n.t('common:type_photo')
  return i18n.t('common:type_text')
}

Page({
  data: {
    mode: 'create',
    type: 'text',
    content: '',
    mediaPath: '',
    duration: 0,
    size: 0,

    /** 照片：最多 9 张，结构 [{path, size}] */
    photos: [],
    maxPhotos: MAX_PHOTOS,

    statusBarHeight: 20,
    canSave: false,
    dirty: false,
    focus: false,
    saving: false,

    // 录音态
    recording: false,
    canceling: false,
    clickMode: false,
    recordClock: '00:00',
    recordSeconds: 0,
    hint: '',
    voicePlaying: false,

    /** 接入同声传译插件后为 true，录音时边录边出字 */
    asrReady: false,
    asrPartial: '',

    maxText: MAX_TEXT,
    maxCaption: MAX_CAPTION,
    toastText: '',
    /** 当前语言文案包 */
    t: {},
    /** 需要带数字或状态的句子，先在 js 里拼好再给 wxml */
    voiceRecordedText: '',
    counterText: '',
    /** 本机媒体用量提示条：'' 不显示 / 快满了 / 已满（只能记文字） */
    spaceTip: '',
    spaceFull: false
  },

  onLoad(options) {
    // 把 setData 包一层：只有动到「时长 / 照片」时才重算那两句带数字的话，
    // 免得在每个改 duration、photos 的地方都手动补一次；录音计时器每秒都在 setData，
    // 所以必须按字段过滤，不能无条件重算。
    const raw = this.setData.bind(this)
    this.setData = (patch, cb) => {
      raw(patch, cb)
      if (!patch) return
      const keys = Object.keys(patch)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        if (k === 'duration' || k === 'photos' || k === 'maxPhotos') {
          this.syncDerived(raw)
          return
        }
      }
    }
    this.setData({ t: i18n.pack('record') })
    this.syncDerived(raw)
    i18n.title(options.mode === 'edit' ? 'record:nav_edit' : 'nav:record')
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (info && info.statusBarHeight) || 20 })

    const mode = options.mode === 'edit' ? 'edit' : 'create'
    this.recordId = options.id || ''
    this.saved = false
    this.cancelFlag = false

    if (mode === 'edit') {
      const rec = store.get(this.recordId)
      if (!rec) {
        wx.showToast({ title: i18n.t('record:toast_gone'), icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
        return
      }
      this.setData({
        mode: 'edit',
        type: rec.type,
        content: rec.content,
        mediaPath: rec.mediaPath,
        photos: (rec.mediaPaths || []).map(p => ({ path: p, size: 0 })),
        duration: rec.duration,
        size: rec.size
      })
      this.syncCanSave()
    } else {
      const type = ['text', 'voice', 'photo'].indexOf(options.type) >= 0 ? options.type : 'text'
      this.setData({ mode: 'create', type: type })

      // 首页「拍一张」直达：进页面就把系统相机拉起来，中间不弹任何选择菜单
      this.autoCamera = type === 'photo' && options.auto === 'camera'

      // 文字草稿：上次没存下的那句话，回来还在
      if (type === 'text') {
        const draft = store.getDraft()
        if (draft) {
          this.setData({ content: draft.content })
          this.syncCanSave()
        }
      }
    }

    this.initRecorder()
  },

  onReady() {
    // 放在 onReady 而不是 onLoad：checkSpace 要把用户目录里的文件全 stat 一遍，
    // 几百张图时可能要一百多毫秒。等首帧画完再算，别让"点加号"顿一下。
    this.checkSpace()

    if (this.data.type === 'text') {
      // 让键盘跟着页面一起起来，少一次点击
      setTimeout(() => this.setData({ focus: true }), 120)
    }

    if (this.autoCamera) {
      this.autoCamera = false
      // 等页面转场动画走完再唤起相机，否则 iOS 上会因"过渡中"直接失败
      setTimeout(() => this.pickPhoto({ cameraOnly: true }), 320)
    }
  },

  /** 录音中来电/切后台：保留已录部分（PRD B2） */
  onHide() {
    if (this.data.recording) this.stopRecord(false)
    if (this.data.voicePlaying) {
      audio.stop()
      this.setData({ voicePlaying: false })
    }
  },

  onUnload() {
    this.unloaded = true
    this.stopTick()
    if (this.data.recording) {
      this.cancelFlag = true
      if (this.rt) this.rt.stop()
      else if (this.rm) this.rm.stop()
    }
    clearTimeout(this.draftTimer)
    audio.stop()
    if (typeof wx.disableAlertBeforeUnload === 'function') {
      try {
        wx.disableAlertBeforeUnload()
      } catch (e) {
        // ignore
      }
    }
  },

  /** 带数字的两句话：改时长、加减照片后重算一次 */
  syncDerived(raw) {
    raw({
      voiceRecordedText: i18n.t('record:voice_recorded', { n: this.data.duration || 0 }),
      counterText: i18n.t('record:counter_photos', {
        n: (this.data.photos || []).length,
        m: this.data.maxPhotos
      })
    })
  },

  /* ------------------------- 输入 ------------------------- */

  onInput(e) {
    this.setData({ content: e.detail.value })
    this.syncCanSave()
    this.markDirty()
    this.scheduleDraft()
  },

  scheduleDraft() {
    if (this.data.mode !== 'create' || this.data.type !== 'text') return
    clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      const raw = this.data.content
      if (raw && raw.trim()) store.saveDraft({ type: 'text', content: raw })
      else store.clearDraft()
    }, 300)
  },

  syncCanSave() {
    const text = (this.data.content || '').trim()
    let canSave = true
    if (this.data.type === 'text') canSave = !!text
    else if (this.data.type === 'photo') canSave = this.data.photos.length > 0
    else canSave = !!this.data.mediaPath
    this.setData({ canSave: canSave })
  },

  markDirty() {
    if (this.data.dirty) return
    this.setData({ dirty: true })
    if (typeof wx.enableAlertBeforeUnload === 'function') {
      try {
        wx.enableAlertBeforeUnload({ message: i18n.t('record:leave_confirm') })
      } catch (e) {
        // 低版本基础库没有该能力，靠取消按钮的确认兜底
      }
    }
  },

  unmarkDirty() {
    this.setData({ dirty: false })
    if (typeof wx.disableAlertBeforeUnload === 'function') {
      try {
        wx.disableAlertBeforeUnload()
      } catch (e) {
        // ignore
      }
    }
  },

  /* ------------------------- 类型切换 ------------------------- */

  onTab(e) {
    const next = e.currentTarget.dataset.type
    // 空间满了只留文字：不能等用户拍完 9 张、发现一张都没存下来才说
    if (next !== 'text' && next !== this.data.type && this.data.spaceFull) {
      this.toast(i18n.t('record:toast_space_full'))
      return
    }
    if (next === this.data.type) {
      // 已经在照片态又点「拍一张」，说明是想立刻拍照，别让它静默无响应
      if (next === 'photo' && !this.data.photos.length && !this.data.recording) this.pickPhoto()
      return
    }
    if (this.data.recording) {
      this.toast(i18n.t('record:toast_unfinished'))
      return
    }

    let has = false
    if (this.data.type === 'text') has = !!(this.data.content || '').trim()
    else if (this.data.type === 'photo') has = this.data.photos.length > 0
    else has = !!this.data.mediaPath

    if (!has) {
      this.applyType(next)
      return
    }

    dialog
      .confirm({
        title: i18n.t('record:switch_title'),
        text: i18n.t('record:switch_text', { type: typeLabel(this.data.type) }),
        cancelText: i18n.t('common:cancel'),
        confirmText: i18n.t('record:switch_ok')
      })
      .then(res => {
        if (res.confirmed) this.applyType(next)
      })
  },

  applyType(next) {
    // 一条记录只允许一种形态，切换时把已采集的内容彻底清掉
    if (this.data.mode === 'create') {
      if (this.data.photos.length) media.removeAll(this.data.photos.map(p => p.path))
      if (this.data.mediaPath) media.remove(this.data.mediaPath)
    }
    if (this.data.mode === 'create' && this.data.type === 'text') store.clearDraft()

    this.setData({
      type: next,
      content: '',
      mediaPath: '',
      photos: [],
      duration: 0,
      size: 0,
      hint: '',
      asrPartial: '',
      recording: false,
      focus: next === 'text' && this.data.mode === 'create'
    })
    this.unmarkDirty()
    this.syncCanSave()
  },

  /* ---------------------- 本机空间 ---------------------- */

  /**
   * 媒体用量检查：决定「提醒快满了」还是「只让记文字」。
   *
   * 为什么一定要放在记录页：用户是在这里拍照、录音，也只有在这个瞬间才需要
   * 知道「再存一张会发生什么」。只在「我的」页提示，等于把告示牌挂在仓库角落。
   *
   * @param {boolean} force 跳过 60 秒节流（落盘失败后要立刻重算）
   */
  checkSpace(force) {
    const now = Date.now()
    if (!force && this.spaceAt && now - this.spaceAt < 60000) return
    this.spaceAt = now

    let bytes = 0
    try {
      bytes = store.usage().mediaBytes || 0
    } catch (e) {
      bytes = 0
    }

    // 写盘失败过就算真满了：各端给的实际配额未必整齐的 200MB，
    // 一次真实的失败比一次估算可信。
    const full = !!this.spaceFailed || bytes >= store.MEDIA_FULL_BYTES
    const warn = !full && bytes >= store.MEDIA_WARN_BYTES

    let tip = ''
    if (full) tip = i18n.t('record:space_full')
    else if (warn) tip = i18n.t('record:space_warn', { size: this.sizeText(bytes) })

    this.setData({ spaceFull: full, spaceTip: tip })
  },

  /** 用量给用户看：MB / GB 不翻译，口径和「我的」页保持一致 */
  sizeText(bytes) {
    const mb = bytes / 1024 / 1024
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'
    return mb < 1 ? '<1 MB' : Math.round(mb) + ' MB'
  },

  /**
   * 落盘失败时统一走这里：记下"满了"、当场出声、立刻重算提示条。
   *
   * 以前静默退回临时路径，用户以为存住了，过几天照片自己消失——
   * 这类问题在评论区只会留下"小程序会丢东西"，说不清也修不掉。
   */
  onMediaFail() {
    const space = media.lastFailReason() === 'space'
    if (space) this.spaceFailed = true
    this.toast(space ? i18n.t('record:toast_space_full') : i18n.t('record:toast_media_fail'))
    this.checkSpace(true)
  },

  /* ------------------------- 保存 / 离开 ------------------------- */

  onSave() {
    if (this.data.saving) return

    const type = this.data.type
    const text = (this.data.content || '').trim()

    if (type === 'text' && !text) {
      this.toast(i18n.t('record:toast_empty_text'))
      return
    }
    if (type === 'photo' && !this.data.photos.length) {
      this.toast(i18n.t('record:toast_no_photo'))
      return
    }
    if (type === 'voice' && !this.data.mediaPath) {
      this.toast(i18n.t('record:toast_no_voice'))
      return
    }

    this.setData({ saving: true })

    const payload = {
      type: type,
      content: text,
      duration: this.data.duration
    }

    if (type === 'photo') {
      payload.mediaPaths = this.data.photos.map(p => p.path)
      payload.mediaPath = payload.mediaPaths[0] || ''
      payload.size = this.data.photos.reduce((sum, p) => sum + (p.size || 0), 0)
    } else {
      payload.mediaPath = this.data.mediaPath
      payload.size = this.data.size
    }

    const rec = this.data.mode === 'edit'
      ? store.update(this.recordId, payload)
      : store.create(payload)

    if (!rec) {
      this.setData({ saving: false })
      return
    }

    this.saved = true
    store.clearDraft()
    getApp().globalData.flashId = rec.id
    this.leave()
  },

  onCancel() {
    if (this.data.recording) {
      this.toast(i18n.t('record:toast_release_first'))
      return
    }
    if (!this.data.dirty) {
      this.leave()
      return
    }
    dialog
      .confirm({
        title: i18n.t('record:discard_title'),
        text: i18n.t('record:discard_text'),
        cancelText: i18n.t('record:discard_cancel'),
        confirmText: i18n.t('record:discard_ok'),
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        this.discard()
        this.leave()
      })
  },

  discard() {
    if (this.data.mode !== 'create') return
    store.clearDraft()
    // 编辑模式下这些文件属于库里已有的那条，不能删
    if (this.data.photos.length) media.removeAll(this.data.photos.map(p => p.path))
    if (this.data.mediaPath) media.remove(this.data.mediaPath)
  },

  leave() {
    if (typeof wx.disableAlertBeforeUnload === 'function') {
      try {
        wx.disableAlertBeforeUnload()
      } catch (e) {
        // ignore
      }
    }
    wx.navigateBack()
  },

  /* ------------------------- 录音 ------------------------- */

  initRecorder() {
    // 有转写能力时优先用插件的识别器（它自己录音并出字），否则用系统录音器
    const state = asr.availability()
    if (state.ok) {
      this.rt = asr.createRealtime({
        onPartial: text => {
          if (!this.data.recording) return
          this.setData({ asrPartial: text })
        },
        onFinal: res => this.onRealtimeStop(res),
        onError: err => {
          console.warn('[record] 转写中断', err)
          this.stopTick()
          this.setData({ recording: false, canceling: false })
          this.toast(i18n.t('record:toast_asr_break'))
        }
      })
      if (this.rt) this.setData({ asrReady: true })
    }

    if (!wx.getRecorderManager) return
    const rm = wx.getRecorderManager()
    this.rm = rm

    rm.onStop(res => this.onRecordStop(res))
    rm.onError(err => {
      console.error('[record] recorder error', err)
      this.stopTick()
      this.setData({ recording: false, canceling: false })
      this.toast(i18n.t('record:toast_rec_fail'))
    })
  },

  ensureAuth() {
    return new Promise(resolve => {
      wx.getSetting({
        success: res => {
          const granted = res.authSetting['scope.record']

          if (granted === true) {
            resolve(true)
            return
          }

          if (granted === false) {
            // 明确拒绝过，只能引导去设置页重新打开
            dialog
              .confirm({
                title: i18n.t('record:perm_mic_title'),
                text: i18n.t('record:perm_mic_text'),
                confirmText: i18n.t('record:perm_go')
              })
              .then(r => {
                if (!r.confirmed) {
                  resolve(false)
                  return
                }
                wx.openSetting({
                  success: s => resolve(!!s.authSetting['scope.record']),
                  fail: () => resolve(false)
                })
              })
            return
          }

          // 从没问过：先自己说明一句，再调起系统授权，避免开门见弹窗
          dialog
            .confirm({
              title: i18n.t('record:mic_title'),
              text: i18n.t('record:mic_text'),
              confirmText: i18n.t('record:mic_ok')
            })
            .then(r => {
              if (!r.confirmed) {
                resolve(false)
                return
              }
              wx.authorize({
                scope: 'scope.record',
                success: () => resolve(true),
                fail: () => resolve(false)
              })
            })
        },
        fail: () => resolve(false)
      })
    })
  },

  startRecord() {
    if (this.data.recording) return
    if (this.data.spaceFull) {
      this.toast(i18n.t('record:toast_space_full'))
      return
    }
    if (!this.rm && !this.rt) {
      this.toast(i18n.t('record:toast_no_recorder'))
      return
    }

    this.ensureAuth().then(ok => {
      if (!ok) {
        this.pendingStop = false
        return
      }
      this.recordStartAt = Date.now()
      this.hinted60 = false
      this.hinted240 = false
      this.setData({ recordSeconds: 0, recordClock: '00:00', hint: '', canceling: false, asrPartial: '' })

      if (this.rt) {
        this.rt.start()
      } else {
        this.rm.start({
          duration: MAX_VOICE_SECONDS * 1000,
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 48000,
          format: 'aac'
        })
      }
      this.setData({ recording: true })
      this.startTick()

      // 授权是异步的，手指可能在 onStart 之前就抬起来了
      if (this.pendingStop) {
        this.pendingStop = false
        this.stopRecord(false)
      }
    })
  },

  startTick() {
    this.stopTick()
    this.timer = setInterval(() => {
      const sec = Math.round((Date.now() - this.recordStartAt) / 1000)
      const patch = { recordSeconds: sec, recordClock: date.clock(sec) }

      // 60s / 240s 各提示一次，但不打断录音（PRD FR-04）
      if (sec >= 60 && !this.hinted60) {
        this.hinted60 = true
        wx.vibrateShort({ type: 'light', fail() {} })
        patch.hint = i18n.t('record:hint_4min')
      }
      if (sec >= 240 && !this.hinted240) {
        this.hinted240 = true
        wx.vibrateShort({ type: 'light', fail() {} })
        patch.hint = i18n.t('record:hint_1min')
      }
      this.setData(patch)
    }, 200)
  },

  stopTick() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  stopRecord(cancel) {
    if (!this.data.recording) return
    this.cancelFlag = !!cancel
    this.stopTick()
    this.setData({ recording: false, canceling: false })
    if (this.rt) this.rt.stop()
    else this.rm.stop()
  },

  onRecordStop(res) {
    this.stopTick()
    if (this.unloaded) return
    this.setData({ recording: false, canceling: false })

    if (this.cancelFlag) {
      this.cancelFlag = false
      this.setData({ hint: '', recordSeconds: 0, recordClock: '00:00' })
      return
    }

    const ms = (res && res.duration) || Date.now() - (this.recordStartAt || Date.now())
    if (ms < 1000 || !res || !res.tempFilePath) {
      this.toast(i18n.t('record:toast_too_short'))
      this.setData({ hint: '', recordSeconds: 0, recordClock: '00:00' })
      return
    }

    this.saveVoice(res.tempFilePath, Math.round(ms / 1000), '')
  },

  /** 插件路径：录音和识别一起回来的那种 */
  onRealtimeStop(res) {
    this.stopTick()
    if (this.unloaded) return
    this.setData({ recording: false, canceling: false })

    if (this.cancelFlag) {
      this.cancelFlag = false
      this.setData({ hint: '', recordSeconds: 0, recordClock: '00:00', asrPartial: '' })
      return
    }

    const text = (res && res.text) || ''
    const path = (res && res.tempFilePath) || ''
    const seconds = Math.round(((res && res.duration) || Date.now() - (this.recordStartAt || 0)) / 1000)

    if (!path) {
      // 转写拿到了字，但没有音频文件：退化成一条文字记录，别把内容丢了
      if (text) {
        this.setData({ type: 'text', content: text, asrPartial: '' })
        this.syncCanSave()
        this.markDirty()
        this.toast(i18n.t('record:toast_text_only'))
      } else {
        this.toast(i18n.t('record:toast_too_short'))
      }
      return
    }

    this.saveVoice(path, Math.max(1, seconds), text)
  },

  saveVoice(tempFilePath, seconds, text) {
    media.saveVoice(tempFilePath).then(({ path, size }) => {
      // 没落盘（空间满 / 文件读不出来）：绝不能把空路径写进记录，
      // 否则会留下一条"标着 8 秒、点开什么都没有"的语音
      if (!path) {
        this.onMediaFail()
        this.setData({ recordSeconds: 0, recordClock: '00:00', hint: '', asrPartial: '' })
        return
      }
      if (this.data.mediaPath && this.data.mode === 'create') media.remove(this.data.mediaPath)
      const patch = {
        mediaPath: path,
        duration: seconds,
        size: size,
        hint: '',
        recordSeconds: 0,
        recordClock: '00:00',
        asrPartial: ''
      }
      // 转写出来的字直接进正文，这样语音也能被搜到
      if (text && !(this.data.content || '').trim()) patch.content = text
      this.setData(patch)
      this.syncCanSave()
      this.markDirty()
    })
  },

  onVoiceTouchStart(e) {
    if (this.data.clickMode) return
    const touch = e.touches && e.touches[0]
    this.touchStartY = touch ? touch.clientY : 0
    this.pendingStop = false
    this.startRecord()
  },

  onVoiceTouchMove(e) {
    if (this.data.clickMode || !this.data.recording) return
    const touch = e.touches && e.touches[0]
    if (!touch) return
    // 上滑超过 60px 视为取消，松手后丢弃这段
    const canceling = this.touchStartY - touch.clientY > 60
    if (canceling !== this.data.canceling) this.setData({ canceling: canceling })
  },

  onVoiceTouchEnd() {
    if (this.data.clickMode) return
    if (!this.data.recording) {
      // 还在等授权，先把"已松手"记下来，等录音真正开始再立刻收尾
      this.pendingStop = true
      return
    }
    this.stopRecord(this.data.canceling)
  },

  onVoiceTap() {
    if (!this.data.clickMode) return
    if (this.data.recording) this.stopRecord(false)
    else this.startRecord()
  },

  toggleMode() {
    if (this.data.recording) return
    this.setData({ clickMode: !this.data.clickMode })
  },

  playVoice() {
    if (!this.data.mediaPath || this.data.recording) return
    if (this.data.voicePlaying) {
      audio.stop()
      this.setData({ voicePlaying: false })
      return
    }
    audio.play(this.data.mediaPath, {
      end: () => this.setData({ voicePlaying: false }),
      error: () => {
        this.setData({ voicePlaying: false })
        this.toast(i18n.t('common:not_found_voice'))
      }
    })
    this.setData({ voicePlaying: true })
  },

  /* ------------------------- 照片 ------------------------- */

  /**
   * 选图。分两种语义：
   *   cameraOnly=true  → 追加时替换全部（首页「拍一张」、重拍）
   *   cameraOnly=false → 往已有的后面追加，最多 9 张
   */
  pickPhoto(opts) {
    const cameraOnly = !!(opts && opts.cameraOnly)

    // 空间满了就别唤起相机了：拍完存不下来，比不让拍更伤人
    if (this.data.spaceFull) {
      this.toast(i18n.t('record:toast_space_full'))
      return
    }

    if (this.data.recording) {
      this.toast(i18n.t('record:toast_end_rec_first'))
      return
    }

    // 非小程序环境（网页预览等）里这些 API 不存在，直接调用会抛错并表现为"点了没反应"
    if (typeof wx.chooseMedia !== 'function' && typeof wx.chooseImage !== 'function') {
      console.warn('[record] chooseMedia / chooseImage 均不可用，当前环境不支持选图')
      this.toast(i18n.t('record:toast_no_camera'))
      return
    }

    const left = MAX_PHOTOS - this.data.photos.length
    if (!cameraOnly && left <= 0) {
      this.toast(i18n.t('record:toast_max_photos', { n: MAX_PHOTOS }))
      return
    }

    media.chooseImages({
      count: cameraOnly ? 1 : left,
      sourceType: cameraOnly ? ['camera'] : ['album', 'camera'],
      camera: 'back'
    })
      .then(tempPaths => {
        // 相机/相册回来之后才挂 loading，避免用户看到加载圈却等不到界面
        wx.showLoading({ title: i18n.t('common:processing'), mask: true })
        this.expectPhotos = tempPaths.length
        return media.saveImages(tempPaths).then(saved => {
          this.hideLoading()
          return saved
        })
      })
      .then(saved => {
        // 重拍时如果一张都没落盘，保留原来那几张：不能因为一次失败把已有的图清空
        const next = cameraOnly ? (saved.length ? saved : this.data.photos) : this.data.photos.concat(saved)
        const kept = next.slice(0, MAX_PHOTOS)
        // 超出 9 张的被丢掉，文件也要删掉，别留孤儿
        if (next.length > MAX_PHOTOS) {
          media.removeAll(next.slice(MAX_PHOTOS).map(p => p.path))
          this.toast(i18n.t('record:toast_max_photos', { n: MAX_PHOTOS }))
        }
        // 替换时，被换掉的旧图要删（编辑态除外，那些属于库里那条记录）
        // 只有真的换上了新图才删——否则会把保留下来的旧图文件删掉
        if (cameraOnly && saved.length && this.data.mode === 'create' && this.data.photos.length) {
          media.removeAll(this.data.photos.map(p => p.path))
        }
        this.setData({ photos: kept })
        this.syncCanSave()
        this.markDirty()
        // 放在最后：万一前面还提示了「最多 9 张」，也要让"没存下来"这条盖住它
        if (this.expectPhotos && saved.length < this.expectPhotos) this.onMediaFail()
      })
      .catch(err => {
        this.hideLoading()
        const msg = (err && (err.errMsg || err.message)) || String(err || '')
        console.warn('[record] pickPhoto 失败:', msg)
        if (msg.indexOf('cancel') >= 0) return
        if (/privacy|112|协议/.test(msg)) {
          this.toast(i18n.t('record:toast_privacy'))
          return
        }
        if (/auth|deny|permission|权限/.test(msg)) {
          this.toast(i18n.t('record:toast_no_perm'))
          return
        }
        this.toast(i18n.t('record:toast_pick_fail', { msg: msg.slice(0, 36) }))
      })
  },

  hideLoading() {
    try {
      wx.hideLoading()
    } catch (e) {
      // 没有 loading 时调用会告警，忽略
    }
  },

  removePhoto(e) {
    const index = Number(e.currentTarget.dataset.i)
    const photos = this.data.photos.slice()
    const hit = photos[index]
    if (!hit) return
    photos.splice(index, 1)
    if (this.data.mode === 'create') media.remove(hit.path)
    this.setData({ photos: photos })
    this.syncCanSave()
    if (photos.length) this.markDirty()
    else this.unmarkDirty()
  },

  previewMedia(e) {
    const index = Number(e.currentTarget.dataset.i)
    const urls = this.data.photos.map(p => p.path)
    if (!urls.length) return
    wx.previewImage({ current: urls[index] || urls[0], urls: urls })
  },

  previewVoice() {
    if (!this.data.mediaPath) return
    wx.previewImage({ current: this.data.mediaPath, urls: [this.data.mediaPath] })
  },

  /* ------------------------- 工具 ------------------------- */

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
