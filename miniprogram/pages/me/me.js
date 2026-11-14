const store = require('../../utils/store')
const date = require('../../utils/date')
const transfer = require('../../utils/transfer')
const dialog = require('../../utils/dialog')
const i18n = require('../../utils/i18n')

/**
 * 作者与联系方式。
 * 放在常量里是为了让"复制联系方式"和"关于"里显示的是同一份字，
 * 不会哪天改了邮箱只改了一处。
 */
const AUTHOR = 'zhouguoxiang'
const WECHAT = '不卷的迭代老爸'
const EMAIL = '77111904@qq.com'
function contactText() {
  return [
    i18n.t('me:about_author', { v: AUTHOR }),
    i18n.t('me:about_wechat', { v: WECHAT }),
    i18n.t('me:about_email', { v: EMAIL })
  ].join('\n')
}

const IMPORT_ERR = i18n.table('me', ['nofile', 'choose', 'read', 'parse', 'format', 'unsupported'], 'err')

/** 10240KB → "10 MB"，2KB → "2 KB"，别让用户自己换算 */
function sizeText(kb) {
  if (!kb) return '0 KB'
  if (kb < 1024) return Math.round(kb) + ' KB'
  const mb = kb / 1024
  return (mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
}

function bytesText(bytes) {
  return sizeText((bytes || 0) / 1024)
}

Page({
  data: {
    total: 0,
    streak: 0,
    firstText: '',
    lastText: '—',
    byType: { text: 0, voice: 0, photo: 0 },
    starred: 0,
    archived: 0,
    tagged: 0,
    storageText: '',
    storagePct: 0,
    storagePctText: '0',
    mediaText: '',
    mediaCount: 0,
    storageWarn: '',
    heat: [],
    heatMax: 0,
    /** 带数字的句子在 js 里拼好，wxml 只负责显示 */
    heatSub: '',
    indexSub: '',
    busy: false,
    /** 备份账本的两个事实：什么时候备过、该不该标成提醒色 */
    backupText: '',
    backupWarn: false,
    version: '1.8.3',
    /** 当前语言与文案包；切换语言后由 applyLang 重新填 */
    t: {},
    lang: 'zh',
    langName: ''
  },

  onShow() {
    this.applyLang()
    this.load()
  },

  /** 把当前语言的文案包塞进 data；页面重建（reLaunch）后由 onShow 再调一次 */
  applyLang() {
    const lang = i18n.lang()
    i18n.title('nav:me')

    this.setData({
      t: i18n.pack('me'),
      lang: lang,
      langName: lang === 'en' ? 'English' : '中文'
    })
  },

  /**
   * 切换语言：写盘后立刻 reLaunch。
   * 为什么不逐页 setData：八个页面里还有一些文案是在 js 里拼好的（日期、统计、
   * 状态句），逐页刷新必然漏掉某一处，而 reLaunch 会让所有页面重新 onLoad，
   * 一次到位。代价是丢掉当前滚动位置，换语言是低频操作，值得。
   */
  onLang() {
    wx.showActionSheet({
      itemList: ['中文', 'English'],
      success: res => {
        const next = res.tapIndex === 1 ? 'en' : 'zh'
        if (next === i18n.lang()) return
        i18n.setLang(next)
        wx.reLaunch({ url: '/pages/me/me' })
      }
    })
  },

  load() {
    const stats = store.stats()
    const heat = store.heat(14)
    const u = store.usage()

    // 两本账分开显示：索引在 10MB 键值存储里，图片/录音在 200MB 本地文件里
    const storageText = u.limitKB ? sizeText(u.storageKB) + ' / ' + sizeText(u.limitKB) : sizeText(u.storageKB)
    const mediaText =
      bytesText(u.mediaBytes) + (u.mediaCount ? ' · ' + u.mediaCount + ' ' + i18n.t('me:unit_media') : '')

    // 备份账本：这里只摆事实（什么时候、多少条），该不该提醒由首页判断
    const bk = store.backupInfo()
    const bkDays = bk.at ? date.dayDiff(bk.at, Date.now()) : -1
    const when = bkDays <= 0 ? i18n.t('me:today') : i18n.t('me:days_ago', { n: bkDays })
    const backupText = !bk.at
      ? i18n.t('me:never_backed')
      : bk.total
        ? i18n.t('me:backup_meta', { t: when, n: bk.total })
        : when
    const backupWarn = !bk.at || bkDays >= 7

    let storageWarn = ''
    if (u.percent >= 80) storageWarn = i18n.t('me:warn_index')
    else if (u.mediaBytes >= store.MEDIA_WARN_BYTES) storageWarn = i18n.t('me:warn_media')

    this.setData({
      total: stats.visible,
      streak: stats.streak,
      firstText: stats.firstAt ? date.fullTime(stats.firstAt) : i18n.t('me:not_started'),
      lastText: stats.lastAt ? date.relative(stats.lastAt) : '—',
      byType: stats.byType,
      starred: stats.starred,
      archived: stats.archived,
      tagged: stats.tagged,
      storageText: storageText,
      storagePct: u.percent,
      storagePctText: u.percent < 1 && u.storageKB > 0 ? '<1' : String(u.percent),
      mediaText: mediaText,
      mediaCount: u.mediaCount,
      storageWarn: storageWarn,
      backupText: backupText,
      backupWarn: backupWarn,
      heat: heat.cells,
      heatMax: heat.max,
      heatSub: i18n.t('me:heat_sub', { n: heat.max }),
      indexSub: i18n.t('me:row_index_sub', { n: u.percent < 1 && u.storageKB > 0 ? '<1' : String(u.percent) })
    })
  },

  /* ------------------------- 整理 ------------------------- */

  /** 归档列表复用首页的筛选，不另做一页 */
  onArchive() {
    if (!this.data.archived) {
      wx.showToast({ title: i18n.t('me:no_archive'), icon: 'none' })
      return
    }
    getApp().globalData.pendingFilter = 'archive'
    wx.navigateBack()
  },

  /* ------------------------- 换手机：导出 ------------------------- */

  onExport() {
    if (this.data.busy) return
    if (this.data.total === 0) {
      wx.showToast({ title: i18n.t('me:no_records'), icon: 'none' })
      return
    }

    this.setData({ busy: true })
    wx.showLoading({ title: i18n.t('common:packing'), mask: true })

    transfer
      .exportBackup()
      .then(res => {
        wx.hideLoading()
        this.setData({ busy: false })
        if (res.mode === 'cancel') return

        const lines = [i18n.t('me:export_count', { n: res.total })]
        if (res.mediaCarried) lines.push(i18n.t('me:export_media', { n: res.mediaCarried }))
        if (res.mediaDropped) lines.push(i18n.t('me:export_dropped', { n: res.mediaDropped }))
        lines.push('')
        lines.push(res.mode === 'share' ? i18n.t('me:export_share') : i18n.t('me:export_saved'))

        dialog.alert({ title: i18n.t('me:export_title'), text: lines.join('\n') })
      })
      .catch(err => {
        wx.hideLoading()
        this.setData({ busy: false })
        if (!err || err.code === 'cancel') return
        dialog.alert({
          title: i18n.t('me:export_fail'),
          text: transfer.EXPORT_ERR[err.code] || i18n.t('common:retry')
        })
      })
  },

  /* ------------------------- 换手机：导入 ------------------------- */

  onImport() {
    if (this.data.busy) return

    dialog
      .confirm({
        title: i18n.t('me:import_ask_title'),
        text: i18n.t('me:import_ask_text'),
        cancelText: i18n.t('me:import_ask_cancel'),
        confirmText: i18n.t('me:import_ask_ok')
      })
      .then(modal => {
        if (!modal.confirmed) return
        this.doImport()
      })
  },

  doImport() {
    this.setData({ busy: true })

    transfer
      .importBackup()
      .then(res => {
        this.setData({ busy: false })
        this.load()

        const lines = []
        lines.push(res.added > 0 ? i18n.t('me:import_added', { n: res.added }) : i18n.t('me:import_none'))
        if (res.skipped) lines.push(i18n.t('me:import_skipped', { n: res.skipped }))
        if (res.mediaRestored) lines.push(i18n.t('me:import_media', { n: res.mediaRestored }))
        if (res.mediaFailed) lines.push(i18n.t('me:import_media_fail', { n: res.mediaFailed }))

        dialog.alert({ title: i18n.t('me:import_title'), text: lines.join('\n') })
      })
      .catch(err => {
        this.setData({ busy: false })
        if (!err || err.code === 'cancel') return
        dialog.alert({
          title: i18n.t('me:import_fail'),
          text: IMPORT_ERR[err.code] || i18n.t('common:retry')
        })
      })
  },

  /* ------------------------- 清空 ------------------------- */

  /** 清空要连点两次确认，避免误触 */
  onClear() {
    if (this.data.total === 0 && this.data.archived === 0) {
      wx.showToast({ title: i18n.t('me:clear_empty'), icon: 'none' })
      return
    }
    dialog
      .confirm({
        title: i18n.t('me:clear_ask_title'),
        text: i18n.t('me:clear_ask_text', { n: this.data.total + this.data.archived }),
        cancelText: i18n.t('me:clear_ask_cancel'),
        confirmText: i18n.t('me:clear_ask_ok'),
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        if (store.clearAll()) {
          this.load()
          wx.showToast({ title: i18n.t('me:clear_done'), icon: 'none' })
        }
      })
  },

  /**
   * 关于：一个只说明"这是什么"的弹窗是死的，所以第二个按钮做成真动作——
   * 想找作者的人，最需要的就是把公众号或邮箱带走，而不是手抄一遍。
   */
  onAbout() {
    const text = [
      i18n.t('me:about_version', { v: this.data.version }),
      '',
      i18n.t('me:about_privacy'),
      '',
      i18n.t('me:about_author', { v: AUTHOR }),
      i18n.t('me:about_wechat', { v: WECHAT }),
      i18n.t('me:about_email', { v: EMAIL })
    ].join('\n')

    dialog
      .confirm({
        title: i18n.t('me:about_title'),
        text: text,
        cancelText: i18n.t('me:about_cancel'),
        confirmText: i18n.t('me:about_confirm')
      })
      .then(r => {
        if (!r.confirmed) return
        wx.setClipboardData({
          data: contactText(),
          success: () => wx.showToast({ title: i18n.t('common:contact_copied'), icon: 'none' })
        })
      })
  },

  /** 点占用两行都到这里：把两本账讲清楚，别让人对着一串 KB 猜 */
  onStorage() {
    const u = store.usage()
    const text = [
      i18n.t('me:storage_index', { used: sizeText(u.storageKB), limit: sizeText(u.limitKB) }),
      i18n.t('me:storage_index_sub'),
      '',
      i18n.t('me:storage_media', { size: bytesText(u.mediaBytes), n: u.mediaCount }),
      i18n.t('me:storage_media_sub'),
      '',
      i18n.t('me:storage_full')
    ].join('\n')
    dialog.alert({ title: i18n.t('me:storage_title'), text: text })
  }
})
