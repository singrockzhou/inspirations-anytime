const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const transfer = require('../../utils/transfer')
const dialog = require('../../utils/dialog')

const PAGE_SIZE = 20
const UNDO_SECONDS = 5

/** 卡片上那句话的摘要，堆叠组、那年今日、多选都用它 */
function peekOf(item) {
  const text = (item.content || '').replace(/\s+/g, ' ').trim()
  if (text) return text.length > 42 ? text.slice(0, 42) + '…' : text
  if (item.type === 'voice') return '一段 ' + (item.duration || 0) + ' 秒的录音'
  if (item.type === 'photo') return ((item.mediaPaths || []).length || 1) + ' 张照片'
  return ''
}

function decorate(item, selected) {
  let badge = '文字'
  if (item.type === 'voice') badge = '语音 ' + (item.duration || 0) + '″'
  else if (item.type === 'photo') {
    const n = (item.mediaPaths || []).length || 1
    badge = n > 1 ? '照片 ' + n + ' 张' : '照片'
  }

  return Object.assign({}, item, {
    _badge: badge,
    _time: date.relative(item.createdAt),
    _peek: peekOf(item),
    _checked: !!selected[item.id]
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

    /** 筛选：全部 / 星标 / 归档 + 单个标签 */
    filter: 'all',
    filterTag: '',
    counts: { all: 0, star: 0, archive: 0 },
    tags: [],
    emptyText: '想到什么，就说一句',
    emptySub: '不用起标题，也不用选分类',

    /** 那年今日：只在默认列表里出现，搜素/筛选时不打扰 */
    anniversary: null,

    /** 多选 */
    selectMode: false,
    selectedCount: 0,

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

  onLoad(options) {
    this.limit = PAGE_SIZE
    this.all = []
    this.expanded = {}
    this.selected = {}
    this.undoTimer = null
    this.highlightTimer = null
    this.pendingDeleteIds = []
    this.actionItem = null
    this.handleInbox(options)
  },

  /** 从记录页返回时刷新，并让刚存下的那条闪一下 */
  onShow(options) {
    // 热启动时分享进来的内容也从这里进
    this.handleInbox(options)

    const app = getApp()
    const flashId = app.globalData.flashId || ''
    if (flashId) app.globalData.flashId = ''

    // 我的页点「归档」时会把筛选态寄存在这里
    if (app.globalData.pendingFilter) {
      this.setData({ filter: app.globalData.pendingFilter, filterTag: '' })
      app.globalData.pendingFilter = ''
      this.limit = PAGE_SIZE
    }

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

  /* ------------------------- 数据 ------------------------- */

  refresh() {
    const stats = store.stats()
    this.all = this.queryList()

    this.setData({
      counts: { all: stats.visible, star: stats.starred, archive: stats.archived },
      tags: store.tags().slice(0, 12),
      anniversary: this.computeAnniversary()
    })
    this.render()
  },

  queryList() {
    const opts = {}
    if (this.data.filter === 'star') opts.only = 'star'
    else if (this.data.filter === 'archive') opts.only = 'archive'
    if (this.data.filterTag) opts.tag = this.data.filterTag
    return store.query(opts)
  },

  computeAnniversary() {
    if (this.data.filter !== 'all' || this.data.filterTag) return null
    const found = date.sameDayPast(store.list(), Date.now())
    if (!found) return null
    return {
      id: found.item.id,
      label: found.label,
      text: peekOf(found.item)
    }
  },

  render() {
    const all = this.all || []
    const slice = all.slice(0, this.limit)
    const selected = this.selected || {}
    const buckets = date.groupBuckets(slice.map(it => decorate(it, selected)))

    buckets.forEach(g => {
      g.open = !!this.expanded[g.key]
    })

    const filtering = this.data.filter !== 'all' || !!this.data.filterTag
    let emptyText = '想到什么，就说一句'
    let emptySub = '不用起标题，也不用选分类'
    if (this.data.filter === 'star') {
      emptyText = '还没有加星的'
      emptySub = '长按一条，选「加星」就钉在这里'
    } else if (this.data.filter === 'archive') {
      emptyText = '归档里是空的'
      emptySub = '长按一条，选「归档」就收进来'
    } else if (this.data.filterTag) {
      emptyText = '#' + this.data.filterTag + ' 下还没有'
      emptySub = '正文里写 #' + this.data.filterTag + ' 就会自动归到这个标签'
    }

    this.setData({
      groups: buckets,
      total: all.length,
      empty: all.length === 0,
      loading: false,
      hasMore: all.length > slice.length,
      emptyText: emptyText,
      emptySub: emptySub,
      selectedCount: Object.keys(selected).length,
      filterTag: this.data.filterTag
    })

    // 过滤态下不显示「到底了」的引导，避免和空态文案打架
    if (filtering && !all.length) this.setData({ empty: true })
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

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  goMe() {
    wx.navigateTo({ url: '/pages/me/me' })
  },

  /* ------------------------- 筛选 ------------------------- */

  onFilter(e) {
    const mode = e.currentTarget.dataset.mode
    if (this.data.selectMode) return
    this.limit = PAGE_SIZE
    this.setData({ filter: mode, filterTag: '', openSwipeId: '' })
    this.refresh()
  },

  onFilterTag(e) {
    const tag = e.currentTarget.dataset.tag
    if (this.data.selectMode) return
    this.limit = PAGE_SIZE
    const next = this.data.filterTag === tag ? '' : tag
    this.setData({ filterTag: next, filter: 'all', openSwipeId: '' })
    this.refresh()
  },

  openAnniversary() {
    const a = this.data.anniversary
    if (!a) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + a.id })
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

    dialog
      .confirm({
        title: '删掉「' + group.label + '」整组？',
        text: '共 ' + group.count + ' 条，删了之后 5 秒内可以撤回。',
        cancelText: '算了',
        confirmText: '删整组',
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        const ids = group.items.map(it => it.id)
        const done = store.removeMany(ids)
        if (!done.length) {
          this.toast('没删掉，再试一次')
          return
        }
        this.setData({ openSwipeId: '' })
        this.refresh()
        this.showUndo(done, '删了「' + group.label + '」' + done.length + ' 条')
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

  onCardToggle(e) {
    const item = e.detail.item
    if (!item) return
    const next = Object.assign({}, this.selected)
    if (next[item.id]) delete next[item.id]
    else next[item.id] = 1
    this.selected = next
    this.render()
  },

  onCardAction(e) {
    const item = e.detail.item
    if (!item) return
    this.actionItem = item

    const inArchive = this.data.filter === 'archive'
    this.setData({
      sheet: {
        visible: true,
        mode: 'card',
        title: '',
        items: [
          { key: 'edit', label: '改一改', desc: '只改这句话，不重新写' },
          { key: 'copy', label: '复制', desc: '把文字复制到剪贴板' },
          {
            key: 'star',
            label: item.starred ? '取消加星' : '加星',
            desc: item.starred ? '从星标里拿下来' : '钉在「星标」里，不容易被时间流冲走'
          },
          {
            key: 'archive',
            label: inArchive ? '移出归档' : '归档',
            desc: inArchive ? '回到主列表' : '不删除，但从主列表收起来'
          },
          { key: 'poster', label: '做成图', desc: '排成一张图，可以存下来或发出去' },
          { key: 'select', label: '多选', desc: '勾几条一起复制、导出或删掉' },
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
    } else if (key === 'star') {
      store.setStar(item.id, !item.starred)
      this.refresh()
      this.toast(item.starred ? '从星标里拿下来了' : '加星了')
    } else if (key === 'archive') {
      const on = !item.archivedAt
      store.setArchive(item.id, on)
      this.refresh()
      this.toast(on ? '收进归档了' : '回到主列表了')
    } else if (key === 'poster') {
      wx.navigateTo({ url: '/pages/poster/poster?id=' + item.id })
    } else if (key === 'select') {
      this.startSelect(item.id)
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

  /* ------------------------- 多选 ------------------------- */

  toggleSelect() {
    if (this.data.selectMode) {
      this.exitSelect()
      return
    }
    this.startSelect('')
  },

  startSelect(firstId) {
    this.selected = {}
    if (firstId) this.selected[firstId] = 1
    this.setData({ selectMode: true, openSwipeId: '', anniversary: null })
    this.render()
  },

  exitSelect() {
    this.selected = {}
    this.setData({ selectMode: false })
    this.refresh()
  },

  selectedRecords() {
    const ids = this.selected || {}
    return (this.all || []).filter(r => ids[r.id])
  },

  onSelCopy() {
    const list = this.selectedRecords()
    if (!list.length) {
      this.toast('先勾几条')
      return
    }
    const text = list
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(r => (r.content || '').trim())
      .filter(Boolean)
      .join('\n\n')
    if (!text) {
      this.toast('选中的都没有文字')
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast('复制了 ' + list.length + ' 条')
    })
  },

  onSelExport() {
    const list = this.selectedRecords()
    if (!list.length) {
      this.toast('先勾几条')
      return
    }
    wx.showLoading({ title: '打包中', mask: true })
    transfer
      .exportText(list)
      .then(res => {
        wx.hideLoading()
        if (res.mode === 'cancel') return
        dialog.alert({
          title: '导出完成',
          text:
            '共 ' + res.total + ' 条，已生成 ' + res.fileName + '。' +
            (res.mode === 'share' ? '转发给「文件传输助手」即可在电脑上打开。' : '已保存到电脑。')
        })
      })
      .catch(err => {
        wx.hideLoading()
        if (!err || err.code === 'cancel') return
        this.toast(err.code === 'unsupported' ? '当前环境不支持导出' : '没导出成，再试一次')
      })
  },

  onSelDelete() {
    const list = this.selectedRecords()
    if (!list.length) {
      this.toast('先勾几条')
      return
    }
    dialog
      .confirm({
        title: '删掉选中的 ' + list.length + ' 条？',
        text: '删了之后 5 秒内可以撤回。',
        cancelText: '算了',
        confirmText: '删了',
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        const done = store.removeMany(list.map(r => r.id))
        if (!done.length) {
          this.toast('没删掉，再试一次')
          return
        }
        this.selected = {}
        this.setData({ selectMode: false })
        this.refresh()
        this.showUndo(done, '删了 ' + done.length + ' 条')
      })
  },

  /* ------------------------- 媒体 ------------------------- */

  onPlay(e) {
    if (this.data.selectMode) return
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
    if (this.data.selectMode) return
    const item = e.detail.item
    if (!item) return
    const urls = (item.mediaPaths && item.mediaPaths.length) ? item.mediaPaths : item.mediaPath ? [item.mediaPath] : []
    if (!urls.length) return
    // 点堆叠里的哪一张，就从哪一张开始看
    const idx = Math.min(Math.max(Number(e.detail.index) || 0, 0), urls.length - 1)
    wx.previewImage({ current: urls[idx], urls: urls })
  },

  /* ------------------------- 分享 ------------------------- */

  /**
   * 转发小程序卡片：带一段正文进去，对方打开就能一键存成自己的一条。
   * 微信的 path 有长度限制，所以截到 400 字，超出部分如实提示已截断。
   */
  onShareAppMessage() {
    const text = (this.data.anniversary && this.data.anniversary.text) || ''
    const path = text
      ? '/pages/index/index?inbox=' + encodeURIComponent(text.slice(0, 400))
      : '/pages/index/index'
    return {
      title: text ? text.slice(0, 30) : '灵感随时记 · 想到什么就记一句',
      path: path
    }
  },

  /** 收到别人转发过来的正文：确认后存成本地一条 */
  handleInbox(query) {
    if (!query || !query.inbox) return
    if (this.inboxHandled) return
    this.inboxHandled = true

    let text = ''
    try {
      text = decodeURIComponent(query.inbox)
    } catch (e) {
      text = String(query.inbox)
    }
    text = (text || '').trim()
    if (!text) return

    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text
    dialog
      .confirm({
        title: '收到一条分享',
        text: preview,
        cancelText: '不用',
        confirmText: '存下来'
      })
      .then(res => {
        if (!res.confirmed) return
        const rec = store.create({ type: 'text', content: text })
        if (!rec) return
        this.refresh()
        this.flash(rec.id)
        this.toast('存进你的灵感了')
      })
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
