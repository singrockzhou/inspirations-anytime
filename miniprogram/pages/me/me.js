const store = require('../../utils/store')
const date = require('../../utils/date')
const transfer = require('../../utils/transfer')

const EXPORT_ERR = {
  empty: '还没有记录可以导出。',
  serialize: '数据转换失败，再试一次。',
  write: '写文件失败，可能是本机空间不足。',
  save: '保存文件失败，换个方式再试一次。',
  share: '分享失败，请确认微信已登录。',
  unsupported: '当前环境不支持导出，请用手机微信打开。'
}

const IMPORT_ERR = {
  nofile: '没选到文件。',
  choose: '没能打开选择器，再试一次。',
  read: '文件读不出来，可能已经损坏。',
  parse: '这个文件不是有效的 JSON。',
  format: '这不是「灵感随时记」导出的备份文件。',
  unsupported: '当前环境不支持导入，请用手机微信打开。'
}

Page({
  data: {
    total: 0,
    firstText: '还没有开始',
    lastText: '—',
    byType: { text: 0, voice: 0, photo: 0 },
    storageText: '',
    busy: false,
    version: '1.0.0'
  },

  onShow() {
    this.load()
  },

  load() {
    const stats = store.stats()

    let storageText = ''
    try {
      const info = wx.getStorageInfoSync()
      storageText = (info.currentSize || 0) + ' KB / ' + (info.limitSize || 0) + ' KB'
    } catch (e) {
      storageText = ''
    }

    this.setData({
      total: stats.total,
      firstText: stats.firstAt ? date.fullTime(stats.firstAt) : '还没有开始',
      lastText: stats.lastAt ? date.relative(stats.lastAt) : '—',
      byType: stats.byType,
      storageText: storageText
    })
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

        wx.showModal({
          title: '导出完成',
          content: lines.join('\n'),
          showCancel: false,
          confirmText: '知道了'
        })
      })
      .catch(err => {
        wx.hideLoading()
        this.setData({ busy: false })
        if (!err || err.code === 'cancel') return
        wx.showModal({
          title: '没导出成',
          content: EXPORT_ERR[err.code] || '再试一次看看。',
          showCancel: false,
          confirmText: '知道了'
        })
      })
  },

  /* ------------------------- 换手机：导入 ------------------------- */

  onImport() {
    if (this.data.busy) return

    wx.showModal({
      title: '从备份导入？',
      content: '会从聊天记录里选一个 .json 备份。导入只做新增，不会覆盖本机已有的记录。',
      cancelText: '算了',
      confirmText: '去选文件',
      confirmColor: '#C4713F',
      success: modal => {
        if (!modal.confirm) return
        this.doImport()
      }
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

        wx.showModal({
          title: '导入完成',
          content: lines.join('\n'),
          showCancel: false,
          confirmText: '知道了'
        })
      })
      .catch(err => {
        this.setData({ busy: false })
        if (!err || err.code === 'cancel') return
        wx.showModal({
          title: '没导入成',
          content: IMPORT_ERR[err.code] || '再试一次看看。',
          showCancel: false,
          confirmText: '知道了'
        })
      })
  },

  /* ------------------------- 清空 ------------------------- */

  /** 清空要连点两次确认，避免误触 */
  onClear() {
    if (this.data.total === 0) {
      wx.showToast({ title: '已经是空的了', icon: 'none' })
      return
    }
    wx.showModal({
      title: '清空全部灵感？',
      content: '共 ' + this.data.total + ' 条，清掉之后找不回来。',
      cancelText: '算了',
      confirmText: '清空',
      confirmColor: '#B5673F',
      success: res => {
        if (!res.confirm) return
        if (store.clearAll()) {
          this.load()
          wx.showToast({ title: '清干净了', icon: 'none' })
        }
      }
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于这个小程序',
      content:
        '灵感随时记 v' +
        this.data.version +
        '\n\n所有记录只保存在这台手机上，不上传、不联网、不需要登录。换手机时用上面的「导出到文件」带走。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
