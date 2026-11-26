/**
 * 模板详情（公开页，参数 k）
 *
 * 参数只有一个：k = templates.LIST 里的 id。
 *
 * 三条约束：
 * 1) 只查常量表，不读 storage —— 与列表页同理，爬虫进来时本机没有数据。
 * 2) k 缺失或查不到时给一页"找不到了"，不白屏、不抛错 —— 旧链接、
 *    手改链接、分享被截断都会走到这里。
 * 3) 正文（骨架 + 示例）在首屏就能看到，不折叠、不懒加载。
 */
const i18n = require('../../utils/i18n')
const templates = require('../../utils/templates')

Page({
  data: {
    t: {},
    item: null,
    /** 查不到这条模板 */
    missing: false,
    /** 已经拼好「适合：xxx」的整句 */
    sceneText: '',
    /** 同分类的其它三条，底部「同类还有」用 */
    related: [],
    /** 「看全部 25 个」——条数同样取自 templates.count，不写死 */
    allText: '',
    showCnNote: false
  },

  onLoad(options) {
    this.setData({
      t: i18n.pack('tpl'),
      allText: i18n.t('tpl:all', { n: templates.count }),
      showCnNote: i18n.isEn()
    })
    this.show(options && options.k)
  },

  show(k) {
    const item = templates.byId(k)
    if (!item) {
      i18n.title('tpl:nav')
      this.setData({ missing: true, item: null, sceneText: '', related: [] })
      return
    }
    /** 标题与场景按语言取；正文（提纲/示例/怎么用）只有中文，靠 h-cn 那句说明 */
    const lang = i18n.isEn() ? 'en' : 'zh'
    const title = templates.pick(item, 'title', lang)
    const scene = templates.pick(item, 'scene', lang)
    // 导航栏只标识"在哪一层"：模板名交给页面大标题。
    // 用模板名会把英文标题截成 "A Tuesday fiv…"（10/25 条超过导航栏容量），
    // 而且大标题就在下面 60px，同一句话写两遍本来也多余。
    if (typeof wx !== 'undefined' && wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: i18n.t('tpl:nav_one') })
    }
    // 只搬 id 和标题：底部这栏是「去哪儿」，不是「读什么」，正文留在各自的详情页
    const related = templates.related(item.id, 3).map(function (x) {
      return { id: x.id, title: templates.pick(x, 'title', lang) }
    })
    this.setData({
      missing: false,
      /* wxml 直接读 item.title：把选好的语言覆盖上去，正文三个字段原样带过 */
      item: Object.assign({}, item, { title: title, scene: scene }),
      related: related,
      sceneText: i18n.t('tpl:scene', { v: scene })
    })
  },

  /**
   * 从「用这个模板记一条」写完回来：`globalData.flashId` 有值，说明刚存下一条。
   *
   * 这时不该把人留在模板页——屏幕上只有骨架和示例，看不到他刚写的东西，
   * "存下了"就成了一句空话。回首页，那条会被点亮（首页 onShow 消费 flashId）。
   * flashId 不在这里清，交给首页清——清早了首页就不知道要亮哪一条。
   */
  onShow() {
    const app = typeof getApp === 'function' ? getApp() : null
    const id = app && app.globalData ? app.globalData.flashId : ''
    if (!id) return
    wx.reLaunch({ url: '/pages/index/index' })
  },

  /** 带骨架进编辑页。参数名 tpl 与 record.js 的解析一一对应 */
  onUse() {
    const item = this.data.item
    if (!item) return
    wx.navigateTo({
      url: '/pages/record/record?type=text&tpl=' + item.id
    })
  },

  /**
   * 回列表。从列表点进来时栈里有上一页，直接返回；从分享链接或搜索
   * 直接打开时栈里只有本页，navigateBack 会失败，改用 redirectTo。
   */
  onBackList() {
    const stack = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (stack.length > 1) {
      wx.navigateBack()
      return
    }
    wx.redirectTo({ url: '/pages/tpl/list' })
  },

  onHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  onShareAppMessage() {
    const item = this.data.item
    if (!item) {
      /* 查不到时分享列表页：{n} 必须填，否则卡片上会露出一个生占位符 */
      return { title: i18n.t('tpl:share_list', { n: templates.count }), path: '/pages/tpl/list' }
    }
    return {
      title: i18n.t('tpl:share_title', { t: item.title }),
      path: '/pages/tpl/detail?k=' + item.id
    }
  }
})
