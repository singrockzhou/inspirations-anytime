const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')

const PAGE_SIZE = 20
const UNDO_SECONDS = 5

/** 堆叠组在展开前只露最上面这一条，其余用层叠边缘暗示还有内容 */
function decorate(item) {
  let badge = '文字'
  if (item.type === 'voice') badge = '语音 ' + (item.duration || 0) + '″'
  else if (item.type === 'photo') badge = '照片'

  let peek = ''
  const text = (item.content || '').replace(/\s+/g, ' ').trim()
  if (text) {
    peek = text.length > 42 ? text.slice(0, 42) + '…' : text
  } else if (item.type === 'voice') {
    peek = '一段 ' + (item.duration || 0) + ' 秒的录音'
  } else if (item.type === 'photo') {
    peek = '一张照片'
  }

  return Object.assign({}, item, {
    _badge: badge,
    _time: date.relative(item.createdAt),
    _peek: peek
  })
}

Page({
  data: {
    groups: [],
    total: 0,
    empty: false,
    loading: true,
    hasMore: false,
    playingId: '',
    highlightId: '',
    /** 当前被左滑打开的那一条，保证同时只露一个删除按钮 */
    openSwipeId: '',
    sheet: {
      visible: false,
      mode: 'card',
      title: '',
      items: []
    },
    undo: {
      visible: false,
      left: UNDO_SECONDS,
      label: ''
    },
    toastText: ''
  },

  onLoad() {
    this.limit = PAGE_SIZE
    this.all = []
    this.expanded = {}
    this.undoTimer = null
    this.highlightTimer = null
    this.pendingDeleteIds = []
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
    if (this.data.openSwipeId) this.setData({ openSwipeId: '' })
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
    const buckets = date.groupBuckets(slice.map(decorate))

    buckets.forEach(g => {
      g.open = !!this.expanded[g.key]
    })

    this.setData({
      groups: buckets,
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

  /* ------------------------- 分组展开 ------------------------- */

  onToggle(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.expanded[key] = !this.expanded[key]
    this.setData({ openSwipeId: '' })
    this.render()
  },

  /* ------------------------- 左滑删除 ------------------------- */

  onSwipeOpen(e) {
    this.setData({ openSwipeId: e.detail.id || '' })
  },

  onSwipeClose() {
    this.setData({ openSwipeId: '' })
  },

  onSwipeDelete(e) {
    const id = e.detail.id
    this.setData({ openSwipeId: '' })
    const item = (this.all || []).filter(r => r.id === id)[0]
    if (!item) return
    this.deleteOne(item)
  },

  /* ------------------------- 删除 ------------------------- */

  deleteOne(item) {
    const removed = store.remove(item.id)
    if (!removed) return
    this.refresh()
    this.showUndo([item.id], '删了 1 条')
  },

  /** 整组删除：先确认条数和分组名，再批量软删，撤销可整组回来 */
  onDeleteGroup(e) {
    const key = e.currentTarget.dataset.key
    const group = (this.data.groups || []).filter(g => g.key === key)[0]
    if (!group || !group.count) return

    wx.showModal({
      title: '删掉「' + group.label + '」整组？',
      content: '共 ' + group.count + ' 条，删了之后 5 秒内可以撤回。',
      cancelText: '算了',
      confirmText: '删整组',
      confirmColor: '#B5673F',
      success: res => {
        if (!res.confirm) return
        const ids = group.items.map(it => it.id)
        const done = store.removeMany(ids)
        if (!done.length) {
          this.toast('没删掉，再试一次')
          return
        }
        this.setData({ openSwipeId: '' })
        this.refresh()
        this.showUndo(done, '删了「' + group.label + '」' + done.length + ' 条')
      }
    })
  },

  /* ------------------------- 撤销删除 ------------------------- */

  showUndo(ids, label) {
    this.pendingDeleteIds = ids || []
    if (this.undoTimer) clearInterval(this.undoTimer)

    let left = UNDO_SECONDS
    this.setData({ undo: { visible: true, left: left, label: label } })

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
    this.pendingDeleteIds = []
    if (this.data.undo.visible) this.setData({ 'undo.visible': false })
  },

  onUndo() {
    const ids = this.pendingDeleteIds.slice()
    if (!ids.length) return
    this.hideUndo()

    const done = store.restoreMany(ids)
    if (!done.length) return
    this.refresh()
    if (done.length === 1) this.flash(done[0])
    this.toast(done.length > 1 ? done.length + ' 条回来了' : '回来了')
  },

  /* ------------------------- 卡片操作 ------------------------- */

  onCardOpen(e) {
    // 有卡片正被左滑打开时，第一次点击只用来收起它
    if (this.data.openSwipeId) {
      this.setData({ openSwipeId: '' })
      return
    }
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
      this.deleteOne(item)
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
