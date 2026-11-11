const store = require('../../utils/store')
const date = require('../../utils/date')

Page({
  data: {
    keyword: '',
    results: [],
    searched: false,
    tags: [],
    focus: true,
    emptyText: '搜正文，也搜 #标签',
    emptySub: '比如「播客」，或者直接点下面一个标签'
  },

  onLoad(query) {
    this.setData({ tags: store.tags().slice(0, 10) })
    if (query && query.tag) {
      this.setData({ keyword: query.tag })
      this.run(query.tag)
    }
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
        _type: r.type === 'voice' ? '语音 ' + (r.duration || 0) + '″' : r.type === 'photo' ? '照片' : '文字',
        _hit: !!seg.mid
      })
    })

    this.setData({ results: rows, searched: true })
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
