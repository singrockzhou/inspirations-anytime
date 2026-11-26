/**
 * 模板列表（公开页）
 *
 * 这一页会被微信爬虫抓（sitemap 白名单里放着它），所以有三条与别处不同的约束：
 *
 * 1) **不读任何本机数据。** 只 require i18n 与 templates，不碰 store。
 *    爬虫进来时 storage 是空的，页面若依赖记录数就会渲染成空态，
 *    而官方明确：页面数据与真实呈现不一致的页面不进入索引。
 *
 * 2) **链接必须是真实 navigator。** 详情入口用 <navigator>，不用
 *    bindtap + navigateTo —— 前者在渲染结果里就是一个可跟随的链接，
 *    后者对爬虫来说什么都不是。官方没有承诺会穷举 detail 的参数组合。
 *
 * 3) **收起的条目不用 wx:if，只用 hidden。** wx:if 会把节点从渲染结果里
 *    摘掉，收起的 2 条模板的链接就跟着消失；hidden 只加 display:none，
 *    节点仍在。至于 display:none 里的链接爬虫到底认不认，官方没有说明，
 *    这一点是**推断**（节点在总比不存在更可能被跟随）。若上线后收录为 0，
 *    第一个该试的改动就是把折叠整个去掉。
 */
const i18n = require('../../utils/i18n')
const templates = require('../../utils/templates')

/** 每个分类收起时露出几条。改这个数要同时看一眼 list.wxml 的注释。 */
const PREVIEW = 3

/** 列表只渲染标题和一句场景，骨架与示例留给详情页。
 *  25 条全量塞进 setData 会把十几 KB 的正文搬到视图层，纯属浪费。 */
function slim(item) {
  return {
    id: item.id,
    title: item.title,
    scene: item.scene
  }
}

Page({
  data: {
    /** 当前语言文案包 */
    t: {},
    groups: [],
    countText: '',
    /** 英文界面下如实说明模板内容是中文，不给半截翻译 */
    showCnNote: false,
    guideText: ''
  },

  onLoad() {
    const groups = templates.groups().map(function (g) {
      const rest = Math.max(g.items.length - PREVIEW, 0)
      return {
        id: g.id,
        name: g.name,
        desc: g.desc,
        countText: i18n.t('tpl:cat_count', { n: g.items.length }),
        /** 收起时露出的三条 */
        head: g.items.slice(0, PREVIEW).map(slim),
        /** 需要展开才看到的其余条目 */
        more: g.items.slice(PREVIEW).map(slim),
        /** 默认每类只露三条，其余收起 */
        open: false,
        /** 「展开剩下 2 个」这句在这里拼好，wxml 里不再传参 */
        moreText: i18n.t('tpl:expand_n', { n: rest })
      }
    })

    this.setData({
      t: i18n.pack('tpl'),
      groups: groups,
      countText: i18n.t('tpl:count', { n: templates.count }),
      showCnNote: i18n.isEn(),
      guideText: i18n.t('guide:nav')
    })
    i18n.title('tpl:nav')
  },

  /**
   * 展开 / 收起某一类。
   *
   * 用 data-idx 而不是 data-id：setData 改嵌套数组要靠下标路径
   * （groups[2].open），用分类 id 还得先反查一遍下标，多一步就多一个错处。
   */
  onToggle(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const g = this.data.groups[idx]
    if (!g || !g.more || !g.more.length) return
    const patch = {}
    patch['groups[' + idx + '].open'] = !g.open
    this.setData(patch)
  },

  /** 分享出去指回自己，别指向首页——收到的人点开就该看到同一份内容 */
  onShareAppMessage() {
    return {
      title: i18n.t('tpl:share_list'),
      path: '/pages/tpl/list'
    }
  }
})
