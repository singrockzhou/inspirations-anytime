const store = require('../../utils/store')
const date = require('../../utils/date')
const transfer = require('../../utils/transfer')
const remind = require('../../utils/remind')

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
    streak: 0,
    firstText: '还没有开始',
    lastText: '—',
    byType: { text: 0, voice: 0, photo: 0 },
    starred: 0,
    archived: 0,
    tagged: 0,
    storageText: '',
    heat: [],
    heatMax: 0,
    remindOn: false,
    remindTime: '21:00',
    remindReady: false,
    busy: false,
    version: '1.1.0'
  },

  onShow() {
    this.load()
  },

  load() {
    const stats = store.stats()
    const heat = store.heat(14)
    const r = remind.status()

    let storageText = ''
    try {
      const info = wx.getStorageInfoSync()
      storageText = (info.currentSize || 0) + ' KB / ' + (info.limitSize || 0) + ' KB'
    } catch (e) {
      storageText = ''
    }

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
      heat: heat.cells,
      heatMax: heat.max,
      remindOn: r.on,
      remindTime: r.timeText,
      remindReady: r.configured
    })
  },

  /* ------------------------- 回顾 ------------------------- */

  onReview() {
    wx.navigateTo({ url: '/pages/review/review' })
  },

  /** 归档列表复用首页的筛选，不另做一页 */
  onArchive() {
    if (!this.data.archived) {
      wx.showToast({ title: '还没有归档的', icon: 'none' })
      return
    }
    getApp().globalData.pendingFilter = 'archive'
    wx.navigateBack()
  },

  /* ------------------------- 从聊天存一条 ------------------------- */

  onImportChat() {
    if (this.data.busy) return
    this.setData({ busy: true })
    wx.showLoading({ title: '处理中', mask: true })

    transfer
      .importFromChat()
      .then(res => {
        wx.hideLoading()
        this.setData({ busy: false })
        this.load()
        const lines = ['已存下 ' + res.records.length + ' 条，回到列表就能看到。']
        if (res.failed) lines.push(res.failed + ' 个文件读不出正文，只留了文件名，可以自己补一句。')
        wx.showModal({
          title: '收到',
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
          title: '没存成',
          content: IMPORT_ERR[err.code] || '再试一次看看。',
          showCancel: false,
          confirmText: '知道了'
        })
      })
  },

  /* ------------------------- 每日提醒 ------------------------- */

  /**
   * 订阅消息必须由服务端下发，所以这里只做两件事：
   * 没配模板时如实说明并记住时间偏好；配了模板才真正请求授权。
   */
  onRemind() {
    if (!this.data.remindReady) {
      wx.showModal({
        title: '还差一步',
        content:
          '每日提醒要靠微信订阅消息，需要先在小程序后台创建模板，把模板 ID 填进 utils/remind.js。\n\n现在可以先把想被提醒的时间记下来。',
        cancelText: '算了',
        confirmText: '选时间',
        confirmColor: '#C4713F',
        success: r => {
          if (r.confirm) this.pickTime()
        }
      })
      return
    }

    if (this.data.remindOn) {
      wx.showModal({
        title: '关掉每日提醒？',
        content: '关掉之后不再收到提醒，记录本身不受影响。',
        confirmText: '关掉',
        success: r => {
          if (!r.confirm) return
          remind.disable()
          this.load()
          wx.showToast({ title: '已关掉', icon: 'none' })
        }
      })
      return
    }

    remind
      .enable()
      .then(res => {
        this.load()
        if (res.on) wx.showToast({ title: '已开启', icon: 'none' })
        else wx.showToast({ title: '没授权，提醒不会来', icon: 'none' })
      })
      .catch(err => {
        if (!err || err.code === 'cancel') return
        wx.showModal({
          title: '没能开启',
          content: err.message || '再试一次看看。',
          showCancel: false,
          confirmText: '知道了'
        })
      })
  },

  onRemindTime(e) {
    const value = e.detail.value || '21:00'
    const parts = value.split(':')
    remind.setTime(Number(parts[0]) || 0, Number(parts[1]) || 0)
    this.load()
    wx.showToast({ title: '记下了 ' + value, icon: 'none' })
  },

  pickTime() {
    // picker 只能由用户点开，这里给一句引导，避免"点了没反应"
    wx.showToast({ title: '点右侧时间设置', icon: 'none' })
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
    if (this.data.total === 0 && this.data.archived === 0) {
      wx.showToast({ title: '已经是空的了', icon: 'none' })
      return
    }
    wx.showModal({
      title: '清空全部灵感？',
      content: '共 ' + (this.data.total + this.data.archived) + ' 条，清掉之后找不回来。',
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
