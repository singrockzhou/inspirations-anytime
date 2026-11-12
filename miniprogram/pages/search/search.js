const store = require('../../utils/store')
const date = require('../../utils/date')
const i18n = require('../../utils/i18n')

Page({
  data: {
    keyword: '',
    results: [],
    searched: false,
    tags: [],
    focus: true,
    t: {},
    emptyText: '',
    emptySub: ''
  },

  onLoad(query) {
    this.applyLang()
    this.setData({ tags: store.tags().slice(0, 10) })
    if (query && query.tag) {
      this.setData({ keyword: query.tag })
      this.run(query.tag)
    }
  },

  /** 文案包：wxml 里用 {{t.xxx}}；搜索页每次进入都重建，随 reLaunch 一起换语言 */
  applyLang() {
    i18n.title('nav:search')
    this.setData({
      t: i18n.pack('search'),
      emptyText: i18n.t('search:ph'),
      emptySub: i18n.t('search:empty_sub')
    })
  },

  onInput(e) {
    const value = e.detail.value
    this.setData({ keyword: value })
    // 输入抖动没必要每次都全量扫，200ms 足够跟手
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run(value), 200)
  },

  onConfirm(e) {
    clearTimeout(this.timer)
    this.run(e.detail.value)
  },

  onTag(e) {
    const tag = e.currentTarget.dataset.tag
    this.setData({ keyword: tag })
    this.run(tag)
  },

  onClear() {
    clearTimeout(this.timer)
    this.setData({ keyword: '', results: [], searched: false })
  },

  run(keyword) {
    const kw = (keyword || '').trim()
    if (!kw) {
      this.setData({ results: [], searched: false })
      return
    }

    const rows = store.search(kw).map(r => {
      const seg = r._seg || { before: '', mid: '', after: '' }
      return Object.assign(r, {
        _time: date.relative(r.createdAt),
        _type:
          r.type === 'voice'
            ? i18n.t('index:badge_voice', { n: r.duration || 0 })
            : r.type === 'photo'
            ? i18n.t('index:badge_photo_one')
            : i18n.t('index:badge_text'),
        _hit: !!seg.mid
      })
    })

    this.setData({
      results: rows,
      searched: true,
      countText: i18n.t('search:count', { n: rows.length }),
      notFoundText: i18n.t('search:not_found', { kw: kw })
    })
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  goBack() {
    wx.navigateBack()
  }
})
