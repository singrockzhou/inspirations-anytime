const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const dialog = require('../../utils/dialog')

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
    photos: [],
    starred: false,
    archived: false,
    needText: false,
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
      updatedText: rec.updatedAt - rec.createdAt > 60000 ? date.fullTime(rec.updatedAt) : '',
      photos: rec.mediaPaths || [],
      starred: !!rec.starred,
      archived: !!rec.archivedAt,
      // 语音/照片没有文字时，给一个"补一句"的口子，补上就能被搜到
      needText: rec.type !== 'text' && !(rec.content || '').trim()
    })
  },

  onEdit() {
    wx.navigateTo({ url: '/pages/record/record?mode=edit&id=' + this.id })
  },

  onCopy() {
    const text = ((this.data.record && this.data.record.content) || '').trim()
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
    dialog
      .confirm({
        title: '删了？',
        text: '删掉之后回到列表，5 秒内还能撤回。',
        cancelText: '留着',
        confirmText: '删',
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        if (store.remove(this.id)) wx.navigateBack()
      })
  },

  /* ------------------------- 星标 / 归档 ------------------------- */

  onToggleStar() {
    const next = !this.data.starred
    if (!store.setStar(this.id, next)) return
    this.setData({ starred: next })
    this.toast(next ? '加星了' : '从星标里拿下来了')
  },

  onToggleArchive() {
    const next = !this.data.archived
    if (!store.setArchive(this.id, next)) return
    this.setData({ archived: next })
    this.toast(next ? '收进归档了' : '回到主列表了')
  },

  /* ------------------------- 做成图 ------------------------- */

  onPoster() {
    wx.navigateTo({ url: '/pages/poster/poster?id=' + this.id })
  },

  /* ------------------------- 补文字 ------------------------- */

  /** 语音/照片没有文字时，补一句就能被搜索命中 */
  onAddText() {
    dialog
      .show({
        title: '补一句',
        editable: true,
        placeholder: '这段讲的是什么？',
        cancelText: '算了',
        confirmText: '存下'
      })
      .then(res => {
        if (!res.confirmed) return
        const text = (res.value || '').trim()
        if (!text) {
          // 一个字没填就退回编辑页去写，不硬拦
          this.onEdit()
          return
        }
        if (!store.update(this.id, { content: text })) return
        this.load()
        this.toast('补上了，现在能搜到')
      })
  },

  /* ------------------------- 媒体 ------------------------- */

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

  onPreview(e) {
    const urls = this.data.photos
    if (!urls.length) return
    const index = Number((e && e.currentTarget && e.currentTarget.dataset.i) || 0)
    wx.previewImage({ current: urls[index] || urls[0], urls: urls })
  },

  goBack() {
    wx.navigateBack()
  },

  onShareAppMessage() {
    const text = ((this.data.record && this.data.record.content) || '').slice(0, 400)
    return {
      title: text ? text.slice(0, 30) : '灵感随时记',
      path: text ? '/pages/index/index?inbox=' + encodeURIComponent(text) : '/pages/index/index'
    }
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
