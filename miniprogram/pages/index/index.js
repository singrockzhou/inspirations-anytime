const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')

const PAGE_SIZE = 20
const UNDO_SECONDS = 5

Page({
  data: {
    groups: [],
    total: 0,
    empty: false,
    loading: true,
    hasMore: false,
    playingId: '',
    highlightId: '',
    sheet: {
      visible: false,
      mode: 'card',
      title: '',
      items: []
    },
    undo: {
      visible: false,
      left: UNDO_SECONDS
    },
    toastText: ''
  },

  onLoad() {
    this.limit = PAGE_SIZE
    this.all = []
    this.undoTimer = null
    this.highlightTimer = null
    this.pendingDeleteId = ''
    this.actionItem = null
  },

  /** 从记录页返回时刷新，并让刚存下的那条闪一下 */
  onShow() {
    const app = getApp()
    const flashId = app.globalData.flashId || ''
    if (flashId) app.globalData.flashId = ''

    this.refresh()
    if (flashId) this.flash(flashId)
  },

  onHide() {
    audio.stop()
    if (this.data.playingId) this.setData({ playingId: '' })
  },

  onUnload() {
    audio.release()
    this.hideUndo()
    if (this.highlightTimer) clearTimeout(this.highlightTimer)
  },

  onPullDownRefresh() {
    this.limit = PAGE_SIZE
    this.refresh()
    wx.stopPullDownRefresh()
  },

  /** 首屏 20 条，触底再加载 20 条 */
  onReachBottom() {
    if (!this.data.hasMore) return
    this.limit += PAGE_SIZE
    this.render()
  },

  refresh() {
    this.all = store.list()
    this.render()
  },

  render() {
    const all = this.all || []
    const slice = all.slice(0, this.limit)
    this.setData({
      groups: date.group(slice),
      total: all.length,
      empty: all.length === 0,
      loading: false,
      hasMore: all.length > slice.length
    })
  },

  flash(id) {
    this.setData({ highlightId: id })
    if (this.highlightTimer) clearTimeout(this.highlightTimer)
    this.highlightTimer = setTimeout(() => {
      this.setData({ highlightId: '' })
    }, 1300)
  },

  /* ------------------------- 新建 ------------------------- */

  goText() {
    wx.navigateTo({ url: '/pages/record/record?mode=create&type=text' })
  },

  goVoice() {
    wx.navigateTo({ url: '/pages/record/record?mode=create&type=voice' })
  },

  /**
   * 拍一张：直接把系统相机拉起来
   * auto=camera 让记录页在 onReady 后立刻调 chooseMedia({sourceType:['camera']})，
   * 不出现"相册/拍照"的二选一菜单，拍完直接回到配文字的界面。
   */
  goPhoto() {
    wx.navigateTo({ url: '/pages/record/record?mode=create&type=photo&auto=camera' })
  },

  /* ------------------------- 卡片操作 ------------------------- */

  onCardOpen(e) {
    const item = e.detail.item
    if (!item) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id })
  },

  onCardAction(e) {
    const item = e.detail.item
    if (!item) return
    this.actionItem = item
    this.setData({
      sheet: {
        visible: true,
        mode: 'card',
        title: '',
        items: [
          { key: 'edit', label: '改一改', desc: '只改这句话，不重新写' },
          { key: 'copy', label: '复制', desc: '把文字复制到剪贴板' },
          { key: 'delete', label: '删了', desc: '5 秒内可以撤回', danger: true }
        ]
      }
    })
  },

  onSheetSelect(e) {
    const key = e.detail.key
    this.closeSheet()

    const item = this.actionItem
    if (!item) return

    if (key === 'edit') {
      wx.navigateTo({ url: '/pages/record/record?mode=edit&id=' + item.id })
    } else if (key === 'copy') {
      this.copyItem(item)
    } else if (key === 'delete') {
      this.deleteItem(item)
    }
  },

  closeSheet() {
    this.setData({ 'sheet.visible': false })
  },

  copyItem(item) {
    const text = (item.content || '').trim()
    if (!text) {
      this.toast('这条没有文字可复制')
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast('复制了')
    })
  },

  deleteItem(item) {
    const removed = store.remove(item.id)
    if (!removed) return
    this.refresh()
    this.showUndo(item.id)
  },

  /* ------------------------- 撤销删除 ------------------------- */

  showUndo(id) {
    this.pendingDeleteId = id
    if (this.undoTimer) clearInterval(this.undoTimer)

    let left = UNDO_SECONDS
    this.setData({ undo: { visible: true, left: left } })

    this.undoTimer = setInterval(() => {
      left -= 1
      if (left <= 0) {
        this.hideUndo()
      } else {
        this.setData({ 'undo.left': left })
      }
    }, 1000)
  },

  hideUndo() {
    if (this.undoTimer) {
      clearInterval(this.undoTimer)
      this.undoTimer = null
    }
    this.pendingDeleteId = ''
    if (this.data.undo.visible) this.setData({ 'undo.visible': false })
  },

  onUndo() {
    const id = this.pendingDeleteId
    if (!id) return
    this.hideUndo()
    if (store.restore(id)) {
      this.refresh()
      this.flash(id)
      this.toast('回来了')
    }
  },

  /* ------------------------- 媒体 ------------------------- */

  onPlay(e) {
    const item = e.detail.item
    if (!item || !item.mediaPath) return

    if (this.data.playingId === item.id) {
      audio.stop()
      this.setData({ playingId: '' })
      return
    }

    audio.play(item.mediaPath, {
      end: () => this.setData({ playingId: '' }),
      error: () => {
        this.setData({ playingId: '' })
        this.toast('这条语音找不到了')
      }
    })
    this.setData({ playingId: item.id })
  },

  onPreview(e) {
    const item = e.detail.item
    if (!item || !item.mediaPath) return
    wx.previewImage({
      current: item.mediaPath,
      urls: [item.mediaPath]
    })
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' })
  },

  /* ------------------------- 工具 ------------------------- */

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => {
      this.setData({ toastText: '' })
    }, 1600)
  }
})
