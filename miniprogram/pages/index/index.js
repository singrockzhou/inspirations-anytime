const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const transfer = require('../../utils/transfer')
const dialog = require('../../utils/dialog')
const share = require('../../utils/share')
const flip = require('../../utils/flip')
const nudge = require('../../utils/nudge')
const i18n = require('../../utils/i18n')
const backup = require('../../utils/backup')

const PAGE_SIZE = 20
const UNDO_SECONDS = 5

/**
 * 「从聊天存一条」的失败文案，码表来自 utils/transfer.js。
 *
 * 写法上的两个约束：
 *   - 不说"文件可能已损坏"这种把责任推给文件的话——真实原因有四种（认不出类型 /
 *     读不出内容 / 存不进来 / 环境不支持），能分辨就不要合并成一句。
 *   - 每条都给一个"接下来能做什么"，因为用户此刻唯一想知道的就是这个。
 */
const COLLECT_ERR = i18n.table('index', [
  'unsupported',
  'nofile',
  'choose',
  'read',
  'empty',
  'denied',
  'full'
], 'err')

/** 没存下的原因，说人话；三个码分别对应"认不出/读不出/存不进" */
const SKIP_REASON = i18n.table('index', ['type', 'read', 'save'], 'skip')

/**
 * 把没存下的文件说成一句人话。
 * 名字能读就报名字（最多三个），读不出名字的只报个数——
 * 绝不把 78a4bca0… 这种机器串摆到用户面前。
 */
function skippedText(list) {
  const items = list || []
  if (!items.length) return ''
  const names = []
  items.forEach(s => {
    if (s && s.name && names.indexOf(s.name) < 0) names.push(s.name)
  })
  const unknown = items.length - names.length
  const parts = []
  if (names.length) {
    const head = names.slice(0, 3).join('、')
    parts.push(head + (names.length > 3 ? i18n.t('index:skipped_etc', { n: names.length }) : ''))
  }
  if (unknown > 0) parts.push(i18n.t('index:skipped_unknown', { n: unknown }))
  return parts.join('、')
}

/** 明细：每个文件后面括号写原因，最多列三条，免得弹窗被顶爆 */
function skippedDetail(list) {
  return (list || [])
    .slice(0, 3)
    .map(s =>
      i18n.t('index:skip_line', {
        name: s.name || i18n.t('index:skip_unknown_name'),
        reason: SKIP_REASON[s.reason] || i18n.t('index:skip_save')
      })
    )
    .join('\n')
}

/** 字节数 → "3.2 MB"，只用在收图后的提示里 */
function bytesText(bytes) {
  const n = bytes || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  const mb = n / 1024 / 1024
  return (mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
}

/** 卡片上那句话的摘要，堆叠组、那年今日、多选都用它 */
function peekOf(item) {
  const text = (item.content || '').replace(/\s+/g, ' ').trim()
  if (text) return text.length > 42 ? text.slice(0, 42) + '…' : text
  if (item.type === 'voice') return i18n.t('index:sum_voice', { n: item.duration || 0 })
  if (item.type === 'photo') return i18n.t('index:sum_photo', { n: (item.mediaPaths || []).length || 1 })
  return ''
}

function decorate(item, selected) {
  let badge = i18n.t('index:badge_text')
  if (item.type === 'voice') badge = i18n.t('index:badge_voice', { n: item.duration || 0 })
  else if (item.type === 'photo') {
    const n = (item.mediaPaths || []).length || 1
    badge = n > 1 ? i18n.t('index:badge_photo', { n: n }) : i18n.t('index:badge_photo_one')
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
    /** 当前语言的文案包，wxml 里用 {{t.xxx}} */
    t: {},
    emptyText: '',
    emptySub: '',

    /** 那年今日：只在默认列表里出现，搜素/筛选时不打扰 */
    anniversary: null,
    /** 回顾位的备选人数：没有那年今日时，用「随便翻一条」顶上这一栏 */
    reviewTotal: 0,
    /** 打开即提醒：今天还没记就占住这一栏，记完一条自动让位 */
    nudge: null,
    /** 备份提示：数据只在本机，攒够条数或久没备份时在顶部提一条 */
    backup: null,

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

  applyLang() {
    this.setData({ t: i18n.pack('index') })
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
    this.applyLang()
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
      anniversary: this.computeAnniversary(),
      // 和重温页用的是同一个口径（含归档），页面上写的条数不会和进去后看到的对不上
      reviewTotal: flip.total(),
      reviewTip: i18n.t('index:review_tip', { n: flip.total() }),
      nudge: this.computeNudge(stats),
      backup: this.computeBackup(stats)
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

  /**
   * 打开即提醒——替代那个发不出去的"每日提醒"。
   *
   * 为什么不弹窗：一天要开好几次，第三次弹窗就会被嫌。放在列表顶上这一栏、
   * 要用户自己点，既到得了（不依赖推送、不需要服务端），又不会拦路；
   * 记完一条它就自己让位给「那年今日」或「随便翻一条」，不用手动关。
   *
   * 判断与文案都在 utils/nudge.js：那里是纯函数，边界能被测试直接驱动。
   */
  computeNudge(stats) {
    return nudge.of(stats || store.stats(), {
      filtering: this.data.filter !== 'all' || !!this.data.filterTag,
      selecting: this.data.selectMode
    })
  },

  /**
   * 备份提示。
   *
   * 为什么要有：记录只存在微信给小程序分的沙箱里，用户删掉小程序、清理微信
   * 存储、换手机，就一起没了，而且没有云端副本可恢复。唯一的跨设备通路是
   * 「导出成文件 → 发给文件传输助手 → 新设备导入」，这条路只能用户自己走。
   *
   * 为什么不是弹窗：它不该有打断成本。做成筛选条下面一条细横幅，看得见、
   * 点一下就处理、不想看就按 ×，比每次打开弹一个"请备份"体面得多。
   *
   * 该不该提、提什么话在 utils/backup.js（纯函数，边界被测过）。
   */
  computeBackup(stats) {
    return backup.of(stats || store.stats(), store.backupInfo(), {
      filtering: this.data.filter !== 'all' || !!this.data.filterTag,
      selecting: this.data.selectMode
    })
  },

  /** 首页就地备份，走的是「我的 → 导出到文件」同一条链路，不另写一份 */
  onBackup() {
    if (this.busyBackup) return
    this.busyBackup = true
    wx.showLoading({ title: i18n.t('common:packing'), mask: true })

    transfer
      .exportBackup()
      .then(res => {
        wx.hideLoading()
        this.busyBackup = false

        if (res.mode === 'cancel') {
          // 用户自己按了取消：这次停留期间别再摆着，下次打开重新判断
          this.setData({ backup: null })
          return
        }

        // 账本由 transfer.exportBackup 记账（含归档，且用户取消时不记），这里只收尾
        this.setData({ backup: null })
        wx.showToast({ title: i18n.t('index:toast_backup_done'), icon: 'none' })
      })
      .catch(err => {
        wx.hideLoading()
        this.busyBackup = false
        if (err && err.code === 'cancel') return
        dialog.alert({
          title: i18n.t('index:dialog_export_fail'),
          text: transfer.EXPORT_ERR[err && err.code] || i18n.t('common:retry')
        })
      })
  },

  /** 以后再说：静默 7 天，不是永久关掉，所以明确告诉他会再提 */
  onBackupClose() {
    store.snoozeBackup()
    this.setData({ backup: null })
    wx.showToast({ title: i18n.t('index:toast_snooze'), icon: 'none' })
  },

  render() {
    const all = this.all || []
    const slice = all.slice(0, this.limit)
    const selected = this.selected || {}
    const buckets = date.groupBuckets(slice.map(it => decorate(it, selected)))

    buckets.forEach(g => {
      g.open = !!this.expanded[g.key]
      g.moreText = i18n.t('index:more_in_group', { n: g.count - 1 })
      g.countText = i18n.t('index:grp_count', { n: g.count })
    })

    const filtering = this.data.filter !== 'all' || !!this.data.filterTag
    let emptyText = i18n.t('index:empty_default')
    let emptySub = i18n.t('index:empty_sub')
    if (this.data.filter === 'star') {
      emptyText = i18n.t('index:empty_star')
      emptySub = i18n.t('index:empty_star_sub')
    } else if (this.data.filter === 'archive') {
      emptyText = i18n.t('index:empty_archive')
      emptySub = i18n.t('index:empty_archive_sub')
    } else if (this.data.filterTag) {
      emptyText = i18n.t('index:empty_tag', { tag: this.data.filterTag })
      emptySub = i18n.t('index:empty_tag_sub', { tag: this.data.filterTag })
    }

    this.setData({
      groups: buckets,
      total: all.length,
      countText: i18n.t('index:count', { n: all.length }),
      empty: all.length === 0,
      loading: false,
      hasMore: all.length > slice.length,
      emptyText: emptyText,
      emptySub: emptySub,
      selectedCount: Object.keys(selected).length,
      selCountText: i18n.t('index:sel_count', { n: Object.keys(selected).length }),
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

  /* ------------------------- 从聊天 / 剪贴板存一条 ------------------------- */

  /**
   * 一个入口，两种来源。
   * 微信不开放"读聊天消息"的接口，所以能收的只有两样：
   * 聊天里的文件/图片，以及用户自己在聊天里复制的那段文字。
   */
  onCollect() {
    if (this.collecting) return
    this.actionItem = null
    this.setData({
      sheet: {
        visible: true,
        mode: 'collect',
        title: i18n.t('index:collect_title'),
        items: [
          {
            key: 'file',
            label: i18n.t('index:collect_file'),
            desc: i18n.t('index:collect_file_desc')
          },
          {
            key: 'paste',
            label: i18n.t('index:collect_paste'),
            desc: i18n.t('index:collect_paste_desc')
          }
        ]
      }
    })
  },

  /**
   * 聊天文件：图片落盘成照片，txt/md/csv 读正文，其它二进制只留文件名。
   * 必须真正落库——老版本只提示"已存下"，其实什么都没写进去。
   */
  collectFiles() {
    if (this.collecting) return
    this.collecting = true
    wx.showLoading({ title: i18n.t('common:processing'), mask: true })

    transfer
      .importFromChat()
      .then(res => {
        wx.hideLoading()
        this.collecting = false

        const made = []
        ;(res.records || []).forEach(d => {
          const rec = store.create({
            type: d.type,
            content: d.content || '',
            mediaPath: d.mediaPath || '',
            mediaPaths: d.mediaPaths || [],
            duration: d.duration || 0,
            size: d.size || 0
          })
          if (rec) made.push(rec)
        })

        // 一条都没存下：store.create 已经说过原因（满 1000 条/写不进去），不再叠一层弹窗
        if (!made.length) return

        this.setData({ filter: 'all', filterTag: '' })
        this.limit = PAGE_SIZE
        this.refresh()
        this.flash(made[0].id)

        const lines = [i18n.t('index:received_first', { n: made.length })]
        if (res.compressed) {
          lines.push(
            i18n.t('index:received_compressed', {
              n: res.compressed,
              b: bytesText(res.savedBytes)
            })
          )
        }
        if (res.shells) {
          lines.push(i18n.t('index:received_shells', { n: res.shells }))
        }
        if (res.skipped && res.skipped.length) {
          lines.push(
            i18n.t('index:received_skipped', {
              n: res.skipped.length,
              list: skippedText(res.skipped)
            })
          )
        }
        if (made.length < res.records.length) {
          lines.push(
            i18n.t('index:received_partial', {
              n: res.records.length - made.length,
              m: store.MAX_RECORDS
            })
          )
        }
        dialog.alert({ title: i18n.t('index:received_title'), text: lines.join('\n') })
      })
      .catch(err => {
        wx.hideLoading()
        this.collecting = false
        if (!err || err.code === 'cancel') return

        // 全部失败：不再用一句"文件可能已损坏"打包所有原因，而是把哪个文件、为什么，摆在明面上
        if (err.code === 'read' && err.skipped && err.skipped.length) {
          const head = i18n.t('index:all_failed_head', { n: err.skipped.length })
          const body = skippedDetail(err.skipped)
          const tail = i18n.t('index:all_failed_tail')
          dialog.alert({
            title: i18n.t('index:all_failed_title'),
            text: head + '\n\n' + body + '\n\n' + tail
          })
          return
        }
        dialog.alert({
          title: i18n.t('index:fail_title'),
          text: COLLECT_ERR[err.code] || i18n.t('common:retry')
        })
      })
  },

  /** 剪贴板：聊天里复制的文字——这才是灵感的常见形态 */
  collectClipboard() {
    if (this.collecting) return
    this.collecting = true
    wx.showLoading({ title: i18n.t('common:reading'), mask: true })

    transfer
      .fromClipboard()
      .then(res => {
        wx.hideLoading()
        this.collecting = false

        const rec = store.create({ type: 'text', content: res.text })
        // 落库失败时 store 已经提示过了
        if (!rec) return

        this.setData({ filter: 'all', filterTag: '' })
        this.limit = PAGE_SIZE
        this.refresh()
        this.flash(rec.id)

        if (res.truncated) {
          dialog.alert({
            title: i18n.t('index:clip_trunc_title'),
            text:
              i18n.t('index:clip_trunc_text', {
                n: res.total,
                m: transfer.MAX_TEXT,
                k: res.text.length
              })
          })
          return
        }
        this.toast(i18n.t('index:clip_saved'))
      })
      .catch(err => {
        wx.hideLoading()
        this.collecting = false
        const code = (err && err.code) || ''
        if (code === 'empty') {
          this.toast(i18n.t('index:clip_empty'))
          return
        }
        dialog.alert({
          title: i18n.t('index:clip_fail_title'),
          text: COLLECT_ERR[code] || i18n.t('common:retry')
        })
      })
  },

  /* ------------------------- 回顾 ------------------------- */

  /** 提醒位被点击：直接进记录页写文字，与底栏「写一句」同一个入口 */
  onNudge() {
    this.goText()
  },

  /** 首页的回顾位：没有那年今日时，用「随便翻一条」顶上这一栏 */
  openReview() {
    wx.navigateTo({ url: '/pages/review/review' })
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
    this.showUndo([item.id], i18n.t('index:undo_one'))
  },

  /** 整组删除：先确认条数和分组名，再批量软删，撤销可整组回来 */
  onDeleteGroup(e) {
    const key = e.currentTarget.dataset.key
    const group = (this.data.groups || []).filter(g => g.key === key)[0]
    if (!group || !group.count) return

    dialog
      .confirm({
        title: i18n.t('index:group_del_title', { name: group.label }),
        text: i18n.t('index:group_del_text', { n: group.count }),
        cancelText: i18n.t('common:cancel'),
        confirmText: i18n.t('index:group_del_ok'),
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        const ids = group.items.map(it => it.id)
        const done = store.removeMany(ids)
        if (!done.length) {
          this.toast(i18n.t('index:del_fail'))
          return
        }
        this.setData({ openSwipeId: '' })
        this.refresh()
        this.showUndo(done, i18n.t('index:undo_group', { name: group.label, n: done.length }))
      })
  },

  /* ------------------------- 撤销删除 ------------------------- */

  showUndo(ids, label) {
    this.pendingDeleteIds = ids || []
    if (this.undoTimer) clearInterval(this.undoTimer)

    let left = UNDO_SECONDS
    this.setData({
      undo: {
        visible: true,
        left: left,
        label: label,
        text: i18n.t('index:undo_text', { label: label, n: left })
      }
    })

    this.undoTimer = setInterval(() => {
      left -= 1
      if (left <= 0) {
        this.hideUndo()
      } else {
        this.setData({
          'undo.left': left,
          'undo.text': i18n.t('index:undo_text', { label: this.data.undo.label, n: left })
        })
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
    this.toast(done.length > 1 ? i18n.t('index:back_count', { n: done.length }) : i18n.t('index:back_one'))
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
          { key: 'edit', label: i18n.t('index:menu_edit'), desc: i18n.t('index:menu_edit_desc') },
          { key: 'copy', label: i18n.t('index:menu_copy'), desc: i18n.t('index:menu_copy_desc') },
          {
            key: 'star',
            label: item.starred ? i18n.t('index:menu_unstar') : i18n.t('index:menu_star'),
            desc: item.starred ? i18n.t('index:menu_unstar_desc') : i18n.t('index:menu_star_desc')
          },
          {
            key: 'archive',
            label: inArchive ? i18n.t('index:menu_unarchive') : i18n.t('index:menu_archive'),
            desc: inArchive ? i18n.t('index:menu_unarchive_desc') : i18n.t('index:menu_archive_desc')
          },
          { key: 'poster', label: i18n.t('index:menu_poster'), desc: i18n.t('index:menu_poster_desc') },
          { key: 'select', label: i18n.t('index:menu_select'), desc: i18n.t('index:menu_select_desc') },
          { key: 'delete', label: i18n.t('index:menu_delete'), desc: i18n.t('index:menu_delete_desc'), danger: true }
        ]
      }
    })
  },

  onSheetSelect(e) {
    const key = e.detail.key
    const mode = this.data.sheet.mode
    this.closeSheet()

    // 收集入口的两种来源，和卡片长按菜单共用同一个 action-sheet
    if (mode === 'collect') {
      if (key === 'file') this.collectFiles()
      else if (key === 'paste') this.collectClipboard()
      return
    }

    const item = this.actionItem
    if (!item) return

    if (key === 'edit') {
      wx.navigateTo({ url: '/pages/record/record?mode=edit&id=' + item.id })
    } else if (key === 'copy') {
      this.copyItem(item)
    } else if (key === 'star') {
      store.setStar(item.id, !item.starred)
      this.refresh()
      this.toast(item.starred ? i18n.t('index:toast_unstarred') : i18n.t('index:toast_starred'))
    } else if (key === 'archive') {
      const on = !item.archivedAt
      store.setArchive(item.id, on)
      this.refresh()
      this.toast(on ? i18n.t('index:toast_archived') : i18n.t('index:toast_unarchived'))
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
      this.toast(i18n.t('index:toast_no_text'))
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast(i18n.t('common:copy_ok'))
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
    this.setData({ selectMode: true, openSwipeId: '', anniversary: null, nudge: null })
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
      this.toast(i18n.t('index:toast_first_select'))
      return
    }
    const text = list
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(r => (r.content || '').trim())
      .filter(Boolean)
      .join('\n\n')
    if (!text) {
      this.toast(i18n.t('index:toast_selected_no_text'))
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast(i18n.t('index:toast_copied_n', { n: list.length }))
    })
  },

  onSelExport() {
    const list = this.selectedRecords()
    if (!list.length) {
      this.toast(i18n.t('index:toast_first_select'))
      return
    }
    wx.showLoading({ title: i18n.t('common:packing'), mask: true })
    transfer
      .exportText(list)
      .then(res => {
        wx.hideLoading()
        if (res.mode === 'cancel') return
        dialog.alert({
          title: i18n.t('index:export_done_title'),
          text:
            i18n.t('index:export_done_text', { n: res.total, name: res.fileName }) +
            (res.mode === 'share'
              ? i18n.t('index:export_done_share')
              : i18n.t('index:export_done_saved'))
        })
      })
      .catch(err => {
        wx.hideLoading()
        if (!err || err.code === 'cancel') return
        this.toast(
          err.code === 'unsupported'
            ? i18n.t('index:toast_export_unsupported')
            : i18n.t('index:toast_export_fail')
        )
      })
  },

  onSelDelete() {
    const list = this.selectedRecords()
    if (!list.length) {
      this.toast(i18n.t('index:toast_first_select'))
      return
    }
    dialog
      .confirm({
        title: i18n.t('index:sel_del_title', { n: list.length }),
        text: i18n.t('index:sel_del_text'),
        cancelText: i18n.t('common:cancel'),
        confirmText: i18n.t('index:menu_delete'),
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        const done = store.removeMany(list.map(r => r.id))
        if (!done.length) {
          this.toast(i18n.t('index:del_fail'))
          return
        }
        this.selected = {}
        this.setData({ selectMode: false })
        this.refresh()
        this.showUndo(done, i18n.t('index:undo_group_plain', { n: done.length }))
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
        this.toast(i18n.t('index:toast_voice_missing'))
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
   * 长度为什么是 120 字、超出会怎样，见 utils/share.js 的注释。
   */
  onShareAppMessage() {
    return share.card((this.data.anniversary && this.data.anniversary.text) || '')
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
        title: i18n.t('index:share_title'),
        text: preview,
        cancelText: i18n.t('index:share_cancel'),
        confirmText: i18n.t('index:share_ok')
      })
      .then(res => {
        if (!res.confirmed) return
        const rec = store.create({ type: 'text', content: text })
        if (!rec) return
        this.refresh()
        this.flash(rec.id)
        this.toast(i18n.t('index:share_saved'))
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
