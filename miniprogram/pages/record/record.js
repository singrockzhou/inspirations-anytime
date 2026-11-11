const store = require('../../utils/store')
const media = require('../../utils/media')
const date = require('../../utils/date')
const audio = require('../../utils/audio')

const MAX_TEXT = 1000
const MAX_CAPTION = 200
const MAX_VOICE_SECONDS = 300

const TYPE_LABEL = { text: '文字', voice: '录音', photo: '照片' }

Page({
  data: {
    mode: 'create',
    type: 'text',
    content: '',
    mediaPath: '',
    duration: 0,
    size: 0,

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
        duration: rec.duration,
        size: rec.size
      })
      this.syncCanSave()
    } else {
      const type = ['text', 'voice', 'photo'].indexOf(options.type) >= 0 ? options.type : 'text'
      this.setData({ mode: 'create', type: type })

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
    if (this.data.recording && this.rm) {
      this.cancelFlag = true
      this.rm.stop()
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
    const canSave = this.data.type === 'text' ? !!text : !!this.data.mediaPath
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
      if (next === 'photo' && !this.data.mediaPath && !this.data.recording) this.pickPhoto()
      return
    }
    if (this.data.recording) {
      this.toast('这段还没录完')
      return
    }

    const has = this.data.type === 'text'
      ? !!(this.data.content || '').trim()
      : !!this.data.mediaPath

    if (!has) {
      this.applyType(next)
      return
    }

    wx.showModal({
      title: '换一种？',
      content: '刚才的' + TYPE_LABEL[this.data.type] + '会清掉',
      cancelText: '算了',
      confirmText: '换',
      confirmColor: '#C4713F',
      success: res => {
        if (res.confirm) this.applyType(next)
      }
    })
  },

  applyType(next) {
    // 一条记录只允许一种形态，切换时把已采集的内容彻底清掉
    if (this.data.mediaPath && this.data.mode === 'create') media.remove(this.data.mediaPath)
    if (this.data.mode === 'create' && this.data.type === 'text') store.clearDraft()

    this.setData({
      type: next,
      content: '',
      mediaPath: '',
      duration: 0,
      size: 0,
      hint: '',
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
    if (type !== 'text' && !this.data.mediaPath) {
      this.toast(type === 'voice' ? '还没录' : '还没选照片')
      return
    }

    this.setData({ saving: true })

    const payload = {
      type: type,
      content: text,
      mediaPath: this.data.mediaPath,
      duration: this.data.duration,
      size: this.data.size
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
    wx.showModal({
      title: '这段还留着吗？',
      content: '还没存下，离开就没了',
      cancelText: '继续写',
      confirmText: '丢掉',
      confirmColor: '#B5673F',
      success: res => {
        if (!res.confirm) return
        this.discard()
        this.leave()
      }
    })
  },

  discard() {
    if (this.data.mode === 'create') {
      store.clearDraft()
      // 编辑模式下 mediaPath 属于库里已有的那条，不能删
      if (this.data.mediaPath) media.remove(this.data.mediaPath)
    }
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
            wx.showModal({
              title: '需要麦克风',
              content: '录一句话需要麦克风权限，去设置里打开？',
              confirmText: '去设置',
              success: r => {
                if (!r.confirm) {
                  resolve(false)
                  return
                }
                wx.openSetting({
                  success: s => resolve(!!s.authSetting['scope.record']),
                  fail: () => resolve(false)
                })
              },
              fail: () => resolve(false)
            })
            return
          }

          // 从没问过：先自己说明一句，再调起系统授权，避免开门见弹窗
          wx.showModal({
            title: '用麦克风',
            content: '录下你说的那句话，只存在这台手机上。',
            confirmText: '允许',
            success: r => {
              if (!r.confirm) {
                resolve(false)
                return
              }
              wx.authorize({
                scope: 'scope.record',
                success: () => resolve(true),
                fail: () => resolve(false)
              })
            },
            fail: () => resolve(false)
          })
        },
        fail: () => resolve(false)
      })
    })
  },

  startRecord() {
    if (this.data.recording) return
    if (!this.rm) {
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
      this.setData({ recordSeconds: 0, recordClock: '00:00', hint: '', canceling: false })

      this.rm.start({
        duration: MAX_VOICE_SECONDS * 1000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'aac'
      })
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
    this.rm.stop()
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

    const seconds = Math.round(ms / 1000)
    media.saveVoice(res.tempFilePath).then(({ path, size }) => {
      if (this.data.mediaPath && this.data.mode === 'create') media.remove(this.data.mediaPath)
      this.setData({
        mediaPath: path,
        duration: seconds,
        size: size,
        hint: '',
        recordSeconds: 0,
        recordClock: '00:00'
      })
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

  pickPhoto() {
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

    media.chooseImage()
      .then(temp => {
        // 相机/相册回来之后才挂 loading，避免用户看到加载圈却等不到界面
        wx.showLoading({ title: '处理中', mask: true })
        return media.saveImage(temp).then(res => {
          this.hideLoading()
          return res
        })
      })
      .then(res => {
        if (this.data.mediaPath && this.data.mode === 'create') media.remove(this.data.mediaPath)
        this.setData({ mediaPath: res.path, size: res.size })
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

  removePhoto() {
    if (this.data.mediaPath && this.data.mode === 'create') media.remove(this.data.mediaPath)
    if (this.data.mode === 'edit') {
      // 编辑态删图 = 让这条记录没有图，交给保存时统一处理
      this.setData({ mediaPath: '', size: 0 })
    } else {
      this.setData({ mediaPath: '', size: 0 })
    }
    this.syncCanSave()
  },

  previewMedia() {
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
