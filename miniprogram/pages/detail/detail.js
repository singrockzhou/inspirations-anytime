const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')

const TYPE_LABEL = { text: '文字', voice: '语音', photo: '照片' }

Page({
  data: {
    id: '',
    record: null,
    missing: false,
    typeLabel: '',
    timeText: '',
    updatedText: '',
    playing: false,
    toastText: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.id = options.id || ''
  },

  /** 从编辑页返回时重新读一次，页面内容与库保持一致 */
  onShow() {
    this.load()
  },

  onUnload() {
    audio.release()
  },

  load() {
    const rec = store.get(this.id)
    if (!rec) {
      this.setData({ record: null, missing: true })
      return
    }
    this.setData({
      record: rec,
      missing: false,
      typeLabel: TYPE_LABEL[rec.type] || '文字',
      timeText: date.fullTime(rec.createdAt),
      // 只有真的改过（超过 1 分钟再保存）才显示修改时间
      updatedText: rec.updatedAt - rec.createdAt > 60000 ? date.fullTime(rec.updatedAt) : ''
    })
  },

  onEdit() {
    wx.navigateTo({ url: '/pages/record/record?mode=edit&id=' + this.id })
  },

  onCopy() {
    const text = (this.data.record && this.data.record.content || '').trim()
    if (!text) {
      this.toast('这条没有文字可复制')
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast('复制了')
    })
  },

  onDelete() {
    wx.showModal({
      title: '删了？',
      content: '删掉之后回到列表，5 秒内还能撤回。',
      cancelText: '留着',
      confirmText: '删',
      confirmColor: '#B5673F',
      success: res => {
        if (!res.confirm) return
        if (store.remove(this.id)) wx.navigateBack()
      }
    })
  },

  onPlay() {
    const rec = this.data.record
    if (!rec || !rec.mediaPath) return

    if (this.data.playing) {
      audio.stop()
      this.setData({ playing: false })
      return
    }

    audio.play(rec.mediaPath, {
      end: () => this.setData({ playing: false }),
      error: () => {
        this.setData({ playing: false })
        this.toast('这段录音找不到了')
      }
    })
    this.setData({ playing: true })
  },

  onPreview() {
    const rec = this.data.record
    if (!rec || !rec.mediaPath) return
    wx.previewImage({ current: rec.mediaPath, urls: [rec.mediaPath] })
  },

  goBack() {
    wx.navigateBack()
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
