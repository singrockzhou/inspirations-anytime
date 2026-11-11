const store = require('../../utils/store')
const date = require('../../utils/date')

Page({
  data: {
    total: 0,
    firstText: '还没有开始',
    lastText: '—',
    byType: { text: 0, voice: 0, photo: 0 },
    storageText: '',
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
        '灵感随时记 v' + this.data.version + '\n\n所有记录只保存在这台手机上，不上传、不联网、不需要登录。想换手机的话，先把重要的那条复制出来。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
