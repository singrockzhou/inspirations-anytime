const store = require('../../utils/store')
const date = require('../../utils/date')

/**
 * 随机重温
 * 只做一件小事：从旧记录里抽一条给你看。
 * 抽的时候刻意偏向"7 天以上"的记录——昨天刚写的再看一遍没有意义，
 * 半年前那句才可能让人"啊，原来是这么想的"。
 */
Page({
  data: {
    item: null,
    empty: false,
    timeText: '',
    agoText: '',
    starred: false,
    total: 0,
    toastText: ''
  },

  onLoad() {
    this.pick(true)
  },

  pick(first) {
    const all = store.list({ includeArchived: true })
    this.setData({ total: all.length })

    if (!all.length) {
      this.setData({ item: null, empty: true })
      return
    }

    const current = this.data.item
    let pool = all.filter(r => !current || r.id !== current.id)
    if (!pool.length) pool = all

    // 优先给"放了一阵子的"，没有就退回全量
    const old = pool.filter(r => Date.now() - r.createdAt > 7 * 86400000)
    const source = old.length ? old : pool
    const item = source[Math.floor(Math.random() * source.length)]

    const days = date.dayDiff(item.createdAt, Date.now())
    this.setData({
      item: item,
      empty: false,
      timeText: date.fullTime(item.createdAt),
      agoText: days <= 0 ? '今天刚记的' : days === 1 ? '昨天记的' : days + ' 天前记的',
      starred: !!item.starred
    })

    if (!first) {
      // 换卡时给一次极轻的震动，比动画更省电也更有"抽到了"的感觉
      wx.vibrateShort({ type: 'light', fail() {} })
    }
  },

  onNext() {
    this.pick(false)
  },

  onStar() {
    const item = this.data.item
    if (!item) return
    store.setStar(item.id, !item.starred)
    this.setData({ starred: !item.starred, 'item.starred': item.starred ? 0 : 1 })
    this.toast(item.starred ? '从星标里拿下来了' : '加星了')
  },

  onOpen() {
    const item = this.data.item
    if (!item) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id })
  },

  goWrite() {
    wx.navigateTo({ url: '/pages/record/record?mode=create&type=text' })
  },

  onShareAppMessage() {
    const item = this.data.item
    const text = item ? (item.content || '').slice(0, 400) : ''
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
