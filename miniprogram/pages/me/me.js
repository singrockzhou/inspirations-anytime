const store = require('../../utils/store')
const date = require('../../utils/date')
const transfer = require('../../utils/transfer')
const dialog = require('../../utils/dialog')

/**
 * 作者与联系方式。
 * 放在常量里是为了让"复制联系方式"和"关于"里显示的是同一份字，
 * 不会哪天改了邮箱只改了一处。
 */
const AUTHOR = 'zhouguoxiang'
const WECHAT = '不卷的迭代老爸'
const EMAIL = '77111904@qq.com'
const CONTACT = '作者：' + AUTHOR + '\n微信：' + WECHAT + '\n邮箱：' + EMAIL

const IMPORT_ERR = {
  nofile: '没选到文件。',
  choose: '没能打开选择器，再试一次。',
  read: '文件读不出来，可能已经损坏。',
  parse: '这个文件不是有效的 JSON。',
  format: '这不是「灵感随时记」导出的备份文件。',
  unsupported: '当前环境不支持导入，请用手机微信打开。'
}

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
    firstText: '还没有开始',
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
    busy: false,
    /** 备份账本的两个事实：什么时候备过、该不该标成提醒色 */
    backupText: '',
    backupWarn: false,
    version: '1.7.6'
  },

  onShow() {
    this.load()
  },

  load() {
    const stats = store.stats()
    const heat = store.heat(14)
    const u = store.usage()

    // 两本账分开显示：索引在 10MB 键值存储里，图片/录音在 200MB 本地文件里
    const storageText = u.limitKB ? sizeText(u.storageKB) + ' / ' + sizeText(u.limitKB) : sizeText(u.storageKB)
    const mediaText = bytesText(u.mediaBytes) + (u.mediaCount ? ' · ' + u.mediaCount + ' 个' : '')

    // 备份账本：这里只摆事实（什么时候、多少条），该不该提醒由首页判断
    const bk = store.backupInfo()
    const bkDays = bk.at ? date.dayDiff(bk.at, Date.now()) : -1
    const backupText = !bk.at
      ? '还没备份过'
      : (bkDays <= 0 ? '今天' : bkDays + ' 天前') + (bk.total ? ' · ' + bk.total + ' 条' : '')
    const backupWarn = !bk.at || bkDays >= 7

    let storageWarn = ''
    if (u.percent >= 80) storageWarn = '记录索引快到上限了，建议先导出备份，再清掉一些旧记录。'
    else if (u.mediaBytes >= 150 * 1024 * 1024) storageWarn = '图片和录音快占满本机文件配额了，建议导出后清理。'

    this.setData({
      total: stats.visible,
      streak: stats.streak,
      firstText: stats.firstAt ? date.fullTime(stats.firstAt) : '还没有开始',
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
      heatMax: heat.max
    })
  },

  /* ------------------------- 整理 ------------------------- */

  /** 归档列表复用首页的筛选，不另做一页 */
  onArchive() {
    if (!this.data.archived) {
      wx.showToast({ title: '还没有归档的', icon: 'none' })
      return
    }
    getApp().globalData.pendingFilter = 'archive'
    wx.navigateBack()
  },

  /* ------------------------- 换手机：导出 ------------------------- */

  onExport() {
    if (this.data.busy) return
    if (this.data.total === 0) {
      wx.showToast({ title: '还没有记录', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    wx.showLoading({ title: '打包中', mask: true })

    transfer
      .exportBackup()
      .then(res => {
        wx.hideLoading()
        this.setData({ busy: false })
        if (res.mode === 'cancel') return

        const lines = ['共 ' + res.total + ' 条']
        if (res.mediaCarried) lines.push('含 ' + res.mediaCarried + ' 个图片/录音')
        if (res.mediaDropped) lines.push(res.mediaDropped + ' 个媒体超过 2MB 未打包')
        lines.push('')
        lines.push(
          res.mode === 'share'
            ? '文件已生成，转发给「文件传输助手」。到新手机上从聊天里选它导入。'
            : '文件已保存到电脑，拷到新手机后再导入。'
        )

        dialog.alert({ title: '导出完成', text: lines.join('\n') })
      })
      .catch(err => {
        wx.hideLoading()
        this.setData({ busy: false })
        if (!err || err.code === 'cancel') return
        dialog.alert({ title: '没导出成', text: transfer.EXPORT_ERR[err.code] || '再试一次看看。' })
      })
  },

  /* ------------------------- 换手机：导入 ------------------------- */

  onImport() {
    if (this.data.busy) return

    dialog
      .confirm({
        title: '从备份导入？',
        text: '会从聊天记录里选一个 .json 备份。导入只做新增，不会覆盖本机已有的记录。',
        cancelText: '算了',
        confirmText: '去选文件'
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
        lines.push(res.added > 0 ? '导入 ' + res.added + ' 条' : '没有新增记录')
        if (res.skipped) lines.push(res.skipped + ' 条已存在或超出上限，已跳过')
        if (res.mediaRestored) lines.push('还原 ' + res.mediaRestored + ' 个图片/录音')
        if (res.mediaFailed) lines.push(res.mediaFailed + ' 个媒体还原失败')

        dialog.alert({ title: '导入完成', text: lines.join('\n') })
      })
      .catch(err => {
        this.setData({ busy: false })
        if (!err || err.code === 'cancel') return
        dialog.alert({ title: '没导入成', text: IMPORT_ERR[err.code] || '再试一次看看。' })
      })
  },

  /* ------------------------- 清空 ------------------------- */

  /** 清空要连点两次确认，避免误触 */
  onClear() {
    if (this.data.total === 0 && this.data.archived === 0) {
      wx.showToast({ title: '已经是空的了', icon: 'none' })
      return
    }
    dialog
      .confirm({
        title: '清空全部灵感？',
        text: '共 ' + (this.data.total + this.data.archived) + ' 条，清掉之后找不回来。',
        cancelText: '算了',
        confirmText: '清空',
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        if (store.clearAll()) {
          this.load()
          wx.showToast({ title: '清干净了', icon: 'none' })
        }
      })
  },

  /**
   * 关于：一个只说明"这是什么"的弹窗是死的，所以第二个按钮做成真动作——
   * 想找作者的人，最需要的就是把微信或邮箱带走，而不是手抄一遍。
   */
  onAbout() {
    const text = [
      '灵感随时记 v' + this.data.version,
      '',
      '所有记录只保存在这台手机上，不上传、不联网、不需要登录。换手机时用上面的「导出到文件」带走。',
      '',
      '作者：' + AUTHOR,
      '微信：' + WECHAT,
      '邮箱：' + EMAIL
    ].join('\n')

    dialog
      .confirm({
        title: '关于小程序',
        text: text,
        cancelText: '知道了',
        confirmText: '复制联系方式'
      })
      .then(r => {
        if (!r.confirmed) return
        wx.setClipboardData({
          data: CONTACT,
          success: () => wx.showToast({ title: '联系方式已复制', icon: 'none' })
        })
      })
  },

  /** 点占用两行都到这里：把两本账讲清楚，别让人对着一串 KB 猜 */
  onStorage() {
    const u = store.usage()
    const text = [
      '记录索引：' + sizeText(u.storageKB) + '，上限 ' + sizeText(u.limitKB) + '。',
      '存的是文字、标签和设置，不含照片、录音。',
      '',
      '图片与录音：' + bytesText(u.mediaBytes) + '，' + u.mediaCount + ' 个文件。',
      '它们作为文件放在本机，不占上面这份额度。',
      '',
      '索引满了只会写不进新记录，已有的不会自动丢。稳妥做法是先「导出到文件」备份，再清掉不要的。'
    ].join('\n')
    dialog.alert({ title: '本机占用怎么看', text: text })
  }
})
