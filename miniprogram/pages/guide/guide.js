/**
 * 使用指南（公开页）
 *
 * 会被搜索收录，所以同样是"纯常量页"：不读记录、不读备份状态、
 * 不调任何隐私接口。里面每一句都得是"这台机器上没有数据也成立"的话。
 *
 * FAQ 不做折叠：折叠在渲染结果里可能只剩一个标题，
 * 而这一页存在的意义就是让第一次来的人（和爬虫）一次看全。
 */
const i18n = require('../../utils/i18n')

/** 与 i18n 里的 q1..q6 / a1..a6 一一对应 */
const FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']

Page({
  data: {
    t: {},
    faq: [],
    tplLink: ''
  },

  onLoad() {
    this.render()
  },

  onShow() {
    // 切换语言走的是 reLaunch，页面会重建；这里兜住"从别处返回时文案还是旧的"。
    this.render()
  },

  render() {
    const t = i18n.pack('guide')
    const faq = FAQ_KEYS.map(function (k) {
      return {
        q: t[k],
        a: t['a' + k.slice(1)]
      }
    })
    this.setData({
      t: t,
      faq: faq,
      tplLink: i18n.t('guide:tpl_link')
    })
    i18n.title('guide:nav')
  },

  onStart() {
    wx.navigateTo({ url: '/pages/record/record?type=text' })
  },

  onShareAppMessage() {
    return {
      title: i18n.t('share:title'),
      path: '/pages/guide/guide'
    }
  }
})
