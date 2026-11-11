const store = require('../../utils/store')
const media = require('../../utils/media')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const asr = require('../../utils/asr')
const dialog = require('../../utils/dialog')

const MAX_TEXT = 1000
const MAX_CAPTION = 200
const MAX_VOICE_SECONDS = 300
const MAX_PHOTOS = 9

const TYPE_LABEL = { text: '文字', voice: '录音', photo: '照片' }

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
    toastText: ''
  },

  onLoad(options) {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (info && info.statusBarHeight) || 20 })

    const mode = options.mode === 'edit' ? 'edit' : 'create'
    this.recordId = options.id || ''
    this.saved = false
    this.cancelFlag = false

    if (mode === 'edit') {
      const rec = store.get(this.recordId)
      if (!rec) {
        wx.showToast({ title: '这条已经不在了', icon: 'none' })
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
        wx.enableAlertBeforeUnload({ message: '这段还没存下，确定离开吗？' })
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
    if (next === this.data.type) {
      // 已经在照片态又点「拍一张」，说明是想立刻拍照，别让它静默无响应
      if (next === 'photo' && !this.data.photos.length && !this.data.recording) this.pickPhoto()
      return
    }
    if (this.data.recording) {
      this.toast('这段还没录完')
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
        title: '换一种？',
        text: '刚才的' + TYPE_LABEL[this.data.type] + '会清掉',
        cancelText: '算了',
        confirmText: '换'
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

  /* ------------------------- 保存 / 离开 ------------------------- */

  onSave() {
    if (this.data.saving) return

    const type = this.data.type
    const text = (this.data.content || '').trim()

    if (type === 'text' && !text) {
      this.toast('还没写呢')
      return
    }
    if (type === 'photo' && !this.data.photos.length) {
      this.toast('还没选照片')
      return
    }
    if (type === 'voice' && !this.data.mediaPath) {
      this.toast('还没录')
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
      this.toast('先松开手')
      return
    }
    if (!this.data.dirty) {
      this.leave()
      return
    }
    dialog
      .confirm({
        title: '这段还留着吗？',
        text: '还没存下，离开就没了',
        cancelText: '继续写',
        confirmText: '丢掉',
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
          this.toast('转写中断了，再试一次')
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
      this.toast('录音没能开始，检查一下麦克风权限')
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
                title: '需要麦克风',
                text: '录一句话需要麦克风权限，去设置里打开？',
                confirmText: '去设置'
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
              title: '用麦克风',
              text: '录下你说的那句话，只存在这台手机上。',
              confirmText: '允许'
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
    if (!this.rm && !this.rt) {
      this.toast('当前环境不支持录音')
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
        patch.hint = '还能录 4 分钟'
      }
      if (sec >= 240 && !this.hinted240) {
        this.hinted240 = true
        wx.vibrateShort({ type: 'light', fail() {} })
        patch.hint = '还剩 1 分钟'
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
      this.toast('太短了，再说一次')
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
        this.toast('只拿到文字，已按文字记录')
      } else {
        this.toast('太短了，再说一次')
      }
      return
    }

    this.saveVoice(path, Math.max(1, seconds), text)
  },

  saveVoice(tempFilePath, seconds, text) {
    media.saveVoice(tempFilePath).then(({ path, size }) => {
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
        this.toast('这段录音找不到了')
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

    if (this.data.recording) {
      this.toast('先结束录音')
      return
    }

    // 非小程序环境（网页预览等）里这些 API 不存在，直接调用会抛错并表现为"点了没反应"
    if (typeof wx.chooseMedia !== 'function' && typeof wx.chooseImage !== 'function') {
      console.warn('[record] chooseMedia / chooseImage 均不可用，当前环境不支持选图')
      this.toast('当前环境不支持拍照')
      return
    }

    const left = MAX_PHOTOS - this.data.photos.length
    if (!cameraOnly && left <= 0) {
      this.toast('最多 ' + MAX_PHOTOS + ' 张')
      return
    }

    media.chooseImages({
      count: cameraOnly ? 1 : left,
      sourceType: cameraOnly ? ['camera'] : ['album', 'camera'],
      camera: 'back'
    })
      .then(tempPaths => {
        // 相机/相册回来之后才挂 loading，避免用户看到加载圈却等不到界面
        wx.showLoading({ title: '处理中', mask: true })
        return media.saveImages(tempPaths).then(saved => {
          this.hideLoading()
          return saved
        })
      })
      .then(saved => {
        const next = cameraOnly ? saved : this.data.photos.concat(saved)
        const kept = next.slice(0, MAX_PHOTOS)
        // 超出 9 张的被丢掉，文件也要删掉，别留孤儿
        if (next.length > MAX_PHOTOS) {
          media.removeAll(next.slice(MAX_PHOTOS).map(p => p.path))
          this.toast('最多 ' + MAX_PHOTOS + ' 张')
        }
        // 替换时，被换掉的旧图要删（编辑态除外，那些属于库里那条记录）
        if (cameraOnly && this.data.mode === 'create' && this.data.photos.length) {
          media.removeAll(this.data.photos.map(p => p.path))
        }
        this.setData({ photos: kept })
        this.syncCanSave()
        this.markDirty()
      })
      .catch(err => {
        this.hideLoading()
        const msg = (err && (err.errMsg || err.message)) || String(err || '')
        console.warn('[record] pickPhoto 失败:', msg)
        if (msg.indexOf('cancel') >= 0) return
        if (/privacy|112|协议/.test(msg)) {
          this.toast('需先在后台配置隐私保护指引')
          return
        }
        if (/auth|deny|permission|权限/.test(msg)) {
          this.toast('没拿到相机或相册权限')
          return
        }
        this.toast('没选上：' + msg.slice(0, 36))
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
